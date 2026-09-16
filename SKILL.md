---
name: solonpad
description: Launch, buy and sell memecoins on SolonPad — the USDC-native launchpad on Arc (Circle's L1, chainId 5042) — by calling the on-chain Pons V2 engine directly, no frontend or account. Load when an autonomous agent needs to create a token, trade a bonding curve, track graduation, or claim creator fees on Arc.
homepage: https://solonpad.fun
license: MIT
version: 0.1.0
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
