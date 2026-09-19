# SolonPad — agent call sequences

Two launch modes. **Instant v4 (below) is the default since 2026-09-16**; the
progressive bonding curve (Pons V2) remains available and is documented in the
second half of this file. `A = addresses.json`, `V = A.instantV4`. Native USDC
amounts are 18-dec `msg.value` throughout.

## V4-0. Discover instant launches

```
created  = eth_getLogs({ address: V.uerc20Factory,  topics: [TokenCreated.topic],  fromBlock: V.deployBlock })
launched = eth_getLogs({ address: V.instantLaunchStrategy, topics: [TokenLaunched.topic], fromBlock: V.deployBlock })
# a SolonPad instant launch = TokenCreated and TokenLaunched in the SAME tx,
# with finalPositionRecipient == V.feeSplitter
```

Pool key for every launch: `{currency0: 0x0, currency1: token, fee: 10000,
tickSpacing: 100, hooks: 0x0}`; `poolId = keccak256(abi.encode(poolKey))`.
State: `StateView.getSlot0(poolId)` → price; `token.tokenURI()` → on-chain JSON
metadata (description / website / image).

## V4-1. Launch a token (1 multicall, no launch fee)

```
graffiti = launcher.getGraffiti(you)
token    = factory.getUERC20Address(name, symbol, 18, V.liquidityLauncher, graffiti)   # CREATE2 predict
tokenData = abi.encode(UERC20Metadata{description, website, image, extraData: 0x})
launcher.multicall([
  createToken(V.uerc20Factory, name, symbol, 18, 1e9*1e18, V.liquidityLauncher, tokenData),
  distributeToken(token, (V.instantLaunchStrategy, 1e9*1e18, abi.encode((feeBeneficiary))), bytes32(0)),
])
```

- Supply is FIXED at 1,000,000,000 × 1e18 (strategy hard constraint).
- The whole supply becomes a single-sided v4 position opening at ≈$4.2K FDV
  (tick 123800); the LP NFT is locked in the FeeSplitter forever. You receive
  no allocation — buy on market like everyone else.
- `feeBeneficiary` gets the creator half of the 1% LP fee via a transferable
  NFT in the BeneficiaryVault.

## V4-2. Trade

Any v4-compatible router works (it is a plain pool). Reference sequence with
the deployed PoolSwapTest router `V.swapRouterPoolSwapTest`:

```
# buy: exact-in native USDC
router.swap{value: in}(poolKey, {zeroForOne: true,  amountSpecified: -in,
  sqrtPriceLimitX96: limit}, {takeClaims: false, settleUsingBurn: false}, "")
# sell: approve token to router first, then zeroForOne: false
```

Set `sqrtPriceLimitX96` from your own quote ± slippage: the swap fills up to
the limit and refunds the unspent input (partial fills are possible — check
the received amount, not just success). Quote from `getSlot0` + position
liquidity with standard v4 math.

## V4-3. Creator fees

```
FeeSplitter.collectFees([tokenId])   # permissionless crank; caller gets nothing
BeneficiaryVault.claim(tokenId, min0, min1)   # beneficiary NFT owner only
```

`tokenId` is the LP NFT id from the launch receipt (PositionManager Transfer
to the FeeSplitter).

---

# Curve mode (Pons V2, progressive launch — optional)

All amounts below are **native USDC with 18 decimals** (`msg.value` units) unless marked
otherwise. `A = addresses.json`. ABIs in `abis/`. Run `VERIFY.md` first.

## 0. Discover launches

```
logs = eth_getLogs({ address: A.solonpad.launchFactory,
                     fromBlock: A.solonpad.deployBlock,
                     topics: [TokenLaunched.topic] })
# each log → (token, curve, creator, pairToken, …) per abis/PonsV2LaunchFactory.json
```

Per-token state (one multicall):
- `curve.getReserves()` → `(quoteReserve, tokenReserve)` — quote includes the 4,000
  phantom; price/token = `quoteReserve / tokenReserve`.
