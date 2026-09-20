// rail-lib.mjs — shared plumbing for the non-custodial cross-chain rail.
// Keys stay in the caller's env (RAIL_PK); nothing here uploads, logs or
// persists them. Every broadcast is preceded by a state-file write so an
// interrupted run resumes instead of double-spending (results/rail-<id>.json).
//
// Chain-table driven: adding an EVM v2/v3 venue chain is one CHAINS entry plus
// a FeeRouter deployment. Non-EVM venues (solana) and curve venues (rh) plug
// in through the same route/venue interface with their own executors.
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseEther, parseUnits, formatEther, formatUnits, encodePacked, keccak256, parseTransaction, decodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { validateRelayProtocol, validateRelayEvmSteps, validateRelayIntent } from './relay-protocol.mjs';
export { validateRelayIntent } from './relay-protocol.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync, renameSync, fsyncSync, statSync } from 'node:fs';

import { homedir } from 'node:os';
import { join } from 'node:path';

const ARC_RPC = process.env.RAIL_ARC_RPC || 'https://rpc.mainnet.arc.io';

// ---- the chain table ----
export const HOME = { // Arc: the funding domain every order starts from and sweeps back to
  key: 'arc', relayId: 5042,
  chain: defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [ARC_RPC] } } }),
  // relay cannot deliver to Arc's native side; the 0x3600 ERC20 view IS the
  // same precompile-backed balance, so sweeps target it and arrive as native.
  sweepCurrency: '0x3600000000000000000000000000000000000000',
};

export const CHAINS = {
  bsc: {
    key: 'bsc', kind: 'evm-v2v3', relayId: 56, dexscreenerId: 'bsc', goplusId: '56',
    chain: defineChain({ id: 56, name: 'BSC', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: { default: { http: [process.env.RAIL_BSC_RPC || 'https://bsc-dataseed.bnbchain.org'] } } }),
    quote: { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
    wnative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    v2Router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    quoterV2: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    v3FeeTiers: [100, 500, 2500, 10000],
    feeRouter: '0xA65a6a95B84FDB666C7B7ec249a7B8A2Cb495803', // v1.1 (buyFrom entries)
    dexMatch: /pancake/i,
  },
  base: {
    key: 'base', kind: 'evm-v2v3', relayId: 8453, dexscreenerId: 'base', goplusId: '8453',
    chain: defineChain({ id: 8453, name: 'Base', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [process.env.RAIL_BASE_RPC || 'https://mainnet.base.org'] } } }),
    quote: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
    wnative: '0x4200000000000000000000000000000000000006',
    v2Router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',      // uniswap v2 router02 (base)
    quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',      // uniswap v3 quoterV2 (base)
    v3FeeTiers: [100, 500, 3000, 10000],
    feeRouter: null, // pending deployment (uni adaptation)
    dexMatch: /uniswap|aerodrome/i,
  },
  arc: {
    key: 'arc', kind: 'solon-native', relayId: 5042, dexscreenerId: null, goplusId: null,
    chain: null, // HOME.chain is the runtime chain object; venue config only here
    quote: { address: null, symbol: 'USDC', decimals: 18 },
    feeRouter: '0x96Ed755a4E176999A892F0E35b5FFf56D25F5D19', // live since Argus aggregation (BRO smoke-tested)
    api: 'https://solonpad.fun',
  },
  rh: {
    key: 'rh', kind: 'solon-native', relayId: 4663, dexscreenerId: null, goplusId: null, // data layer: our own APIs
    chain: defineChain({ id: 4663, name: 'Robinhood', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [process.env.RAIL_RH_RPC || 'https://rpc.mainnet.chain.robinhood.com/rpc'] } } }),
    quote: { address: null, symbol: 'ETH', decimals: 18 },       // native-quoted venues
    feeRouter: '0xBef20379BdE976e807d8E6E9E831961512A02278',     // SolonFeeRouter (live since aggregation v1)
    api: 'https://solonpad.fun',                                  // pools + dd from our own aggregator
  },
  sol: {
    key: 'sol', kind: 'jupiter', relayId: 792703809, dexscreenerId: 'solana', goplusId: 'solana',
    chain: null, // non-EVM: executor lives in sol-flow.mjs / sol-venue.mjs
    quote: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    feeRouter: null, // fee rides Jupiter platformFeeBps + feeAccount (see sol-venue.mjs)
    dexMatch: /raydium|pumpswap|pumpfun|meteora|orca|moonshot|fluxbeam|heaven/i,
  },
};
CHAINS.arc.chain = HOME.chain; // the home chain doubles as a venue chain
export const chainCfg = (key) => {
  const c = CHAINS[key];
  if (!c) throw new Error(`unsupported chain '${key}' (have: ${Object.keys(CHAINS).join(', ')})`);
  return c;
};

