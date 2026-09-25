# solonpad-skill

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

Not available to persons or entities in the United States, China, or sanctioned
jurisdictions.