- `curve.realQuoteReserve()` → real USDC raised. Graduation progress =
  `real / (A.economics.graduationTargetUsdc * 1e18)`.
- `curve.graduated()` → if true, trade on Uniswap v4 instead (§4).

## 1. Launch a token (1 tx)

```
fee       = factory.launchFee()                       # re-read, do not hardcode
allowed   = factory.canLaunch(you)                    # false → factory paused for you
economics = factory.previewLaunchEconomics(0, 0x0)    # pin the curve params you expect

factory.launchToken{value: fee}(
  { name, symbol, logo: "https://…", description, socials: {5 strings},
    creatorFeeRecipient: you, creatorTaxBps: 0..500, buybackEnabled: true,
    expectedEconomics: economics, salt: random32bytes },
  0,          # pairTokenId 0 = native USDC
  address(0))
→ returns (token, curve)
```

`expectedEconomics` makes the tx revert if the owner changes fees between your read and
your send — always pass the fresh preview, never a cached one.

## 2. Buy on the curve

```
quote  = eth_call curve.buy(amountIn, 0, you) {value: amountIn}     # exact output
minOut = quote * 9900 / 10000                                       # your slippage policy
curve.buy{value: amountIn}(amountIn, minOut, you)
```

- Oversized buys near graduation fill partially and **refund the unspent USDC** in the
  same tx, then auto-graduate the market.
- First minutes after launch a **snipe tax** applies:
  `curve.currentSnipeTaxBps(you)` — creators are exempt on their own launch.

Closed-form check (mirror of contract math, use to sanity-check the eth_call):
```
net    = in − in*feeBps/1e4 − in*creatorTaxBps/1e4 − in*snipeTaxBps/1e4
out    = net * tokenReserve / (quoteReserve + net)
```

## 3. Sell on the curve

```
token.approve(curve, amt)              # exact amount, not infinite
quote  = eth_call curve.sell(amt, 0, you)
curve.sell(amt, quote*99/100, you)     # USDC arrives as native balance
```

Sells work until the instant of graduation; after it, the curve is closed both ways.

## 4. After graduation

The full range LP is minted to the locker (permanent — verify with
`locker.isLocked(token)`). Trade via Uniswap v4:
pool key = `{currency0: 0x0 (native), currency1: token, fee: 0, tickSpacing: 200,
hooks: A.solonpad.memeHook}` through `A.uniswapV4Canonical.universalRouter`.
The hook takes the swap fee and splits protocol/creator shares automatically.

## 5. Creator fee claims (pull payment)

Curve fees accrue to the escrow under your address as they trade:
```
escrow.claim()            # your entire native-USDC balance
escrow.claim(amount)      # partial
```
`sweepFees(minBuybackTokensOut)` on a live curve is permissionless — calling it moves
accrued fees to the escrow and executes the buyback slice; anyone may crank it.

## 6. Monitoring rules an agent should hardcode

- Re-read `launchFee`/`feeBps`/taxes before every send (owner-adjustable within caps).
- Confirmations: 1 block (~0.5 s) is final enough for curve reads; use the receipt for
  value accounting.
- Keep ≥0.05 native USDC for gas — a buy that spends the entire balance strands you.
- A curve at >95% progress can graduate under you: send buys with `minOut` and accept
  the partial-fill refund path, never assume the full amount executes on-curve.


## §Aggregator — trading any pad's pan through SolonFeeRouter (v0.3.0)

One stateless contract per chain (`addresses.json → aggregator.feeRouter`), 0.5%
interface fee on the quote leg, `minOut` net of fee. ABI: `abis/SolonFeeRouter.json`.

- **Pons curve pans (RH, pre-graduation)**
  - Buy (ETH quote): `feeRouter.curveBuy{value: quoteIn}(curve, address(0), quoteIn, minTokensOut)`
    — tokens go straight to you; partial-fill refunds are forwarded back.
  - Sell: `token.approve(feeRouter, amt)` → `feeRouter.curveSell(curve, token, address(0), amt, minQuoteOut)`.
  - ERC20-quoted curves: pass the quote address and `approve` it instead; `msg.value` must be 0.