export const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address, uint256) returns (bool)',
  'function transfer(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
]);
const V2_ROUTER = parseAbi(['function getAmountsOut(uint256, address[]) view returns (uint256[])']);
const QUOTER_V2 = parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)']);
export const FEE_ROUTER = parseAbi([
  'function buyV2(address[] path, uint256 amountIn, uint256 minOut) returns (uint256)',
  'function buyV2From(address[] path, uint256 minOut, address recipient) returns (uint256)',
  'function buyV3From(bytes path, address quote, uint256 minOut, address recipient) returns (uint256)',
  'function sellV2(address[] path, uint256 amountIn, uint256 minOut) returns (uint256)',
  'function buyV3(bytes path, address quote, uint256 amountIn, uint256 minOut) returns (uint256)',
  'function sellV3(bytes path, address token, address quote, uint256 amountIn, uint256 minOut) returns (uint256)',
]);

export const SETTINGS = { gasFloorUsd: 0.6, gasTopupUsd: 1.5, feeBps: 50, ddMinLpUsd: 10_000, ddMaxTaxPct: 15 };
export const CFG = { arc: HOME, bsc: CHAINS.bsc, ...SETTINGS }; // legacy alias (pre-table callers)

export function loadAccount() {
  const pk = process.env.RAIL_PK;
  if (!pk) throw new Error('RAIL_PK env not set (the rail is non-custodial: bring your own key)');
  return privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
}
export const arcPublic = () => createPublicClient({ chain: HOME.chain, transport: http() });
export const arcWallet = (account) => createWalletClient({ account, chain: HOME.chain, transport: http() });
export const chainPublic = (key) => createPublicClient({ chain: chainCfg(key).chain, transport: http() });
export const chainWallet = (key, account) => createWalletClient({ account, chain: chainCfg(key).chain, transport: http() });
// legacy aliases
export const bscPublic = () => chainPublic('bsc');
export const bscWallet = (account) => chainWallet('bsc', account);

export const fmtQuote = (key, v) => Number(formatUnits(v, chainCfg(key).quote.decimals)).toFixed(2);
export const parseQuote = (key, usd) => parseUnits(String(usd), chainCfg(key).quote.decimals);
export const fmtUsdt = (v) => fmtQuote('bsc', v); // legacy alias

