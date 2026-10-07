# solonpad-skill

## What changed in 1.1

V3, the stock-dividend launchpad (live on Arc since 2026-10-03): every V3 coin's 1% trade
fee is split six ways by an immutable constant and the holder share is paid out in
tokenized stock. New: V3 sections in `SKILL.md` / `AGENT-GUIDE.md` (§V3-0 to §V3-11) /
`VERIFY.md` (§V3), `addresses.json → v3` (every V3 contract and its runtime codehash),
`abis/v3/` (18 Sourcify-verified ABIs), 200 more `errors.json` selectors, V3 checks in
`verify.mjs` and V3 / reserves modes in `pad-read.mjs`.

## What changed in 1.0

Arc only: removed Robinhood Chain launches, the cross-pad aggregator, the Solon Rail
cross-chain tools (crossbuy/crosssell/sweepback, BSC/Solana/RH lanes, Relay validators),
the x402 premium data client and RPC credits, and the factsheet/changes API agent loop —
`pad-read` and `verify` now read the chain only.

The machine interface for [SolonPad](https://solonpad.fun) — the USDC-native memecoin
launchpad on Arc (chainId 5042). An autonomous agent loads `SKILL.md`, verifies every
address on-chain (`VERIFY.md`), and launches/trades by calling the contracts directly.
No API, no account, no frontend required.

- `SKILL.md` — when and how an agent should use this
- `addresses.json` — pinned chain + contract addresses (verify before use), incl. the
  stock/meme-quoted instant v4 instances (`instantV4.quoteInstances`)
- `AGENT-GUIDE.md` — exact call sequences (instant v4 / stock-quoted v4 / curve / fees / staking)
- `VERIFY.md` — the on-chain checklist to run before sending value
- `abis/` — the ABIs an agent needs
- `errors.json` — revert selector dictionary
- `tools/verify.mjs` — one-command read-only trust check (`node verify.mjs`)
- `tools/pad-read.mjs` — read-only launch reader and quoter, chain-only
- SOLON staking (`addresses.json → staking`, `abis/SolonStaking.json`, `AGENT-GUIDE.md` §G) — stake SOLON, earn the streamed platform-fee buyback; no lock, no cooldown ([solonpad.fun/stake](https://solonpad.fun/stake))

```bash
cd tools && npm i
npm test            # offline consistency tests
node verify.mjs     # mainnet read-only checks
node pad-read.mjs   # recent launches
```

Engine provenance: source-matched to Pons V2 (Robinhood Chain, Sourcify exact_match) —
see `addresses.json → provenance`.

Not available to persons or entities in the United States, China, Japan, or sanctioned
jurisdictions.
