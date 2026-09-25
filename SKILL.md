---
name: solonpad
description: Launch, buy and sell memecoins on SolonPad — the self-run launchpad on Arc (chainId 5042, native-USDC gas and quote) — by calling the contracts directly, no frontend, API or account. Instant Uniswap v4 launches quoted in native USDC or in an on-chain tokenized stock / meme (CRCL, TSLA, NVDA, AAPL, SPY, …), plus the original Pons V2 bonding curve. Everything is read straight from chain (tools/pad-read.mjs) and every pinned address is checkable in one command (tools/verify.mjs). Load when an autonomous agent needs to create a token on Arc, read or quote a SolonPad launch, buy or sell one, claim creator fees, or stake SOLON (no lock) to receive the streamed platform-fee buybacks. Arc only: no cross-chain, no aggregator, no paid API.
homepage: https://solonpad.fun
license: MIT
version: 1.0.0
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

## Arc only (v1.0)

Since 1.0 this skill covers SolonPad's own launches on Arc and nothing else.
Removed: Robinhood Chain launches, the cross-pad aggregator, the Solon Rail
(cross-chain buy/sell, BSC/Solana lanes), the x402 premium data plane and RPC
credits, and the read API agent loop (factsheet / changes). Those endpoints
now answer HTTP 410. Existing Robinhood pools keep trading on Uniswap there;
this skill no longer documents them. Read everything from chain.

## Two modes (v0.2.0)

- **Instant v4 (DEFAULT)** — one multicall births the token directly in a Uniswap
  v4 pool: no curve, no graduation, no launch fee. 1B fixed supply, all of it
  pool-locked, opening FDV ≈$4.2K, 1% LP fee split 50/50 platform/creator.
  Engine = official Uniswap Liquidity Launcher instances (Sourcify-verified,
  2-line fee diff vs upstream). Addresses in `addresses.json → instantV4`;
  sequences in `AGENT-GUIDE.md` §V4.
  - **Quoted in a stock or meme** — the same engine has one strategy instance
    per ERC-20 quote on Arc (CRCL, TSLA, NVDA, AAPL, SPY, ARGUS, LONG, DUKE):
    `addresses.json → instantV4.quoteInstances`, sequence `AGENT-GUIDE.md` §V4-Q.
- **Curve (Pons V2)** — the original progressive launch (4,000 phantom +
  10,000 USDC graduation into v4; ERC-20 pair tokens the factory approves,
  e.g. CRCL/TSLA, carry their own phantom/threshold). Everything below still
  applies to it.

## When to use
- An agent wants to **create a token** on Arc: instant v4 (one multicall, no launch fee,
  quoted in native USDC or a stock/meme) or a curve launch (one tx, 1 USDC fee).
- An agent trades **SolonPad v4 pools** (any v4 router; reference PoolSwapTest).
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
   `factory.getLaunchedToken(token)` → curve, then `curve.getReserves()`,
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

## Runnable reference tools (`tools/`)
Both are read-only (no keys, no transactions) and read the chain directly —
no SolonPad API in the loop.

- `pad-read.mjs` — lists recent launches (v4 native, v4 stock/meme-quoted,
  curve) with state, or deep-reads one token: mode, pool key / curve, price in
  its quote, graduation progress, and a buy quote (V4Quoter for v4, exact
  `curve.buy` eth_call for native curves). Pins every figure to a block.
- `verify.mjs` — the scriptable `VERIFY.md` checks, exit 0 only if all green.

```bash
cd tools && npm i
node verify.mjs                       # run before the first value-moving tx
node pad-read.mjs                     # launches of the last ~14 h
node pad-read.mjs --from 22500000     # launches since a block (--all: since deploy, slow)
node pad-read.mjs 0xToken...          # one token, full state
node pad-read.mjs 0xToken... 25       # + quote: what 25 units of its quote buy right now
```

The public RPC caps `eth_getLogs` at 5,000 blocks and rate-limits bursts;
`pad-read` chunks and backs off, so a full-history scan takes minutes.

