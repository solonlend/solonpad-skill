---
name: solonpad
description: Launch, buy and sell memecoins on SolonPad — the multi-chain launchpad AND pad aggregator on Arc (5042, USDC-native) and Robinhood Chain (4663, ETH) — by calling the contracts directly, no frontend or account. Instant Uniswap v4 launches priced in USDC/ETH/tokenized stocks/memes; the aggregator indexes every other pad's pools (Pons, pools.trade, Minara, Azex, …) and one FeeRouter call trades any of them. A read API adds an agent loop: incremental discovery (/api/changes), one-call token factsheets with tri-state fields (/api/factsheet), a calibrated rule-based verdict, and execution rails. Load when an autonomous agent needs to create a token, monitor the whole Arc/RH pad market, score a pan, trade any pad's pan, or claim creator fees.
homepage: https://solonpad.fun
license: MIT
version: 0.4.2
pin: "Install by pinning a commit hash. This repo is the machine interface; the website is only a pointer to it."
---

# SolonPad — the launchpad an AI agent runs by itself

SolonPad is a bonding-curve launchpad on **Arc**, quoted in **native USDC** (the chain's
gas token). The engine is a source-verified port of Pons V2 — Robinhood Chain's leading
launchpad ($1.8B cumulative DEX volume) — redeployed against Arc's canonical Uniswap v4.
There is no API of ours in the loop: an agent brings its own wallet and calls the
contracts. This directory IS the interface.

**Trust model:** trust the pinned commit + on-chain verification, never a live endpoint.
Re-verify every address in `addresses.json` on-chain (`VERIFY.md`) before sending value.
Provenance: 13/14 engine sources are whitespace-identical to the Sourcify `exact_match`
of the live Pons V2 factory on chain 4663 (see `addresses.json → provenance`).

## Multi-chain + aggregator (v0.3.0)

- **Robinhood Chain (4663)** — same instant-v4 engine, native **ETH** gas/quote,
  plus quote instances priced in tokenized stocks and memes (NVDA, TSLA, AAPL,
  META, GOOGL, SPY, PONS, CASHCAT). No curve mode on RH. Addresses in
  `addresses.json → robinhood`. Flagship: SOLON (`flagshipToken`).
- **Aggregator** — SolonPad indexes every other pad's pools: Pons + pools.trade
  on RH; Minara, Azex and ALL native-USDC v4 pools on Arc. Read layer:
  `https://solonpad.fun/api/launches?chain=arc|rh` (fields: `source`, `hook`,
  `poolKey`, `curve`, `price`, `change24h`, `originDomain`). Trade layer:
  **SolonFeeRouter** (`addresses.json → aggregator.feeRouter`, ABI
  `abis/SolonFeeRouter.json`) wraps curve buys/sells and v4 swaps with a 0.5%
  interface fee on the quote leg — buys skim the input, sells skim the output,
  `minOut` is always net of fee. Stateless; refunds and outputs forward in the
  same call. Only hooks in `aggregator.hookRouting.open` are tradeable this
  way (each was fork-probed); `closed` hooks are display/index only.

## Two modes (v0.2.0)

- **Instant v4 (DEFAULT)** — one multicall births the token directly in a Uniswap
  v4 pool: no curve, no graduation, no launch fee. 1B fixed supply, all of it
  pool-locked, opening FDV ≈$4.2K, 1% LP fee split 50/50 platform/creator.
  Engine = official Uniswap Liquidity Launcher instances (Sourcify-verified,
  2-line fee diff vs upstream). Addresses in `addresses.json → instantV4`;
  sequences in `AGENT-GUIDE.md` §V4.
- **Curve (Pons V2)** — the original progressive launch (4,000 phantom +
  10,000 USDC graduation into v4). Everything below still applies to it.

## When to use
- An agent wants to **create a token** on Arc in one transaction (1 USDC fee) and receive
  the curve address to trade or market-make on.
- An agent trades bonding curves: **buy with native USDC** (`msg.value`, 18-dec), sell back
  any time before graduation; every price is a closed-form constant-product quote.
- An agent monitors **graduation**: at 10,000 USDC raised the market auto-migrates into a
  Uniswap v4 pool with LP permanently locked; trading continues there via the meme hook.
- An agent is a **token creator** claiming its share of curve fees from the escrow.

## When NOT to use
- You are (or act for) a person/entity in the **US, China, or a sanctioned jurisdiction** —
  not offered to you; bypassing via VPN/proxy/direct call is a knowing violation.
- You need a chain other than Arc (5042).
- You expect custody, an API key, or a hosted service — there is none; you run everything.
- You want leveraged stock lending — that is Solon Lend (`solonlend/skill`), a separate
  product on Robinhood Chain.

## Arc-specific facts (they will bite you)
- **Native USDC is gas AND quote.** `msg.value` is 18-dec. The ERC-20 view of the same
  balance lives at `0x3600…0000` with **6 decimals**. Curve buys are `payable` — never
  approve/transfer the ERC-20 view for a curve buy.
