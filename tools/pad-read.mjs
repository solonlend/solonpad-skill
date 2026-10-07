#!/usr/bin/env node
// SolonPad read-only reference reader. No keys, no transactions — public client only.
// Reads the chain directly (no SolonPad API). Covers V3.1 coins (the current launch
// stack), V3.0 coins (stock dividends), instant v4 launches (native USDC and every quote instance in addresses.json) and
// curve launches. ARC_RPC / RH_RPC override the public RPCs.
// Usage:
//   node pad-read.mjs                   list launches of the last ~14 h (100k blocks), V3 included
//   node pad-read.mjs --v31             list every V3.1 coin since the V3.1 deploy block
//   node pad-read.mjs --v3              list every V3.0 coin since the V3 deploy block
//   node pad-read.mjs --reserves        V3 stock proof of reserves: Arc supply vs RH ReserveVault
//   node pad-read.mjs --from 22500000   list launches since a block
//   node pad-read.mjs --all             list every launch since deploy (slow on the
//                                       public RPC: 5k-block log windows, rate-limited)
//   node pad-read.mjs 0xToken           one token (V3.1 or V3.0 coin, v4 or curve), full pinned-block state
//   node pad-read.mjs 0xToken 25        + buy quote for 25 units of its quote (V3: V3Quoter, fee itemized;
//                                       V3.1: V4Quoter, after the 1% LP fee)
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
const client = createPublicClient({ transport: http(process.env.ARC_RPC || A.chain.rpc, { retryCount: 5, retryDelay: 400 }) });
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


// ---------------------------------------------------------------- V3 (stock-dividend coins)
const V3 = A.v3;
const v3FactoryAbi = abiOf(await load('abis/v3/V3LaunchFactory.json'));
const v3CoinAbi = abiOf(await load('abis/v3/V3RewardToken.json'));
const v3RightsAbi = abiOf(await load('abis/v3/CreatorRightsNFT.json'));
const v3QuoterAbi = abiOf(await load('abis/v3/V3Quoter.json'));
const launchStateEvent = parseAbiItem('event LaunchState(bytes32 indexed poolId, address indexed token, uint8 state)');
const V3_STATE = ['None', 'Registered', 'Initialized', 'Locked'];
const Q192 = 2n ** 192n;
const r = (address, abi, functionName, args = []) => withBackoff(() => client.readContract({ address, abi, functionName, args, blockNumber: block }));

/** Quote per coin, 18-dec both sides; the pool sorts (quote, coin) by address. */
function v3Price(sqrtPriceX96, quote, coin) {
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  if (p2 === 0n) return null;
  return formatEther(BigInt(quote) < BigInt(coin) ? (Q192 * 10n ** 18n) / p2 : (p2 * 10n ** 18n) / Q192);
}
const v3Key = (coin, quote) => {
  const q0 = BigInt(quote) < BigInt(coin);
  return { currency0: q0 ? quote : coin, currency1: q0 ? coin : quote, fee: 0, tickSpacing: 100, hooks: V3.launch.V3QuoteFeeHook };
};

