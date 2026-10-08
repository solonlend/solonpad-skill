// verify.mjs — runs the scriptable checks of VERIFY.md against Arc mainnet (legacy, V3.0 and V3.1).
// Read-only: no keys, no transactions, no SolonPad API — chain reads only.
// Exit 0 = all green, 1 = any red.
//   cd tools && npm i && node verify.mjs      (ARC_RPC / RH_RPC override the public RPCs)
import { createPublicClient, http, parseAbi, keccak256, encodeAbiParameters } from 'viem';
import { readFileSync } from 'node:fs';

const A = JSON.parse(readFileSync(new URL('../addresses.json', import.meta.url)));
const client = createPublicClient({ transport: http(process.env.ARC_RPC || A.chain.rpc, { retryCount: 5, retryDelay: 400 }) });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? ' OK ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// 1. chain id
const chainId = await client.getChainId();
check('chainId is 5042', chainId === 5042, `got ${chainId}`);

// 2. factory wired to canonical v4
const factoryPm = await client.readContract({ address: A.solonpad.launchFactory, abi: parseAbi(['function poolManager() view returns (address)']), functionName: 'poolManager' });
check('factory.poolManager == canonical', eq(factoryPm, A.uniswapV4Canonical.poolManager), factoryPm);

// 3. locker: has code, ABI has no unlock/withdraw/execute surface
const lockerCode = await client.getCode({ address: A.solonpad.launchLocker });
const lockerAbi = JSON.parse(readFileSync(new URL('../abis/PonsV2LaunchLocker.json', import.meta.url)));
const lockerFns = (lockerAbi.abi ?? lockerAbi).filter(x => x.type === 'function').map(x => x.name.toLowerCase());
const forbidden = ['withdraw', 'unlock', 'execute', 'sweep', 'rescue'].filter(f => lockerFns.some(n => n.includes(f)));
check('locker deployed + one-way ABI', !!lockerCode && lockerCode !== '0x' && forbidden.length === 0, forbidden.length ? 'forbidden fns: ' + forbidden : `${lockerFns.length} fns`);

// 4. hook fee sanity (caps are constructor constants in source — see provenance;
// here we assert the live values sit inside the documented bounds)
const hookAbi = parseAbi(['function hookFeeBps() view returns (uint16)', 'function protocolFeeShareBps() view returns (uint16)']);
const [fee, share] = await Promise.all(['hookFeeBps', 'protocolFeeShareBps'].map(fn => client.readContract({ address: A.solonpad.memeHook, abi: hookAbi, functionName: fn })));
check('hook fee within documented bounds', fee <= 1000 && share <= 10000, `hookFeeBps ${fee} (<=1000), protocolShare ${share} (<=10000)`);

// 5. escrow pull-only ABI shape
const escrowAbi = JSON.parse(readFileSync(new URL('../abis/PonsV2FeeEscrow.json', import.meta.url)));
const escrowFns = (escrowAbi.abi ?? escrowAbi).filter(x => x.type === 'function').map(x => x.name.toLowerCase());
const escrowBad = escrowFns.filter(n => ['sweep', 'rescue', 'withdrawto', 'settreasury'].some(f => n.includes(f)));
check('escrow pull-only ABI', escrowBad.length === 0, escrowBad.length ? 'suspicious: ' + escrowBad : `${escrowFns.length} fns`);

// 6. live economics
const econAbi = parseAbi(['function launchFee() view returns (uint256)', 'function launchEnabled() view returns (bool)']);
const [launchFee, enabled] = await Promise.all([
  client.readContract({ address: A.solonpad.launchFactory, abi: econAbi, functionName: 'launchFee' }),
  client.readContract({ address: A.solonpad.launchFactory, abi: econAbi, functionName: 'launchEnabled' }),
]);
check('economics readable', typeof enabled === 'boolean', `launchFee ${launchFee} wei-USDC, enabled ${enabled}`);

