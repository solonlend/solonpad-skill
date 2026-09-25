#!/usr/bin/env node
// SolonPad read-only reference reader. No keys, no transactions — public client only.
// Reads the chain directly (no SolonPad API). Covers instant v4 launches (native
// USDC and every quote instance in addresses.json) and curve launches.
// Usage:
//   node pad-read.mjs                   list launches of the last ~14 h (100k blocks)
//   node pad-read.mjs --from 22500000   list launches since a block
//   node pad-read.mjs --all             list every launch since deploy (slow on the
//                                       public RPC: 5k-block log windows, rate-limited)
//   node pad-read.mjs 0xToken           one token, full pinned-block state
//   node pad-read.mjs 0xToken 25        + exact-output quote for a 25-unit quote-token buy
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPublicClient, http, isAddress, formatEther, parseEther, parseAbi, parseAbiItem, zeroAddress, keccak256, encodeAbiParameters } from 'viem';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = async (p) => JSON.parse(await readFile(path.join(here, '..', p), 'utf8'));
const A = await load('addresses.json');
const abiOf = (j) => j.abi ?? j;
const factoryAbi = abiOf(await load('abis/PonsV2LaunchFactory.json'));
const curveAbi = abiOf(await load('abis/PonsV2BondingCurve.json'));
const tokenAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)']);
const stateViewAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']);
const quoterAbi = parseAbi(['function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)']);

const V = A.instantV4;
const LOG_RANGE = 5000n; // rpc.mainnet.arc.io rejects wider eth_getLogs ranges
const client = createPublicClient({ transport: http(A.chain.rpc, { retryCount: 5, retryDelay: 400 }) });
const chainId = await client.getChainId();
if (chainId !== A.chain.chainId) throw new Error(`chainId ${chainId} != ${A.chain.chainId} — wrong RPC`);
const block = await client.getBlockNumber();

// Instances: native USDC + every ERC-20 quote instance. quote = zeroAddress for native.
const instances = [
  { symbol: 'USDC', quote: zeroAddress, strategy: V.instantLaunchStrategy, splitter: V.feeSplitter },
  ...Object.entries(V.quoteInstances ?? {}).filter(([k]) => !k.startsWith('_'))
    .map(([symbol, q]) => ({ symbol, quote: q.quote, strategy: q.strategy, splitter: q.splitter })),
];
const byStrategy = new Map(instances.map((i) => [i.strategy.toLowerCase(), i]));

const curveLaunched = parseAbiItem(
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)');
const v4Launched = parseAbiItem(
  'event TokenLaunched(bytes32 indexed poolId, address indexed token, address indexed finalPositionRecipient, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withBackoff(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      const limited = /rate limit/i.test(String(e?.details ?? e?.message)) || e?.code === -32005;
      if (!limited || attempt >= 6) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function getLogsChunked(address, event, fromBlock) {
  const out = [];
  for (let b = fromBlock; b <= block; b += LOG_RANGE * 3n) {
    const batch = await Promise.all([0n, 1n, 2n].map((i) => b + i * LOG_RANGE).filter((f) => f <= block).map((f) => {
      const t = f + LOG_RANGE - 1n > block ? block : f + LOG_RANGE - 1n;
      return withBackoff(() => client.getLogs({ address, event, fromBlock: f, toBlock: t }));
    }));
    out.push(...batch.flat());
  }
  return out;
}

const poolIdOf = (k) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

function keyFor(token, quote) {
  const [currency0, currency1] = BigInt(token) < BigInt(quote) ? [token, quote] : [quote, token];
  return { currency0, currency1, fee: V.poolKey.fee, tickSpacing: V.poolKey.tickSpacing, hooks: V.poolKey.hooks };
}

async function v4State(token, inst, key, atBlock) {
  const [sqrtPriceX96, tick] = await client.readContract({
    address: A.uniswapV4Canonical.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolIdOf(key)], blockNumber: atBlock });
  if (sqrtPriceX96 === 0n) return null;
  // p = currency1 per currency0 (both 18-dec). Price quoted in the instance's quote token.
  const p = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const tokenIsC0 = key.currency0.toLowerCase() === token.toLowerCase();
  const price = tokenIsC0 ? p : 1 / p;
  return { mode: 'v4', quoteSymbol: inst.symbol, quoteToken: inst.quote, poolId: poolIdOf(key), poolKey: key,
           price, fdvInQuote: price * 1e9, tick: Number(tick) };
}

async function curveState(curve, atBlock) {
  const read = (functionName, args) => client.readContract({ address: curve, abi: curveAbi, functionName, args, blockNumber: atBlock });
  const [reserves, real, threshold, graduated, feeBps, isNative, pairToken] = await Promise.all(
    ['getReserves', 'realQuoteReserve', 'graduationThreshold', 'graduated', 'feeBps', 'isNativeQuote', 'pairToken'].map((fn) => read(fn)));
  const [q, t] = reserves;
  return {
    mode: 'curve', quoteToken: isNative ? zeroAddress : pairToken, isNativeQuote: isNative,
    price: Number(q) / Number(t),
    realRaised: Number(formatEther(real)),
    graduationThreshold: formatEther(threshold),
    graduationPct: threshold ? (Number(real) / Number(threshold)) * 100 : null,
    graduated, feeBps: Number(feeBps),
    quoteReserve: formatEther(q), tokenReserve: formatEther(t),
  };
}