- **Any open-hook v4 pool (both chains)**
  - Buy: `feeRouter.v4Swap{value: amountIn}(poolKey, true, amountIn, minOut, false)`
    (native quote) — ERC20 quote: approve the router, no value.
  - Sell: `token.approve(feeRouter, amt)` → `feeRouter.v4Swap(poolKey, false, amt, minOut, true)`.
  - `poolKey` comes verbatim from the read API (`poolKey` field). Direction:
    `zeroForOne=true` spends currency0. Check the hook is in
    `aggregator.hookRouting.open` first; closed hooks revert for external routers.
- **Launching onto Pons from your own wallet (RH)** — call Pons directly:
  `0x7eD5…1EC7e.launchToken{value: launchFee()}(params, 0, address(0))`; the
  TokenParams tuple layout is in the Pons section of `abis/`. SolonPad's frontend
  adds a flat 0.0002 ETH platform fee; calling the factory yourself, you owe nothing.


## §Agent loop — discover → factsheet → verdict → execute (v0.4)

The read API base is `https://solonpad.fun`. It is a convenience view over the
indexer; §VERIFY tells you how to spot-check it against the chain. Poll politely
(the site fronts Cloudflare; send a real User-Agent).

### D1. Discover

```
GET /api/launches?chain=arc|rh          # full list: {rows, blockNumber, indexing}
GET /api/changes?chain=arc              # no `since` → {events:[], cursor} (init)
GET /api/changes?chain=arc&since=<cursor>
```

- Poll `changes` every 15–60 s; `events` are `new_launch` records (v1 — more
  event types later), `cursor` is opaque, keep the newest one.
- Empty `events` returns the same cursor. HTTP `410` = cursor expired: refetch
  without `since` and continue from the fresh cursor (you may have missed
  events; reconcile against `launches` if completeness matters).
- `truncated: true` = more waiting: poll again immediately.

### D2. Factsheet

```
GET /api/factsheet/{token}?chain=arc|rh
→ { asof, identity, age, market, fees, tradeable, structure, flags }
```

- **Tri-state fields.** A group lists `unavailable` and `notApplicable` keys.
  `null` + listed in `unavailable` = not known — **never read it as zero**.
  Listed in `notApplicable` = this pan cannot have it (a curve pan has no hook
  tax). Neither state may add or subtract score in D3.
- `fees` discloses every cost before you trade: `routerFeeBps` (50), the pan's
  hook `buyTaxBps`/`sellTaxBps` (Argus pans carry these), `lpFeeBps`.
- `tradeable.value=false` comes with `reason` — believe it; the router will
  revert or the trade gate refuses anyway.

### D3. Verdict — rule-based score, calibrated on live data

From 100, **worst matching row only per field**; different fields add. Score
only fields the factsheet actually returned; an `unavailable` field skips its
row and counts in coverage.

| Field | Condition | Deduct |
|---|---|---|
| `structure.holderCount` | < 5 / < 20 / < 100 | −20 / −10 / −4 |
| `tradeable.value` | false | −25 |
| `market.volume24h` | == 0 | −12 |
| `market.trades24h` | < 5 | −6 |
| `fees` max(buyTaxBps, sellTaxBps) | > 1000 / > 500 | −20 / −8 |
| `age` (now − launchTimestamp) | < 10 min | −10 |
| `market.liquidity` | < $500 / < $2K | −20 / −8 |
| `flags.cloneNameHits` | > 0 | −10 |

- Coverage = executed rows ÷ 8; report it next to the score. Below 5/8, label
  the score indicative only.
- Output every deduction as `field → measured value → points`; close with
  "rule-based read of indexed data, not advice".
