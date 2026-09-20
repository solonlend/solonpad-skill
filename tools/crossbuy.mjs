// crossbuy.mjs — one command, any-chain degen buy. [FINANCIAL EXECUTION]
// Non-custodial: your key (RAIL_PK env), your wallet, our route + fee router.
//   node crossbuy.mjs --token 0x… --usd 100 [--slippage-bps 300] [--force] [--order id]
// Flow: dd gate -> quote preview -> gas keeper -> bridge Arc USDC -> BSC USDT
//       -> best-route swap via PancakeFeeRouter (0.5% rail fee) -> receipt.
// Crash-safe: re-run with the same --order to resume, never double-send.
import { parseEther, formatUnits, parseUnits, encodeFunctionData } from 'viem';
import { CFG, ERC20, FEE_ROUTER, loadAccount, arcPublic, bscPublic, arcWallet, bscWallet, orderState, dueDiligence, findPools, bestBuyRoute, relayQuote, executeRelaySteps, waitBscArrival, ensureGas, exactInputFloor, fmtUsdt, safeExecuteTransaction, reconcileOrderStep, singleDebitCap } from './rail-lib.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(`--${name}`);
const token = arg('token'); const usd = Number(arg('usd'));
const slippageBps = Number(arg('slippage-bps', 300));
if (!token || !Number.isFinite(usd) || usd <= 0) { console.error('usage: crossbuy.mjs --token 0x… --usd 100 [--slippage-bps 300] [--force] [--order id]'); process.exit(2); }
const MAX_ORDER_USD = Number(process.env.MAX_ORDER_USD || 500);
if (usd > MAX_ORDER_USD && !flag('force')) { console.error(`order $${usd} > soft cap $${MAX_ORDER_USD} (fat-finger guard; --force to override)`); process.exit(2); }
if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > (flag('force') ? 1000 : 300)) { console.error('slippage cap: 3% (10% with --force)'); process.exit(2); }

const account = loadAccount();
const singleMode = flag('single');
// No flag: the curve default. With the flag: the caller's own flat premium.
const premiumFlag = arg('max-premium-bps');
const maxTotalDebit = singleMode ? singleDebitCap(usd, premiumFlag === undefined ? undefined : Number(premiumFlag), arg('max-arc-debit')) : null;
const orderId = arg('order', `buy-${token.slice(2, 8)}-${Date.now()}`);
// an order is bound to (chain, token, usd) on first dispatch: a resume can
// never re-select a different chain (arc/rh share state keys and interpret
// raw amounts in different units — a chain flip on resume is a fund-loss bug)
const state = orderState(orderId);
const bound = state.load().steps['order-meta'];
let chain = arg('chain');
if (bound) {
  const savedSteps = state.load().steps;
  const savedSingle = bound.single ?? (Object.keys(savedSteps).some(key => key.startsWith('single')) ? true : Object.keys(savedSteps).some(key => key !== 'order-meta') ? false : singleMode);
  if (savedSingle !== singleMode || bound.maxTotalDebit !== undefined && bound.maxTotalDebit !== (maxTotalDebit?.toString() ?? null)
      || bound.wallet && bound.wallet.toLowerCase() !== account.address.toLowerCase()) {
    console.error('order mode, wallet and total debit are bound; resume with the original parameters'); process.exit(2);
  }
  if ((chain && chain !== bound.chain) || bound.token.toLowerCase() !== token.toLowerCase() || Number(bound.usd) !== usd) {
    console.error(`order '${orderId}' is bound to chain=${bound.chain} token=${bound.token} usd=${bound.usd} — refusing to resume with different parameters`);
    process.exit(2);
  }
  chain = bound.chain;
} else if (!chain) {
  // auto-select by pool depth across enabled chains. Identity is the exact
  // contract address: an EVM address is only ever compared against EVM
  // chains, a base58 mint only against solana — same-name-different-address
  // listings are different assets and never merged.
  const candidates = /^0x[0-9a-fA-F]{40}$/.test(token) ? ['bsc', 'arc', 'rh'] : ['sol'];
  const depths = [];
  for (const key of candidates) {
    try {
      const pools = await findPools(token, key);
      if (pools.length) depths.push({ key, lpUsd: Number(pools[0].lpUsd ?? 0) });
    } catch { /* chain index unreachable -> not a candidate this run */ }
  }
  if (!depths.length) { console.error('token not found on any enabled chain (bsc, arc, rh, sol) — pass --chain to override'); process.exit(1); }
  depths.sort((a, b) => b.lpUsd - a.lpUsd);
  // our own arc/rh index carries no USD depth: unknown is not zero, so ANY
  // unknown among several candidates makes the comparison meaningless and
  // demands an explicit --chain instead of a guess
  if (depths.length > 1 && depths.some(d => d.lpUsd === 0)) {
    console.error(`token found on several chains without comparable depth (${depths.map(d => d.key).join(', ')}) — pass --chain`);
    process.exit(2);
  }
  chain = depths[0].key;
  console.log(`auto-selected '${chain}' by deepest pool: ${depths.map(d => `${d.key} ${d.lpUsd > 0 ? '$' + Math.round(d.lpUsd).toLocaleString() : 'depth n/a'}`).join(' | ')}`);
}
if (singleMode && chain !== 'bsc') { console.error('--single is supported only on the BSC buy lane'); process.exit(2); }
if (!bound || bound.single === undefined) state.mark('order-meta', { chain, token, usd, wallet: account.address, single: singleMode, maxTotalDebit: maxTotalDebit?.toString() ?? null, txHash: 'n/a' });
if (chain === 'rh' || chain === 'arc') {
  const { rhBuyFlow } = await import('./rh-flow.mjs');
  await rhBuyFlow({ account, token, usd, slippageBps, force: flag('force'), orderId, state, chainKey: chain });
  process.exit(0);
}
if (chain === 'sol') {
  const { solBuyFlow } = await import('./sol-flow.mjs');
  await solBuyFlow({ account, token, usd, slippageBps, force: flag('force'), orderId, state });
  process.exit(0);
}
if (chain !== 'bsc') { console.error(`chain '${chain}' not yet enabled (have: bsc, rh, arc, sol)`); process.exit(2); }
const arcP = arcPublic(), bscP = bscPublic();
const arcW = arcWallet(account), bscW = bscWallet(account);
state.lockWallet(account.address, [5042, 56]);
if (state.done('swap')) { await reconcileOrderStep(bscP, state, 'swap'); console.log('buy already executed: ' + state.load().steps.swap.txHash); process.exit(0); }
if (state.load().steps['single-filled']) { console.log('single buy already filled: ' + state.file); process.exit(0); }
console.log(`order ${orderId} | wallet ${account.address}`);