// 9. instant v4 strategy constants (native USDC instance)
const stratAbi = parseAbi(['function LP_FEE() view returns (uint24)', 'function TICK_SPACING() view returns (int24)', 'function TOTAL_SUPPLY() view returns (uint256)', 'function feeSplitter() view returns (address)', 'function initialTick() view returns (int24)', 'function quoteToken() view returns (address)']);
const V = A.instantV4;
const readStrat = (address, fns) => Promise.all(fns.map(fn => client.readContract({ address, abi: stratAbi, functionName: fn })));
const [lpFee, spacing, supply, splitter, tick0] = await readStrat(V.instantLaunchStrategy, ['LP_FEE', 'TICK_SPACING', 'TOTAL_SUPPLY', 'feeSplitter', 'initialTick']);
check('instant v4 strategy constants', Number(lpFee) === 10000 && Number(spacing) === 100 && supply === 10n ** 27n && eq(splitter, V.feeSplitter) && Number(tick0) === V.economics.initialTick,
  `lpFee ${lpFee}, spacing ${spacing}, tick ${tick0}, splitter ${splitter}`);

// 9b. every ERC-20 quote instance (stocks / memes) matches addresses.json
for (const [sym, q] of Object.entries(V.quoteInstances ?? {}).filter(([k]) => !k.startsWith('_'))) {
  const [qLpFee, qSpacing, qSupply, qSplitter, qTick, qQuote] = await readStrat(q.strategy, ['LP_FEE', 'TICK_SPACING', 'TOTAL_SUPPLY', 'feeSplitter', 'initialTick', 'quoteToken']);
  check(`quote instance ${sym}`, Number(qLpFee) === 10000 && Number(qSpacing) === 100 && qSupply === 10n ** 27n && eq(qSplitter, q.splitter) && eq(qQuote, q.quote) && Number(qTick) === q.initialTick,
    `quote ${qQuote}, tick ${qTick}`);
}

// §G staking: token wiring, roles, full backing
const S = A.staking;
const stakeAbi = parseAbi(['function solon() view returns (address)', 'function owner() view returns (address)', 'function distributor() view returns (address)', 'function totalStaked() view returns (uint256)', 'function rewardReserve() view returns (uint256)', 'function paused() view returns (bool)', 'function stakeCap() view returns (uint256)']);
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const [solon, owner, distributor, totalStaked, rewardReserve, paused, stakeCap] = await Promise.all(
  ['solon', 'owner', 'distributor', 'totalStaked', 'rewardReserve', 'paused', 'stakeCap'].map(fn => client.readContract({ address: S.solonStaking, abi: stakeAbi, functionName: fn })));
check('§G1 staking token == SOLON', eq(solon, S.stakingToken) && eq(solon, V.flagship.token), solon);
check('§G2 staking owner/distributor match addresses.json', eq(owner, S.owner) && eq(distributor, S.distributor), `owner ${owner}, distributor ${distributor}`);
const held = await client.readContract({ address: S.stakingToken, abi: erc20, functionName: 'balanceOf', args: [S.solonStaking] });
check('§G3 staking fully backed', held >= totalStaked + rewardReserve, `balance ${held / 10n ** 18n} >= staked ${totalStaked / 10n ** 18n} + reserve ${rewardReserve / 10n ** 18n} SOLON`);
console.log(`info  §G4 paused ${paused}, cap headroom ${(stakeCap - totalStaked) / 10n ** 18n} SOLON (check against your amount)`);

// ---- V3 (stock-dividend launchpad, live since 2026-10-03) — VERIFY.md §V3 ----
const V3 = A.v3;
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const arc = createPublicClient({ transport: http(process.env.ARC_RPC || A.chain.rpc, { retryCount: 6, retryDelay: 1500 }) });
const rh = createPublicClient({ transport: http(process.env.RH_RPC || V3.robinhood.rpc, { retryCount: 6, retryDelay: 1500 }) });

// V3-1. every deployed contract's runtime code equals the pinned codehash (Sourcify-verified builds)
const names = Object.keys(V3.contractsByDeployName);
const badCode = [];
for (const k of names) {
  const code = await arc.getCode({ address: V3.contractsByDeployName[k] });
  if (!code || keccak256(code) !== V3.codehashes[k]) badCode.push(k);
  await pause(150);
}
check('V3 runtime codehashes match the pin', badCode.length === 0, badCode.length ? 'mismatch: ' + badCode.join(', ') : `${names.length}/${names.length} contracts`);

// V3-2. six-way split: a pinned lot's FeeCredited allocation and the pool's registered beneficiaries
const L = V3.launch.V3FeeLedger;
const lotBlock = 23992449n; // SMOKE lot 1: 0.1 USDC fee
const feeLogs = await arc.getLogs({ address: L, fromBlock: lotBlock, toBlock: lotBlock,
  event: parseAbi(['event FeeCredited(bytes32 indexed poolId, uint256 indexed lotId, address indexed quote, uint256 amount, uint256[6] allocated)'])[0] });
