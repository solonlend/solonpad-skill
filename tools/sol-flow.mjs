// sol-flow.mjs — buy/sell/sweep orchestration for the Solana (Jupiter) lane.
// Two keys, one order: RAIL_PK signs the Arc side (funding domain), RAIL_SOL_PK
// signs on Solana. Quote asset is USDC (same face as Arc's), so a bridged
// order arrives ready to spend; SOL for fees/rent comes from the gas keeper.
// Rail fee = Jupiter platformFeeBps 50 into our treasury's USDC ATA — for
// ExactIn swaps the fee account may be on either side of the pair, so one
// USDC account covers buys (input side) and sells (output side).
import { PublicKey } from '@solana/web3.js';
import { parseEther, formatEther } from 'viem';
import { CHAINS, HOME, SETTINGS, arcPublic, arcWallet, orderState, dueDiligence, findPools, relayQuote, executeRelaySteps, waitArrival, reconcileOrderStep, exactInputFloor } from './rail-lib.mjs';
import { solConn, loadSolKeypair, USDC_MINT, FEE_ACCOUNT, FEE_TREASURY, tokenBalance, solBalance, jupQuote, jupSwapTx, signAndSend, sendRelaySolStep, ensureAta, TOKEN_PROGRAM, waitSolArrival, reconcileSig } from './sol-venue.mjs';

// 0.008 SOL: two ATA rents (~0.00204 each) + swap fees + exit reserve.
// The $1.5 top-up bridges ~0.013 SOL, comfortably above the floor.
const GAS_FLOOR_LAMPORTS = 8_000_000n;
const GAS_MIN_FOR_EXIT = 3_000_000n; // sell/sweep only: fees + one possible ATA rent
const NATIVE_SOL = '11111111111111111111111111111111';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
// SOL/USD from Jupiter's own routing — independent of the relay response.
async function solUsdJup() {
  const probe = await jupQuote({ inputMint: USDC_MINT.toBase58(), outputMint: WSOL_MINT, amount: 50_000_000, slippageBps: 100 });
  const lamports = Number(probe.outAmount);
  if (!(lamports > 0)) throw new Error('independent SOL price unavailable (Jupiter probe failed)');
  return 50 / (lamports / 1e9);
}
const yes = () => process.argv.includes('--yes');

const fmtUsdc = (v) => (Number(v) / 1e6).toFixed(2);

async function ensureFeeAta(conn, solKp, state) {
  const previous = state.load().steps['sol-fee-ata'];
  if (previous?.txHash) {
    const status = await reconcileSig(conn, previous.txHash, previous.raw);
    if (status === 'confirmed') return { addr: FEE_ACCOUNT, sig: previous.txHash, created: false };
    state.mark('sol-fee-ata', { txHash: null, raw: null });
  }
  return ensureAta(conn, solKp, FEE_TREASURY, USDC_MINT, TOKEN_PROGRAM,
    (txHash, raw) => state.mark('sol-fee-ata', { txHash, raw }));
}