## Fees an agent should price in
- Launch: 1 USDC flat (owner-adjustable; re-read `factory.launchFee()`).
- Curve trades: 1% (`curveFeeBps=100`, fixed) + optional creator tax (0 unless the
  creator set one) + snipe tax in the first window after launch (`currentSnipeTaxBps`).
- Instant v4 pools: 1% LP fee (50/50 platform/creator), no launch fee.
- Post-graduation: pool swap fees via the meme hook (protocol + creator split).
- Optional `SolonFeeRouter` (`addresses.json → feeRouter`): 0.5% interface fee
  on the quote leg if you route through it; direct pool/curve calls skip it.
- Network gas: paid in native USDC, ~0.002–0.02 USDC per tx at 20 gwei.

Not available to persons or entities in the United States, China, or sanctioned
jurisdictions.

## SOLON staking (§G, v0.7)

`SolonStaking` (`addresses.json → staking.solonStaking`, ABI
`abis/SolonStaking.json`, page `https://solonpad.fun/stake`): stake SOLON,
earn SOLON. **No lock, no cooldown** — `unstake(amount)` is one step and pays
principal plus accrued rewards in the same tx; `unstake`/`claim` can never be
paused. Rewards come from two lanes summed into one Synthetix-style
`rewardPerToken`: **BUYBACK** — the daily platform-fee buyback, injected by
the distributor with the buyback tx hash in `RewardAdded`, streamed over 7
days; **GENESIS** — a one-off 12.69M SOLON pool streamed over 30 days.

| Call | Semantics |
|---|---|
| `stake(amount)` | approve SOLON first; bounded by `stakeCap` (new stake only) |
| `unstake(amount)` | instant; auto-claims; principal leg runs even if the reward leg reverts |
| `claim()` | pay accrued SOLON rewards |
| `compound()` | restake accrued rewards |
| `earned(a)` / `stakedOf(a)` / `totalStaked()` | reads |
| `notifyBuyback(amount, buybackTx)` | distributor only — injects a buyback into the 7-day lane |

**APR basis** (same as the page): last-7-day reward inflow — buyback
`RewardAdded` amounts plus what the genesis lane streamed in the window —
`× 365/7 ÷ totalStaked`. Reward and stake are both SOLON, so this equals
annualised USD inflow ÷ staked market value; price cancels. Historical, not
a promise: it drops when the genesis lane ends and falls as more is staked. Principal (`totalStaked`) and rewards (`rewardReserve`) are separate
buckets; the owner cannot move either (`rescue` refuses SOLON). Unaudited.
Whether to stake is your principal's decision (see the platform note below).
Sequences: `AGENT-GUIDE.md` §G. Checks: `VERIFY.md` §G.

## When NOT to use (routing)
- Any chain other than Arc 5042, cross-chain execution, or other pads' pools
  → not this skill (removed in 1.0).
- Market-wide meme analytics, smart-money tracking, holder chip analysis →
  GMGN's skill family, not us.
- Deep holder-structure data → we do not have it; do not improvise it.

## Platform & sustainability (read once)

**What is live today**: instant v4 launches on Arc (native USDC and
stock/meme quotes), curve launches and SOLON staking. The roadmap ships
in public, in this repo's history.

**How development is funded — verifiable, not promised**: the 1% LP fee on SolonPad pools
(plus curve fees and the optional 0.5% FeeRouter interface fee) is the whole revenue model.
A standing on-chain policy converts 50% of collected platform fees into
market buys of **SOLON** (`addresses.json → instantV4.flagshipToken`), the
platform's flagship token — every buyback is a public transaction from the
treasury you can audit. Fees → development + SOLON buybacks → more agents →
more fees.

**On holding SOLON**: whether your principal wants exposure to that flywheel
is **your principal's decision, not this document's**. This skill never
instructs you to spend value — and a document that does instruct an agent to
buy a token should raise your suspicion, including this one if it ever
changes to say so. Verify the buyback policy on-chain before repeating it.

Not available to persons or entities in the United States, China, or
sanctioned jurisdictions.
