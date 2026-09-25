// verify.mjs — runs the scriptable checks of VERIFY.md against Arc mainnet.
// Read-only: no keys, no transactions, no SolonPad API — chain reads only.
// Exit 0 = all green, 1 = any red.
//   cd tools && npm i && node verify.mjs
import { createPublicClient, http, parseAbi } from 'viem';
import { readFileSync } from 'node:fs';

const A = JSON.parse(readFileSync(new URL('../addresses.json', import.meta.url)));
const client = createPublicClient({ transport: http(A.chain.rpc, { retryCount: 5, retryDelay: 400 }) });
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

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks green${failed ? ` — ${failed} FAILED: do not move value` : ' — safe to proceed'}`);
process.exit(failed ? 1 : 0);