export async function gasKeeper(conn, account, solKp, arcP, arcW, state, { timeoutMs = 180_000, pollMs = 4000 } = {}) {
  // A durable hash is a pending obligation, not proof of broadcast/delivery.
  // Reconcile every old attempt before *any* new economic operation, even if
  // an unrelated transfer already brought the Solana wallet above its floor.
  const recorded = Object.entries(state.load().steps)
    .filter(([key, value]) => /^sol-gas-bridge(?:-\d+)?:\d+:\d+$/.test(key) && value.txHash);
  for (const [key] of recorded) await reconcileOrderStep(arcP, state, key);
  let bal = await solBalance(conn, solKp.publicKey);
  if (bal >= GAS_FLOOR_LAMPORTS) return { topped: recorded.length > 0, sol: Number(bal) / 1e9 };
  const stepName = 'sol-gas-bridge';
  // One sized top-up per order. Source confirmation plus a timeout is NOT
  // terminal destination failure: a delayed first fill must never authorize
  // a second debit under a new attempt key. Historical attempts above are
  // reconciled but never extended. An insufficient fill needs manual funding.
  if (recorded.length === 0) {
    const solUsd = await solUsdJup();
    const probe = await relayQuote({ user: account.address, recipient: solKp.publicKey.toBase58(),
      fromChain: HOME.relayId, toChain: CHAINS.sol.relayId,
      fromCurrency: '0x0000000000000000000000000000000000000000', toCurrency: NATIVE_SOL,
      amountWei: parseEther(String(SETTINGS.gasTopupUsd)),
      minOutput: exactInputFloor({ usdIn: SETTINGS.gasTopupUsd, outUsdPrice: solUsd, outDecimals: 9 }) });
    const probeOut = BigInt(probe.details.currencyOut.amount);
    const shortfall = GAS_FLOOR_LAMPORTS - bal;
    let q = probe;
    if (probeOut < shortfall) {
      const usd = Math.min(10, Math.ceil((Number(shortfall) / Number(probeOut)) * SETTINGS.gasTopupUsd * 1.25 * 100) / 100);
      q = await relayQuote({ user: account.address, recipient: solKp.publicKey.toBase58(),
        fromChain: HOME.relayId, toChain: CHAINS.sol.relayId,
        fromCurrency: '0x0000000000000000000000000000000000000000', toCurrency: NATIVE_SOL,
        amountWei: parseEther(String(usd)),
        minOutput: exactInputFloor({ usdIn: usd, outUsdPrice: solUsd, outDecimals: 9 }) });
    }
    await executeRelaySteps(q, arcW, arcP, state, stepName);
  }
  const deadline = Date.now() + timeoutMs;
  while (bal < GAS_FLOOR_LAMPORTS && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    bal = await solBalance(conn, solKp.publicKey);
  }
  if (bal < GAS_FLOOR_LAMPORTS) throw new Error('gas bridge arrival unresolved or insufficient — resume this order; no additional debit authorized, verify delivery before manual funding');
  return { topped: true, sol: Number(bal) / 1e9 };
}