/** null when `coin` is not a V3 launch. */
async function v3Coin(coin) {
  const poolId = await client.readContract({ address: coin, abi: v3CoinAbi, functionName: 'poolId', blockNumber: block }).catch(() => null);
  if (!poolId) return null;
  const l = await r(V3.launch.V3LaunchFactory, v3FactoryAbi, 'launches', [poolId]);
  if (l[0].toLowerCase() !== coin.toLowerCase()) return null;
  const [quote, kind, symbol, name] = await Promise.all(['quote', 'settlementKind', 'symbol', 'name'].map((fn) => r(coin, v3CoinAbi, fn)));
  const [slot0, eligible, credited, participants, lastFeeAt, rightsId] = await Promise.all([
    r(A.uniswapV4Canonical.stateView, stateViewAbi, 'getSlot0', [poolId]),
    r(coin, v3CoinAbi, 'totalEligible'), r(coin, v3CoinAbi, 'totalCredited'),
    r(coin, v3CoinAbi, 'participantCount'), r(coin, v3CoinAbi, 'lastFeeAt'),
    r(V3.launch.CreatorRightsNFT, v3RightsAbi, 'tokenOfPool', [poolId])]);
  const [rightsOwner, claimable, paid] = await Promise.all(['ownerOf', 'claimable', 'paid'].map((fn) => r(V3.launch.CreatorRightsNFT, v3RightsAbi, fn, [rightsId])));
  return {
    mode: 'v3', coin, name, symbol, poolId, state: V3_STATE[Number(l[8])] ?? Number(l[8]),
    quote, quoteKind: Number(kind) === 0 ? 'USDC (PurchaseStock: holder share buys stock)' : 'STOCK.sol (DirectStock: holder share paid in the quote stock)',
    poolKey: v3Key(coin, quote), priceQuotePerCoin: v3Price(slot0[0], quote, coin), tick: Number(slot0[1]), lpFee: Number(slot0[3]),
    holders: { totalEligible: formatEther(eligible), totalCreditedUsd: formatEther(credited), participants: participants.toString(),
      lastFeeAt: Number(lastFeeAt) ? new Date(Number(lastFeeAt) * 1000).toISOString() : null },
    creatorRights: { tokenId: rightsId.toString(), owner: rightsOwner, claimable: formatEther(claimable), paid: formatEther(paid) },
    metadataHash: l[9],
  };
}

