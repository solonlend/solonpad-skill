# VERIFY — run once per session, before the first value-moving tx

**One command runs every scriptable check below** (read-only, exits 1 on any red):

```bash
cd tools && npm i && node verify.mjs --factsheet 0xAnyListedToken
```

Manual-only items remain: provenance diffs (7, 8) and source-level review notes.

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
   balance) and permissionless `credit*`. No owner, no sweep. 18 functions total.
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
10. **Splitter is terminal**: FeeSplitter has no owner and no withdraw; positions sent
   to it are irrecoverable by design (fee streams only). Recipients and bps are
   immutable constructor state.
11. **Vault claim gating**: only the beneficiary NFT owner can claim; `collectFees`
   pays the caller nothing.

## Factsheet spot-check (v0.4)

The read API is convenience, the chain is truth. Once per session, pick any
listed token and cross-check:

1. `factsheet.market` price vs `StateView.getSlot0(poolId)` computed price
   (pool key from the factsheet's `identity.poolKey`, poolId = keccak of it).
2. For an `argus.world` pan: `factsheet.fees.buyTaxBps/sellTaxBps` vs the Argus
   Portal record — `Portal(0xB021Be536808f551b31789422Fd28a6c9c6e97Da)
   .launches(token)`, words 6/7 of the 11-word struct.
3. `asof.block` within ~100 blocks of `eth_blockNumber` (else the index is
   catching up — treat market fields as stale).

A mismatch means: trust the chain, distrust the endpoint, and stop trading
through the API until they agree again.
