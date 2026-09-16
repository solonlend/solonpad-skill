#!/usr/bin/env node
// SolonPad read-only reference reader. No keys, no transactions — public client only.
// Usage:
//   node pad-read.mjs                 list all launches with curve state
//   node pad-read.mjs 0xToken         one token, full pinned-block state
//   node pad-read.mjs 0xToken 25      + exact-output quote for a 25 USDC buy
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPublicClient, http, isAddress, formatEther, parseEther, parseAbiItem } from 'viem';

const here = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(await readFile(path.join(here, '..', 'addresses.json'), 'utf8'));
const factoryAbi = JSON.parse(await readFile(path.join(here, '..', 'abis', 'PonsV2LaunchFactory.json'), 'utf8'));
const curveAbi = JSON.parse(await readFile(path.join(here, '..', 'abis', 'PonsV2BondingCurve.json'), 'utf8'));
const tokenAbi = JSON.parse(await readFile(path.join(here, '..', 'abis', 'PonsV2LauncherToken.json'), 'utf8'));

const client = createPublicClient({ transport: http(A.chain.rpc) });
const chainId = await client.getChainId();
if (chainId !== A.chain.chainId) throw new Error(`chainId ${chainId} != ${A.chain.chainId} — wrong RPC`);
const block = await client.getBlockNumber();

const launchedEvent = parseAbiItem(
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)');

async function curveState(curve, atBlock) {
  const [reserves, real, graduated, feeBps] = await Promise.all([
    client.readContract({ address: curve, abi: curveAbi, functionName: 'getReserves', blockNumber: atBlock }),
    client.readContract({ address: curve, abi: curveAbi, functionName: 'realQuoteReserve', blockNumber: atBlock }),
    client.readContract({ address: curve, abi: curveAbi, functionName: 'graduated', blockNumber: atBlock }),
    client.readContract({ address: curve, abi: curveAbi, functionName: 'feeBps', blockNumber: atBlock }),
  ]);
  const [q, t] = reserves;
  return {
    priceUsdc: Number(q) / Number(t),
    realRaisedUsdc: Number(formatEther(real)),
    graduationPct: (Number(formatEther(real)) / A.economics.graduationTargetUsdc) * 100,
    graduated, feeBps: Number(feeBps),
    quoteReserve: formatEther(q), tokenReserve: formatEther(t),
  };
}

const [target, quoteUsd] = process.argv.slice(2);

if (!target) {
  const logs = await client.getLogs({
    address: A.solonpad.launchFactory, event: launchedEvent,
    fromBlock: BigInt(A.solonpad.deployBlock), toBlock: block,
  });
  console.log(JSON.stringify({ pinnedBlock: String(block), launches: await Promise.all(
    logs.map(async (l) => {
      const [name, symbol] = await Promise.all([
        client.readContract({ address: l.args.token, abi: tokenAbi, functionName: 'name' }),
        client.readContract({ address: l.args.token, abi: tokenAbi, functionName: 'symbol' }),
      ]);
      return { token: l.args.token, curve: l.args.curve, creator: l.args.deployer,
               name, symbol, ...(await curveState(l.args.curve, block)) };
    })) }, null, 1));
} else {
  if (!isAddress(target)) throw new Error('not an address');
  const launch = await client.readContract({
    address: A.solonpad.launchFactory, abi: factoryAbi, functionName: 'getLaunchedToken', args: [target] });
  const curve = launch.curve ?? launch[0];
  const state = await curveState(curve, block);
  const out = { pinnedBlock: String(block), token: target, curve, ...state };
  if (quoteUsd && !state.graduated) {
    const amountIn = parseEther(quoteUsd);
    const probe = '0x0000000000000000000000000000000000000001';
    const quoted = await client.readContract({
      address: curve, abi: curveAbi, functionName: 'buy',
      args: [amountIn, 0n, probe], account: probe, value: amountIn,
      stateOverride: [{ address: probe, balance: amountIn * 2n }],
    });
    out.buyQuote = { usdcIn: quoteUsd, tokensOut: formatEther(quoted),
                     note: 'exact-output eth_call at pinned block; add your own minOut' };
  }
  console.log(JSON.stringify(out, null, 1));
}