// ERC-20-quoted curves cannot be eth_call-quoted without a funded, approved
// account, so mirror the contract math (AGENT-GUIDE.md §2 closed form) instead.
async function curveClosedFormQuote(curve, amountIn, atBlock) {
  const read = (functionName, args) => client.readContract({ address: curve, abi: curveAbi, functionName, args, blockNumber: atBlock });
  const probe = '0x0000000000000000000000000000000000000001';
  const [[q, t], feeBps, creatorTaxBps, snipeTaxBps] = await Promise.all([
    read('getReserves'), read('feeBps'), read('creatorTaxBps'), read('currentSnipeTaxBps', [probe])]);
  const net = amountIn - amountIn * feeBps / 10000n - amountIn * creatorTaxBps / 10000n - amountIn * snipeTaxBps / 10000n;
  return (net * t) / (q + net);
}

async function names(token) {
  const [name, symbol] = await Promise.all(['name', 'symbol'].map((fn) =>
    withBackoff(() => client.readContract({ address: token, abi: tokenAbi, functionName: fn })).catch(() => null)));
  return { name, symbol };
}

const args = process.argv.slice(2);
const DEFAULT_WINDOW = 100_000n;
const allIdx = args.indexOf('--all');
if (allIdx >= 0) args.splice(allIdx, 1);
const fromIdx = args.indexOf('--from');
const fromArg = fromIdx >= 0 ? BigInt(args.splice(fromIdx, 2)[1])
  : allIdx >= 0 ? null : block - DEFAULT_WINDOW;
const [target, quoteAmt] = args;

if (!target) {
  const start = (b) => (fromArg && fromArg > BigInt(b) ? fromArg : BigInt(b));
  // Sequential on purpose: the public RPC rate-limits bursts.
  const curveLogs = await getLogsChunked(A.solonpad.launchFactory, curveLaunched, start(A.solonpad.deployBlock));
  const v4Logs = await getLogsChunked(instances.map((i) => i.strategy), v4Launched, start(V.deployBlock));
  const launches = [];
  for (const l of v4Logs) {
    const inst = byStrategy.get(l.address.toLowerCase());
    if (!inst || l.args.finalPositionRecipient.toLowerCase() !== inst.splitter.toLowerCase()) continue;
    const state = await v4State(l.args.token, inst, l.args.key, block);
    launches.push({ token: l.args.token, launchBlock: String(l.blockNumber), ...(await names(l.args.token)), ...state });
  }
  for (const l of curveLogs) {
    launches.push({ token: l.args.token, curve: l.args.curve, creator: l.args.deployer, launchBlock: String(l.blockNumber),
                    quoteToken: l.args.pairToken, ...(await names(l.args.token)), ...(await curveState(l.args.curve, block)) });
  }
  launches.sort((a, b) => Number(BigInt(b.launchBlock) - BigInt(a.launchBlock)));
  console.log(JSON.stringify({ pinnedBlock: String(block), fromBlock: fromArg ? String(fromArg) : 'deploy', count: launches.length, launches }, null, 1));
} else {
  if (!isAddress(target)) throw new Error('not an address');
  let out = null;
  // Curve launch?
  const launch = await client.readContract({
    address: A.solonpad.launchFactory, abi: factoryAbi, functionName: 'getLaunchedToken', args: [target] }).catch(() => null);
  const curve = launch && (launch.curve ?? launch[0]);
  if (curve && curve !== zeroAddress) {
    const state = await curveState(curve, block);
    out = { pinnedBlock: String(block), token: target, curve, ...(await names(target)), ...state };
    if (quoteAmt && !state.graduated) {
      const amountIn = parseEther(quoteAmt);
      const probe = '0x0000000000000000000000000000000000000001';
      if (state.isNativeQuote) {
        const quoted = await client.readContract({
          address: curve, abi: curveAbi, functionName: 'buy',
          args: [amountIn, 0n, probe], account: probe, value: amountIn, blockNumber: block,
          stateOverride: [{ address: probe, balance: amountIn * 2n }],
        });
        out.buyQuote = { quoteIn: quoteAmt, tokensOut: formatEther(quoted),
                         note: 'exact-output eth_call of curve.buy at pinned block; add your own minOut' };
      } else {
        const quoted = await curveClosedFormQuote(curve, amountIn, block);
        out.buyQuote = { quoteIn: quoteAmt, quoteToken: state.quoteToken, tokensOut: formatEther(quoted),
                         note: 'closed-form mirror of the curve math (ERC-20 quote; your own snipe tax may differ) — confirm with eth_call from your funded, approved wallet' };
      }
    }
  } else {
    // Instant v4 launch: find the instance whose pool exists.
    for (const inst of instances) {
      const key = keyFor(target, inst.quote);
      const state = await v4State(target, inst, key, block);
      if (!state) continue;
      out = { pinnedBlock: String(block), token: target, ...(await names(target)), ...state };
      if (quoteAmt) {
        const zeroForOne = key.currency0.toLowerCase() === inst.quote.toLowerCase(); // spend the quote
        const { result } = await client.simulateContract({
          address: A.uniswapV4Canonical.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
          args: [{ poolKey: key, zeroForOne, exactAmount: parseEther(quoteAmt), hookData: '0x' }], blockNumber: block });
        out.buyQuote = { quoteIn: quoteAmt, quoteSymbol: inst.symbol, tokensOut: formatEther(result[0]),
                         note: 'V4Quoter exact-input at pinned block, after the 1% LP fee; add your own minOut' };
      }
      break;
    }
  }
  if (!out) throw new Error('not a SolonPad launch (no curve in the factory, no pool in any instance of addresses.json)');
  console.log(JSON.stringify(out, null, 1));
}
