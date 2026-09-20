// Relay protocol.v2 verification, shared by server and CLI. Canonical chain
// IDs/depository/router are pinned from https://api.relay.link/chains (2026-09-19),
// independently of quote responses. See https://docs.relay.link/references/api/api_core_concepts/input-validation.
import { decodeFunctionData, encodeFunctionData, parseAbi, zeroAddress } from 'viem';
import { verifyArcConversionExecutor } from './relay-arc-conversion.mjs';
const CHAIN_IDS = { 5042: 'arc', 56: 'bnb', 4663: 'robinhood', 8453: 'base', 792703809: 'solana' };
const VM_TYPES = { arc: 'ethereum-vm', bnb: 'ethereum-vm', robinhood: 'ethereum-vm', base: 'ethereum-vm', solana: 'solana-vm' };
export const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
export const RELAY_ROUTER = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const DEPOSIT_ABI = parseAbi(['function depositErc20(address depositor,address token,bytes32 id)', 'function depositNative(address depositor, bytes32 id)', 'function depositErc20(address depositor,address token,uint256 amount,bytes32 id)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && (a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b);
const assert = (condition, message) => { if (!condition) throw new Error(`Relay protocol: ${message}`); };
const num = value => { assert(typeof value === 'string' && /^[0-9]{1,78}$/.test(value), 'invalid integer'); return BigInt(value); };

const APPROVE_ABI = parseAbi(['function approve(address spender,uint256 amount)']);
function decodeCanonical(abi, data) {
  const decoded = decodeFunctionData({ abi, data });
  assert(same(data, encodeFunctionData({ abi, functionName: decoded.functionName, args: decoded.args })), 'noncanonical calldata');
  return decoded;
}

export function validateRelayEvmSteps(q, intent) {
  assert(Array.isArray(q.steps) && q.steps.length > 0 && q.steps.every(s => s.kind === 'transaction' && Array.isArray(s.items) && s.items.length > 0), 'unsupported transaction sequence');
  const transactions = q.steps.flatMap(s => s.items.map(item => item.data));
  assert(transactions.length === 1 || transactions.length === 2, 'unsupported transaction sequence');
  const tx = transactions.at(-1);
  assert(tx && tx.chainId === intent.fromChain && same(tx.from, intent.user), 'transaction chain/payer mismatch');
  assert(/^0x(?:[\da-f]{2})*$/i.test(tx.data), 'invalid calldata');
  const expectedInput = intent.txs ? num(q.details?.currencyIn?.amount) : BigInt(intent.amountWei);
  const native = same(intent.fromCurrency, zeroAddress);
  assert(num(tx.value) === (native ? expectedInput : 0n), 'transaction exact input value mismatch');
  assert(num(q.details?.currencyIn?.amount) === expectedInput, 'quoted input amount mismatch');
  const assets = [intent.fromCurrency, intent.toCurrency, '0x3600000000000000000000000000000000000000'];
  assert(!assets.some(asset => same(tx.to, asset)), 'transaction destination is an asset');
  assert(same(tx.to, RELAY_ROUTER) || same(tx.to, RELAY_DEPOSITORY), 'unsupported transaction destination');
  if (tx.gas !== undefined) assert(num(tx.gas) > 0n && num(tx.gas) <= 5_000_000n, 'gas estimate out of bounds');
  if (transactions.length === 2) {
    const approval = transactions[0];
    assert(!native && approval && same(approval.to, intent.fromCurrency) && same(approval.from, intent.user) && approval.chainId === intent.fromChain && num(approval.value) === 0n, 'invalid approval transaction');
    let decoded;
    try { decoded = decodeCanonical(APPROVE_ABI, approval.data); } catch { assert(false, 'unsupported approval calldata'); }
    // approve replaces the allowance; a smaller amount cannot fund the exact
    // deposit that follows, even when a larger allowance existed beforehand.
    assert(same(decoded.args[0], tx.to) && decoded.args[1] > 0n && decoded.args[1] === expectedInput, 'approval spender/amount mismatch');
    if (approval.gas !== undefined) assert(num(approval.gas) > 0n && num(approval.gas) <= 5_000_000n, 'approval gas estimate out of bounds');
  }
  return { tx, expectedInput, native };
}

// Shared intent validation for browser stock-zap and CLI rail. EVM step
// validation pins the destination to the canonical router/depository, which
// is stricter than an independently maintained known-asset destination denylist.
export function validateRelayIntent(q, intent) {
  if (!q || JSON.stringify(q).toLowerCase().includes('lifiintents')) throw new Error('Relay quoted unsupported lifiIntents');
  const uint = value => typeof value === 'string' && /^[0-9]{1,78}$/.test(value);
  const details = q.details, cin = details?.currencyIn, cout = details?.currencyOut;
  if (!same(details?.sender, intent.user) || !same(details?.recipient, intent.recipient)
      || cin?.currency?.chainId !== intent.fromChain || cout?.currency?.chainId !== intent.toChain
      || !same(cin?.currency?.address, intent.fromCurrency) || !same(cout?.currency?.address, intent.toCurrency)
      || !uint(cin?.amount) || !uint(cout?.amount)
      || BigInt(intent.txs ? cout.amount : cin.amount) !== BigInt(intent.amountWei)) throw new Error('Relay quote does not match original assets, amount, chain or recipient');
  if (!intent.txs) {
    // Exact-input floors must come from the CALLER (independent price or
    // stable parity), never from the quote: a hostile relay controls every
    // number in its own response, including currencyOut.minimumAmount.
    if (intent.minOutput === undefined) throw new Error('Relay exact-input intent requires a caller-derived minOutput floor');
    const minOutput = BigInt(intent.minOutput);
    if (!(minOutput > 0n) || !uint(cout.minimumAmount) || BigInt(cout.minimumAmount) < minOutput) throw new Error('Relay quoted minimum receive below the caller minOutput floor');
  }
  if (intent.fromChain === 792703809) return;
  validateRelayEvmSteps(q, intent);
}

export async function validateRelayProtocol(q, intent) {
  const origin = CHAIN_IDS[intent.fromChain], destination = CHAIN_IDS[intent.toChain];
  assert(origin && destination, 'unsupported origin/destination protocol chain');
  const solana = origin === 'solana';
  const expectedInput = intent.txs ? num(q.details?.currencyIn?.amount) : BigInt(intent.amountWei);
  assert(expectedInput > 0n, 'nonpositive input');
  const tx = solana ? undefined : validateRelayEvmSteps(q, intent).tx;
  const v2 = q.protocol?.v2;
  if (!v2) {
    assert(!Object.hasOwn(q.protocol ?? {}, 'v2'), 'malformed protocol.v2');
    assert(solana && intent.allowUnverifiedSolOrigin === true, 'missing protocol.v2; unverified quote refused');
    const { validateRelaySolInstructions } = await import('./relay-solana.mjs');
    validateRelaySolInstructions(q, intent);
    console.warn('WARNING: Relay Solana origin lacks protocol.v2; only constrained deposit instructions verified. Destination fulfillment retains executor/provider trust (allowUnverifiedSolOrigin:true).');
    return { verified: true, protocolVerified: false, verification: 'solana-instructions' };
  }
  const order = v2.orderData, payment = order?.inputs?.[0]?.payment;
  assert(order?.version === 'v1' && order.inputs.length === 1 && payment, 'unsupported protocol order schema');
  // Arc native USDC has 18 decimals; its ERC20 representation has 6.
  // Only the decoded, pinned conversion route below can use this denomination.
  const converted = origin === 'arc' && same(intent.fromCurrency, zeroAddress) && same(payment.currency, ARC_USDC);
  // 18dp native wei floors to the 6dp view; since 2026-09 relay prices its
  // service fee into the native input, so the wei amount carries sub-1e12 dust
  // and the credited 6dp payment sits below the floor by that fee. The binding
  // invariants are the pinned router and that no order leg can credit more
  // than the native value the transaction actually pays.
  const quotedInput = converted ? expectedInput / 1_000_000_000_000n : expectedInput;
  const paymentAmount = num(payment.amount);
  assert(!converted || same(tx.to, RELAY_ROUTER), 'unpinned Arc USDC conversion route');
  assert(payment.chainId === origin && same(payment.currency, converted ? ARC_USDC : intent.fromCurrency), 'order input payment mismatch');
  if (converted) {
    const conversion = q.details?.route?.origin?.outputCurrency;
    assert(conversion?.currency?.chainId === intent.fromChain && same(conversion.currency.address, ARC_USDC)
      && num(conversion.amount) <= quotedInput, 'conversion quote asset/amount mismatch');
    const minimum = num(conversion.minimumAmount);
    assert(minimum > 0n && minimum <= paymentAmount && paymentAmount <= num(conversion.amount), 'conversion input payment outside declared range');
  } else assert(paymentAmount === quotedInput, 'order input payment mismatch');
  assert(order.output?.chainId === destination && order.output.payments?.length === 1, 'output chain/payment count mismatch');
  const output = order.output.payments[0];
  // Never fall back to the quote's own minimumAmount: it is attacker-controlled.
  assert(intent.txs || intent.minOutput !== undefined, 'exact-input intent missing caller minOutput floor');
  const minOutput = intent.txs ? BigInt(intent.amountWei) : BigInt(intent.minOutput);
  // Since 2026-09 relay pays a calls-carrying order's output to its own router,
  // which then executes the committed destination calls; the user's delivery is
  // bound by the call commitments verified below plus the destination refund.
  // Orders without destination calls must still pay the user directly.
  const routerReceives = (intent.txs?.length ?? 0) > 0 && same(output.recipient, RELAY_ROUTER);
  assert(minOutput > 0n && (same(output.recipient, intent.recipient) || routerReceives) && same(output.currency, intent.toCurrency) && num(output.minimumAmount) >= minOutput, 'output recipient/currency/minimum mismatch');
  assert(Number.isSafeInteger(order.output.deadline) && order.output.deadline > Math.floor(Date.now()/1000), 'order expired');
  assert(Array.isArray(order.inputs[0].refunds) && order.inputs[0].refunds.length > 0 && order.inputs[0].refunds.length <= 2, 'unsupported refunds');
  const refundChains = new Set();
  for (const refund of order.inputs[0].refunds) {
    const expectedRecipient = refund.chainId === origin ? intent.user : refund.chainId === destination ? intent.recipient : null;
    assert(expectedRecipient && same(refund.recipient, expectedRecipient), 'refund recipient mismatch');
    assert(!refundChains.has(refund.chainId), 'duplicate refund chain'); refundChains.add(refund.chainId);
    assert(same(refund.currency, refund.chainId === origin ? payment.currency : intent.toCurrency), 'refund currency mismatch');
    assert(Number.isSafeInteger(refund.deadline) && refund.deadline >= order.output.deadline, 'refund deadline mismatch');
    num(refund.minimumAmount);
    validateExtraData(refund.extraData, refund.chainId);
  }
  validateExtraData(order.output.extraData, destination);
  assert(Array.isArray(order.fees) && order.fees.length === 0, 'unsupported protocol fees');
  assert(num(output.expectedAmount) >= num(output.minimumAmount), 'invalid output amount');
  if (q.details?.currencyOut?.amount !== undefined) assert(num(output.expectedAmount) === num(q.details.currencyOut.amount), 'output expected amount mismatch');
  if (q.details?.currencyOut?.minimumAmount !== undefined) assert(num(output.minimumAmount) >= num(q.details.currencyOut.minimumAmount), 'output minimum amount mismatch');
  const { getOrderId, encodeOrderCall } = await import('@relay-protocol/settlement-sdk');
  const calls = intent.txs ?? [];
  assert(Array.isArray(order.output.calls) && order.output.calls.length === calls.length, 'destination call count mismatch');
  if (calls.length) assert(VM_TYPES[destination] === 'ethereum-vm', 'unsupported destination calls');
  for (let i=0; i<calls.length; i++) {
    const encoded = encodeOrderCall({ vmType: 'ethereum-vm', call: { to: calls[i].to, data: calls[i].data, value: String(calls[i].value ?? 0) } });
    assert(same(order.output.calls[i], encoded), 'destination call commitment mismatch');
  }
  const orderId = getOrderId(order, VM_TYPES);
  assert(same(orderId, v2.orderId), 'order hash mismatch');
  const claim = v2.paymentDetails;
  const depository = solana ? '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2' : RELAY_DEPOSITORY;
  assert(claim && claim.chainId === origin && same(claim.depository, depository) && same(claim.currency, payment.currency) && num(claim.amount) === paymentAmount, 'claimed depository/payment mismatch');
  if (solana) {
    const { validateRelaySolInstructions } = await import('./relay-solana.mjs');
    validateRelaySolInstructions(q, intent, orderId);
  } else if (same(tx.to, RELAY_ROUTER)) {
    verifyRouter(tx, intent, payment, orderId, expectedInput, converted);
  } else {
    verifyDeposit(tx.data, intent.user, payment.currency, paymentAmount, orderId, num(tx.value));
  }
  return { verified: true, protocolVerified: true, orderId };
}

function validateExtraData(data, chain) {
  assert(data === '0x' || (VM_TYPES[chain] === 'ethereum-vm' && same(data, '0x' + '0'.repeat(24) + RELAY_ROUTER.slice(2))), 'unsupported routing extraData');
}
function verifyDeposit(data, payer, currency, amount, orderId, value, allBalance = false, conversionMaximum, cleanupAmount) {
  const decoded = decodeCanonical(DEPOSIT_ABI, data);
  assert(same(decoded.args[0], payer) && same(decoded.args.at(-1), orderId), 'deposit payer/order commitment mismatch');
  const native = same(currency, zeroAddress);
  assert(decoded.functionName === (native ? 'depositNative' : 'depositErc20'), 'deposit function/payment currency mismatch');
  assert(value === (native ? amount : 0n), 'deposit value mismatch');
  if (!native) {
    assert(same(decoded.args[1], currency), 'ERC20 deposit currency mismatch');
    assert(decoded.args.length === 4
      ? conversionMaximum === undefined ? decoded.args[2] === amount : decoded.args[2] > 0n && decoded.args[2] <= conversionMaximum
      : allBalance, 'ERC20 deposit payment mismatch');
    // Cleanup replaces the depository allowance. A nonzero explicit allowance
    // must exactly fund the explicit deposit, without leaving arbitrary residue.
    // Zero uses the converted full balance; the actual balance can still cause
    // the transaction to revert, without weakening the caller's economic bounds.
    if (conversionMaximum !== undefined && decoded.args.length === 4) {
      assert(allBalance || cleanupAmount === decoded.args[2], 'cleanup/deposit amount mismatch');
    }
  }
}

// RelayRouterV3 verified source: src/v3/RelayRouterV3.sol at the pinned
// deployment (see docs/RELAY-VERIFICATION.md). This is not the settlement SDK's
// withdrawal multicall ABI, which has a different tuple layout and selector.
export const RELAY_ROUTER_ABI = parseAbi([
  'function multicall((address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata) payable',
  'function cleanupErc20sViaCall(address[] tokens,address[] tos,bytes[] datas,uint256[] amounts)',
]);
const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const KYBER_ABI = parseAbi([
  'function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns (uint256 returnAmount,uint256 gasUsed)',
]);
function verifyRouter(tx, intent, payment, orderId, expectedInput, converted) {
  assert(intent.fromChain === 5042, 'unsupported router chain');
  let decoded;
  try { decoded = decodeFunctionData({ abi: RELAY_ROUTER_ABI, data: tx.data }); }
  catch { assert(false, 'unsupported router calldata'); }
  assert(decoded.functionName === 'multicall', 'unsupported router entry point');
  const canonical = encodeFunctionData({abi:RELAY_ROUTER_ABI,functionName:decoded.functionName,args:decoded.args});
  // Relay appends its order ID as an attribution suffix. Accept exactly that
  // suffix or no suffix; never ignore arbitrary trailing calldata.
  assert(same(tx.data,canonical) || same(tx.data,canonical + orderId.slice(2)), 'noncanonical router calldata');
  const [calls, refundTo, nftRecipient, metadata] = decoded.args;
  assert((same(refundTo, zeroAddress) || same(refundTo, intent.user)) && same(nftRecipient, zeroAddress), 'router refund/recipient mismatch');
  assert(metadata.length <= 514, 'unsupported router metadata');
  assert(calls.length === (converted ? 2 : 1) && calls.every(c => c.allowFailure === false), 'unsupported nested call sequence');
  assert(calls.reduce((sum,c)=>sum+c.value,0n) === num(tx.value), 'nested transaction value mismatch');
  const deposit = calls.at(-1), amount = num(payment.amount);
  if (converted) {
    const maximum = expectedInput / 1_000_000_000_000n;
    assert(same(deposit.target, RELAY_ROUTER) && deposit.value === 0n, 'unsupported nested deposit wrapper');
    const cleanup = decodeCanonical(RELAY_ROUTER_ABI, deposit.callData);
    assert(cleanup.functionName === 'cleanupErc20sViaCall', 'unsupported nested deposit wrapper');
    const [tokens, targets, datas, amounts] = cleanup.args;
    assert([tokens,targets,datas,amounts].every(a=>a.length === 1)
      && same(tokens[0], payment.currency) && same(targets[0], RELAY_DEPOSITORY)
      && amounts[0] <= maximum, 'nested deposit asset/target/amount mismatch');
    verifyDeposit(datas[0], intent.user, payment.currency, amount, orderId, 0n, amounts[0] === 0n, maximum, amounts[0]);
    const swap = calls[0];
    assert(same(swap.target, KYBER_ROUTER) && swap.value === expectedInput, 'unsupported conversion target/value');
    const execution = decodeCanonical(KYBER_ABI, swap.callData).args[0], desc = execution.desc;
    assert(same(desc.srcToken, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') && same(desc.dstToken, ARC_USDC)
      && same(desc.dstReceiver, RELAY_ROUTER) && desc.amount === expectedInput
      && desc.srcReceivers.length === 0 && desc.srcAmounts.length === 0 && desc.feeReceivers.length === 0 && desc.feeAmounts.length === 0
      && desc.permit === '0x' && desc.flags === 512n && same(execution.approveTarget,zeroAddress), 'unsupported conversion shape');
    // Conversion deposits use the full resulting balance, so exact input
    // binding is impossible by construction. The caller is instead bound by
    // (a) exact native max spend, (b) ONLY the allowlisted conversion + canonical
    // deposit/order, (c) the committed output >= caller minimum, and (d) refunds
    // to the user. The declared input range is Relay's conversion slippage;
    // it cannot authorize extra spend or settlement below the output minimum.
    // Direct deposit paths retain exact binding. Never admit opaque executable
    // payloads merely because the outer aggregator target is pinned.
    assert(desc.minReturnAmount > 0n && desc.minReturnAmount <= maximum, 'invalid conversion minimum');
    verifyArcConversionExecutor(execution, expectedInput);
    return;
  }
  assert(same(deposit.target, RELAY_DEPOSITORY), 'nested deposit must target canonical depository');
  verifyDeposit(deposit.callData, intent.user, payment.currency, amount, orderId, deposit.value);
}