// 1. due-diligence gate (fails closed)
const dd = await dueDiligence(token);
if (!dd.ok && !flag('force')) { console.error(`DD GATE: ${dd.reason} — refusing (add --force to bypass at your own risk)`); process.exit(1); }
if (!dd.ok) console.log(`dd_bypassed: ${dd.reason}`);
const pools = await findPools(token);
if (!pools.length) { console.error('no pancake pool found for token'); process.exit(1); }
if (pools[0].lpUsd < CFG.ddMinLpUsd && !flag('force')) { console.error(`DD GATE: deepest LP $${pools[0].lpUsd.toFixed(0)} < $${CFG.ddMinLpUsd} — refusing (--force to bypass)`); process.exit(1); }

// 2. quote preview ([FINANCIAL EXECUTION] parameter echo)
const usdtTarget = parseUnits(String(usd), 18); // BSC USDT is 18dp
const route = await bestBuyRoute(bscP, token, usdtTarget);
if (!route) { console.error('no viable route (v2 paths and v3 tiers all empty)'); process.exit(1); }
const railFee = (usdtTarget * BigInt(CFG.feeBps)) / 10_000n;
console.log(`[FINANCIAL EXECUTION] buy ${token} for ~$${usd}`);
console.log(`  route: ${route.kind}${route.fee ? ` fee=${route.fee}` : ''} | est out ${route.out} raw | rail fee ${fmtUsdt(railFee)} USDT | slippage ${slippageBps}bps | dd: taxes ${dd.fields.buyTax ?? '?'}%/${dd.fields.sellTax ?? '?'}%`);
if (!flag('yes')) { console.log('re-run with --yes to execute'); process.exit(0); }

// SINGLE-SIGNATURE MODE (--single): one Arc tx; relay delivers USDT straight
// to the FeeRouter and atomically executes buyFrom on the destination, tokens
// land in the caller's wallet. No BSC gas needed at all.
if (flag('single')) {
  // EXACT_OUTPUT: exactly `usd` USDT lands at the router; the Arc side costs
  // ~8-12% more on small orders (prepaid destination gas + solver buffer) —
  // the receipt discloses the premium.
  const minOutSingle = (route.out * BigInt(10_000 - slippageBps - 2 * CFG.feeBps)) / 10_000n;
  const buyData = route.kind === 'v2'
    ? encodeFunctionData({ abi: FEE_ROUTER, functionName: 'buyV2From', args: [route.path, minOutSingle, account.address] })
    : encodeFunctionData({ abi: FEE_ROUTER, functionName: 'buyV3From', args: [route.path, CFG.bsc.quote.address, minOutSingle, account.address] });
  // relay's executor receives the exact-output USDT first, then runs txs —
  // so tx[0] moves the known exact amount into the router, tx[1] spends it.
  const transferData = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [CFG.bsc.feeRouter, usdtTarget] });
  const q = await relayQuote({ user: account.address, recipient: account.address, fromChain: 5042, toChain: 56,
    fromCurrency: '0x0000000000000000000000000000000000000000', toCurrency: CFG.bsc.quote.address, amountWei: usdtTarget,
    txs: [{ to: CFG.bsc.quote.address, data: transferData, value: '0' }, { to: CFG.bsc.feeRouter, data: buyData, value: '0' }] });
  if (BigInt(q.details.currencyIn.amount) > maxTotalDebit) throw new Error('maximum total Arc debit exceeded; use explicit --max-arc-debit to authorize a larger total');
  console.log(`single-signature: paying ${(Number(q.details.currencyIn.amount)/1e18).toFixed(2)} Arc USDC for exactly ${fmtUsdt(BigInt(q.details.currencyOut.amount))} USDT delivered+bought in one fill`);
  const baseline = state.load().steps['single-baseline'];
  const before = baseline ? BigInt(baseline.before) : await bscP.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
  if (!baseline) state.mark('single-baseline', { before: before.toString() });
  await executeRelaySteps(q, arcW, arcP, state, 'single', { maxTotalDebit });
  const got = await waitBscArrival(bscP, account.address, token, before, 180_000);
  const dec = await bscP.readContract({ address: token, abi: ERC20, functionName: 'decimals' }).catch(() => 18);
  state.mark('single-filled', { got: got.toString() });
  console.log(`BOUGHT ${formatUnits(got, dec)} tokens with ONE Arc signature | receipt: ${state.file}`);
  process.exit(0);
}

