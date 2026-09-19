// rh-venue.mjs — Robinhood-chain execution lane for the rail.
// Eats our own dogfood: pool discovery and dd come from the SolonPad
// aggregator's public APIs, execution goes through the on-chain
// SolonFeeRouter (0.5% on the quote leg, live since aggregation v1).
// RH quirk that makes life easy: the quote asset IS the gas asset (ETH),
// so bridged funds are self-gassing — no separate gas keeper leg.
import { parseAbi, keccak256, encodeAbiParameters, encodeFunctionData, zeroAddress } from 'viem';
import { readFileSync } from 'node:fs';
import { chainCfg } from './rail-lib.mjs';

export const RH_FEE_ROUTER = parseAbi([
  'function curveBuy(address curve, address quote, uint256 quoteIn, uint256 minTokensOut) payable returns (uint256)',
  'function curveSell(address curve, address token, address quote, uint256 tokensIn, uint256 minQuoteOut) returns (uint256)',
  'function v4Swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint256 amountIn, uint256 minOut, bool feeOnOutput) payable returns (uint256)',
]);

// Our own launches on RH use the fixed native-line pool parameters.
const SOLONPAD_RH_KEY = (token) => ({ currency0: zeroAddress, currency1: token, fee: 10000, tickSpacing: 100, hooks: zeroAddress });

export const poolKeyId = (k) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

const verifiedLaunches = new WeakSet();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const CURVE_IDENTITY = parseAbi(['function token() view returns (address)', 'function pairToken() view returns (address)', 'function factory() view returns (address)']);
const FACTORY_IDENTITY = parseAbi(['function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))']);
const STATE_VIEW = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)']);

/** Bind untrusted discovery to original caller intent before approval or bridge.
 * V4 currencies are part of the executable PoolKey, not server metadata. Its
 * PoolManager has no token() getter: read the initialized pool via trusted
 * StateView using that exact key. Curve token/quote addresses come directly
 * from eth_call. V2's launchedTokens mapping is private; getLaunchedToken is
 * its public accessor (src/v2/PonsV2LaunchFactory.sol), NOT an API assertion. */
export async function rhVerifyLaunch(pub, launch, requestedToken, chainKey = 'rh') {
  const config = JSON.parse(readFileSync(new URL(`../../web/lib/addresses.${chainKey}.json`, import.meta.url), 'utf8'));
  if (!same(launch.token, requestedToken) || !same(launch.pairToken, zeroAddress) || !launch.nativeQuoted) throw new Error('launch token/quote identity mismatch');
  const checked = { ...launch, poolKey: launch.poolKey ? Object.freeze({ ...launch.poolKey }) : null };
  if (launch.mode === 'curve' && !launch.graduated) {
    if (!config.factory || same(config.factory, zeroAddress)) throw new Error('curve provenance unavailable: no trusted factory for chain');
    const record = await pub.readContract({ address: config.factory, abi: FACTORY_IDENTITY, functionName: 'getLaunchedToken', args: [requestedToken] });
    if (!record.exists || !same(record.token, requestedToken) || !same(record.curve, launch.curve) || !same(record.pairToken, zeroAddress)) throw new Error('curve factory provenance/identity mismatch');
    for (const [functionName, expected] of [['token', requestedToken], ['pairToken', zeroAddress], ['factory', config.factory]]) {
      const actual = await pub.readContract({ address: launch.curve, abi: CURVE_IDENTITY, functionName });
      if (!same(actual, expected)) throw new Error(`curve on-chain ${functionName} identity mismatch`);
    }
  } else {
    if (!checked.poolKey || !same(checked.poolKey.currency0, zeroAddress) || !same(checked.poolKey.currency1, requestedToken)) throw new Error('pool currency identity mismatch');
    const slot = await pub.readContract({ address: config.stateView, abi: STATE_VIEW, functionName: 'getSlot0', args: [poolKeyId(checked.poolKey)] });
    if (BigInt(slot[0]) === 0n) throw new Error('pool identity not initialized on-chain');
  }
  Object.freeze(checked); verifiedLaunches.add(checked); return checked;
}
function requireVerified(launch) {
  if (!verifiedLaunches.has(launch)) throw new Error('launch identity must be verified on-chain before construction');
}

/** Launch facts from our aggregator's list API; the poolKey is verified
 * locally against the poolId for consistency only. rhVerifyLaunch supplies
 * the independent on-chain and caller-intent checks. Due diligence rides the factsheet's tradeable verdict. */
