# VERIFY — run once per session, before the first value-moving tx

**One command runs every scriptable check below** (read-only, exits 1 on any red):

```bash
cd tools && npm i && node verify.mjs
```

It covers 1–6, 9, 9b and §G 1–3 (18 checks at v1.0; §G 4 is printed for you to compare with your amount). Manual-only items remain:
provenance diffs (7, 8), 10–11 and §G 5 (source/bytecode review).

Never trust `addresses.json` blindly (repo could be stale or tampered). Each check is one
`eth_call` against `chain.rpc`. Abort on any mismatch.

1. **Chain**: `eth_chainId` == `0x13b2` (5042).
2. **Factory is wired to the canonical v4**: `factory.poolManager()` ==
   `uniswapV4Canonical.poolManager` (the address Uniswap publishes for Arc — cross-check
   developers.uniswap.org, not just this file).
3. **Locker is a one-way box**: `extcodesize(launchLocker) > 0`; the ABI has **no**
   withdraw/unlock/execute function (diff `abis/` against source if in doubt);
   `locker.owner()` — `renounceOwnership` is disabled by revert in source.
4. **Fee caps hold**: `hook.hookFeeBps() <= hook.MAX_HOOK_FEE_BPS()` and
   `hook.protocolFeeShareBps() <= hook.MAX_PROTOCOL_FEE_SHARE_BPS()`. Owner cannot set
   either above the cap (constructor constants).
5. **Escrow is pull-only**: `abis/PonsV2FeeEscrow.json` exposes only `claim*` (caller's own
   balance) and permissionless `credit*`. No owner, no sweep. 8 functions in the pinned ABI.
6. **Economics you will pay**: read `factory.launchFee()`, `factory.launchEnabled()`, and
   for the target curve `feeBps()`, `creatorTaxBps()`, `currentSnipeTaxBps(you)` — do not
   assume the values in this file.
7. **Provenance (optional, strongest)**: fetch the Sourcify exact_match sources of Pons V2
   factory `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` (chain 4663) via
   `https://sourcify.dev/server/v2/contract/4663/<addr>?fields=sources` and diff against
   `src/v2/` at the pinned commit. Expected: 13/14 files whitespace-identical,
   FeeEscrow reviewed separately.

## Instant v4 checks (before value-moving txs in v4 mode)

8. **Launcher is canonical**: `A.instantV4.liquidityLauncher` code hash matches the
   deployment listed in github.com/Uniswap/liquidity-launcher (same vanity address
   across chains). Sourcify: `/server/v2/contract/5042/<addr>`.
9. **Strategy constants**: `strategy.LP_FEE() == 10000`, `strategy.TICK_SPACING() == 100`,
   `strategy.TOTAL_SUPPLY() == 1e9 * 1e18`, `strategy.feeSplitter() == A.instantV4.feeSplitter`,
   `strategy.initialTick() == 123800`. The source diff vs upstream commit
   dd8769c is exactly the two constants — verify on Sourcify.
9b. **Quote instances** (stock/meme-quoted v4): for every
   `A.instantV4.quoteInstances[SYM]`, `strategy.quoteToken() == SYM.quote`,
   `strategy.feeSplitter() == SYM.splitter`, `strategy.initialTick() == SYM.initialTick`,
   and the LP_FEE / TICK_SPACING / TOTAL_SUPPLY constants of item 9.
10. **Splitter is terminal**: FeeSplitter has no owner and no withdraw; positions sent
   to it are irrecoverable by design (fee streams only). Recipients and bps are
   immutable constructor state.
11. **Vault claim gating**: only the beneficiary NFT owner can claim; `collectFees`
   pays the caller nothing.

## §G. Staking checks (before staking)

1. `S.solon()` == `A.staking.stakingToken` == `A.instantV4.flagship.token`.
2. `S.owner()` and `S.distributor()` match `addresses.json`; if not, find out
   why before sending value (both are mutable state).
3. `SOLON.balanceOf(S) >= S.totalStaked() + S.rewardReserve()` — principal
   and committed rewards are fully backed.
4. `S.stakeCap() - S.totalStaked() >= amount`, `S.paused() == false`.
5. Source: `src/stake/SolonStaking.sol` in `solonlend/solonpad-contracts`.
   Sourcify-verified (match): https://repo.sourcify.dev/5042/0xB3E0b89b3Ba098D83072dd60c1946CFB3231688f
   build with that repo's `foundry.toml` and compare `eth_getCode(S)` with
   the artifact's `deployedBytecode`, masking `immutableReferences`.