// ---- order state (crash-safe resume) ----
const LOCK_TTL_MS = 10 * 60_000;
function exclusiveLease(file) {
  const nonce = `${process.pid}-${Date.now()}-${Math.random()}`;
  try {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now(), nonce })); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Never steal from a live process, even after TTL: it could still sign.
    const observed = readFileSync(file, 'utf8');
    let old; try { old = JSON.parse(observed); if (!old || typeof old !== 'object') old = {}; } catch { old = {}; }
    let alive = true;
    try { if (!Number.isInteger(old.pid)) alive = false; else process.kill(old.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    const age = Date.now() - (old.timestamp ?? statSync(file).mtimeMs);
    if (alive || age < LOCK_TTL_MS) throw new Error(`order/executor locked: ${file}`);
    // Serialize stale recovery too, so two reclaimers cannot unlink a new lock.
    const reclaim = `${file}.reclaim`;
    let guard; try { guard = openSync(reclaim, 'wx', 0o600); } catch { throw new Error(`order/executor locked: ${file}`); }
    try {
      if (readFileSync(file, 'utf8') !== observed) throw new Error(`order/executor locked: ${file}`);
      unlinkSync(file);
      return exclusiveLease(file);
    } finally { closeSync(guard); unlinkSync(reclaim); }
  }
  return () => { try { if (JSON.parse(readFileSync(file, 'utf8')).nonce === nonce) unlinkSync(file); } catch {} };
}
export function orderState(orderId, options = {}) {
  const directory = options.directory ?? 'results';
  // Same OS user, same wallet/chain: exclusion survives different CLI cwd.
  // Explicit directories isolate tests; callers must not use them to run a
  // second financial executor against the same wallet.
  const walletDirectory = options.directory ?? join(homedir(), '.solonpad', 'rail-locks');
  mkdirSync(walletDirectory, { recursive: true, mode: 0o700 });
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(orderId)) throw new Error('invalid order id');
  mkdirSync(directory, { recursive: true });
  const file = `${directory}/rail-${orderId}.json`;
  const releases = [exclusiveLease(`${file}.lock`)];
  const wallets = new Set();
  let closed = false;
  const close = () => { if (!closed) { closed = true; for (const release of releases.reverse()) release(); process.off('exit', close); } };
  process.once('exit', close);
  const load = () => { if (closed) throw new Error('order state closed'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { orderId, steps: {} }; };
  return {
    file, load, close,
    lockWallet(address, chainIds) {
      for (const chain of [...new Set(chainIds)].sort()) {
        const key = `${chain}-${address.toLowerCase()}`;
        if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('invalid wallet executor key');
        if (!wallets.has(key)) { releases.push(exclusiveLease(`${walletDirectory}/executor-${key}.lock`)); wallets.add(key); }
      }
    },
    mark(step, data) {
      const s = load(); s.steps[step] = { ...(s.steps[step] ?? {}), ...data, at: new Date().toISOString() };
      const temp = `${file}.${process.pid}.tmp`;
      const fd = openSync(temp, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(s, null, 1)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, file);
      const dirFd = openSync(directory, 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    },
    done: (step) => !!load().steps[step]?.txHash || !!load().steps[step]?.skipped,
  };
}

// The default ceiling is a fixed allowance plus a share, because the cost has
// that shape: measured 2026-09-20, an order pays about $0.75 of fixed bridge
// and destination-execution cost plus 3% of its size. One flat percentage must
// misjudge an end of the range — 15% refused a $5 order needing 17.15% while
// granting $250 four times the headroom it could use. An explicit
// --max-premium-bps remains the caller's own flat choice.
export const PREMIUM_FIXED_USD = '1.2';
export const PREMIUM_SHARE_BPS = 800;
export function singleDebitCap(usd, premiumBps, explicitMax) {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('invalid order amount');
  if (premiumBps !== undefined && (!Number.isInteger(premiumBps) || premiumBps < 0 || premiumBps > 10_000)) throw new Error('invalid premium bps (0..10000)');
  if (explicitMax !== undefined) {
    if (!/^[0-9]+(?:\.[0-9]{1,18})?$/.test(String(explicitMax)) || parseEther(String(explicitMax)) <= 0n) throw new Error('invalid explicit maximum Arc debit');
    return parseEther(String(explicitMax));
  }
  const budget = parseEther(String(usd));
  if (premiumBps !== undefined) return budget * BigInt(10_000 + premiumBps) / 10_000n;
  return budget + parseEther(PREMIUM_FIXED_USD) + budget * BigInt(PREMIUM_SHARE_BPS) / 10_000n;
}

// Return a confirmed receipt, or stop on ambiguity; never create a new nonce
// for an operation with durable signed bytes, including approvals.
export async function reconcileOrderStep(pub, state, key) {
  const prior = state.load().steps[key];
  if (!prior?.txHash || prior.txHash === 'n/a') return null;
  let receipt = await pub.getTransactionReceipt({ hash: prior.txHash }).catch(() => null);
  if (!receipt) {
    if (!prior.raw) throw new Error(`recorded step ${key} has no signed bytes; verify ${prior.txHash} on-chain before retrying`);
    try { await pub.sendRawTransaction({ serializedTransaction: prior.raw }); } catch (error) {
      // Already-known or RPC transport errors are ambiguous. Receipt polling
      // can resolve them without ever signing a replacement transaction.
      receipt = await pub.getTransactionReceipt({ hash: prior.txHash }).catch(() => null);
      if (!receipt) throw new Error(`recorded step ${key} rebroadcast unresolved (${prior.txHash}): ${String(error).slice(0, 160)}`);
    }
    if (!receipt) receipt = await pub.waitForTransactionReceipt({ hash: prior.txHash, timeout: 120_000 });
  }
  if (receipt.status !== 'success') throw new Error(`recorded step ${key} reverted: ${prior.txHash}`);
  state.mark(key, { confirmed: true });
  return { hash: prior.txHash, receipt };
}
export async function safeExecuteTransaction(pub, wallet, state, key, call, { maxTotalDebit, beforeSign } = {}) {
  state.lockWallet(wallet.account.address, [pub.chain.id]);
  const prior = state.load().steps[key];
  if (maxTotalDebit !== undefined && prior?.raw) {
    const signed = parseTransaction(prior.raw);
    const fee = signed.maxFeePerGas ?? signed.gasPrice;
    if (signed.gas === undefined || fee === undefined || BigInt(signed.value ?? 0) + signed.gas * fee > BigInt(maxTotalDebit)) throw new Error('maximum total Arc debit exceeded by recorded transaction');
  }
  const recovered = await reconcileOrderStep(pub, state, key);
  if (recovered) return recovered;
  const request = await pub.prepareTransactionRequest({ account: wallet.account, ...call });
  if (maxTotalDebit !== undefined) {
    const fee = request.maxFeePerGas ?? request.gasPrice;
    if (request.gas === undefined || fee === undefined || BigInt(request.value ?? 0) + BigInt(request.gas) * BigInt(fee) > BigInt(maxTotalDebit)) {
      throw new Error('maximum total Arc debit exceeded (quoted input plus bounded transaction fee)');
    }
  }
  // New signatures must still satisfy time-sensitive intent after RPC waits.
  // Recovery above only rebroadcasts already persisted bytes and skips this hook.
  if (beforeSign) await beforeSign();
  const raw = await wallet.signTransaction(request);
  const hash = keccak256(raw);
  state.mark(key, { txHash: hash, raw });
  await pub.sendRawTransaction({ serializedTransaction: raw });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`step ${key} reverted: ${hash}`);
  state.mark(key, { confirmed: true });
  return { hash, receipt };
}