export async function solBuyFlow({ account, token, usd, slippageBps, force, orderId, state = orderState(orderId) }) {
  state.lockWallet(account.address, [HOME.relayId]);
  const conn = solConn();
  const solKp = loadSolKeypair();
  state.lockWallet(solKp.publicKey.toBase58(), ['sol']);
  const arcP = arcPublic(), arcW = arcWallet(account);
  const mint = new PublicKey(token);

  // a recorded-but-unsettled swap is reconciled before anything new is built:
  // confirmed -> report; failed/expired -> cleared for one fresh attempt
  const swapRec = state.load().steps['sol-swap'];
  if (swapRec?.txHash && !swapRec.got) {
    const verdict = await reconcileSig(conn, swapRec.txHash, swapRec.raw);
    if (verdict === 'confirmed') { state.mark('sol-swap', { got: 'confirmed-on-resume' }); console.log(`swap confirmed on resume | tx ${swapRec.txHash}`); }
    else { console.log(`recorded swap ${verdict} (${swapRec.txHash}) — rebuilding`); state.mark('sol-swap', { txHash: null, raw: null, supersedes: swapRec.txHash }); }
  }
  if (state.done('sol-swap')) { console.log('buy already executed for this order'); return; }

  // dd gate: GoPlus solana authorities + DexScreener LP depth (fails closed)
  const dd = await dueDiligence(token, 'sol');
  if (!dd.ok && !force) { console.error(`DD GATE: ${dd.reason} — refusing (--force to bypass)`); process.exit(1); }
  if (!dd.ok) console.log(`dd_bypassed: ${dd.reason}`);
  const pools = await findPools(token, 'sol');
  if (!pools.length) { console.error('no solana pool found for token'); process.exit(1); }
  if (pools[0].lpUsd < SETTINGS.ddMinLpUsd && !force) { console.error(`DD GATE: deepest LP $${pools[0].lpUsd.toFixed(0)} < $${SETTINGS.ddMinLpUsd} — refusing (--force to bypass)`); process.exit(1); }

  // quote preview ([FINANCIAL EXECUTION] parameter echo)
  const usdcTarget = BigInt(Math.round(usd * 1e6));
  const preview = await jupQuote({ inputMint: USDC_MINT.toBase58(), outputMint: token, amount: usdcTarget, slippageBps, platformFeeBps: SETTINGS.feeBps });
  console.log(`[FINANCIAL EXECUTION] buy ${token} on solana for ~$${usd}`);
  console.log(`  route: ${preview.routePlan.map(r => r.swapInfo?.label).join('>')} | est out ${preview.outAmount} raw | rail fee ${SETTINGS.feeBps}bps via feeAccount | impact ${preview.priceImpactPct}% | dd flags ${JSON.stringify(dd.fields.flags ?? [])}`);
  if (!yes()) { console.log('re-run with --yes to execute'); process.exit(0); }

  const gas = await gasKeeper(conn, account, solKp, arcP, arcW, state);
  console.log(`gas: ${gas.topped ? 'topped up' : 'sufficient'} (${gas.sol.toFixed(4)} SOL)`);

  // bridge Arc USDC -> Solana USDC. Spend ONLY this order's arrival — never
  // sweep pre-existing wallet USDC into a buy.
  const usdcBefore = await tokenBalance(conn, solKp.publicKey, USDC_MINT);
  if (!state.done('sol-bridge-arrived')) {
    const savedBaseline = state.load().steps['sol-bridge-baseline'];
    if (usdcBefore >= usdcTarget && !savedBaseline) {
      // deliberate BSC-lane parity: pre-held quote USDC may fund the order,
      // capped at the order target below — never the whole wallet
      state.mark('sol-bridge-arrived', { skipped: true, txHash: 'n/a', arrived: usdcTarget.toString() });
      console.log('bridge skipped: enough Solana USDC on hand');
    } else {
      // the pre-bridge balance is persisted BEFORE any bridge step, so a
      // crash-resume measures arrival against the original baseline instead
      // of re-snapshotting a balance the arrival already landed in
      const baseline = savedBaseline ? BigInt(savedBaseline.before) : usdcBefore;
      if (!savedBaseline) state.mark('sol-bridge-baseline', { before: usdcBefore.toString(), txHash: 'n/a' });
      const sendAmount = parseEther(String(Math.ceil(usd * 1.03))); // relay's fee comes out of the output
      const q = await relayQuote({ user: account.address, recipient: solKp.publicKey.toBase58(),
        fromChain: HOME.relayId, toChain: CHAINS.sol.relayId,
        fromCurrency: '0x0000000000000000000000000000000000000000', toCurrency: USDC_MINT.toBase58(),
        amountWei: sendAmount,
        // stable->stable: parity floor from OUR amount, never the quote's own minimum
        minOutput: exactInputFloor({ usdIn: Math.ceil(usd * 1.03), outDecimals: 6 }) });
      console.log(`bridging ~$${Math.ceil(usd * 1.03)} Arc USDC -> Solana USDC (est out ${fmtUsdc(q.details.currencyOut.amount)})`);
      await executeRelaySteps(q, arcW, arcP, state, 'sol-bridge');
      const arrived = await waitSolArrival(conn, solKp.publicKey, USDC_MINT, baseline);
      state.mark('sol-bridge-arrived', { skipped: false, txHash: 'n/a', arrived: arrived.toString() });
    }
  }
  const arrivedRaw = BigInt(state.load().steps['sol-bridge-arrived']?.arrived ?? 0);
  if (arrivedRaw === 0n) { console.error('no recorded arrival for this order — refusing to spend wallet balance'); process.exit(1); }
  const balNow = await tokenBalance(conn, solKp.publicKey, USDC_MINT);
  const spend = arrivedRaw < balNow ? arrivedRaw : balNow;
  const spendCapped = spend < usdcTarget ? spend : usdcTarget;

  // fee account is permissionless to create; one-time rent from the caller
  const feeReady = await conn.getAccountInfo(FEE_ACCOUNT);
  if (!feeReady) {
    const r = await ensureFeeAta(conn, solKp, state);
    console.log(`fee account initialized (${r.addr.toBase58()}) tx ${r.sig}`);
  }

  if (!state.done('sol-swap')) {
    const quote = await jupQuote({ inputMint: USDC_MINT.toBase58(), outputMint: token, amount: spendCapped, slippageBps, platformFeeBps: SETTINGS.feeBps });
    state.mark('sol-swap', { intent: { spend: spendCapped.toString(), estOut: quote.outAmount } });
    const before = await tokenBalance(conn, solKp.publicKey, mint);
    const b64 = await jupSwapTx({ quoteResponse: quote, userPublicKey: solKp.publicKey.toBase58(), feeAccount: FEE_ACCOUNT.toBase58() });
    const sig = await signAndSend(conn, solKp, b64, (s, raw) => state.mark('sol-swap', { txHash: s, raw }), { inputMint: USDC_MINT.toBase58(), outputMint: token, amount: spendCapped, minOut: BigInt(quote.otherAmountThreshold), slippageBps, platformFeeBps: SETTINGS.feeBps, feeAccount: FEE_ACCOUNT.toBase58() });
    const got = (await tokenBalance(conn, solKp.publicKey, mint)) - before;
    state.mark('sol-swap', { got: got.toString() });
    console.log(`BOUGHT ${got} raw tokens for ${fmtUsdc(spendCapped)} USDC (incl 0.5% rail fee) | tx ${sig}`);
  }
  console.log(`receipt: ${state.file}`);
}