- **Calibration record (2026-09-18, live factsheets):** SOLON (flagship,
  842 holders, $101K/24h) → 100 · top Argus pan ($176K/24h) → ~100 ·
  semi-alive pan (3 holders, 4 trades) → 68 · dead matrix pan (2 holders,
  0 volume) → 62 · minutes-old untradeable Argus pan → ~47. `liquidity` and
  `cloneNameHits` were unavailable in this pass and scored as coverage.
  Re-calibrate against a fresh sample before tightening any threshold, and
  keep this record updated (date + samples + spread).
- Grades: ≥80 active · ≥60 stagnant, look closer · <60 avoid or wait.

### D4. Execution rails — `[FINANCIAL EXECUTION]`

Moving value requires your principal's explicit authorization. Without it,
stay read-only. With it, every step below is mandatory:

1. **Gate**: refuse while `tradeable.value != true`.
2. **Estimate**: `amountIn × spot` minus hook tax minus 0.5% router fee —
   list each line, do not net them silently.
3. **minOut** = estimate × (1 − slippage), slippage ≤ 5% unless your principal
   set another. **Never send minOut = 0.**
4. **Approve exact amounts.** ERC20-quoted buys approve the quote to the
   router (on Arc the native-USDC ERC-20 view `0x3600…0000`, 6-dec, is the
   same balance as your gas — spendable directly, no wrapping). Sells approve
   the token.
5. **Reconcile the receipt**: received vs minOut vs estimate. `v4Swap` refunds
   unspent input on partial fills — check the received amount, not tx success.
6. Failure table: revert on a closed hook → the pan is display-only; a
   `NativeMismatch` custom error → wrong value/approve path for this quote;
   output below minOut → slippage, re-quote before retrying; `410` from
   `changes` → stale cursor, re-init.

## §E. Cross-chain rail — Arc funding, any-chain execution (v0.5)

The rail extends D4 across chains: fund on **Arc native USDC**, execute on
**BSC, Solana, Robinhood or Arc itself**, sweep proceeds home. Non-custodial:
your keys never leave your machine (`RAIL_PK` for EVM chains, `RAIL_SOL_PK`
for Solana — base58 secret key or JSON byte array). The 0.5% rail fee is
enforced **at source**, not by these scripts: EVM lanes swap through a
FeeRouter contract, the Solana lane rides Jupiter's native `platformFeeBps`
into the treasury's USDC token account. Addresses: `addresses.json → rail`;
verify them on-chain before first value (VERIFY.md discipline applies).

### E1. Tools

```bash
cd tools && npm i
node crossbuy.mjs  --token <addr|mint> --usd 50 [--chain bsc|arc|rh|sol] [--single] [--yes]
node crosssell.mjs --token <addr|mint> [--pct 100] --chain <key> [--yes]
node sweepback.mjs --chain <key> [--usd all] [--yes]
```

- Without `--chain`, crossbuy auto-selects by deepest pool. Identity is the
  exact contract address: an EVM address is never matched against Solana or
  vice versa — same-name-different-address listings are different assets.
- Without `--yes`, every tool stops after printing the full
  `[FINANCIAL EXECUTION]` parameter echo. D4's authorization rule applies
  unchanged: no explicit principal authorization, no `--yes`.
- Every broadcast is preceded by a state write (`results/rail-<order>.json`).
  On any failure, re-run with the same `--order` — completed steps are
  skipped, never re-sent. That file is also your receipt.

### E2. What each lane does

| Lane | Quote | Fee point | Mechanics |
|---|---|---|---|
| `bsc` | USDT (18-dec) | PancakeFeeRouter | relay bridge → best-of v2 paths/v3 tiers → router swap. `--single`: ONE Arc signature — relay delivers exact-output USDT to the router and atomically executes the buy (destination revert = automatic full refund to your Arc wallet, live-tested) |
| `sol` | USDC (6-dec) | Jupiter `platformFeeBps` | relay bridge (SOL gas keeper auto-tops from Arc) → Jupiter route → fee lands in treasury USDC both directions |
| `rh` | ETH | SolonFeeRouter | self-gassing: ETH is quote AND gas; minOut from an eth_call simulation of the actual router call |
| `arc` | USDC | SolonFeeRouter | zero-bridge home lane |