// ---- due-diligence gate ----
export async function dueDiligence(token, chainKey = 'bsc') {
  const c = chainCfg(chainKey);
  if (!c.goplusId) {
    // our own aggregator is the dd source on chains we index ourselves
    if (c.api) {
      const f = await fetch(`${c.api}/api/factsheet/${token}?chain=${chainKey}`, { redirect: 'error' }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (!f) return { ok: false, reason: 'factsheet unavailable (fails closed; --force to override)', fields: {} };
      return { ok: true, reason: '', fields: { source: 'solonpad-factsheet' } };
    }
    return { ok: false, reason: 'no dd source for chain', fields: {} };
  }
  if (c.goplusId === 'solana') {
    // Solana authorities model: a live authority IS the rug vector
    const r = await fetch(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${token}`, { redirect: 'error' }).then(r => r.json()).catch(() => null);
    const d = r?.result?.[token];
    if (!d) return { ok: false, reason: 'goplus unavailable (fails closed; --force to override)', fields: {} };
    // an absent field is never a passing check: every authority we gate on
    // must be present and explicitly renounced
    // only an explicit renounced status ('0') passes; '1', 'unknown', absent —
    // anything else — is a refusal. An absent field is never a passing check.
    const AUTHORITIES = { freezable: 'freeze authority', mintable: 'mint authority', balance_mutable_authority: 'balance-mutation authority', closable: 'close authority', transfer_fee_upgradable: 'fee-change authority', transfer_hook_upgradable: 'hook-change authority' };
    const problems = [];
    for (const [k, label] of Object.entries(AUTHORITIES)) {
      const s = d[k]?.status;
      if (s === '1') problems.push(`${label} live`);
      else if (s !== '0') problems.push(`${label} status ${JSON.stringify(s ?? 'absent')} — fails closed`);
    }
    if (String(d.non_transferable) === '1') problems.push('non-transferable token');
    // transfer_fee: {} means none; a non-empty config must parse or we refuse.
    // GoPlus nests bps under current_fee_rate.fee_rate and exposes scheduled
    // rates; Number(object)=NaN and Number(null)=0 both silently pass a >cap
    // comparison, so only explicit, finite, non-null values count as parsed.
    // per-slot parsing: null/absent means "no fee configured here" (legit and
    // common); a PRESENT slot must yield a finite rate or the whole config
    // fails closed — a malformed slot silently dropped was the reviewed hole.
    const slotRate = (slot) => {
      if (slot === null || slot === undefined) return undefined;      // not configured
      if (typeof slot === 'object') {
        const r = Number(slot.fee_rate);
        return Number.isFinite(r) ? r : NaN;                          // object without a parsable rate = malformed
      }
      const r = Number(slot);
      return slot === '' || !Number.isFinite(r) ? NaN : r;
    };
    const tf = d.transfer_fee;
    if (tf && typeof tf === 'object' && Object.keys(tf).length > 0) {
      const rates = [slotRate(tf.current_fee_rate), slotRate(tf.fee_rate), slotRate(tf.scheduled_fee_rate), slotRate(tf.newer_transfer_fee)];
      const known = rates.filter(r => r !== undefined);
      if (!known.length || known.some(Number.isNaN)) problems.push('transfer fee config unparseable — fails closed');
      else for (const r of known) if (r / 100 > SETTINGS.ddMaxTaxPct) { problems.push(`transfer fee ${(r / 100).toFixed(1)}% (current or scheduled) > ${SETTINGS.ddMaxTaxPct}%`); break; }
    }
    return { ok: problems.length === 0, reason: problems.join('; '), fields: { flags: problems, holderCount: Number(d.holder_count ?? 0) } };
  }
  const r = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${c.goplusId}?contract_addresses=${token}`, { redirect: 'error' }).then(r => r.json()).catch(() => null);
  const d = r?.result?.[token.toLowerCase()];
  if (!d) return { ok: false, reason: 'goplus unavailable (fails closed; --force to override)', fields: {} };
  const honeypot = d.is_honeypot === '1';
  const buyTax = Number(d.buy_tax ?? 0) * 100, sellTax = Number(d.sell_tax ?? 0) * 100;
  const problems = [];
  if (honeypot) problems.push('is_honeypot=1');
  if (buyTax + sellTax > SETTINGS.ddMaxTaxPct) problems.push(`taxes ${buyTax.toFixed(1)}%+${sellTax.toFixed(1)}% > ${SETTINGS.ddMaxTaxPct}%`);
  if (d.cannot_sell_all === '1') problems.push('cannot_sell_all=1');
  return { ok: problems.length === 0, reason: problems.join('; '), fields: { honeypot, buyTax, sellTax } };
}

// ---- pool discovery ----
export async function findPools(token, chainKey = 'bsc') {
  const c = chainCfg(chainKey);
  if (!c.dexscreenerId) {
    if (!c.api) return [];
    const rows = await fetch(`${c.api}/api/launches?chain=${chainKey}`, { redirect: 'error' }).then(r => r.json()).then(d => d.rows ?? []).catch(() => []);
    const row = rows.find(r => r.token?.toLowerCase() === token.toLowerCase());
    return row ? [{ pair: row.poolId ?? row.curve, lpUsd: Number(row.liquidity ?? 0), quoteSymbol: row.quoteSymbol ?? c.quote.symbol, launch: row }] : [];
  }
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, { redirect: 'error' }).then(r => r.json());
  const pairs = (r.pairs ?? []).filter(p => p.chainId === c.dexscreenerId && c.dexMatch.test(p.dexId ?? ''));
  const rank = (p) => Number(p.liquidity?.usd ?? 0);
  pairs.sort((a, b) => rank(b) - rank(a));
  return pairs.map(p => ({ pair: p.pairAddress, labels: p.labels ?? [], lpUsd: rank(p), quote: p.quoteToken.address, quoteSymbol: p.quoteToken.symbol, isV3: (p.labels ?? []).includes('v3') }));
}

// ---- routing (evm-v2v3 kind): best quote->token route across v2 paths and v3 tiers ----
async function evmRoutes(pub, c, tokenIn, tokenOut, amountIn) {
  const candidates = [];
  const mids = [[], [c.wnative]];
  for (const mid of mids) {
    const path = [tokenIn, ...mid, tokenOut];
    try {
      const out = await pub.readContract({ address: c.v2Router, abi: V2_ROUTER, functionName: 'getAmountsOut', args: [amountIn, path] });
      candidates.push({ kind: 'v2', path, out: out[out.length - 1] });
    } catch { /* no such v2 path */ }
  }
  for (const fee of c.v3FeeTiers) {
    try {
      const { result } = await pub.simulateContract({ address: c.quoterV2, abi: QUOTER_V2, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] });
      candidates.push({ kind: 'v3', fee, path: encodePacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]), out: result[0] });
    } catch { /* no pool at tier */ }
  }
  candidates.sort((a, b) => (a.out < b.out ? 1 : -1));
  return candidates[0] ?? null;
}
export async function bestBuyRoute(pub, token, quoteIn, chainKey = 'bsc') {
  const c = chainCfg(chainKey);
  if (c.kind !== 'evm-v2v3') throw new Error(`routing for '${c.kind}' handled by its own executor`);
  return evmRoutes(pub, c, c.quote.address, token, quoteIn);
}
export async function bestSellRoute(pub, token, tokensIn, chainKey = 'bsc') {
  const c = chainCfg(chainKey);
  if (c.kind !== 'evm-v2v3') throw new Error(`routing for '${c.kind}' handled by its own executor`);
  return evmRoutes(pub, c, token, c.quote.address, tokensIn);
}

