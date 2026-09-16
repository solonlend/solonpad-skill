# VERIFY — run once per session, before the first value-moving tx

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
