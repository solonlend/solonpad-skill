// rh-flow.mjs — buy/sell/sweep orchestration for the Robinhood lane.
// ETH is both quote and gas on RH, so a bridged order is self-gassing: we
// spend 97% of the arrival and the rest pays for the swap and the exit.
// minOut comes from an eth_call simulation of the actual router call right
// before sending — the free insurance a same-block quote can't give.
import { parseEther, formatEther, decodeFunctionResult, encodeFunctionData } from 'viem';
import { CHAINS, HOME, ERC20, SETTINGS, arcPublic, arcWallet, chainPublic, chainWallet, orderState, relayQuote, executeRelaySteps, waitArrival, safeExecuteTransaction, reconcileOrderStep, exactInputFloor, ethUsdBsc, bscPublic } from './rail-lib.mjs';
import { rhLaunch, rhDueDiligence, rhBuildBuy, rhBuildSell, rhVerifyLaunch, RH_FEE_ROUTER } from './rh-venue.mjs';

const GAS_RESERVE_BPS = 300n; // keep 3% of the bridged ETH for gas

async function simulateNetOut(pub, from, call) {
  const data = await pub.call({ account: from, to: call.to, data: call.data, value: call.value });
  const fn = call.data.slice(0, 10) === '0x269310e6' ? 'curveBuy' : call.data.slice(0, 10) === '0xd0c7c2d6' ? 'curveSell' : 'v4Swap';
  return decodeFunctionResult({ abi: RH_FEE_ROUTER, functionName: fn, data: data.data ?? data });
}

export function rhBridgeBaseline(state, currentBalance) {
  const steps = state.load().steps;
  if (steps['rh-bridge-baseline']) return BigInt(steps['rh-bridge-baseline'].before);
  if (Object.entries(steps).some(([key, value]) => key.startsWith('rh-bridge:') && value.txHash)) {
    throw new Error('RH bridge baseline is missing for a recorded payment — verify its destination delivery before recovery');
  }
  // Must be durable before any source transaction can be broadcast. A crash
  // after destination arrival cannot redefine the original balance as zero
  // arrival and leave this order waiting for an unrelated second transfer.
  state.mark('rh-bridge-baseline', { before: currentBalance.toString() });
  return currentBalance;
}