// ---- relay bridge ----
const relayIntents = new WeakMap();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && (a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b);
export async function relayQuote({ user, recipient, fromChain, toChain, fromCurrency, toCurrency, amountWei, minOutput, txs, txsGasLimit, allowUnverifiedSolOrigin = false }) {
  const calls = txs ? Object.freeze(JSON.parse(JSON.stringify(txs)).map(Object.freeze)) : undefined;
  if (!calls && !(typeof minOutput === 'bigint' ? minOutput > 0n : /^[1-9][0-9]*$/.test(String(minOutput)))) {
    throw new Error('exact-input relay quotes require a caller-derived minOutput floor (see exactInputFloor)');
  }
  const intent = Object.freeze({ user, recipient, fromChain, toChain, fromCurrency, toCurrency, amountWei: amountWei.toString(), allowUnverifiedSolOrigin: allowUnverifiedSolOrigin === true, ...(calls ? { txs: calls } : { minOutput: minOutput.toString() }) });
  const body = { user, recipient, originChainId: fromChain, destinationChainId: toChain, originCurrency: fromCurrency, destinationCurrency: toCurrency, amount: amountWei.toString(), tradeType: txs ? 'EXACT_OUTPUT' : 'EXACT_INPUT', includeProtocolData: true,
    ...(txs ? { txs, txsGasLimit: txsGasLimit ?? 800_000 } : {}) };
  const res = await fetch('https://api.relay.link/quote', { redirect: 'error', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const q = await res.json();
  if (!res.ok) throw new Error('relay quote failed: ' + JSON.stringify(q).slice(0, 160));
  validateRelayIntent(q, intent);
  const verification = await validateRelayProtocol(q, intent);
  if (verification?.verified !== true) throw new Error('Relay protocol verification did not verify the executable intent');
  relayIntents.set(q, intent);
  return q;
}

// Coordinates are retained only as durable storage addresses for existing CLI
// readers. A refreshed quote is matched to this ORIGINAL ordered semantic plan;
// its step/item indices never select a saved receipt or allocate a new operation.
function relayExecutionPlan(q, intent, verification, stepName) {
  const { expectedInput } = validateRelayEvmSteps(q, intent);
  const items = q.steps.flatMap((step, i) => step.items.map((item, j) => ({ data: item.data, key: `${stepName}:${i}:${j}` })));
  const obligations = items.map(({ data: d, key }, index) => {
    const common = { chainId: intent.fromChain, payer: intent.user.toLowerCase() };
    const semantic = index === items.length - 1
      ? { role: 'deposit', ...common, to: d.to.toLowerCase(), token: intent.fromCurrency.toLowerCase(), amountBound: expectedInput.toString(), orderId: verification.orderId.toLowerCase(), value: BigInt(d.value).toString(), calldataHash: keccak256(d.data) }
      : (() => {
        const { args } = decodeFunctionData({ abi: ERC20, data: d.data });
        return { role: 'approve', ...common, token: d.to.toLowerCase(), spender: args[0].toLowerCase(), amount: args[1].toString() };
      })();
    return { key, semantic };
  });
  return { version: 1, intent, requestId: q.steps.at(-1)?.requestId ?? q.details?.requestId, obligations };
}
const sameObligation = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function verifyRecordedRelayOperation(prior, obligation) {
  if (!sameObligation(prior.relayObligation, obligation.semantic)) throw new Error('Relay execution plan: recorded operation does not match obligation');
  if (!prior.raw || !prior.txHash || prior.txHash === 'n/a' || keccak256(prior.raw) !== prior.txHash) throw new Error('Relay execution plan: recorded operation lacks bound signed bytes');
  const tx = parseTransaction(prior.raw), s = obligation.semantic;
  if (tx.chainId !== s.chainId) throw new Error('Relay execution plan: recorded transaction chain mismatch');
  if (s.role === 'deposit') {
    if (!same(tx.to, s.to) || BigInt(tx.value ?? 0) !== BigInt(s.value) || keccak256(tx.data ?? '0x') !== s.calldataHash) throw new Error('Relay execution plan: recorded deposit mismatch');
  } else {
    const { functionName, args } = decodeFunctionData({ abi: ERC20, data: tx.data });
    if (!same(tx.to, s.token) || BigInt(tx.value ?? 0) !== 0n || functionName !== 'approve' || !same(args[0], s.spender) || args[1].toString() !== s.amount) throw new Error('Relay execution plan: recorded approval mismatch');
  }
}
export async function executeRelaySteps(q, wallet, pub, state, stepName, options = {}) {
  const intent = relayIntents.get(q);
  if (!intent || pub.chain.id !== intent.fromChain || !same(wallet.account.address, intent.user)) throw new Error('Relay quote is not bound to this caller original intent');
  // Verify and execute one local snapshot: the caller can still hold the quote
  // while protocol decoding or an earlier approval waits asynchronously.
  q = structuredClone(q);
  validateRelayIntent(q, intent);
  const verification = await validateRelayProtocol(q, intent);
  if (verification?.verified !== true) throw new Error('Relay protocol verification did not verify the executable intent');
  state.lockWallet(wallet.account.address, [pub.chain.id]);
  const current = relayExecutionPlan(q, intent, verification, stepName), planKey = `${stepName}:plan`;
  const savedSteps = state.load().steps;
  let plan = savedSteps[planKey]?.plan;
  if (!plan) {
    if (Object.keys(savedSteps).some(key => key.startsWith(`${stepName}:`))) throw new Error('Relay execution plan missing for legacy state; reconcile manually before retrying');
    plan = current;
    state.mark(planKey, { plan }); // Persist ALL obligations before any preparation or signature.
  }
  if (plan.version !== 1 || !Array.isArray(plan.obligations) || plan.obligations.length < 1 || plan.obligations.length > 2
      || plan.obligations.at(-1)?.semantic?.role !== 'deposit'
      || (plan.obligations.length === 2 && plan.obligations[0]?.semantic?.role !== 'approve')
      || !sameObligation(plan.intent, current.intent)) throw new Error('Relay execution plan does not match original intent');
  const planKeys = new Set(plan.obligations.map(o => o.key));
  if (planKeys.size !== plan.obligations.length || plan.obligations.some(o => !o.key?.startsWith(`${stepName}:`) || o.key === planKey)
      || Object.keys(savedSteps).some(key => key.startsWith(`${stepName}:`) && key !== planKey && !planKeys.has(key))) throw new Error('Relay execution plan has untracked operations');

  // Resolve every durable operation, including deposits that have moved or
  // disappeared in refreshed provider steps, before preparing anything new.
  const completed = new Set();
  for (const obligation of plan.obligations) {
    const prior = savedSteps[obligation.key];
    if (!prior) continue;
    if (prior.raw || prior.txHash || prior.confirmed || prior.skipped) {
      verifyRecordedRelayOperation(prior, obligation);
      // Preserve maximum-debit enforcement during recovery as well.
      await safeExecuteTransaction(pub, wallet, state, obligation.key, {}, options);
      completed.add(obligation.key);
    } else if (!sameObligation(prior.relayObligation, obligation.semantic)) throw new Error('Relay execution plan: unfinished operation does not match obligation');
  }
  if (completed.size === plan.obligations.length) return plan.requestId;

  const matches = current.obligations.map(candidate => plan.obligations.find(original => sameObligation(original.semantic, candidate.semantic)));
  if (matches.some(match => !match) || plan.obligations.some(original => !completed.has(original.key) && !matches.includes(original))) throw new Error('Relay execution plan does not match unfinished obligations');
  const omittedApproval = plan.obligations.find(o => o.semantic.role === 'approve' && !matches.includes(o));
  const transactions = q.steps.flatMap(step => step.items.map(item => item.data));
  for (const [index, obligation] of matches.entries()) {
    if (completed.has(obligation.key)) continue;
    const d = transactions[index];
    const beforeSign = async () => {
      if (obligation.semantic.role === 'deposit' && omittedApproval) {
        const a = omittedApproval.semantic;
        const allowance = await pub.readContract({ address: a.token, abi: ERC20, functionName: 'allowance', args: [intent.user, a.spender] });
        if (BigInt(allowance) < BigInt(a.amount)) throw new Error('Relay execution plan: omitted approval allowance is insufficient');
      }
      // Recheck the deadline after every RPC wait, including allowance reads.
      const rechecked = await validateRelayProtocol(q, intent);
      if (rechecked?.verified !== true) throw new Error('Relay protocol verification failed before signing');
    };
    state.mark(obligation.key, { relayObligation: obligation.semantic, intent: { to: d.to, value: d.value } });
    await safeExecuteTransaction(pub, wallet, state, obligation.key, { to: d.to, data: d.data,
      value: BigInt(d.value), gas: d.gas ? (BigInt(d.gas) * 15n) / 10n : undefined }, { ...options, beforeSign });
  }
  return plan.requestId;
}
export async function waitArrival(pub, address, token, beforeBal, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 4000));
    const bal = token
      ? await pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [address] })
      : await pub.getBalance({ address });
    if (bal > beforeBal) return bal - beforeBal;
  }
  throw new Error('bridge arrival timeout (funds may still land; re-run to resume)');
}
export const waitBscArrival = waitArrival; // legacy alias