// 3. gas keeper
const gas = await ensureGas(account, arcW, arcP, bscP, state);
console.log(`gas: ${gas.topped ? 'topped up' : 'sufficient'} (was $${gas.balUsd.toFixed(2)})`);

// 4. main bridge (skipped when the wallet already holds enough BSC USDT)
const usdtBal = await bscP.readContract({ address: CFG.bsc.quote.address, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
if (usdtBal < usdtTarget && !state.done('main-bridge-arrived')) {
  const need = usdtTarget - usdtBal;
  // bridge a touch over: relay's fee comes out of the output
  const sendAmount = parseEther(String(Math.ceil(usd * 1.03)));
  const q = await relayQuote({ user: account.address, recipient: account.address, fromChain: 5042, toChain: 56,
    fromCurrency: '0x0000000000000000000000000000000000000000', toCurrency: CFG.bsc.quote.address, amountWei: sendAmount,
    // stable->stable: parity floor from OUR amount, never the quote's own minimum
    minOutput: exactInputFloor({ usdIn: Math.ceil(usd * 1.03), outDecimals: 18 }) });
  console.log(`bridging ~$${Math.ceil(usd * 1.03)} Arc USDC -> BSC USDT (est out ${fmtUsdt(BigInt(q.details.currencyOut.amount))})`);
  await executeRelaySteps(q, arcW, arcP, state, 'main-bridge');
  await waitBscArrival(bscP, account.address, CFG.bsc.quote.address, usdtBal);
  state.mark('main-bridge-arrived', { skipped: false, txHash: 'n/a' });
} else if (usdtBal >= usdtTarget) { state.mark('main-bridge-arrived', { skipped: true, txHash: 'n/a' }); console.log('bridge skipped: enough BSC USDT on hand'); }

// 5. swap via FeeRouter (fee on the input side, on-chain, transparent)
const spend = (await bscP.readContract({ address: CFG.bsc.quote.address, abi: ERC20, functionName: 'balanceOf', args: [account.address] }));
const amountIn = spend < usdtTarget ? spend : usdtTarget;
const finalRoute = await bestBuyRoute(bscP, token, amountIn);
if (!finalRoute) throw new Error('no viable final route');
const minOut = (finalRoute.out * BigInt(10_000 - slippageBps - CFG.feeBps)) / 10_000n;
if (state.done('approve')) await reconcileOrderStep(bscP, state, 'approve');
else {
  const allowance = await bscP.readContract({ address: CFG.bsc.quote.address, abi: ERC20, functionName: 'allowance', args: [account.address, CFG.bsc.feeRouter] });
  if (allowance < amountIn) {
    await safeExecuteTransaction(bscP, bscW, state, 'approve', { to: CFG.bsc.quote.address,
      data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [CFG.bsc.feeRouter, amountIn] }) });
  } else state.mark('approve', { skipped: true, txHash: 'n/a' });
}
state.mark('swap', { intent: { kind: finalRoute.kind, amountIn: amountIn.toString(), minOut: minOut.toString() } });
const before = await bscP.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
const data = finalRoute.kind === 'v2'
  ? encodeFunctionData({ abi: FEE_ROUTER, functionName: 'buyV2', args: [finalRoute.path, amountIn, minOut] })
  : encodeFunctionData({ abi: FEE_ROUTER, functionName: 'buyV3', args: [finalRoute.path, CFG.bsc.quote.address, amountIn, minOut] });
const { hash: h } = await safeExecuteTransaction(bscP, bscW, state, 'swap', { to: CFG.bsc.feeRouter, data, gas: 600_000n });
const got = (await bscP.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account.address] })) - before;
const dec = await bscP.readContract({ address: token, abi: ERC20, functionName: 'decimals' }).catch(() => 18);
state.mark('swap', { got: got.toString() });
console.log(`BOUGHT ${formatUnits(got, dec)} tokens | spent ${fmtUsdt(amountIn)} USDT (incl 0.5% rail fee) | tx ${h}`);
console.log(`receipt: ${state.file}`);
