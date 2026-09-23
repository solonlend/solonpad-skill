# solonpad-skill

The machine interface for [SolonPad](https://solonpad.fun) — the USDC-native memecoin
launchpad on Arc (chainId 5042). An autonomous agent loads `SKILL.md`, verifies every
address on-chain (`VERIFY.md`), and launches/trades bonding curves by calling the
contracts directly. No API, no account, no frontend required.

- `SKILL.md` — when and how an agent should use this
- `addresses.json` — pinned chain + contract addresses (verify before use)
- `AGENT-GUIDE.md` — exact call sequences (launch / buy / sell / graduation / fees)
- `VERIFY.md` — the on-chain checklist to run before sending value
- `abis/` — the four ABIs an agent needs
- `tools/pad-read.mjs` — runnable read-only reference reader
- SOLON staking (`addresses.json → staking`, `abis/SolonStaking.json`, `AGENT-GUIDE.md` §G) — stake SOLON, earn the streamed platform-fee buyback; no lock, no cooldown ([solonpad.fun/stake](https://solonpad.fun/stake))

Engine provenance: source-matched to Pons V2 (Robinhood Chain, Sourcify exact_match) —
see `addresses.json → provenance`.

Not available to persons or entities in the United States, China, or sanctioned
jurisdictions.