// ---- gas keeper: keep enough native for a couple of swaps ----
export async function nativeUsd(pub, chainKey = 'bsc') {
  const c = chainCfg(chainKey);
  const out = await pub.readContract({ address: c.v2Router, abi: V2_ROUTER, functionName: 'getAmountsOut', args: [parseEther('1'), [c.wnative, c.quote.address]] });
  return Number(formatUnits(out[1], c.quote.decimals));
}
export const bnbUsd = (pub) => nativeUsd(pub, 'bsc'); // legacy alias

// ---- independent exact-input floors ----
// The floor an EXACT_INPUT bridge must clear, derived from OUR input notional
// and an INDEPENDENT reference price (1 for stable<->stable) — never from the
// relay quote, whose every field a hostile responder controls. pctBps covers
// proportional legs (measured 0.4-1.4%/leg, §E4), fixedUsd covers relay's
// fixed fee + destination gas prepay on small orders. Refuses orders too
// small to bound rather than passing an unbounded one.
export function exactInputFloor({ usdIn, outUsdPrice = 1, outDecimals = 18, pctBps = 300, fixedUsd = 0.9 }) {
  if (!Number.isFinite(usdIn) || !Number.isFinite(outUsdPrice) || !(usdIn > 0) || !(outUsdPrice > 0)) throw new Error('exact-input floor needs a finite positive input notional and independent reference price');
  // Integer micro-USD end to end so equal inputs always yield equal floors.
  const floorMicroUsd = Math.floor((Math.round(usdIn * 1e6) * (10_000 - pctBps)) / 10_000) - Math.round(fixedUsd * 1e6);
  const micro = BigInt(Math.floor(floorMicroUsd / outUsdPrice));
  if (!(micro > 0n)) throw new Error(`order too small to bound minimum receive independently ($${usdIn.toFixed(2)} in; raise the amount)`);
  return outDecimals >= 6 ? micro * 10n ** BigInt(outDecimals - 6) : micro / 10n ** BigInt(6 - outDecimals);
}
// Independent ETH/USD for the RH lanes (RH has no local USD venue): read
// Pancake v2 on BSC through WBNB. A hostile relay cannot influence this.
const ETH_BSC = '0x2170Ed0880ac9A755fd29B2688956BD959F933F8';
export async function ethUsdBsc(pub) {
  const c = chainCfg('bsc');
  const out = await pub.readContract({ address: c.v2Router, abi: V2_ROUTER, functionName: 'getAmountsOut', args: [parseEther('1'), [ETH_BSC, c.wnative, c.quote.address]] });
  return Number(formatUnits(out[out.length - 1], c.quote.decimals));
}
export async function ensureGas(account, arcW, arcP, destP, state, chainKey = 'bsc') {
  const c = chainCfg(chainKey);
  const price = await nativeUsd(destP, chainKey);
  const bal = await destP.getBalance({ address: account.address });
  const balUsd = Number(formatEther(bal)) * price;
  if (balUsd >= SETTINGS.gasFloorUsd) return { topped: false, balUsd };
  if (state.done('gas-bridge:0:0')) { await reconcileOrderStep(arcP, state, 'gas-bridge:0:0'); return { topped: true, balUsd }; }
  const q = await relayQuote({ user: account.address, recipient: account.address, fromChain: HOME.relayId, toChain: c.relayId,
    fromCurrency: '0x0000000000000000000000000000000000000000', toCurrency: '0x0000000000000000000000000000000000000000',
    amountWei: parseEther(String(SETTINGS.gasTopupUsd)),
    // floor priced by the destination venue's own quote (`price` above), not the relay
    minOutput: exactInputFloor({ usdIn: SETTINGS.gasTopupUsd, outUsdPrice: price, outDecimals: 18 }) });
  const before = await destP.getBalance({ address: account.address });
  await executeRelaySteps(q, arcW, arcP, state, 'gas-bridge');
  await waitArrival(destP, account.address, null, before);
  return { topped: true, balUsd };
}