async function v3Quote(info, usd) {
  if (info.quote !== zeroAddress) throw new Error('the V3 quote helper covers native-USDC coins only');
  const amountIn = parseEther(usd);
  const probe = '0x00000000000000000000000000000000000000a1';
  const request = { key: info.poolKey, buy: true, amountSpecified: -amountIn, sqrtPriceLimitX96: 0n, minOut: 0n, maxIn: amountIn,
    recipient: probe, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
  const { result } = await client.simulateContract({ address: V3.trade.V3Quoter, abi: v3QuoterAbi, functionName: 'quote',
    args: [request, probe], account: probe, value: amountIn, blockNumber: block, stateOverride: [{ address: probe, balance: amountIn * 2n }] });
  return { usdcIn: usd, coinsOut: formatEther(result.minOut), hookFeeUsdc: formatEther(result.hookFee),
    netToPoolUsdc: formatEther(result.netQuote), fullFillOnly: result.fullFillOnly,
    note: 'simulated through V3Router at the pinned block; minOut here is a zero-slippage bound, set your own below it' };
}

async function v3List(fromBlock) {
  const logs = await getLogsChunked(V3.launch.V3LaunchFactory, launchStateEvent, fromBlock);
  const out = [];
  for (const l of logs.filter((x) => Number(x.args.state) === 3)) {
    const c = await v3Coin(l.args.token);
    if (c) out.push({ token: c.coin, symbol: c.symbol, name: c.name, launchBlock: String(l.blockNumber), mode: 'v3', poolId: c.poolId,
      quoteKind: c.quoteKind.split(' ')[0], priceQuotePerCoin: c.priceQuotePerCoin, launchTx: l.transactionHash });
  }
  return out;
}


// ---------------------------------------------------------------- V3.1 (hookless launch stack, new launches since 2026-10-07)
const V31 = A.v31;
const C31 = V31.contracts;
const v31Abi = async (n) => abiOf(await load(`abis/v31/${n}.json`));
const [v31FactoryAbi, v31SplitterAbi, v31RightsAbi, v31HoldersAbi, v31TokenAbi] = await Promise.all(
  ['V31LaunchFactory', 'V31FeeSplitter', 'V31CreatorRightsNFT', 'V31HolderRewards', 'V31Token'].map(v31Abi));
const v31Launched = parseAbiItem(
  'event TokenLaunched(address indexed token, address indexed deployer, bytes32 indexed poolId, address pairToken, address holderSource, uint256 positionId, uint256 payoutChoiceId)');

/** null when `coin` is not a V3.1 launch (V31LaunchFactory.tokenOfPool(poolId) is the authority, not the pool key:
 *  a V3.1 USDC pool has the same key shape as a legacy instant v4 pool). */
async function v31Coin(coin) {
  const lf = await client.readContract({ address: coin, abi: v31TokenAbi, functionName: 'launchFactory', blockNumber: block }).catch(() => null);
  if (!lf || lf.toLowerCase() !== C31.V31LaunchFactory.toLowerCase()) return null;
  let poolId = null, key = null;
  for (const quote of [zeroAddress, V31.wiring.stockQuote]) {
    const k = await r(C31.V31LaunchFactory, v31FactoryAbi, 'poolKeyFor', [coin, quote]);
    const id = poolIdOf(k);
    if ((await r(C31.V31LaunchFactory, v31FactoryAbi, 'tokenOfPool', [id])).toLowerCase() === coin.toLowerCase()) { poolId = id; key = k; break; }
  }
  if (!poolId) return null;
  const l = await r(C31.V31FeeSplitter, v31SplitterAbi, 'launchOf', [poolId]);
  const [name, symbol, totalSupply] = await Promise.all(['name', 'symbol', 'totalSupply'].map((fn) => r(coin, v31TokenAbi, fn)));
  const [slot0, creatorOwed, rightsId, enrolled] = await Promise.all([
    r(A.uniswapV4Canonical.stateView, stateViewAbi, 'getSlot0', [poolId]),
    r(C31.V31FeeSplitter, v31SplitterAbi, 'creatorOwed', [poolId]),
    r(C31.V31CreatorRightsNFT, v31RightsAbi, 'tokenOfPool', [poolId]),
    r(C31.V31HolderRewards, v31HoldersAbi, 'coins', [coin])]);
  const [rightsOwner, paid] = await Promise.all(['ownerOf', 'paid'].map((fn) => r(C31.V31CreatorRightsNFT, v31RightsAbi, fn, [rightsId])));
  const kind = Number(enrolled[1]);
  const epoch = BigInt(Math.floor(Date.now() / 86_400_000));
  const todayBudget = await r(C31.V31HolderRewards, v31HoldersAbi, 'coinBudget', [coin, epoch]);
  return {
    mode: 'v31', coin, name, symbol, poolId, quote: l.quote, positionId: l.positionId.toString(), launcher: l.creator,
    quoteKind: kind === 0 ? 'USDC (kind 0: holder share joins the shared reward round, paid in stock)' : 'NVDA.sol (kind 1: holder share paid in NVDA.sol via claimStock)',
    poolKey: key, priceQuotePerCoin: v3Price(slot0[0], l.quote, coin), tick: Number(slot0[1]), lpFee: Number(slot0[3]),
    supply: formatEther(totalSupply),
    holders: { kind, cohort: Number(enrolled[2]), todayBudgetRaw: todayBudget.toString(),
      note: 'budgets only grow when someone calls V31FeeSplitter.collect(poolId); fees sit in the LP position until then' },
    creatorRights: { tokenId: rightsId.toString(), owner: rightsOwner, collectedClaimable: formatEther(creatorOwed), paid: formatEther(paid),
      note: 'claimCreator collects first, so the claimable amount after collect can be higher than collectedClaimable' },
  };
}

async function v31Quote(info, amount) {
  const zeroForOne = info.poolKey.currency0.toLowerCase() === info.quote.toLowerCase(); // spend the quote
  const { result } = await client.simulateContract({
    address: V31.trade.v4Quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: info.poolKey, zeroForOne, exactAmount: parseEther(amount), hookData: '0x' }], blockNumber: block });
  return { quoteIn: amount, quote: info.quote, coinsOut: formatEther(result[0]), lpFeeInApprox: formatEther(parseEther(amount) / 100n),
    note: 'V4Quoter exact-input at the pinned block, after the 1% LP fee; build minOut below it and trade through UniversalRouter (AGENT-GUIDE.md V31-2)' };
}