export async function solSellFlow({ token, pct, slippageBps, orderId }) {
  const state = orderState(orderId);
  const conn = solConn();
  const solKp = loadSolKeypair();
  state.lockWallet(solKp.publicKey.toBase58(), ['sol']);
  const mint = new PublicKey(token);
  // reconcile a recorded sell BEFORE reading balances: a completed sell that
  // emptied the position must report itself, not die on 'zero balance'
  const sellRec0 = state.load().steps['sol-sell'];
  if (sellRec0?.txHash && !sellRec0.got) {
    const verdict = await reconcileSig(conn, sellRec0.txHash, sellRec0.raw);
    if (verdict === 'confirmed') { state.mark('sol-sell', { got: 'confirmed-on-resume' }); console.log(`sell confirmed on resume | tx ${sellRec0.txHash}`); return; }
    console.log(`recorded sell ${verdict} (${sellRec0.txHash}) — rebuilding`); state.mark('sol-sell', { txHash: null, raw: null, supersedes: sellRec0.txHash });
  }
  if (state.done('sol-sell')) { console.log('sell already executed for this order (resume): ' + state.load().steps['sol-sell'].txHash); return; }
  const gasBal = await solBalance(conn, solKp.publicKey);
  if (gasBal < GAS_MIN_FOR_EXIT) { console.error(`insufficient SOL for fees (${Number(gasBal) / 1e9} < 0.003) — a buy's gas keeper tops up, or send SOL manually`); process.exit(1); }
  const bal = await tokenBalance(conn, solKp.publicKey, mint);
  if (bal === 0n) { console.error('zero balance'); process.exit(1); }
  const amountIn = (bal * BigInt(Math.round(pct * 100))) / 10_000n;
  const quote = await jupQuote({ inputMint: token, outputMint: USDC_MINT.toBase58(), amount: amountIn, slippageBps, platformFeeBps: SETTINGS.feeBps });
  console.log(`[FINANCIAL EXECUTION] sell ${pct}% on solana | est ${fmtUsdc(quote.outAmount)} USDC net of 0.5% rail fee | route ${quote.routePlan.map(r => r.swapInfo?.label).join('>')}`);
  if (!yes()) { console.log('re-run with --yes to execute'); process.exit(0); }
  const feeReady = await conn.getAccountInfo(FEE_ACCOUNT);
  if (!feeReady) await ensureFeeAta(conn, solKp, state);
  state.mark('sol-sell', { intent: { amountIn: amountIn.toString(), estOut: quote.outAmount } });
  const before = await tokenBalance(conn, solKp.publicKey, USDC_MINT);
  const b64 = await jupSwapTx({ quoteResponse: quote, userPublicKey: solKp.publicKey.toBase58(), feeAccount: FEE_ACCOUNT.toBase58() });
  const sig = await signAndSend(conn, solKp, b64, (s, raw) => state.mark('sol-sell', { txHash: s, raw }), { inputMint: token, outputMint: USDC_MINT.toBase58(), amount: amountIn, minOut: BigInt(quote.otherAmountThreshold), slippageBps, platformFeeBps: SETTINGS.feeBps, feeAccount: FEE_ACCOUNT.toBase58() });
  const got = (await tokenBalance(conn, solKp.publicKey, USDC_MINT)) - before;
  state.mark('sol-sell', { got: got.toString() });
  console.log(`SOLD -> +${fmtUsdc(got)} USDC net | tx ${sig}`);
}

