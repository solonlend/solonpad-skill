// sol-venue.mjs — Solana plumbing for the rail's Jupiter lane.
// Non-custodial: the caller brings RAIL_SOL_PK (base58 secret key or JSON
// byte array); nothing here uploads, logs or persists it. Rail fee rides
// Jupiter's native platformFeeBps + feeAccount (no custom program needed):
// feeAccount is our treasury's USDC ATA, valid for both directions of an
// ExactIn swap against USDC (fee may be taken on either side of the pair).
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction, AddressLookupTableAccount } from '@solana/web3.js';
import bs58 from 'bs58';
import { validateRelayIntent } from './rail-lib.mjs';
import { validateRelayProtocol } from './relay-protocol.mjs';
import { validateRelaySolInstructions } from './relay-solana.mjs';

export const SOL_RPC = process.env.RAIL_SOL_RPC || 'https://api.mainnet-beta.solana.com';
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
// rail fee treasury (keypair held offline; only the pubkey lives here)
export const FEE_TREASURY = new PublicKey('B2Ej9TNMfeoMSG9pYFyD5dXTtekkHWvaN4Wvq31wFp7Q');
export const FEE_ACCOUNT = new PublicKey('4AJiPadLWt9t8rDocRr74ue1DYRhNcpWmfKj4Dz6jm8o'); // = ata(FEE_TREASURY, USDC)

const JUP = process.env.RAIL_JUP_API || 'https://lite-api.jup.ag/swap/v1';

export const solConn = () => new Connection(SOL_RPC, 'confirmed');

export function loadSolKeypair() {
  const raw = process.env.RAIL_SOL_PK;
  if (!raw) throw new Error('RAIL_SOL_PK env not set (non-custodial: bring your own Solana key — base58 secret key or JSON byte array)');
  try {
    const bytes = raw.trim().startsWith('[') ? new Uint8Array(JSON.parse(raw)) : bs58.decode(raw.trim());
    return Keypair.fromSecretKey(bytes);
  } catch {
    // fixed message: parser/library errors would otherwise echo key bytes
    throw new Error('RAIL_SOL_PK is not a valid Solana secret key (expected base58 string or JSON byte array)');
  }
}