const lot = feeLogs[0]?.args;
const bps = V3.constants.feeSplitBps.map(BigInt);
const splitOk = !!lot && lot.allocated.every((x, i) => x * 10000n === lot.amount * bps[i]);
check('V3 fee split = [5750,1000,1000,500,1000,750] on a real lot', splitOk, lot ? `amount ${lot.amount}, allocated ${lot.allocated.join('/')}` : 'pinned FeeCredited log not found');
if (lot) {
  const info = await arc.readContract({ address: L, abi: parseAbi(['function poolInfo(bytes32) view returns ((address quote, uint8 settlementKind, address hook, address[6] beneficiaries))']), functionName: 'poolInfo', args: [lot.poolId] });
  const B = V3.feeBeneficiaries;
  const want = [lot.poolId && (await arc.readContract({ address: V3.launch.V3LaunchFactory, abi: parseAbi(['function launches(bytes32) view returns (address,bytes32,uint256,int24,int24,int24,uint128,uint256,uint8,bytes32)']), functionName: 'launches', args: [lot.poolId] }))[0], B['1_creator'], B['2_desk'], B['3_staking'], B['4_buybackBurn'], B['5_protocol']];
  const benOk = want.every((w, i) => info.beneficiaries[i].toLowerCase() === w.toLowerCase())
    && info.hook.toLowerCase() === V3.launch.V3QuoteFeeHook.toLowerCase();
  check('V3 pool beneficiaries = coin/creatorNFT/desk/staking/buyback/protocol', benOk, info.beneficiaries.join(','));
}

// V3-3. governance: 48h timelock, 3/5 proposer, guardian, bootstrap closed, ownership wired
const G = V3.governance;
const govAbi = parseAbi(['function getMinDelay() view returns (uint256)', 'function hasRole(bytes32,address) view returns (bool)', 'function bootstrapClosed() view returns (bool)']);
const safeAbi = parseAbi(['function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])']);
const PROPOSER = keccak256(new TextEncoder().encode('PROPOSER_ROLE'));
const GUARDIAN = keccak256(new TextEncoder().encode('GUARDIAN_ROLE'));
const [delay, proposer, closed, thr, owners, gthr, gowners, grole] = [
  await arc.readContract({ address: G.V3Governance, abi: govAbi, functionName: 'getMinDelay' }),
  await arc.readContract({ address: G.V3Governance, abi: govAbi, functionName: 'hasRole', args: [PROPOSER, G.multisig] }),
  await arc.readContract({ address: G.V3Governance, abi: govAbi, functionName: 'bootstrapClosed' }),
  await arc.readContract({ address: G.multisig, abi: safeAbi, functionName: 'getThreshold' }),
  await arc.readContract({ address: G.multisig, abi: safeAbi, functionName: 'getOwners' }),
  await arc.readContract({ address: G.guardian, abi: safeAbi, functionName: 'getThreshold' }),
  await arc.readContract({ address: G.guardian, abi: safeAbi, functionName: 'getOwners' }),
  await arc.readContract({ address: G.V3Governance, abi: govAbi, functionName: 'hasRole', args: [GUARDIAN, G.guardian] }),
];
check('V3 timelock >= 48h, multisig 3/5 proposer, guardian 2/3, bootstrap closed', delay >= 172800n && proposer && closed && thr === 3n && owners.length === 5 && grole && gthr === 2n && gowners.length === 3,
  `minDelay ${delay}s, proposer ${proposer}, multisig ${thr}/${owners.length}, guardian ${gthr}/${gowners.length} role ${grole}, bootstrapClosed ${closed}`);
const hubOwner = await arc.readContract({ address: V3.stockLayer.SolonStockHub, abi: parseAbi(['function owner() view returns (address)']), functionName: 'owner' });
const deskGov = await arc.readContract({ address: V3.desk.DeskNFT, abi: parseAbi(['function governance() view returns (address)']), functionName: 'governance' });
check('V3 hub owner and Desk governance = V3Governance', hubOwner.toLowerCase() === G.V3Governance.toLowerCase() && deskGov.toLowerCase() === G.V3Governance.toLowerCase(), `hub.owner ${hubOwner}, desk.governance ${deskGov}`);