### E3. Due-diligence gates (fail closed)

BSC: GoPlus `token_security` — honeypot, taxes >15%, `cannot_sell_all`, plus
deepest-pool LP <$10K refuses. Solana: GoPlus authorities model — **any
authority not explicitly renounced (freeze/mint/close/balance-mutable/
fee-change/hook-change) is a refusal**, absent or unknown fields are a
refusal (never a pass), Token-2022 transfer fees >15% — current or scheduled
— are a refusal, plus the same $10K LP floor. Arc/RH: the factsheet verdict
(§D3) is the gate — our own index carries no USD pool depth, so no depth
floor applies there. Your principal can override with `--force`; record
that they did.

### E4. Costs to price in (live-measured)

- Bridge legs ~0.4–1.4% each way depending on chain + relay fees; the quote
  echo itemizes before you sign anything.
- Round-trip friction, real smokes: BSC $10 ≈ $0.14 · RH $5 ≈ $0.47 ·
  Arc $3 ≈ $0.17 · Solana $5 ≈ $0.67 (includes one-time fee-account rent).
- `--single` premium ≈ $0.85 on a $10 order (prepaid destination gas +
  solver margin); it buys you needing no destination gas at all.
- Solana keeps a small SOL reserve in your wallet (gas keeper bridges ~$1.5
  when below 0.008 SOL); ATA rents ~0.002 SOL each are one-time per token.

### E5. Failure semantics an agent must know

- A relay quote containing `lifiIntents` is refused automatically (funds can
  hang in OIF escrow for days; hard-learned).
- Every exact-input bridge carries a **caller-derived minimum receive**,
  priced independently of the quote (stable parity, or Pancake/Jupiter/venue
  reference for ETH/SOL/gas legs). A quote whose committed minimum sits below
  that floor is refused before anything is signed — the quote's own numbers
  are never a floor, since a hostile responder controls all of them.
- `--single` bundles: if the destination transaction reverts, relay refunds
  the whole fill to your Arc wallet — there is no stuck-in-the-middle state.
- Bridge arrival timeouts do NOT mean lost funds: the state file holds the
  request; re-run the same `--order` to resume watching.
- Budget discipline: a buy spends only what this order bridged in (or, on
  quote-USDC lanes, pre-held quote up to the order target) — never your
  wallet's whole balance.

## §F. Premium data plane — pay per call over x402 (v0.6)

Five paid endpoints on `https://solonpad.fun`, priced in **Arc native USDC**
and paid in-band with **x402 v2** (HTTP 402 challenge → you sign one EIP-3009
`TransferWithAuthorization` → retry with the payment header). No account, no
API key, no top-up UI: the wallet you already hold for the rail *is* the
account. Free endpoints (§D) stay free and unchanged.

### F1. Endpoints and prices

| Endpoint | Scope | List | **Launch offer (−50%, what you pay)** | atomic |
|---|---|---:|---:|---:|
| `GET /api/premium/verdict/{token}?chain=arc\|rh` | factsheet + calibrated verdict + rail DD, one call | $0.02 | **$0.01** | `10000` |
| `POST /api/premium/verdicts` | 1–50 tokens, one chain, ordered results | $0.40 | **$0.20** | `200000` |
| `GET /api/premium/ohlcv?chain=bsc\|sol&token=&tf=&limit=1..5000` | deep OHLCV history (free tier = 200 candles) | $0.04 | **$0.02** | `20000` |
| `GET /api/premium/changes?chain=&since=` | 1000 events/page (free tier = 200) | $0.10 | **$0.05** | `50000` |
| `POST /api/premium/rpc-credit` | 10,000 RPC calls, all four chains, one voucher | $2 | **$1** | `1000000` |