async function v31List(fromBlock) {
  const logs = await getLogsChunked(C31.V31LaunchFactory, v31Launched, fromBlock);
  const out = [];
  for (const l of logs) {
    const c = await v31Coin(l.args.token);
    if (c) out.push({ token: c.coin, symbol: c.symbol, name: c.name, launchBlock: String(l.blockNumber), mode: 'v31', poolId: c.poolId,
      quote: c.quote, payoutChoiceId: l.args.payoutChoiceId.toString(), priceQuotePerCoin: c.priceQuotePerCoin, launcher: l.args.deployer, launchTx: l.transactionHash });
  }
  return out;
}

async function reserves() {
  const rh = createPublicClient({ transport: http(process.env.RH_RPC || V3.robinhood.rpc, { retryCount: 5, retryDelay: 400 }) });
  const rhBlock = await rh.getBlockNumber();
  const erc = parseAbi(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
  const hubAbi = parseAbi(['function supplyOf(address) view returns (uint256)']);
  const assets = [];
  for (const [ticker, st] of Object.entries(V3.stockLayer.stocks).filter(([k]) => !k.startsWith('_'))) {
    const [supply, hubSupply] = await Promise.all([r(st.arc, erc, 'totalSupply'), r(V3.stockLayer.SolonStockHub, hubAbi, 'supplyOf', [st.rh])]);
    const held = await rh.readContract({ address: st.rh, abi: erc, functionName: 'balanceOf', args: [V3.robinhood.ReserveVault], blockNumber: rhBlock });
    // hubSupply mirrors arcSupply by construction; the RH balance is the check
    assets.push({ ticker, arcToken: st.arc, rhToken: st.rh, arcSupply: formatEther(supply), hubSupply: formatEther(hubSupply),
      rhReserveVault: formatEther(held), covered: held >= supply });
  }
  return { arcBlock: String(block), rhBlock: String(rhBlock), reserveVault: V3.robinhood.ReserveVault, assets };
}

const args = process.argv.slice(2);
const DEFAULT_WINDOW = 100_000n;
const allIdx = args.indexOf('--all');
if (allIdx >= 0) args.splice(allIdx, 1);
const fromIdx = args.indexOf('--from');
const fromArg = fromIdx >= 0 ? BigInt(args.splice(fromIdx, 2)[1])
  : allIdx >= 0 ? null : block - DEFAULT_WINDOW;
const [target, quoteAmt] = args;
const pretty = (x) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 1);

if (target === '--reserves') {
  console.log(pretty(await reserves()));
} else if (target === '--v31') {
  const coins = await v31List(BigInt(V31.deployedAtBlock));
  console.log(pretty({ pinnedBlock: String(block), fromBlock: String(V31.deployedAtBlock), count: coins.length, launches: coins }));
} else if (target === '--v3') {
  const coins = await v3List(BigInt(V3.deployedAtBlock));
  console.log(pretty({ pinnedBlock: String(block), fromBlock: String(V3.deployedAtBlock), count: coins.length, launches: coins }));
} else if (!target) {
  const start = (b) => (fromArg && fromArg > BigInt(b) ? fromArg : BigInt(b));
  // Sequential on purpose: the public RPC rate-limits bursts.
  const curveLogs = await getLogsChunked(A.solonpad.launchFactory, curveLaunched, start(A.solonpad.deployBlock));
  const v4Logs = await getLogsChunked(instances.map((i) => i.strategy), v4Launched, start(V.deployBlock));
  const launches = [...await v31List(start(V31.deployedAtBlock)), ...await v3List(start(V3.deployedAtBlock))];
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
  // V3.1 coin? (checked before instant v4: same pool key shape)
  const v31 = await v31Coin(target);
  if (v31) {
    out = { pinnedBlock: String(block), ...v31 };
    if (quoteAmt) out.buyQuote = await v31Quote(v31, quoteAmt);
    console.log(pretty(out));
    process.exit(0);
  }
  // V3.0 coin?
  const v3 = await v3Coin(target);
  if (v3) {
    out = { pinnedBlock: String(block), ...v3 };
    if (quoteAmt) out.buyQuote = await v3Quote(v3, quoteAmt);
    console.log(pretty(out));
    process.exit(0);
  }
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