export async function rhLaunch(token, chainKey = 'rh') {
  const api = chainCfg(chainKey).api;
  const rows = await fetch(`${api}/api/launches?chain=${chainKey}`, { redirect: 'error' }).then(r => r.json()).then(d => d.rows ?? []).catch(() => []);
  const r = rows.find(x => x.token?.toLowerCase() === token.toLowerCase());
  if (!r) return null;
  let poolKey = r.poolKey ?? null;
  if (!poolKey && r.source === 'solonpad' && r.mode === 'v4') poolKey = SOLONPAD_RH_KEY(token);
  if (poolKey && r.poolId && poolKeyId(poolKey).toLowerCase() !== r.poolId.toLowerCase()) {
    throw new Error(`poolKey failed keccak check against poolId — refusing (endpoint data untrusted by design)`);
  }
  return {
    token, source: r.source, mode: r.mode, graduated: !!r.graduated,
    curve: r.curve && r.curve !== zeroAddress ? r.curve : null,
    poolKey, pairToken: r.pairToken && r.pairToken !== zeroAddress ? r.pairToken : zeroAddress,
    nativeQuoted: !r.pairToken || r.pairToken === zeroAddress,
    liquidity: Number(r.liquidity ?? r.raised ?? 0), volume24h: Number(r.volume24h ?? 0),
  };
}

/** Aggregator-side dd: the factsheet already computes a tradeable verdict with
 * reasons; flags carry the structural warnings. */
export async function rhDueDiligence(token, chainKey = 'rh') {
  const api = chainCfg(chainKey).api;
  const f = await fetch(`${api}/api/factsheet/${token}?chain=${chainKey}`, { redirect: 'error' }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!f) return { ok: false, reason: 'factsheet unavailable (fails closed; --force to override)', fields: {} };
  const flags = Array.isArray(f.flags) ? f.flags : [];
  let ok = f.tradeable?.value === true;
  let reason = ok ? '' : (f.tradeable?.reason || 'not tradeable');
  // Curve launches have no indexed spot, which the factsheet's site-oriented
  // tradeable verdict treats as blocking. On-chain execution does not need a
  // spot for a CURVE venue: the pre-send eth_call simulation is the real
  // tradability check. Pool venues keep the refusal — their interface pricing
  // depends on the indexed spot, so the downgrade is strictly curve-scoped.
  const isCurve = Array.isArray(f.identity?.notApplicable) && f.identity.notApplicable.includes('poolKey');
  if (!ok && isCurve && /spot estimate unavailable/i.test(reason)) { ok = true; flags.unshift('no-indexed-spot (curve; priced by simulation)'); reason = ''; }
  return { ok, reason, fields: { flags: flags.slice(0, 5), source: 'solonpad-factsheet' } };
}

/** Build the FeeRouter call for an ETH-quoted buy. Curve launches route
 * through curveBuy; pooled ones through v4Swap (hooked or not). */
export function rhBuildBuy(launch, ethIn, minOut, feeRouter) {
  requireVerified(launch);
  if (!launch.nativeQuoted) throw new Error('non-native-quoted RH pool: unsupported in rail v1 (needs the quote asset in hand)');
  if (launch.mode === 'curve' && !launch.graduated) {
    if (!launch.curve) throw new Error('curve launch without curve address');
    return { to: feeRouter, value: ethIn,
      data: encodeFunctionData({ abi: RH_FEE_ROUTER, functionName: 'curveBuy', args: [launch.curve, zeroAddress, ethIn, minOut] }) };
  }
  if (!launch.poolKey) throw new Error('pooled launch without a verifiable poolKey');
  // native is currency0 on every native-quoted v4 pool: buying is zeroForOne.
  return { to: feeRouter, value: ethIn,
    data: encodeFunctionData({ abi: RH_FEE_ROUTER, functionName: 'v4Swap', args: [launch.poolKey, true, ethIn, minOut, false] }) };
}

export function rhBuildSell(launch, tokensIn, minOut, feeRouter) {
  requireVerified(launch);
  if (!launch.nativeQuoted) throw new Error('non-native-quoted RH pool: unsupported in rail v1');
  if (launch.mode === 'curve' && !launch.graduated) {
    return { to: feeRouter, value: 0n,
      data: encodeFunctionData({ abi: RH_FEE_ROUTER, functionName: 'curveSell', args: [launch.curve, launch.token, zeroAddress, tokensIn, minOut] }) };
  }
  if (!launch.poolKey) throw new Error('pooled launch without a verifiable poolKey');
  return { to: feeRouter, value: 0n,
    data: encodeFunctionData({ abi: RH_FEE_ROUTER, functionName: 'v4Swap', args: [launch.poolKey, false, tokensIn, minOut, true] }) };
}