Flat fees, independent of result count or cache hits. The wire amount is the
launch-offer column; the machine-readable source of truth is
`tools/x402-prices.json` (server and client both import it — if the 402
challenge and your pinned amount disagree, **nothing is signed**). Arc/RH
deep OHLCV is not sold because the free endpoint already returns full local
history. Batch pricing note: 20 tokens = break-even vs single calls; 50
distinct tokens = $0.004/verdict.

### F2. Paying (`tools/x402-pay.mjs`)

```bash
export RAIL_PK=0x...                    # payer key (same wallet as the rail)
export X402_PAY_TO=0x...                # pinned seller — from the skill repo, NOT from the challenge
node x402-pay.mjs 'https://solonpad.fun/api/premium/verdict/0xTOKEN?chain=arc'

X402_EXPECTED_AMOUNT=200000 X402_METHOD=POST \
  X402_BODY='{"chain":"arc","tokens":["0xA...","0xB..."]}' \
  node x402-pay.mjs 'https://solonpad.fun/api/premium/verdicts'
```

Rules the client enforces (and you must not weaken):

- **Pin everything**: seller (`X402_PAY_TO`), amount (`X402_EXPECTED_AMOUNT`),
  network `eip155:5042`, asset `0x3600…0000`. The advertised price in the
  challenge is never adopted; a mismatch aborts before any signature.
- The client reads the token's `name()/version()/DOMAIN_SEPARATOR()` on-chain
  and recomputes the EIP-712 domain before signing. HTTPS only (localhost
  exempt), redirects rejected.
- **One challenge, one signed retry, never an automatic re-sign.** EIP-3009
  signs transfer fields only (payer/recipient/amount/validity/nonce), not the
  URL or body — an intercepted authorization could be replayed against a
  different same-price body, so payment headers are secrets in transit.

### F3. Settlement semantics (what a 402-after-payment means)

- Cheap calls (single verdict, OHLCV) deliver after Circle `/verify`, settle
  asynchronously: `payment.status:"verified"`, `settlement:"pending"`.
- Expensive calls (batch, changes, rpc-credit — ≥ `50000` atomic) **settle
  before delivery**: you get data only with `payment.status:"settled"` and a
  transaction hash.
- A 402 after a settlement attempt carries `nonceLocked:true`,
  `resignAllowed:false` and ledger/Circle ids. **A timeout is not proof of
  failure** — the transfer may have landed. Keep the ids, reconcile out of
  band (the operator runs `x402-reconcile.mjs` against Circle's status API);
  re-signing blindly can pay twice.
- Billable = successfully constructed delivery: an empty changes page, a
  confirmed-missing token report and an annotated-partial history all bill;
  invalid input, quota denial (429) and deadline expiry never bill.

### F4. RPC credit pack

`POST /api/premium/rpc-credit` (no body) → `{voucher, credits:10000,
chains:["arc","bsc","rh","sol"]}`. The voucher is a 64-hex bearer; **the
server stores only its SHA-256 — lose the plaintext and the credits are
unrecoverable**, so persist it from the response immediately.

```bash
curl 'https://solonpad.fun/api/rpc/sol' -H "Authorization: Bearer $RPC_VOUCHER" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}'
```

One JSON-RPC entry = one credit, on any of the four chains, shared balance,
`X-RPC-Credits-Left` header on every response. Batches ≤50 entries and count
per entry. Once a call is forwarded upstream it is charged even if the
provider errors — no automatic refunds; treat ambiguous signed-transaction
submissions as possibly-landed (same discipline as §E5). Standard node
methods only (no websockets, no guaranteed archive depth). It is a
convenience tier — zero signup, four chains, one payment — not a
high-throughput SLA; heavy sustained loads should buy a provider plan
directly.

### F5. Why this exists (read once, same spirit as the platform note)

Paid calls fund the same treasury flywheel as the router fee: revenue →
development + on-chain SOLON buybacks, all auditable. Live revenue and
request counts are public at `https://solonpad.fun/agents` — verify, don't
trust. Not available to persons or entities in the United States, China, or
sanctioned jurisdictions.