export function ata(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  const [addr] = PublicKey.findProgramAddressSync([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ATA_PROGRAM);
  return addr;
}

// One query: the RPC's mint filter spans both token programs, and passing
// programId alongside mint is ignored — two filtered calls would double-count
// (verified against mainnet). Read errors propagate: a fabricated zero here
// would let a buy mistake pre-existing funds for a fresh bridge arrival.
export async function tokenBalance(conn, owner, mint) {
  const res = await conn.getParsedTokenAccountsByOwner(owner, { mint });
  let total = 0n;
  for (const { account } of res.value) total += BigInt(account.data.parsed.info.tokenAmount.amount);
  return total;
}

export async function solBalance(conn, owner) {
  return BigInt(await conn.getBalance(owner));
}

// which token program owns this mint (ATA derivation differs for Token-2022)
export async function mintProgram(conn, mint) {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} not found on-chain`);
  if (!info.owner.equals(TOKEN_PROGRAM) && !info.owner.equals(TOKEN_2022_PROGRAM)) throw new Error('mint has unsupported token program');
  return info.owner;
}

// ---- Jupiter quote + swap build ----
export async function jupQuote({ inputMint, outputMint, amount, slippageBps, platformFeeBps }) {
  const u = new URL(`${JUP}/quote`);
  u.searchParams.set('inputMint', inputMint); u.searchParams.set('outputMint', outputMint);
  u.searchParams.set('instructionVersion', 'V1');
  u.searchParams.set('amount', amount.toString()); u.searchParams.set('slippageBps', String(slippageBps));
  if (platformFeeBps) u.searchParams.set('platformFeeBps', String(platformFeeBps));
  const r = await fetch(u, { redirect: 'error' }); const q = await r.json();
  if (!r.ok || q.error) throw new Error('jupiter quote failed: ' + JSON.stringify(q).slice(0, 200));
  if (q.inputMint !== inputMint || q.outputMint !== outputMint || BigInt(q.inAmount) !== BigInt(amount) || q.swapMode !== 'ExactIn' || q.slippageBps !== slippageBps || (q.platformFee?.feeBps ?? 0) !== (platformFeeBps ?? 0)) throw new Error('Jupiter quote does not match original intent');
  return q;
}

export async function jupSwapTx({ quoteResponse, userPublicKey, feeAccount }) {
  const body = { quoteResponse, userPublicKey, instructionVersion: 'V1', wrapAndUnwrapSol: false, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: 'high', maxLamports: 2_000_000 } },
    ...(feeAccount ? { feeAccount } : {}) };
  const r = await fetch(`${JUP}/swap`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('jupiter swap build failed: ' + JSON.stringify(j).slice(0, 200));
  return j.swapTransaction; // base64 VersionedTransaction
}

export const JUPITER_PROGRAM = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const COMPUTE_PROGRAM = new PublicKey('ComputeBudget111111111111111111111111111111');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const ALLOWED_PROGRAMS = [JUPITER_PROGRAM, COMPUTE_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, MEMO_PROGRAM];
// V1 layout from https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts.
// Parse the whole route (including variable enum payloads), never just its
// trailer: trailing junk must not disguise the amounts the program executes.
// Unknown variants/V2/ledger/exact-out fail closed until their decoder is reviewed.
const SWAP_PAYLOAD_BYTES = [0,0,0,0,0,0,0,0,1,0,0,0,1,0,0,1,1,1,1,0,0,1,0,1,1,0,0,1,1,16,0,0,0,4,0,0,0,0,0,1,0,4,3,10,5,5,0,null,0,0,0,0,0,0,0,0,0,0,1,0,1,1];
const requireKey = (ix, i, expected) => {
  if (!ix.keys[i]?.pubkey.equals(expected)) throw new Error(`Jupiter account ${i} does not match intent`);
};
function routeAmounts(data, shared) {
  let pos = shared ? 9 : 8;
  if (data.length < pos + 4) throw new Error('unsupported Jupiter instruction');
  const count = data.readUInt32LE(pos); pos += 4;
  if (count < 1 || count > 16) throw new Error('unsupported Jupiter route length');
  for (let i = 0; i < count; i++) {
    const size = SWAP_PAYLOAD_BYTES[data[pos++]];
    if (size == null || pos + size + 3 > data.length) throw new Error('unsupported Jupiter swap variant');
    pos += size + 3;
  }
  if (pos + 19 !== data.length) throw new Error('unsupported Jupiter instruction layout');
  return { amount: data.readBigUInt64LE(pos), quotedOut: data.readBigUInt64LE(pos + 8), slippage: data.readUInt16LE(pos + 16), fee: data[pos + 18] };
}
export async function validateJupiterTransaction(conn, tx, user, intent) {
  if (!intent || !intent.inputMint || !intent.outputMint || BigInt(intent.amount ?? 0) <= 0n || BigInt(intent.minOut ?? 0) <= 0n) throw new Error('Jupiter signing requires original swap intent');
  const input = new PublicKey(intent.inputMint), output = new PublicKey(intent.outputMint);
  const fee = new PublicKey(intent.feeAccount);
  if (!fee.equals(FEE_ACCOUNT) || (!input.equals(USDC_MINT) && !output.equals(USDC_MINT))) throw new Error('Jupiter fee account/mint intent mismatch');
  const tables = [];
  for (const lookup of tx.message.addressTableLookups ?? []) {
    const table = await conn.getAddressLookupTable(lookup.accountKey);
    if (!table.value) throw new Error('Jupiter lookup table unavailable');
    tables.push(table.value);
  }
  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  if (!message.payerKey.equals(user) || tx.message.header.numRequiredSignatures !== 1) throw new Error('Jupiter user signer intent mismatch');
  // Do program admission before any further reads, and before signing.
  for (const ix of message.instructions) if (!ALLOWED_PROGRAMS.some(p => ix.programId.equals(p))) throw new Error('Jupiter instruction program is not allowed');
  const inputProgram = await mintProgram(conn, input), outputProgram = await mintProgram(conn, output);
  const source = ata(user, input, inputProgram), destination = ata(user, output, outputProgram);
  let routes = 0, units = 1_400_000n, microLamports = 0n;
  const budgetOps = new Set();
  for (const ix of message.instructions) {
    const data = Buffer.from(ix.data);
    if (ix.programId.equals(JUPITER_PROGRAM)) {
      routes++;
      const discriminator = data.subarray(0, 8).toString('hex');
      const shared = discriminator === 'c1209b3341d69c81';
      if (!shared && discriminator !== 'e517cb977ae3ad2a') throw new Error('unsupported Jupiter instruction');
      if (shared) {
        requireKey(ix,2,user); requireKey(ix,3,source); requireKey(ix,6,destination);
        requireKey(ix,7,input); requireKey(ix,8,output); requireKey(ix,9,fee);
      } else {
        requireKey(ix,1,user); requireKey(ix,2,source); requireKey(ix,3,destination);
        // Optional destination override must be absent (program sentinel) or same ATA.
        if (!ix.keys[4]?.pubkey.equals(JUPITER_PROGRAM) && !ix.keys[4]?.pubkey.equals(destination)) throw new Error('Jupiter destination account intent mismatch');
        requireKey(ix,5,output); requireKey(ix,6,fee);
      }
      const amounts = routeAmounts(data, shared);
      if (amounts.amount !== BigInt(intent.amount) || amounts.slippage > intent.slippageBps || amounts.fee !== intent.platformFeeBps || amounts.slippage > 10_000 || amounts.quotedOut * BigInt(10_000 - amounts.slippage) / 10_000n < BigInt(intent.minOut)) throw new Error('Jupiter executable amount/slippage/fee does not match intent');
    } else if (ix.programId.equals(COMPUTE_PROGRAM)) {
      if (ix.keys.length || budgetOps.has(data[0])) throw new Error('invalid ComputeBudget instruction');
      budgetOps.add(data[0]);
      if (data[0] === 2 && data.length === 5) { units = BigInt(data.readUInt32LE(1)); if (units > 1_400_000n || units === 0n) throw new Error('ComputeBudget units exceed cap'); }
      else if (data[0] === 3 && data.length === 9) microLamports = data.readBigUInt64LE(1);
      else throw new Error('unsupported ComputeBudget instruction');
    } else if (ix.programId.equals(ATA_PROGRAM)) {
      if (data.length !== 1 || data[0] !== 1 || ix.keys.length !== 6) throw new Error('unsupported ATA instruction');
      requireKey(ix,0,user); requireKey(ix,2,user); requireKey(ix,4,SYSTEM_PROGRAM);
      const isInput = ix.keys[3]?.pubkey.equals(input);
      requireKey(ix,3,isInput ? input : output); requireKey(ix,1,isInput ? source : destination); requireKey(ix,5,isInput ? inputProgram : outputProgram);
    } else if (ix.programId.equals(MEMO_PROGRAM)) {
      if (data.length > 256 || ix.keys.some(k => k.isWritable)) throw new Error('unsupported Memo instruction');
    } else {
      // USDC/token swaps need no direct System transfers, Token approvals,
      // authority changes or closing accounts. Program allowlisting alone
      // would allow these wallet drains, so deny unsupported operations.
      throw new Error('unsupported System/Token instruction in Jupiter swap');
    }
  }
  if (routes !== 1) throw new Error('Jupiter requires exactly one swap instruction');
  if ((units * microLamports + 999_999n) / 1_000_000n > 2_000_000n) throw new Error('Jupiter priority fee exceeds intent cap');
}

// The signature (= txid) is known the moment the tx is signed. onSent fires
// BEFORE broadcast with (sig, rawBase64) so callers persist both first: a
// crash anywhere inside or after the RPC call can neither lose track of an
// accepted transaction nor let a retry double-spend — the recorded bytes can
// only ever be rebroadcast, never rebuilt.
export async function signAndSend(conn, keypair, b64tx, onSent, intent) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64tx, 'base64'));
  await validateJupiterTransaction(conn, tx, keypair.publicKey, intent);
  tx.sign([keypair]);
  const raw = tx.serialize();
  const sig = bs58.encode(tx.signatures[0]);
  if (onSent) await onSent(sig, Buffer.from(raw).toString('base64'));
  await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  await confirmSig(conn, sig);
  return sig;
}

// Resume helper: what happened to a recorded signature?
// 'confirmed' — landed (confirmed/finalized only; 'processed' can still be
// dropped on a fork and must not count); 'failed' — landed and reverted;
// 'gone' — the recorded bytes are PROVABLY expired/unlanded, safe to rebuild.
// Anything ambiguous (transient RPC errors, null statuses without an expiry
// proof) throws instead: rebuilding on ambiguity is the double-spend path.
const settled = (st) => st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized');
export async function reconcileSig(conn, sig, rawB64) {
  const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
  if (settled(st)) return 'confirmed';
  if (st?.err) return 'failed';
  if (st) { // processed: give it a moment to confirm rather than guessing
    try { await confirmSig(conn, sig, 30_000); return 'confirmed'; } catch { /* fall through */ }
  }
  if (!rawB64) throw new Error(`recorded tx ${sig} is unsettled and no raw bytes were stored — verify on explorer before retrying`);
  try {
    await conn.sendRawTransaction(Buffer.from(rawB64, 'base64'), { maxRetries: 2 });
    await confirmSig(conn, sig, 45_000);
    return 'confirmed';
  } catch { /* classified below by proof, never by error text */ }
  const again = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
  if (settled(again)) return 'confirmed';
  if (again?.err) return 'failed';
  if (again) throw new Error(`recorded tx ${sig} is processed but unconfirmed — re-run shortly, do not rebuild`);
  // 'gone' demands a PROOF, not an error string: the recorded bytes carry
  // their recentBlockhash — if the chain says that blockhash is no longer
  // valid, this exact tx can never land in the future, and the
  // history-searching status read above says it never landed in the past.
  const bh = VersionedTransaction.deserialize(Buffer.from(rawB64, 'base64')).message.recentBlockhash;
  const validity = await conn.isBlockhashValid(bh, { commitment: 'processed' });
  if (validity.value === true) throw new Error(`recorded tx ${sig} may still land (blockhash valid) — re-run shortly, do not rebuild`);
  return 'gone';
}

export async function confirmSig(conn, sig, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`solana tx failed: ${sig} ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return st;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`confirmation timeout: ${sig} (may still land; check explorer before retrying)`);
}

