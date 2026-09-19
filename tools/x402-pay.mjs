#!/usr/bin/env node
// One caller-pinned authorization; caller owns RAIL_PK. Never auto-retry a payment.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const X402_PRICES = createRequire(import.meta.url)('./x402-prices.json');

// The standalone skill has its own viem dependency; root checkouts use web's.
// Resolve first so errors while loading an installed package are never hidden.
let requireViem = createRequire(import.meta.url);
try { requireViem.resolve('viem'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  requireViem = createRequire(new URL('../../web/package.json', import.meta.url));
}
const { createPublicClient, getTypesForEIP712Domain, hashDomain, http, isAddress, parseAbi, zeroAddress } = requireViem('viem');
const { privateKeyToAccount } = requireViem('viem/accounts');

const ASSET = '0x3600000000000000000000000000000000000000';
const NETWORKS = {
  'eip155:5042': { chainId: 5042, rpc: 'https://rpc.mainnet.arc.io' },
  'eip155:5042002': { chainId: 5042002, rpc: 'https://rpc.testnet.arc.network' },
};
const ABI = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
]);
const TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };

/** A single challenge/sign/retry attempt. Returned settlement state is the server's, not a claim of finality. */
export async function payPremium({ url, privateKey, expectedSeller,
  method = 'GET', body = /** @type {any} */ (undefined), expectedAmount = X402_PRICES.verdict,
  network = process.env.X402_NETWORK || 'eip155:5042', rpcUrl = process.env.X402_RPC_URL,
  fetchImpl = fetch, publicClient = /** @type {any} */ (undefined), now = () => Math.floor(Date.now() / 1000),
}) {
  const config = NETWORKS[network];
  if (!config) throw new Error('Unsupported X402_NETWORK; use eip155:5042 or eip155:5042002 network');
  if (typeof privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('RAIL_PK must contain a valid caller private key');
  let account;
  try { account = privateKeyToAccount(privateKey); }
  catch { throw new Error('RAIL_PK must contain a valid caller private key'); }
  if (typeof expectedSeller !== 'string' || !isAddress(expectedSeller, { strict: false }) || expectedSeller.toLowerCase() === zeroAddress) {
    throw new Error('Pin the expected seller with X402_PAY_TO');
  }
  let target;
  try { target = new URL(url); } catch { throw new Error('Invalid endpoint URL'); }
  if (target.username || target.password || target.hash || !(target.protocol === 'https:'
    || (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))) {
    throw new Error('Endpoint URL must use HTTPS (HTTP allowed only on localhost), without credentials or fragments');
  }
  if (!['GET', 'POST'].includes(method)) throw new Error('Unsupported method; use GET or POST');
  if (typeof expectedAmount !== 'string' || !/^[1-9][0-9]*$/.test(expectedAmount)
    || BigInt(expectedAmount) >= 2n ** 256n) throw new Error('Pin expectedAmount as a positive uint256 atomic amount string');
  if (method === 'GET' && body !== undefined) throw new Error('GET requests cannot include a body');
  let serializedBody;
  if (method === 'POST') {
    try {
      serializedBody = typeof body === 'string' ? body : JSON.stringify(body);
      JSON.parse(serializedBody);
    } catch { throw new Error('POST body must be valid JSON'); }
  }
  const requestHeaders = serializedBody === undefined ? {} : { 'Content-Type': 'application/json' };
  const challengeResponse = await fetchImpl(url, { method, body: serializedBody, headers: requestHeaders, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (challengeResponse.status !== 402) throw new Error(`Expected payment challenge HTTP 402; received ${challengeResponse.status}`);
  const challenge = await challengeResponse.json();
  const accepted = challenge?.accepts?.[0];
  if (challenge?.x402Version !== 2 || challenge?.resource?.url !== url || !accepted
    || accepted.scheme !== 'exact' || accepted.network !== network || accepted.asset?.toLowerCase() !== ASSET
    || accepted.amount !== expectedAmount || accepted.payTo?.toLowerCase() !== expectedSeller?.toLowerCase()
    || accepted.maxTimeoutSeconds !== 12 || accepted.extra?.name !== 'USDC'
    || accepted.extra?.version !== '2' || accepted.extra?.assetTransferMethod !== 'eip3009') {
    throw new Error('Unexpected payment requirements; no payment signed');
  }
  const client = publicClient || createPublicClient({ transport: http(rpcUrl || config.rpc, { timeout: 10000, retryCount: 0 }) });
  const [chainId, name, version, separator] = await Promise.all([
    client.getChainId(),
    ...['name', 'version', 'DOMAIN_SEPARATOR'].map(functionName => client.readContract({ address: ASSET, abi: ABI, functionName })),
  ]);
  const domain = { name, version, chainId, verifyingContract: ASSET };
  if (chainId !== config.chainId || name !== 'USDC' || version !== '2'
    || typeof separator !== 'string'
    || separator.toLowerCase() !== hashDomain({ domain, types: { EIP712Domain: getTypesForEIP712Domain({ domain }) } }).toLowerCase()) {
    throw new Error('RPC chain or USDC EIP-712 domain mismatch; no payment signed');
  }
  const timestamp = now();
  const authorization = {
    from: account.address, to: expectedSeller, value: expectedAmount,
    // The 12-second maxTimeoutSeconds is settlement wait, not authorization TTL.
    // Two minutes leaves room for verification and settlement; server caps TTL at 300s.
    validAfter: String(timestamp - 1), validBefore: String(timestamp + 120),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const signature = await account.signTypedData({ domain, types: TYPES, primaryType: 'TransferWithAuthorization', message: authorization });
  const payment = { x402Version: 2, resource: challenge.resource, accepted, payload: { signature, authorization } };
  // Outlast the entire authorization window, including verification, bounded
  // cold data work and settlement; never abandon while the server can charge.
  const paid = await fetchImpl(url, { method, body: serializedBody, redirect: 'error', signal: AbortSignal.timeout(130000),
    headers: { ...requestHeaders, 'X-PAYMENT': Buffer.from(JSON.stringify(payment)).toString('base64') },
  });
  if (!paid.ok) {
    const body = await paid.json().catch(() => undefined);
    // Preserve reconciliation identifiers and instructions in both library errors
    // and the CLI's stderr. Never silently retry an authorization or re-sign.
    throw Object.assign(new Error(`Payment request returned HTTP ${paid.status}; not automatically retried${body === undefined ? '' : `\n${JSON.stringify(body, null, 2)}`}`),
      { status: paid.status, body });
  }
  return paid.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  if (!url || process.argv.length !== 3) {
    console.error('Usage: node skill/tools/x402-pay.mjs <premium-url>\nRequired env: RAIL_PK, X402_PAY_TO. Optional: X402_NETWORK, X402_RPC_URL, X402_METHOD (GET|POST), X402_BODY (JSON), X402_EXPECTED_AMOUNT (atomic USDC, default 10000).');
    process.exitCode = 1;
  } else {
    payPremium({ url, privateKey: process.env.RAIL_PK, expectedSeller: process.env.X402_PAY_TO,
      method: process.env.X402_METHOD || 'GET', body: process.env.X402_BODY,
      expectedAmount: process.env.X402_EXPECTED_AMOUNT ?? X402_PRICES.verdict,
    })
      .then(receipt => console.log(JSON.stringify(receipt, null, 2)))
      .catch(error => { console.error(`x402 payment: ${error.message}`); process.exitCode = 1; });
  }
}