export async function rhBuyFlow({ account, token, usd, slippageBps, force, orderId, chainKey = 'rh', state = orderState(orderId) }) {
  state.lockWallet(account.address, [HOME.relayId, CHAINS[chainKey].relayId]);
  const rhP = chainPublic(chainKey), rhW = chainWallet(chainKey, account);
  const arcP = arcPublic(), arcW = arcWallet(account);
  const FR = CHAINS[chainKey].feeRouter;
  const sym = CHAINS[chainKey].quote.symbol;
  if (await reconcileOrderStep(rhP, state, 'rh-swap')) { console.log('buy already executed for this order'); return; }

  const discovered = await rhLaunch(token, chainKey);
  const launch = discovered ? await rhVerifyLaunch(rhP, discovered, token, chainKey) : null;
  if (!launch) { console.error(`token not found in the ${chainKey} index`); process.exit(1); }
  const dd = await rhDueDiligence(token, chainKey);
  if (!dd.ok && !force) { console.error(`DD GATE: ${dd.reason} — refusing (--force to bypass)`); process.exit(1); }
  if (!dd.ok) console.log(`dd_bypassed: ${dd.reason}`);
  console.log(`[FINANCIAL EXECUTION] buy ${token} on ${chainKey} for ~$${usd}`);
  console.log(`  venue: ${launch.mode}${launch.graduated ? '/graduated' : ''} (${launch.source}) | dd: ${dd.ok ? 'pass' : 'BYPASSED'} | flags ${JSON.stringify(dd.fields.flags ?? [])}`);
  if (!process.argv.includes('--yes')) { console.log('re-run with --yes to execute'); process.exit(0); }

  // Home-chain (arc) orders skip the bridge entirely: the wallet's USDC is
  // the quote and the gas, budget is simply the order size.
  if (chainKey === 'arc' && !state.done('rh-bridge-arrived')) {
    const bal = await rhP.getBalance({ address: account.address });
    const want = parseEther(String(usd));
    if (bal < want + parseEther('0.5')) { console.error('insufficient Arc USDC for order + gas'); process.exit(1); }
    state.mark('rh-bridge-arrived', { skipped: true, txHash: 'n/a', arrived: want.toString() });
  }
  // bridge Arc USDC -> RH ETH (self-gassing arrival). Spend ONLY this
  // order's arrival: pre-existing wallet ETH (gas reserves, other orders)
  // must never be swept into a buy.
  if (!state.done('rh-bridge-arrived')) {
    const ethBefore = rhBridgeBaseline(state, await rhP.getBalance({ address: account.address }));
    // ETH/USD read from Pancake on BSC — independent of the relay response
    const ethUsd = await ethUsdBsc(bscPublic());
    const q = await relayQuote({ user: account.address, recipient: account.address, fromChain: HOME.relayId, toChain: CHAINS.rh.relayId,
      fromCurrency: '0x0000000000000000000000000000000000000000', toCurrency: '0x0000000000000000000000000000000000000000',
      amountWei: parseEther(String(usd)),
      minOutput: exactInputFloor({ usdIn: usd, outUsdPrice: ethUsd, outDecimals: 18 }) });
    console.log(`bridging $${usd} Arc USDC -> RH ETH (est ${Number(formatEther(BigInt(q.details.currencyOut.amount))).toFixed(5)} ETH)`);
    await executeRelaySteps(q, arcW, arcP, state, 'rh-bridge');
    const arrived = await waitArrival(rhP, account.address, null, ethBefore);
    state.mark('rh-bridge-arrived', { skipped: false, txHash: 'n/a', arrived: arrived.toString() });
  }

  // spend this order's arrival minus a gas reserve; simulate for the true minOut
  const arrivedWei = BigInt(state.load().steps['rh-bridge-arrived']?.arrived ?? 0);
  if (arrivedWei === 0n) { console.error('no recorded arrival for this order — refusing to spend wallet balance'); process.exit(1); }
  const bal = await rhP.getBalance({ address: account.address });
  const budget = arrivedWei < bal ? arrivedWei : bal;
  const spendable = budget - (budget * GAS_RESERVE_BPS) / 10_000n;
  const probe = rhBuildBuy(launch, spendable, 1n, FR);
  const est = await simulateNetOut(rhP, account.address, probe);
  const minOut = (BigInt(est) * BigInt(10_000 - slippageBps)) / 10_000n;
  if (!state.done('rh-swap')) {
    const call = rhBuildBuy(launch, spendable, minOut, FR);
    state.mark('rh-swap', { intent: { spend: spendable.toString(), minOut: minOut.toString() } });
    const before = await rhP.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
    const { hash: h, receipt: rc } = await safeExecuteTransaction(rhP, rhW, state, 'rh-swap', { ...call, gas: 800_000n });
    if (rc.status !== 'success') { console.error('swap reverted', h); process.exit(1); }
    const got = (await rhP.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account.address] })) - before;
    state.mark('rh-swap', { txHash: h, got: got.toString() });
    console.log(`BOUGHT ${Number(formatEther(got)).toLocaleString()} tokens for ${Number(formatEther(spendable)).toFixed(5)} ${sym} (incl 0.5% rail fee) | tx ${h}`);
  }
  console.log(`receipt: ${state.file}`);
}