export async function solSweepFlow({ account, orderId, usd = 'all' }) {
  const state = orderState(orderId);
  const conn = solConn();
  const solKp = loadSolKeypair();
  state.lockWallet(solKp.publicKey.toBase58(), ['sol']);
  const arcP = arcPublic();
  // reconcile any recorded sweep sends first: a signature is persisted BEFORE
  // broadcast, so a record alone does not prove the network ever saw it.
  // Confirmed -> settle-only; provably gone -> cleared for a fresh sweep.
  const sentKeys = Object.keys(state.load().steps).filter(k => k.startsWith('sol-sweep:') && state.done(k));
  const savedBaseline = state.load().steps['sol-sweep-baseline'];
  let confirmedSend = false;
  for (const key of sentKeys) {
    const rec = state.load().steps[key];
    const verdict = await reconcileSig(conn, rec.txHash, rec.raw); // ambiguity throws — never rebuild on a guess
    if (verdict === 'confirmed') confirmedSend = true;
    else { console.log(`recorded sweep step ${verdict} (${rec.txHash}) — cleared`); state.mark(key, { txHash: null, raw: null, supersedes: rec.txHash }); }
  }
  if (confirmedSend) {
    // this order's sweep left the wallet already: only settle its arrival —
    // never quote or send a second one under the same id
    if (!savedBaseline) { console.error('sweep confirmed but no baseline recorded — verify on Arc manually, receipt: ' + state.file); process.exit(1); }
    const got = await waitArrival(arcP, account.address, null, BigInt(savedBaseline.before), 180_000);
    console.log(`ARRIVED on Arc: +${Number(formatEther(got)).toFixed(2)} USDC (resumed)`);
    return;
  }
  const bal = await tokenBalance(conn, solKp.publicKey, USDC_MINT);
  if (bal === 0n) { console.error('nothing to sweep'); process.exit(1); }
  const gasBal = await solBalance(conn, solKp.publicKey);
  if (gasBal < GAS_MIN_FOR_EXIT) { console.error(`insufficient SOL for fees (${Number(gasBal) / 1e9} < 0.003)`); process.exit(1); }
  if (usd !== 'all' && !Number.isFinite(Number(usd))) { console.error(`bad --usd '${usd}' (number or 'all')`); process.exit(1); }
  const amount = usd === 'all' ? bal : BigInt(Math.round(Number(usd) * 1e6));
  if (!(amount > 0n) || amount > bal) { console.error(`bad amount (have ${fmtUsdc(bal)} USDC)`); process.exit(1); }
  const relayIntent = { user: solKp.publicKey.toBase58(), recipient: account.address,
    fromChain: CHAINS.sol.relayId, toChain: HOME.relayId,
    fromCurrency: USDC_MINT.toBase58(), toCurrency: HOME.sweepCurrency, amountWei: amount,
    // stable->stable parity floor. Solana origin has no protocol.v2 binding, so
    // this is enforced against the quote's declared minimum (residual executor
    // trust documented below) — still fatal to a lazily forged quote.
    minOutput: exactInputFloor({ usdIn: Number(amount) / 1e6, outDecimals: 6 }),
    // Legacy Solana responses cannot bind destination terms to protocol.v2.
    // This sweep explicitly accepts that residual Relay executor trust; quote
    // and signing still enforce canonical USDC deposit instructions and warn.
    allowUnverifiedSolOrigin: true };
  const q = await relayQuote(relayIntent);
  console.log(`[FINANCIAL EXECUTION] sweep ${fmtUsdc(amount)} Solana USDC -> Arc USDC (est $${fmtUsdc(q.details.currencyOut.amount)})`);
  if (!yes()) { console.log('re-run with --yes to execute'); process.exit(0); }
  // Arc baseline is persisted before the first send so a resumed run can
  // still recognize an arrival that landed while we were away
  const before = savedBaseline ? BigInt(savedBaseline.before) : await arcP.getBalance({ address: account.address });
  if (!savedBaseline) state.mark('sol-sweep-baseline', { before: before.toString(), txHash: 'n/a' });
  for (const [i, step] of q.steps.entries()) {
    for (const [j, item] of step.items.entries()) {
      const key = `sol-sweep:${i}:${j}`;
      if (state.done(key)) continue;
      state.mark(key, { intent: 'relay solana-origin step' });
      await sendRelaySolStep(conn, solKp, item, (s, raw) => state.mark(key, { txHash: s, raw }), { quote: q, intent: relayIntent });
    }
  }
  const got = await waitArrival(arcP, account.address, null, before, 180_000);
  console.log(`ARRIVED on Arc: +${Number(formatEther(got)).toFixed(2)} USDC`);
}