// V3-4. proof of reserves: Arc STOCK.sol supply == hub.supplyOf(rh) <= RH ReserveVault balance
const erc = parseAbi(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
for (const [ticker, s] of Object.entries(V3.stockLayer.stocks).filter(([k]) => !k.startsWith('_'))) {
  const supply = await arc.readContract({ address: s.arc, abi: erc, functionName: 'totalSupply' });
  const hubSupply = await arc.readContract({ address: V3.stockLayer.SolonStockHub, abi: parseAbi(['function supplyOf(address) view returns (uint256)']), functionName: 'supplyOf', args: [s.rh] });
  const held = await rh.readContract({ address: s.rh, abi: erc, functionName: 'balanceOf', args: [V3.robinhood.ReserveVault] });
  check(`V3 reserve ${ticker}: RH vault >= Arc supply`, held >= supply, `arc ${supply}, hub ${hubSupply}, rh vault ${held}`);
}

// ---- V3.1 (hookless launch stack, serving new launches since 2026-10-07) — VERIFY.md §V31 ----
const V31 = A.v31;
const C31 = V31.contracts;
const W = V31.wiring;
const abi31 = (n) => JSON.parse(readFileSync(new URL(`../abis/v31/${n}.json`, import.meta.url)));
const read31 = async (name, fns) => {
  const out = {};
  for (const fn of fns) { out[fn] = await arc.readContract({ address: C31[name], abi: abi31(name), functionName: fn }); await pause(60); }
  return out;
};
const same = (got, want) => Object.entries(want).filter(([k, v]) => !eq(got[k], v)).map(([k, v]) => `${k} ${got[k]} != ${v}`);

// V31-1. runtime codehashes of the eight V3.1 contracts equal the pin (55297b7 build)
const names31 = Object.keys(C31).filter((k) => !k.startsWith('_'));
const bad31 = [];
for (const k of names31) {
  const code = await arc.getCode({ address: C31[k] });
  if (!code || keccak256(code) !== V31.codehashes[k]) bad31.push(k);
  await pause(150);
}
check('V3.1 runtime codehashes match the pin', bad31.length === 0, bad31.length ? 'mismatch: ' + bad31.join(', ') : `${names31.length}/${names31.length} contracts`);

// V31-2. factory: immutables and pool constants
const K = V31.constants;
const f = await read31('V31LaunchFactory', ['poolManager', 'positionManager', 'governance', 'payoutChoice', 'holders', 'stockQuote', 'launchOracle', 'stockStatus', 'splitter', 'LP_FEE', 'TICK_SPACING', 'INITIAL_TICK', 'LOWER_TICK', 'UPPER_TICK', 'launchesPaused']);
const fBad = [...same(f, { poolManager: W.poolManager, positionManager: W.positionManager, governance: W.governance, payoutChoice: W.payoutChoice,
  holders: C31.V31HolderRewards, stockQuote: W.stockQuote, launchOracle: C31.V31LaunchOracle, stockStatus: W.stockStatus, splitter: C31.V31FeeSplitter }),
  ...(Number(f.LP_FEE) === K.lpFee && Number(f.TICK_SPACING) === K.tickSpacing && Number(f.INITIAL_TICK) === K.initialTick
    && Number(f.LOWER_TICK) === K.usdcRange[0] && Number(f.UPPER_TICK) === K.usdcRange[1] ? [] : [`pool constants ${f.LP_FEE}/${f.TICK_SPACING}/${f.INITIAL_TICK}/${f.LOWER_TICK}/${f.UPPER_TICK}`])];
check('V3.1 factory wiring + pool constants (fee 10000, spacing 100, tick 123800, range -160100..123800, no hook)', fBad.length === 0,
  fBad.length ? fBad.join('; ') : `9 immutables, launchesPaused ${f.launchesPaused}`);

// V31-3. fee splitter: the six destinations and custody wiring
const s = await read31('V31FeeSplitter', ['positionManager', 'desk', 'staking', 'buyback', 'protocol', 'treasury', 'holders', 'stockAsset', 'factory', 'creatorRights']);
const sBad = same(s, { positionManager: W.positionManager, desk: W.desk, staking: C31.V31StakingEscrow, buyback: C31.V31BuybackExecutor, protocol: W.protocolVault,
  treasury: W.treasury, holders: C31.V31HolderRewards, stockAsset: W.stockQuote, factory: C31.V31LaunchFactory, creatorRights: C31.V31CreatorRightsNFT });
check('V3.1 splitter destinations = HolderRewards/DeskRewards/StakingEscrow/BuybackExecutor/ProtocolVault (+ multisig for coin-side fees)', sBad.length === 0, sBad.length ? sBad.join('; ') : '10 immutables');

// V31-4. the other six contracts point at each other and at the V3.0 pieces they reuse
const h = await read31('V31HolderRewards', ['rounds', 'schedule', 'stockAsset', 'poolManager', 'positionManager', 'treasury', 'factory', 'splitter']);
const n = await read31('V31CreatorRightsNFT', ['splitter', 'nativeUsdcView']);
const e = await read31('V31StakingEscrow', ['governance', 'distributor', 'frozen']);
const b = await read31('V31BuybackExecutor', ['governance', 'solon', 'feeRouter', 'burnSink', 'stock', 'poolManager']);
const o = await read31('V31LaunchOracle', ['governance', 'asset', 'anchorOracle', 'poolManager', 'source', 'freshnessWindow', 'paused']);
const fd = await read31('V31StockOracleFeed', ['oracle', 'asset']);
const satBad = [
  ...same(h, { rounds: W.rewardRoundManager, schedule: W.rewardAssetSchedule, stockAsset: W.stockQuote, poolManager: W.poolManager, positionManager: W.positionManager,
    treasury: W.treasury, factory: C31.V31LaunchFactory, splitter: C31.V31FeeSplitter }).map((x) => 'holders.' + x),
  ...same(n, { splitter: C31.V31FeeSplitter, nativeUsdcView: W.nativeUsdcView }).map((x) => 'rights.' + x),
  ...same(e, { governance: W.governance }).map((x) => 'escrow.' + x),
  ...same(b, { governance: W.governance, solon: W.solon, feeRouter: W.feeRouter, burnSink: W.burnSink, stock: W.stockQuote, poolManager: W.poolManager }).map((x) => 'buyback.' + x),
  ...same(o, { governance: W.governance, asset: W.stockQuote, anchorOracle: W.anchorOracle, poolManager: W.poolManager }).map((x) => 'oracle.' + x),
  ...same(fd, { oracle: W.anchorOracle, asset: W.stockQuote }).map((x) => 'feed.' + x),
  ...(Number(o.freshnessWindow) <= K.launchOracleFreshnessSeconds ? [] : [`oracle.freshnessWindow ${o.freshnessWindow} > ${K.launchOracleFreshnessSeconds}`]),
];
check('V3.1 holder rewards / rights NFT / escrow / buyback / launch oracle / feed wiring', satBad.length === 0, satBad.length ? satBad.join('; ')
  : `${[h, n, e, b, o, fd].reduce((x, r) => x + Object.keys(r).length, 0)} reads; escrow distributor ${e.distributor}, frozen ${e.frozen}; oracle source ${o.source}, paused ${o.paused}`);

// V31-5. the shared holder source is registered once with the V3.0 RewardRoundManager
const sp = await arc.readContract({ address: W.rewardRoundManager, abi: parseAbi(['function sourcePool(address) view returns (bytes32)']), functionName: 'sourcePool', args: [C31.V31HolderRewards] });
const spWant = keccak256(new TextEncoder().encode('SOLON_V31_HOLDERS'));
check('V3.1 RewardRoundManager.sourcePool(V31HolderRewards) = keccak256("SOLON_V31_HOLDERS")', sp === spWant && sp === V31.governance.rewardSourcePoolId, sp);

// V31-6. guardian: exactly the five tighten-only selectors, never resume/designate
const gaAbi = parseAbi(['function guardianAction(address,bytes4) view returns (bool)']);
const target = (k) => C31[k.split('.')[0]];
const gaBad = [];
for (const [want, set] of [[true, V31.governance.guardianActions], [false, V31.governance.notGuardian]]) {
  for (const [k, sel] of Object.entries(set).filter(([x]) => !x.startsWith('_'))) {
    const got = await arc.readContract({ address: G.V3Governance, abi: gaAbi, functionName: 'guardianAction', args: [target(k), sel] });
    if (got !== want) gaBad.push(`${k} ${got}`);
    await pause(60);
  }
}
check('V3.1 guardian allow-list: 5 tighten-only selectors on, resume/designate off', gaBad.length === 0, gaBad.length ? gaBad.join('; ') : '5 on, 3 off');

// V31-6b. the reissue distributor (deployed 2026-10-08): its six immutables point at the live stack. Whether it is
// designated yet is reported by V31-4 (escrow distributor) — 0x0 until the 48h designate batch executes.
const ri = await read31('V31StakingReissue', ['governance', 'escrow', 'rounds', 'staking', 'schedule', 'stockAsset']);
const riBad = same(ri, { governance: W.governance, escrow: C31.V31StakingEscrow, rounds: W.rewardRoundManager, staking: W.solonStakingV2, schedule: W.rewardAssetSchedule, stockAsset: W.stockQuote });
check('V31StakingReissue immutables = Governance / StakingEscrow / RewardRoundManager / SolonStakingV2 / RewardAssetSchedule / NVDA.sol', riBad.length === 0, riBad.length ? riBad.join('; ') : '6 immutables');

// V31-7. every V3.1 coin so far: its LP position is held by the splitter, the token is a factory V31Token with no owner
const rights = abi31('V31CreatorRightsNFT');
const nextId = await arc.readContract({ address: C31.V31CreatorRightsNFT, abi: rights, functionName: 'nextTokenId' });
const coinBad = [];
const tokAbi = abi31('V31Token');
const ids = []; for (let i = nextId - 1n; i >= 1n && ids.length < 25; i--) ids.push(i); // newest 25
for (const id of ids) {
  const poolId = await arc.readContract({ address: C31.V31CreatorRightsNFT, abi: rights, functionName: 'poolOf', args: [id] });
  const coin = await arc.readContract({ address: C31.V31LaunchFactory, abi: abi31('V31LaunchFactory'), functionName: 'tokenOfPool', args: [poolId] });
  const l = await arc.readContract({ address: C31.V31FeeSplitter, abi: abi31('V31FeeSplitter'), functionName: 'launchOf', args: [poolId] });
  const lpOwner = await arc.readContract({ address: W.positionManager, abi: parseAbi(['function ownerOf(uint256) view returns (address)']), functionName: 'ownerOf', args: [l.positionId] });
  const [lf, own, dec] = await Promise.all(['launchFactory', 'owner', 'decimals'].map((fn) => arc.readContract({ address: coin, abi: tokAbi, functionName: fn })));
  if (!eq(l.token, coin) || !eq(lpOwner, C31.V31FeeSplitter) || !eq(lf, C31.V31LaunchFactory) || !eq(own, '0x0000000000000000000000000000000000000000') || Number(dec) !== 18
    || Number(l.key.fee) !== K.lpFee || Number(l.key.tickSpacing) !== K.tickSpacing || !eq(l.key.hooks, '0x0000000000000000000000000000000000000000')) coinBad.push(coin);
  await pause(100);
}
check('V3.1 coins: LP NFT held by the splitter, hookless 1% key, factory token with owner() = 0', coinBad.length === 0,
  coinBad.length ? 'bad: ' + coinBad.join(', ') : `${ids.length} coin(s) checked (${nextId - 1n} launched)`);

// info: can a kind-1 (NVDA.sol-paired) launch price right now?
try {
  const [tick, price18] = await arc.readContract({ address: C31.V31LaunchFactory, abi: abi31('V31LaunchFactory'), functionName: 'stockLaunchTick' });
  console.log(`info  V3.1 kind-1 launch possible now: tick ${tick}, NVDA.sol $${Number(price18) / 1e18}`);
} catch (err) {
  console.log(`info  V3.1 kind-1 launch not possible now: stockLaunchTick() reverts ${err.cause?.data?.errorName ?? err.shortMessage}${err.cause?.data?.args ? '(' + err.cause.data.args.join(',') + ')' : ''} (USDC launches unaffected)`);
}

// ---- §LEND (SolonLend on canonical Morpho, live since 2026-10-08) — VERIFY.md §LEND ----
const LE = A.lend;
const M = LE.ourMarket;

// LEND-1. our one contract: oracle codehash == pin, wired to the V3 stock anchor, price() == peek × 1e6
const oracleCode = await arc.getCode({ address: LE.oracle.SolonLendOracle });
const lendOracleAbi = parseAbi(['function source() view returns (address)', 'function asset() view returns (address)', 'function price() view returns (uint256)']);
const [oSrc, oAsset, oPrice] = await Promise.all(['source', 'asset', 'price'].map(fn => arc.readContract({ address: LE.oracle.SolonLendOracle, abi: lendOracleAbi, functionName: fn })));
const [peek18] = await arc.readContract({ address: LE.oracle.source, abi: parseAbi(['function peek(address) view returns (uint128, uint64)']), functionName: 'peek', args: [M.collateralToken] });
check('§LEND-1 oracle: codehash pinned, source = SolonStockOracle, asset = NVDA.sol, price = peek × 1e6 > 0',
  !!oracleCode && keccak256(oracleCode) === LE.oracle.codehash && eq(oSrc, LE.oracle.source) && eq(oAsset, M.collateralToken) && oPrice > 0n && oPrice === peek18 * 10n ** 6n,
  `price $${Number(oPrice) / 1e24}`);

// LEND-2. the market id recomputes from the five params and reads back identically from the singleton
const lendParams = { loanToken: M.loanToken, collateralToken: M.collateralToken, oracle: M.oracle, irm: M.irm, lltv: BigInt(M.lltv) };
const lendId = keccak256(encodeAbiParameters([{ components: [
  { name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' },
  { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' }], type: 'tuple' }], [lendParams]));
const onchainParams = await arc.readContract({ address: LE.morpho, abi: parseAbi(['function idToMarketParams(bytes32) view returns (address, address, address, address, uint256)']), functionName: 'idToMarketParams', args: [lendId] });
check('§LEND-2 market id recomputes and the singleton returns the documented params (LLTV 62.5%)',
  lendId === M.id && eq(onchainParams[0], M.loanToken) && eq(onchainParams[1], M.collateralToken) && eq(onchainParams[2], M.oracle) && eq(onchainParams[3], M.irm) && onchainParams[4] === BigInt(M.lltv),
  lendId);

// LEND-3. vault + adapter provenance: both are instances registered by Morpho's own factories
const lendSalt = keccak256(new TextEncoder().encode(LE.vault.salt));
const vaultFromFactory = await arc.readContract({ address: LE.vaultV2Factory, abi: parseAbi(['function vaultV2(address, address, bytes32) view returns (address)']), functionName: 'vaultV2', args: [LE.vault.owner, LE.loanToken, lendSalt] });
const adapterFromFactory = await arc.readContract({ address: LE.adapterFactory, abi: parseAbi(['function morphoMarketV1AdapterV2(address) view returns (address)']), functionName: 'morphoMarketV1AdapterV2', args: [LE.vault.address] });
const [adMorpho, adVault] = await Promise.all([
  arc.readContract({ address: LE.vault.adapter, abi: parseAbi(['function morpho() view returns (address)']), functionName: 'morpho' }),
  arc.readContract({ address: LE.vault.adapter, abi: parseAbi(['function parentVault() view returns (address)']), functionName: 'parentVault' }),
]);
check('§LEND-3 vault and adapter come from Morpho\'s factories and point at the singleton',
  eq(vaultFromFactory, LE.vault.address) && eq(adapterFromFactory, LE.vault.adapter) && eq(adMorpho, LE.morpho) && eq(adVault, LE.vault.address),
  `vault ${vaultFromFactory}, adapter ${adapterFromFactory}`);

// LEND-4. vault economics you will pay; roles are the documented single EOA (disclosure, not a pass/fail)
const lendVaultAbi = parseAbi(['function asset() view returns (address)', 'function performanceFee() view returns (uint256)', 'function maxRate() view returns (uint256)', 'function curator() view returns (address)', 'function owner() view returns (address)', 'function totalAssets() view returns (uint256)']);
const [vAsset, vFee, vRate, vCur, vOwn, vTot] = await Promise.all(['asset', 'performanceFee', 'maxRate', 'curator', 'owner', 'totalAssets'].map(fn => arc.readContract({ address: LE.vault.address, abi: lendVaultAbi, functionName: fn })));
check('§LEND-4 vault: asset = 0x3600 USDC view, performance fee 10%, maxRate set',
  eq(vAsset, LE.loanToken) && vFee === BigInt(LE.vault.performanceFeeWad) && vRate > 0n,
  `fee ${vFee}, maxRate ${vRate}, totalAssets ${vTot}`);
console.log(`info  §LEND vault roles: owner ${vOwn}, curator ${vCur} (single EOA by design — read lend.vault._roles before depositing)`);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks green${failed ? ` — ${failed} FAILED: do not move value` : ' — safe to proceed'}`);
process.exit(failed ? 1 : 0);
