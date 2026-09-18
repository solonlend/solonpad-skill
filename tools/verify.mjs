// verify.mjs — runs the scriptable checks of VERIFY.md against Arc mainnet.
// Read-only: no keys, no transactions. Exit 0 = all green, 1 = any red.
//   cd tools && npm i && node verify.mjs [--factsheet 0xToken]
import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbi } from 'viem';
import { readFileSync } from 'node:fs';

const A = JSON.parse(readFileSync(new URL('../addresses.json', import.meta.url)));
const client = createPublicClient({ transport: http(A.chain.rpc) });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? ' OK ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// 1. chain id
const chainId = await client.getChainId();
check('chainId is 5042', chainId === 5042, `got ${chainId}`);

// 2. factory wired to canonical v4
const factoryPm = await client.readContract({ address: A.solonpad.launchFactory, abi: parseAbi(['function poolManager() view returns (address)']), functionName: 'poolManager' });
check('factory.poolManager == canonical', factoryPm.toLowerCase() === A.uniswapV4Canonical.poolManager.toLowerCase(), factoryPm);

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

// 9. instant v4 strategy constants
const stratAbi = parseAbi(['function LP_FEE() view returns (uint24)', 'function TICK_SPACING() view returns (int24)', 'function TOTAL_SUPPLY() view returns (uint256)', 'function feeSplitter() view returns (address)']);
const V = A.instantV4;
const [lpFee, spacing, supply, splitter] = await Promise.all(['LP_FEE', 'TICK_SPACING', 'TOTAL_SUPPLY', 'feeSplitter'].map(fn => client.readContract({ address: V.instantLaunchStrategy, abi: stratAbi, functionName: fn })));
check('instant v4 strategy constants', Number(lpFee) === 10000 && Number(spacing) === 100 && supply === 10n ** 27n && splitter.toLowerCase() === V.feeSplitter.toLowerCase(), `lpFee ${lpFee}, spacing ${spacing}, splitter ${splitter}`);

// Factsheet spot-check (optional): --factsheet 0xToken
const tokenArg = process.argv[process.argv.indexOf('--factsheet') + 1];
if (process.argv.includes('--factsheet') && tokenArg?.startsWith('0x')) {
  const base = (A.aggregator?.readApi?.factsheet ?? '').split('/api/')[0] || 'https://solonpad.fun';
  const res = await fetch(`${base}/api/factsheet/${tokenArg}?chain=arc`, { headers: { 'user-agent': 'solonpad-skill-verify/0.4' } });
  if (!res.ok) check('factsheet reachable', false, `HTTP ${res.status}`);
  else {
    const fs = await res.json();
    const tip = await client.getBlockNumber();
    check('factsheet asof fresh (<=100 blocks)', tip - BigInt(fs.asof.block) <= 100n, `asof ${fs.asof.block}, tip ${tip}`);
    const k = fs.identity.poolKey;
    if (k) {
      const poolId = keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
        [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
      const slot0 = await client.readContract({ address: A.uniswapV4Canonical.stateView, abi: parseAbi(['function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']), functionName: 'getSlot0', args: [poolId] });
      check('factsheet pool exists on-chain', slot0[0] > 0n, `sqrtPriceX96 ${slot0[0]}`);
    }
  }
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks green${failed ? ` — ${failed} FAILED: do not move value` : ' — safe to proceed'}`);
process.exit(failed ? 1 : 0);
