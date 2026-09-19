import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters } from 'viem';

const EXECUTOR = '0x8f10b468b06c6fd214b65f87778827f7d113f996';
const ENTRY = '0xd7a5c6b52756e795f680b0f7e0c2f21281dde6ef';
const ROUTER = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const MODULE = '0x61f598cd00000000000000007b0e2e8300899b647d5ebc66f9d4fa3f16c54061';
const CONVERSION = '0x3e49ed2a00000000000000014963a429d5154e6c773ed81bdc219380c2064fe9';
const FEE_RECEIVER = '0x1111110f0f73c0b2ef09ec012eae758b3e03a902';
const PAYLOAD = parseAbiParameters('uint256 packed, bytes signature, bytes route');
const ROUTE = parseAbiParameters('address recipient, bytes32[] modules, (address token,uint256 flags,(uint256 amount,bytes32 selectorFlags,bytes data,address receiver)[] swaps)[] tokens, uint256 range, uint256 amounts, uint256 config, address feeReceiver, uint256 reserved, uint256 deadline, bytes extra');
const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const assert = (condition, message) => { if (!condition) throw new Error(`Relay protocol: conversion executor ${message}`); };
function decodeCanonical(abi, data) {
  const decoded = decodeAbiParameters(abi, data);
  assert(same(encodeAbiParameters(abi, decoded), data), 'noncanonical encoding');
  return decoded;
}

// Narrow, complete encoding allowlist for the captured Arc native -> 0x3600
// route. The executor address is independently published by Kyber at
// https://github.com/KyberNetwork/ks-aggregation-router/blob/main/script/config/executors.json.
// The packed ABI below was reconstructed from the original captures and fresh
// $2/$25/$10.123456 unsigned quotes; it is NOT independently published executor
// source. Names such as flags/config describe opaque numeric fields, not proven
// contract semantics. Every executable byte is pinned or bound to the exact
// input: no arbitrary bytes, module, token, recipient or additional call is
// accepted. The only unconstrained bytes are the fixed-size quote signature;
// their ABI location is fixed and cannot become another executable leg.
export function verifyArcConversionExecutor(execution, expectedInput) {
  assert(same(execution.callTarget, EXECUTOR), 'target mismatch');
  const data = execution.targetData;
  assert(typeof data === 'string' && /^0x[0-9a-f]+$/i.test(data) && same(data.slice(0, 42), ENTRY), 'entry mismatch');
  assert(expectedInput > 0n && expectedInput < (1n << 128n) && expectedInput % 1_000_000_000_000n === 0n, 'input out of bounds');
  let payload, route;
  try {
    payload = decodeCanonical(PAYLOAD, `0x${data.slice(42)}`);
    route = decodeCanonical(ROUTE, payload[2]);
  } catch {
    assert(false, 'unsupported or noncanonical encoding');
  }
  const [packed, signature] = payload;
  assert(packed === ((expectedInput << 128n) | expectedInput) && signature.length === 132, 'input/signature mismatch');
  const [recipient, modules, tokens, range, amounts, config, feeReceiver, reserved, deadline, extra] = route;
  const amount = expectedInput / 1_000_000_000_000n;
  const wholeUnits = expectedInput / 1_000_000_000_000_000_000n;
  assert(same(recipient, ROUTER) && same(feeReceiver, FEE_RECEIVER) && reserved === 0n && extra === '0x', 'recipient/auxiliary data mismatch');
  assert(modules.length === 1 && same(modules[0], MODULE), 'module mismatch');
  assert(range === (((expectedInput * 95n / 100n) << 128n) | (expectedInput * 105n / 100n))
    && amounts === ((expectedInput << 128n) | amount)
    && config === ((wholeUnits << 72n) | (1_000_000n << 24n)), 'numeric configuration mismatch');
  assert(deadline > BigInt(Math.floor(Date.now() / 1000)) && deadline <= BigInt(Number.MAX_SAFE_INTEGER), 'quote expired');
  assert(tokens.length === 2, 'token/call count mismatch');
  const [source, destination] = tokens;
  assert(same(source.token, NATIVE) && source.flags === ((wholeUnits << 128n) | amount)
    && source.swaps.length === 1 && same(destination.token, ARC_USDC)
    && destination.flags === ((1n << 255n) | (1n << 128n)) && destination.swaps.length === 0, 'asset/call shape mismatch');
  const conversion = source.swaps[0];
  assert(conversion.amount === amount && same(conversion.selectorFlags, CONVERSION)
    && same(conversion.receiver, EXECUTOR) && conversion.data === '0x', 'nested target/amount/data mismatch');
}