export async function rhSellFlow({ account, token, pct, slippageBps, orderId, chainKey = 'rh' }) {
  const state = orderState(orderId);
  state.lockWallet(account.address, [CHAINS[chainKey].relayId]);
  const rhP = chainPublic(chainKey), rhW = chainWallet(chainKey, account);
  const FR = CHAINS[chainKey].feeRouter;
  const sym = CHAINS[chainKey].quote.symbol;
  if (await reconcileOrderStep(rhP, state, 'rh-sell')) { console.log('sell already executed for this order'); return; }
  const discovered = await rhLaunch(token, chainKey);
  const launch = discovered ? await rhVerifyLaunch(rhP, discovered, token, chainKey) : null;
  if (!launch) { console.error('token not found in the RH index'); process.exit(1); }
  const bal = await rhP.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
  if (bal === 0n) { console.error('zero balance'); process.exit(1); }
  const amountIn = (bal * BigInt(Math.round(pct * 100))) / 10_000n;
  // the pre-authorization preview must not depend on an allowance (approving
  // before --yes was the reviewed bug); without allowance the router
  // simulation reverts, so the estimate defers to after approval
  const probe = rhBuildSell(launch, amountIn, 1n, FR);
  const allowance0 = await rhP.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [account.address, FR] });
  let est = null;
  if (allowance0 >= amountIn) est = await simulateNetOut(rhP, account.address, probe);
  console.log(`[FINANCIAL EXECUTION] sell ${pct}% on ${chainKey} | est ${est !== null ? Number(formatEther(BigInt(est))).toFixed(5) + ' ' + sym + ' net' : 'computed after approval (no allowance yet); minOut guard still applies'}`);
  if (!process.argv.includes('--yes')) { console.log('re-run with --yes to execute'); process.exit(0); }
  // approval only after explicit authorization — an approve is a broadcast too
  if (allowance0 < amountIn) {
    state.mark('rh-approve', { intent: `approve ${amountIn}` });
    await safeExecuteTransaction(rhP, rhW, state, 'rh-approve', { to: token, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [FR, amountIn] }), value: 0n });
  }
  if (est === null) est = await simulateNetOut(rhP, account.address, probe);
  const minOut = (BigInt(est) * BigInt(10_000 - slippageBps)) / 10_000n;
  const call = rhBuildSell(launch, amountIn, minOut, FR);
  state.mark('rh-sell', { intent: { amountIn: amountIn.toString(), minOut: minOut.toString() } });
  const before = await rhP.getBalance({ address: account.address });
  const { hash: h, receipt: rc } = await safeExecuteTransaction(rhP, rhW, state, 'rh-sell', { ...call, gas: 800_000n });
  if (rc.status !== 'success') { console.error('sell reverted', h); process.exit(1); }
  const gasCost = rc.gasUsed * rc.effectiveGasPrice;
  const got = (await rhP.getBalance({ address: account.address })) - before + gasCost;
  state.mark('rh-sell', { txHash: h, got: got.toString() });
  console.log(`SOLD -> +${Number(formatEther(got)).toFixed(5)} ${sym} net | tx ${h}`);
}

export async function rhSweepFlow({ account, orderId }) {
  const state = orderState(orderId);
  state.lockWallet(account.address, [HOME.relayId, CHAINS.rh.relayId]);
  const rhP = chainPublic('rh'), rhW = chainWallet('rh', account);
  const arcP = arcPublic();
  const bal = await rhP.getBalance({ address: account.address });
  const keep = parseEther('0.0005'); // leave dust for a future return trip
  if (bal <= keep) { console.error('nothing to sweep'); process.exit(1); }
  const amount = bal - keep;
  // ETH/USD read from Pancake on BSC — independent of the relay response
  const ethUsd = await ethUsdBsc(bscPublic());
  const q = await relayQuote({ user: account.address, recipient: account.address, fromChain: CHAINS.rh.relayId, toChain: HOME.relayId,
    fromCurrency: '0x0000000000000000000000000000000000000000', toCurrency: HOME.sweepCurrency, amountWei: amount,
    minOutput: exactInputFloor({ usdIn: Number(formatEther(amount)) * ethUsd, outDecimals: 6 }) });
  console.log(`[FINANCIAL EXECUTION] sweep ${Number(formatEther(amount)).toFixed(5)} RH ETH -> Arc USDC (est $${(Number(q.details.currencyOut.amount) / 1e6).toFixed(2)}, enforced min $${(Number(q.details.currencyOut.minimumAmount) / 1e6).toFixed(2)})`);
  if (!process.argv.includes('--yes')) { console.log('re-run with --yes to execute'); process.exit(0); }
  const before = await arcP.getBalance({ address: account.address });
  await executeRelaySteps(q, rhW, rhP, state, 'rh-sweep');
  const got = await waitArrival(arcP, account.address, null, before, 180_000);
  console.log(`ARRIVED on Arc: +${Number(formatEther(got)).toFixed(2)} USDC`);
}
