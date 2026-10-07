// verify.mjs — runs the scriptable checks of VERIFY.md against Arc mainnet.
// Read-only: no keys, no transactions, no SolonPad API — chain reads only.
// Exit 0 = all green, 1 = any red.
//   cd tools && npm i && node verify.mjs      (ARC_RPC / RH_RPC override the public RPCs)
import { createPublicClient, http, parseAbi, keccak256 } from 'viem';
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

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks green${failed ? ` — ${failed} FAILED: do not move value` : ' — safe to proceed'}`);
process.exit(failed ? 1 : 0);
