// Relay Solana deposit_token layout: settlement-sdk 0.0.143 RelayDepositoryIdl.
// Program pinned independently from Relay /chains (2026-09-19). The supported
// sweep is USDC -> Arc. Unknown instructions, native deposits, extra accounts
// and token extensions require a reviewed decoder before they can be signed.
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
export const SOL_RELAY_DEPOSITORY = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
const PROGRAM = new PublicKey(SOL_RELAY_DEPOSITORY);
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM = '11111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CONFIG = PublicKey.findProgramAddressSync([Buffer.from('relay_depository')], PROGRAM)[0];
const VAULT = PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM)[0];
const ata = (owner, mint) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
const assert = (ok, message) => { if (!ok) throw new Error(`Relay Solana: ${message}`); };
export function validateRelaySolInstructions(q, intent, orderId) {
  assert(intent && intent.fromChain === 792703809 && intent.fromCurrency === USDC && !intent.txs, 'unsupported original deposit intent');
  assert(typeof intent.user === 'string', 'missing original depositor');
  const user = new PublicKey(intent.user), mint = new PublicKey(intent.fromCurrency);
  const amount = String(intent.amountWei);
  assert(/^[0-9]{1,20}$/.test(amount) && BigInt(amount) > 0n && BigInt(amount) <= 0xffffffffffffffffn, 'invalid deposit amount');
  assert(q?.details?.currencyIn?.amount === amount, 'quoted input amount mismatch');
  assert(Array.isArray(q.steps) && q.steps.length === 1 && q.steps[0].kind === 'transaction'
    && Array.isArray(q.steps[0].items) && q.steps[0].items.length === 1, 'unsupported transaction sequence');
  const data = q.steps[0].items[0].data;
  assert(data && !data.transaction && !data.serializedTransaction && !data.signers, 'unsupported transaction payload');
  // No lookup table is trusted or fetched: the validated ten-key deposit fits
  // a local v0 message with static keys. Live quotes advertise an optional ALT.
  const list = data.instructions;
  assert(Array.isArray(list) && list.length === 1, 'requires exactly one canonical deposit instruction');
  const ix = list[0];
  assert(ix?.programId === SOL_RELAY_DEPOSITORY, 'unsupported instruction program');
  assert(typeof ix.data === 'string' && /^[0-9a-f]{96}$/i.test(ix.data), 'invalid deposit instruction encoding');
  const bytes = Buffer.from(ix.data, 'hex');
  assert(bytes.subarray(0, 8).toString('hex') === '0b9c60da27a3b413', 'unsupported deposit discriminator');
  assert(bytes.readBigUInt64LE(8) === BigInt(amount), 'executable deposit amount mismatch');
  const id = `0x${bytes.subarray(16).toString('hex')}`;
  assert(id !== `0x${'00'.repeat(32)}`, 'invalid deposit order id');
  if (orderId !== undefined) assert(typeof orderId === 'string' && /^0x[0-9a-f]{64}$/i.test(orderId) && id === orderId.toLowerCase(), 'deposit order id mismatch');
  const expected = [CONFIG.toBase58(), user.toBase58(), user.toBase58(), VAULT.toBase58(), mint.toBase58(), ata(user, mint).toBase58(), ata(VAULT, mint).toBase58(), TOKEN.toBase58(), ATA.toBase58(), SYSTEM];
  assert(Array.isArray(ix.keys) && ix.keys.length === expected.length, 'invalid deposit account count');
  for (let i = 0; i < expected.length; i++) {
    const key = ix.keys[i];
    assert(key?.pubkey === expected[i] && key.isSigner === (i === 1) && key.isWritable === [1,5,6].includes(i), `deposit account ${i} identity/privileges mismatch`);
  }
  return { orderId: id, instructions: [new TransactionInstruction({ programId: PROGRAM, data: bytes,
    keys: ix.keys.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })) })] };
}
