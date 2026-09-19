// crosssell.mjs — sell a BSC position back to USDT. [FINANCIAL EXECUTION]
//   node crosssell.mjs --token 0x… [--pct 100] [--slippage-bps 300] [--force] [--yes] [--order id]
// Output stays as BSC USDT in your wallet (chain back-to-back plays without
// re-bridging); use sweepback.mjs to return everything to Arc.
import { formatUnits, encodeFunctionData } from 'viem';
import { CFG, ERC20, FEE_ROUTER, loadAccount, bscPublic, bscWallet, orderState, bestSellRoute, fmtUsdt, safeExecuteTransaction, reconcileOrderStep } from './rail-lib.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(`--${name}`);
const token = arg('token'); const pct = Number(arg('pct', 100));
const slippageBps = Number(arg('slippage-bps', 300));
if (!token || !Number.isFinite(pct) || pct <= 0 || pct > 100) { console.error('usage: crosssell.mjs --token 0x… [--pct 100] [--yes]'); process.exit(2); }
if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > (flag('force') ? 1000 : 300)) { console.error('slippage cap: 3% (10% with --force)'); process.exit(2); }

const account = loadAccount();
const chain = arg('chain', 'bsc');
if (chain === 'rh' || chain === 'arc') {
  const { rhSellFlow } = await import('./rh-flow.mjs');
  await rhSellFlow({ account, token, pct, slippageBps, orderId: arg('order', `sell-${token.slice(2, 8)}-${Date.now()}`), chainKey: chain });
  process.exit(0);
}
if (chain === 'sol') {
  const { solSellFlow } = await import('./sol-flow.mjs');
  await solSellFlow({ token, pct, slippageBps, orderId: arg('order', `sell-${token.slice(2, 8)}-${Date.now()}`) });
  process.exit(0);
}
if (chain !== 'bsc') { console.error(`chain '${chain}' not yet enabled (have: bsc, rh, arc, sol)`); process.exit(2); }
const state = orderState(arg('order', `sell-${token.slice(2, 8)}-${Date.now()}`));
const bscP = bscPublic(), bscW = bscWallet(account);
state.lockWallet(account.address, [56]);
if (state.done('sell')) { await reconcileOrderStep(bscP, state, 'sell'); console.log('sell already executed: ' + state.load().steps.sell.txHash); process.exit(0); }
const bal = await bscP.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
if (bal === 0n) { console.error('zero balance'); process.exit(1); }
const amountIn = (bal * BigInt(Math.round(pct * 100))) / 10_000n;
const dec = await bscP.readContract({ address: token, abi: ERC20, functionName: 'decimals' }).catch(() => 18);

const route = await bestSellRoute(bscP, token, amountIn);
if (!route) { console.error('no viable sell route'); process.exit(1); }
const minOut = (route.out * BigInt(10_000 - slippageBps - CFG.feeBps)) / 10_000n;
console.log(`[FINANCIAL EXECUTION] sell ${pct}% (${formatUnits(amountIn, dec)}) of ${token}`);
console.log(`  route ${route.kind}${route.fee ? ` fee=${route.fee}` : ''} | est ${fmtUsdt(route.out)} USDT gross, min ${fmtUsdt(minOut)} net of 0.5% rail fee`);
if (!flag('yes')) { console.log('re-run with --yes to execute'); process.exit(0); }

if (state.done('approve')) await reconcileOrderStep(bscP, state, 'approve');
else {
  const allowance = await bscP.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [account.address, CFG.bsc.feeRouter] });
  if (allowance < amountIn) await safeExecuteTransaction(bscP, bscW, state, 'approve', { to: token,
    data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [CFG.bsc.feeRouter, amountIn] }) });
}
state.mark('sell', { intent: { amountIn: amountIn.toString(), minOut: minOut.toString() } });
const before = await bscP.readContract({ address: CFG.bsc.quote.address, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
const data = route.kind === 'v2'
  ? encodeFunctionData({ abi: FEE_ROUTER, functionName: 'sellV2', args: [route.path, amountIn, minOut] })
  : encodeFunctionData({ abi: FEE_ROUTER, functionName: 'sellV3', args: [route.path, token, CFG.bsc.quote.address, amountIn, minOut] });
const { hash: h } = await safeExecuteTransaction(bscP, bscW, state, 'sell', { to: CFG.bsc.feeRouter, data, gas: 600_000n });
const got = (await bscP.readContract({ address: CFG.bsc.quote.address, abi: ERC20, functionName: 'balanceOf', args: [account.address] })) - before;
state.mark('sell', { got: got.toString() });
console.log(`SOLD -> ${fmtUsdt(got)} USDT net | tx ${h}`);