// ---- relay Solana-origin steps: build a v0 tx from returned instructions ----
export async function sendRelaySolStep(conn, keypair, item, onSent, context) {
  if (!context?.quote || !context?.intent) throw new Error('Solana Relay signing requires original quote and intent');
  if (typeof onSent !== 'function') throw new Error('Solana Relay requires durable pre-broadcast persistence');
  // Snapshot caller-owned intent and quote before the first await. An item
  // supplied separately must be exactly the item that protocol validation sees.
  const { quote, intent } = structuredClone(context);
  if (keypair.publicKey.toBase58() !== intent.user) throw new Error('Solana Relay signer does not match original intent');
  if (JSON.stringify(item) !== JSON.stringify(quote.steps?.[0]?.items?.[0])) throw new Error('Solana Relay step does not match verified quote');
  validateRelayIntent(quote, intent);
  const verified = await validateRelayProtocol(quote, intent);
  if (verified?.verified !== true) throw new Error('Solana Relay protocol verification failed');
  const { instructions } = validateRelaySolInstructions(quote, intent, verified.orderId);
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  // Recheck expiry/order binding after the RPC wait and immediately before
  // signing. Ignore provider lookup tables; the canonical deposit fits locally.
  const rechecked = await validateRelayProtocol(quote, intent);
  if (rechecked?.verified !== true) throw new Error('Solana Relay protocol verification failed before signing');
  const message = new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);
  const raw = tx.serialize(), sig = bs58.encode(tx.signatures[0]);
  await onSent(sig, Buffer.from(raw).toString('base64'));
  await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  await confirmSig(conn, sig);
  return sig;
}

// create an ATA if missing (permissionless; payer funds the ~0.002 SOL rent).
// Used once per fee mint for the treasury's feeAccount.
export async function ensureAta(conn, payerKp, owner, mint, tokenProgram = TOKEN_PROGRAM, onSent) {
  const addr = ata(owner, mint, tokenProgram);
  if (await conn.getAccountInfo(addr)) return { addr, created: false };
  const SYSTEM = new PublicKey('11111111111111111111111111111111');
  const ix = new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payerKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: addr, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: payerKp.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payerKp]);
  const raw = tx.serialize();
  const sig = bs58.encode(tx.signatures[0]);
  if (!onSent) throw new Error('ATA creation requires durable pre-broadcast persistence');
  await onSent(sig, Buffer.from(raw).toString('base64'));
  await conn.sendRawTransaction(raw, { maxRetries: 3 });
  await confirmSig(conn, sig);
  return { addr, created: true, sig };
}

export async function waitSolArrival(conn, owner, mint, beforeBal, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 4000));
    const bal = mint ? await tokenBalance(conn, owner, mint) : await solBalance(conn, owner);
    if (bal > beforeBal) return bal - beforeBal;
  }
  throw new Error('bridge arrival timeout (funds may still land; re-run to resume)');
}