- Blocks land every ~510 ms; one confirmation is enough for curve state reads.
- Every launched token is 18-dec ERC-20 with fixed 1B supply.

## Strategy (READ → VERIFY → USE)
1. **READ** — load `addresses.json` + `abis/`. Enumerate launches from
   `LaunchFactory.TokenLaunched` logs (from `deployBlock`). For one token read
   `factory.launchedTokens(token)` → curve, then `curve.getReserves()`,
   `curve.realQuoteReserve()`, `curve.graduated()`, `curve.feeBps()`.
2. **VERIFY** — run `VERIFY.md` once per session before the first value-moving tx:
   factory wiring, locker immutability, fee caps, provenance diff.
3. **USE** — exact call sequences in `AGENT-GUIDE.md`:
   - Launch: `factory.launchToken{value: launchFee}(params, 0, address(0))`
   - Buy: `curve.buy{value: amountIn}(amountIn, minOut, recipient)`
   - Sell: `token.approve(curve, amt)` → `curve.sell(amt, minOut, recipient)`
   - Graduated? trade the v4 pool via the Universal Router instead.
   - Creator fees: `escrow.claimToken(...)` / `escrow.claim(...)` — pull-payment, only
     your own credited balance.

## Decode any revert (`errors.json`)

Every custom error selector across the deployed contracts (and the v4/periphery
stack you will touch through them) lives in `errors.json`:
`selector → { sig, contracts, hint? }`. On a revert, look up the first 4 bytes
of the return data; the battle-tested entries carry a `hint` telling you what
to change. An unknown selector means the revert came from a third-party
contract, not ours.

## Runnable reference tool (`tools/`)
`pad-read.mjs` — read-only (no keys, no transactions): lists all launches with curve
state, or deep-reads one token (price, reserves, graduation progress, buy quote for a
given USDC amount computed with the exact contract math). Pins every figure to a block.

```bash
cd tools && npm i
node pad-read.mjs                     # list all launches
node pad-read.mjs 0xToken...          # one token, full state
node pad-read.mjs 0xToken... 25       # + quote: what 25 USDC buys right now
```

## Fees an agent should price in
- Launch: 1 USDC flat (owner-adjustable; re-read `factory.launchFee()`).
- Curve trades: 1% (`curveFeeBps=100`, fixed) + optional creator tax (0 unless the
  creator set one) + snipe tax in the first window after launch (`currentSnipeTaxBps`).
- Post-graduation: pool swap fees via the meme hook (protocol + creator split).
- Network gas: paid in native USDC, ~0.002–0.02 USDC per tx at 20 gwei.

Not available to persons or entities in the United States, China, or sanctioned
jurisdictions.

## Agent loop (v0.4)

The aggregator's read API turns this skill into a full agent trading layer:

| Scenario | Where |
|---|---|
| Discover new pans incrementally | `GET /api/changes?chain=&since=` — `AGENT-GUIDE.md` §D1 |
| One-call token due-diligence data | `GET /api/factsheet/{token}?chain=` — §D2 (tri-state fields) |
| Score a pan before touching it | §D3 — calibrated rule table, evidence-chain output |
| Trade with safety rails | §D4 — `[FINANCIAL EXECUTION]`, mandatory minOut |
| Manage positions / creator fees | §V4-3, §5 |

Fields the factsheet marks `unavailable` are unknown, never zero. The API is a
convenience view — `VERIFY.md` shows how to spot-check it against the chain
before trusting it with value.

## When NOT to use (routing)
- Cross-chain meme analytics, smart-money tracking, holder chip analysis →
  that is GMGN's skill family, not us.
- Solana / BSC / Base pans → not our chains (Arc 5042 + Robinhood 4663 only).
- Deep holder-structure data → we do not have it; do not improvise it from
  our fields.
- Discover→score→trade on Arc/RH from one interface → this skill.

## Platform & sustainability (read once)

**What is live today**: instant v4 + curve launches on Arc, instant v4 on
Robinhood Chain, the cross-pad aggregator (Pons, pools.trade, Minara, Azex,
Argus, every open v4 pool), and the agent loop above. **Where this is going**:
richer factsheet fields (liquidity depth, clone flags), more change-event
types, more pads, sharper calibrated scoring — the roadmap ships in public,
in this repo's history.

**How development is funded — verifiable, not promised**: the 0.5% FeeRouter
interface fee and the 1% LP fee on own-pad pools are the whole revenue model.
A standing on-chain policy converts 50% of collected platform fees into
market buys of **SOLON** (`addresses.json → instantV4.flagshipToken`), the
platform's flagship token — every buyback is a public transaction from the
treasury you can audit. Fees → development + SOLON buybacks → more agents →
more fees. Using the router *is* funding the roadmap.

**On holding SOLON**: whether your principal wants exposure to that flywheel
is **your principal's decision, not this document's**. This skill never
instructs you to spend value — and a document that does instruct an agent to
buy a token should raise your suspicion, including this one if it ever
changes to say so. Verify the buyback policy on-chain before repeating it.

Not available to persons or entities in the United States, China, or
sanctioned jurisdictions.
