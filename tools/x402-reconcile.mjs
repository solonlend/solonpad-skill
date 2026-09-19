#!/usr/bin/env node
// Server-operator reconciliation only: never verify, settle, sign a payment, or unlock a nonce.
// Wire contract: https://developers.circle.com/api-reference/agent-stack/facilitator-service/get-payment-status
// Proof contract: https://developers.circle.com/facilitator-service/sign-seller-proof
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const Database = requireWeb('better-sqlite3');
const { keccak256, toBytes } = requireWeb('viem');
const { privateKeyToAccount } = requireWeb('viem/accounts');
const types = { SellerRequest: [
  { name: 'purpose', type: 'string' }, { name: 'method', type: 'string' }, { name: 'bodyHash', type: 'bytes32' },
  { name: 'network', type: 'string' }, { name: 'payTo', type: 'address' }, { name: 'nonce', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint64' }, { name: 'expiresAt', type: 'uint64' },
] };
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const transactionHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
function parseDetails(text) {
  try { return object(JSON.parse(text)); } catch { return {}; }
}

function validStatus(result, row, details) {
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    && result.paymentId === details.paymentId && result.network === row.network
    && ['pending', 'completed', 'failed'].includes(result.status)
    && (result.payer == null || sameAddress(result.payer, row.payer))
    && (result.payTo == null || sameAddress(result.payTo, row.pay_to))
    && (result.transaction == null || transactionHash(result.transaction))
    && (details.transaction == null || transactionHash(details.transaction)
      && (result.transaction == null || details.transaction.toLowerCase() === result.transaction.toLowerCase()))
    && (result.amount == null || typeof result.amount === 'string' && /^[1-9][0-9]*$/.test(result.amount))
    && (details.amount == null || result.amount == null || result.amount === details.amount)
    && (result.status !== 'completed' || transactionHash(result.transaction));
}

async function statusProof(account, network, now) {
  const issuedAt = Math.floor(now / 1000), expiresAt = issuedAt + 300;
  const nonce = `0x${randomBytes(32).toString('hex')}`, payTo = account.address;
  const signature = await account.signTypedData({
    domain: { name: 'Circle Facilitator Seller Request', version: '1', chainId: Number(network.split(':')[1]) },
    types, primaryType: 'SellerRequest',
    message: { purpose: 'status', method: 'GET', bodyHash: keccak256(toBytes('')), network, payTo, nonce,
      issuedAt: BigInt(issuedAt), expiresAt: BigInt(expiresAt) },
  });
  return Buffer.from(JSON.stringify({ version: 1, signature, network, payTo, nonce, issuedAt, expiresAt })).toString('base64url');
}

/** Read-only by default, with injected HTTP transport for offline acceptance tests. */
export async function reconcilePayments({ filename, privateKey, apply = false, fulfill = false, paymentKey = /** @type {string | undefined} */ (undefined), now = Date.now, fetchImpl = fetch }) {
  if (paymentKey !== undefined && (!fulfill || typeof paymentKey !== 'string' || !paymentKey)) throw new Error('--payment-key requires --fulfill');
  if (typeof filename !== 'string' || !filename) throw new Error('A sqlite path is required');
  let account;
  try {
    if (typeof privateKey !== 'string' || !/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error();
    account = privateKeyToAccount(privateKey);
  } catch { throw new Error('X402_SELLER_PK must contain the seller private key'); }
  const db = new Database(filename, { readonly: !apply, fileMustExist: true, timeout: 1000 });
  try {
    const rows = [];
    for (const row of db.prepare("SELECT * FROM x402_payments WHERE status IN ('pending', 'unknown', 'verified', 'failed') ORDER BY created_at, key").all()) {
      const details = parseDetails(row.details), { paymentId } = details;
      if (row.status === 'failed' && !['settlement_failed', 'settlement_outcome_unknown', 'settlement_pending'].includes(details.reason)) continue;
      const report = { key: row.key, paymentId, status: row.status, applied: false, reason: /** @type {string | undefined} */ (undefined) };
      rows.push(report);
      if (typeof paymentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(paymentId)) {
        report.reason = 'missing_payment_id';
        continue;
      }
      if (!['eip155:5042', 'eip155:5042002'].includes(row.network) || !sameAddress(row.pay_to, account.address)) {
        report.reason = 'ledger_identity_mismatch';
        continue;
      }
      let result;
      try {
        const proof = await statusProof(account, row.network, now());
        const response = await fetchImpl(`https://api.circle.com/v1/facilitator/x402/status/${paymentId}`, {
          method: 'GET', headers: { 'Facilitator-Seller-Proof': proof }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) throw new Error('status_unavailable');
        result = await response.json();
      } catch { report.reason = 'status_unavailable'; continue; }
      if (!validStatus(result, row, details)) { report.reason = 'invalid_status_response'; continue; }
      const status = result.status === 'completed' ? 'settled' : result.status;
      Object.assign(report, { status });
      if (apply) {
        // Compare-and-swap prevents racing an in-flight settlement or a second operator.
        const changed = db.prepare(`UPDATE x402_payments SET status = ?, details = ?, updated_at = ?
          WHERE key = ? AND status = ? AND details = ? AND updated_at = ?`)
          .run(status, JSON.stringify({ ...details, ...(result.transaction ? { transaction: result.transaction } : {}),
            reconciliation: result.status }), now(), row.key, row.status, row.details, row.updated_at);
        report.applied = changed.changes === 1;
        if (!report.applied) report.reason = 'concurrent_update';
      }
    }
    const fulfillments = /** @type {Array<{key:string,payer:string,applied:boolean,reason?:string,voucher?:string,credits?:number,chains?:string[]}>} */ ([]);
    if (fulfill) {
      // Upgrades are restricted to the explicit mutating operator mode.
      const paymentColumns = new Set(db.prepare('PRAGMA table_info(x402_payments)').all().map(row => row.name));
      const creditColumns = new Set(db.prepare('PRAGMA table_info(rpc_credits)').all().map(row => row.name));
      if (apply) db.transaction(() => {
        if (!paymentColumns.has('fulfilled_at')) db.exec('ALTER TABLE x402_payments ADD COLUMN fulfilled_at INTEGER');
        db.exec(`CREATE TABLE IF NOT EXISTS rpc_credits (voucher_hash TEXT PRIMARY KEY,
          credits_left INTEGER NOT NULL CHECK(credits_left >= 0), created INTEGER NOT NULL, last_used INTEGER)`);
        if (!creditColumns.has('payment_key')) db.exec('ALTER TABLE rpc_credits ADD COLUMN payment_key TEXT');
        if (!creditColumns.has('revoked_at')) db.exec('ALTER TABLE rpc_credits ADD COLUMN revoked_at INTEGER');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS rpc_credits_active_payment ON rpc_credits(payment_key) WHERE revoked_at IS NULL');
      }).immediate();
      for (const row of db.prepare("SELECT * FROM x402_payments WHERE status = 'settled' AND endpoint = 'rpc-credit' ORDER BY created_at, key").all()) {
        if (paymentKey !== undefined && row.key !== paymentKey) continue;
        if (paymentKey === undefined && row.fulfilled_at != null) continue;
        const report = /** @type {{key:string,payer:string,applied:boolean,reason?:string,voucher?:string,credits?:number,chains?:string[]}} */ ({ key: row.key, payer: row.payer, applied: false });
        fulfillments.push(report);
        const details = parseDetails(row.details);
        if (!['eip155:5042', 'eip155:5042002'].includes(row.network) || !sameAddress(row.pay_to, account.address)) {
          report.reason = 'ledger_identity_mismatch'; continue;
        }
        if (!transactionHash(details.transaction) || (row.amount ?? details.amount) !== '1000000') {
          report.reason = 'settled_payment_evidence_required'; continue;
        }
        if (!apply) { report.reason = 'would_replace_voucher'; continue; }
        db.transaction(() => {
          // CAS and revocation/issuance are one write transaction. Two operators
          // cannot mint independently from the same observed fulfillment state.
          const current = db.prepare('SELECT * FROM x402_payments WHERE key = ?').get(row.key);
          if (current.status !== 'settled' || current.details !== row.details
            || current.updated_at !== row.updated_at || current.fulfilled_at !== row.fulfilled_at) {
            report.reason = 'concurrent_update'; return;
          }
          const prior = db.prepare('SELECT MIN(credits_left) AS remaining FROM rpc_credits WHERE payment_key = ?').get(row.key);
          if (prior.remaining === null && current.verified_at == null
            && db.prepare('SELECT 1 FROM rpc_credits WHERE payment_key IS NULL AND revoked_at IS NULL LIMIT 1').get()) {
            report.reason = 'legacy_vouchers_require_attribution'; return;
          }
          const credits = prior.remaining ?? 10000;
          const at = now(), voucher = randomBytes(32).toString('hex');
          db.prepare('UPDATE rpc_credits SET revoked_at = ? WHERE payment_key = ? AND revoked_at IS NULL').run(at, row.key);
          db.prepare('INSERT INTO rpc_credits (voucher_hash, credits_left, created, payment_key) VALUES (?, ?, ?, ?)')
            .run(createHash('sha256').update(voucher).digest('hex'), credits, at, row.key);
          db.prepare('UPDATE x402_payments SET fulfilled_at = ?, updated_at = ? WHERE key = ?').run(at, at, row.key);
          Object.assign(report, { applied: true, voucher, credits, chains: ['arc', 'bsc', 'rh', 'sol'] });
        }).immediate();
      }
    }
    return { dryRun: !apply, rows, ...(fulfill ? { fulfillments } : {}) };
  } finally { db.close(); }
}

const usage = 'Usage: node skill/tools/x402-reconcile.mjs [sqlite-path] [--apply] [--fulfill] [--payment-key <ledger-key>]\n'
  + 'Required env: X402_SELLER_PK. Path: positional argument or X402_SQLITE_PATH.\n'
  + 'Default: dry-run, read-only sqlite. --apply writes status updates. --fulfill repairs settled RPC purchases; --payment-key replaces a lost voucher. Never initiates payments.\n'
  + 'Keep unresolved nonces locked. Payers must NOT re-sign until reconciliation.';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const paymentKeyIndex = args.indexOf('--payment-key');
  const paymentKey = paymentKeyIndex >= 0 ? args[paymentKeyIndex + 1] : undefined;
  const positional = args.filter((_, index) => index !== paymentKeyIndex && index !== paymentKeyIndex + 1 || paymentKeyIndex < 0);
  const paths = positional.filter(arg => !arg.startsWith('--'));
  if (args.length === 1 && args[0] === '--help') console.log(usage);
  else if (paths.length > 1 || positional.some(arg => arg.startsWith('--') && !['--apply', '--fulfill'].includes(arg))
    || paymentKeyIndex >= 0 && (!paymentKey || paymentKey.startsWith('--') || !args.includes('--fulfill'))
    || args.filter(arg => arg === '--payment-key').length > 1 || args.filter(arg => arg === '--fulfill').length > 1
    || args.filter(arg => arg === '--apply').length > 1 || !(paths[0] || process.env.X402_SQLITE_PATH)) {
    console.error(usage); process.exitCode = 1;
  } else {
    reconcilePayments({ filename: paths[0] || process.env.X402_SQLITE_PATH,
      privateKey: process.env.X402_SELLER_PK, apply: args.includes('--apply'), fulfill: args.includes('--fulfill'), paymentKey,
    }).then(result => console.log(JSON.stringify(result, null, 2)))
      // Do not echo database/transport errors that may contain sensitive contents.
      .catch(() => { console.error('x402 reconciliation failed: check sqlite path/schema, permissions and X402_SELLER_PK'); process.exitCode = 1; });
  }
}
