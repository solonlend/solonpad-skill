// sweepback.mjs — return BSC USDT to Arc as native USDC. [FINANCIAL EXECUTION]
//   node sweepback.mjs [--usd all] [--yes] [--order id]
// Leaves BNB gas dust in place (worthless to bridge, useful next trip).
import { parseUnits, formatEther } from 'viem';
import { CFG, ERC20, loadAccount, arcPublic, bscPublic, bscWallet, orderState, relayQuote, executeRelaySteps, exactInputFloor, fmtUsdt } from './rail-lib.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(`--${name}`);
const account = loadAccount();
const chain = arg('chain', 'bsc');
if (chain === 'rh') {
  const { rhSweepFlow } = await import('./rh-flow.mjs');
  await rhSweepFlow({ account, orderId: arg('order', `sweep-${Date.now()}`) });
  process.exit(0);
}
if (chain === 'sol') {
  const { solSweepFlow } = await import('./sol-flow.mjs');
  await solSweepFlow({ account, orderId: arg('order', `sweep-${Date.now()}`), usd: arg('usd', 'all') });
  process.exit(0);
}
if (chain !== 'bsc') { console.error(`chain '${chain}' not yet enabled (have: bsc, rh, sol)`); process.exit(2); }
const state = orderState(arg('order', `sweep-${Date.now()}`));
const arcP = arcPublic(), bscP = bscPublic(), bscW = bscWallet(account);

const bal = await bscP.readContract({ address: CFG.bsc.quote.address, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
const want = arg('usd', 'all');
const amount = want === 'all' ? bal : parseUnits(want, 18);
if (amount === 0n || amount > bal) { console.error(`bad amount (have ${fmtUsdt(bal)} USDT)`); process.exit(1); }

const q = await relayQuote({ user: account.address, recipient: account.address, fromChain: 56, toChain: 5042,
  fromCurrency: CFG.bsc.quote.address,
  // relay has no route to Arc's native side, but the 0x3600 ERC20 view IS the
  // same balance (precompile-backed twin) — arriving there arrives as native.
  toCurrency: '0x3600000000000000000000000000000000000000', amountWei: amount,
  // stable->stable: parity floor from OUR amount, never the quote's own minimum
  minOutput: exactInputFloor({ usdIn: Number(amount) / 1e18, outDecimals: 6 }) });
console.log(`[FINANCIAL EXECUTION] sweep ${fmtUsdt(amount)} BSC USDT -> Arc USDC (est out ${(Number(q.details.currencyOut.amount) / 1e6).toFixed(2)}, enforced min ${(Number(q.details.currencyOut.minimumAmount) / 1e6).toFixed(2)})`);
if (!flag('yes')) { console.log('re-run with --yes to execute'); process.exit(0); }

const before = await arcP.getBalance({ address: account.address });
await executeRelaySteps(q, bscW, bscP, state, 'sweep');
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 4000));
  const now = await arcP.getBalance({ address: account.address });
  if (now > before) { console.log(`ARRIVED on Arc: +${Number(formatEther(now - before)).toFixed(2)} USDC`); process.exit(0); }
}
console.log('not arrived in 120s — relay may still be settling; funds are traceable in the state file');
