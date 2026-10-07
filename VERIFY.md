# VERIFY — run once per session, before the first value-moving tx

**One command runs every scriptable check below** (read-only, exits 1 on any red):

```bash
cd tools && npm i && node verify.mjs
```

It covers 1–6, 9, 9b, §G 1–3, §V3-1 to §V3-4 and the V3.1 checks (33 checks at v1.3; §G 4 is printed for you to compare with your amount). Last full run 2026-10-07: 33/33 green. Manual-only items remain:
provenance diffs (7, 8), 10–11, §G 5 (source/bytecode review) and §S (the SOLON fee keeper's legs).

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

## §V3. Stock-dividend launchpad checks (before any V3 value-moving tx)

`V3 = addresses.json → v3`. `$ARC = https://rpc.mainnet.arc.io`,
`$RH = https://rpc.mainnet.chain.robinhood.com/rpc`. Every `cast` line below is read-only.
`verify.mjs` runs V3-1 to V3-4 for you; the commands let you reproduce any of them by hand.

**V3-1. Code is what was verified.**
- Sourcify: every address in `V3.contractsByDeployName` (52 on Arc), `V3.robinhood` (6 on
  chain 4663) and `V3.ethereum` (1 on chain 1) returned `"match": "match"` on 2026-10-07:
  `curl -s https://sourcify.dev/server/v2/contract/5042/0xDCFBD25f034D51Af797Dd7c5c914F16403B54E10`
  (the factory). The Arc explorer page links the same verified source.
- Runtime code: `keccak256(eth_getCode(addr)) == V3.codehashes[name]` for all 52 Arc
  contracts. By hand (this RPC has no `eth_getProof`, so hash the code yourself):
  `cast keccak $(cast code 0xDCFBD25f034D51Af797Dd7c5c914F16403B54E10 --rpc-url $ARC)`
  → `0x51af9093…6340e4`.
- BurnSink: `cast code 0xA6Fa998dEDd85BD22454d42819c360b2E4FB4c8B --rpc-url $ARC` → `0x5f80fd`
  (PUSH0 DUP1 REVERT: no function exists, nothing can leave).

**V3-2. The six-way split is the constant.** There is no getter: the split is a literal
in `V3FeeLedger._credit` (Sourcify source `src/v3/V3FeeLedger.sol` line 238,
`[uint256(5750), 1000, 1000, 500, 1000, 750]`). Confirm it on a real lot:
```bash
cast logs --from-block 23992449 --to-block 23992449 --address 0x70bb736eCBfBACf6bdDfbfeDd7E36D3Dac59e088 \
  'FeeCredited(bytes32 indexed poolId, uint256 indexed lotId, address indexed quote, uint256 amount, uint256[6] allocated)' --rpc-url $ARC
# amount 1e17 (0.1 USDC) → allocated 5.75e16 / 1e16 / 1e16 / 5e15 / 1e16 / 7.5e15
cast call 0x70bb736eCBfBACf6bdDfbfeDd7E36D3Dac59e088 'poolInfo(bytes32)((address,uint8,address,address[6]))' \
  0xf1ff2754da155633e39be10a76f1467536153aeabae4a1def1e8ca4ed1781bc7 --rpc-url $ARC
# beneficiaries: [coin, CreatorRightsNFT, DeskRewards, SolonStakingV2, BuybackBurnExecutor, ProtocolVault]
```
For any coin you trade, read `poolInfo(poolId)` and compare with `V3.feeBeneficiaries`.

**V3-3. Governance: 48h timelock behind a 3/5 Safe.**
```bash
G=0xF50875086526FC658D9c125B1D8E64Fa32aE7ddf; M=0x8798245d1606712828731a238e5414eefBbbB59C
cast call $G 'getMinDelay()(uint256)' --rpc-url $ARC                                   # 172800
cast call $G 'hasRole(bytes32,address)(bool)' $(cast keccak PROPOSER_ROLE) $M --rpc-url $ARC   # true
cast call $G 'bootstrapClosed()(bool)' --rpc-url $ARC                                  # true
cast call $M 'getThreshold()(uint256)' --rpc-url $ARC                                  # 3 (of 5 owners: getOwners())
cast call 0x9E8D7502A702d195631937aCb69bf30FfAd3786c 'owner()(address)' --rpc-url $ARC  # = $G (SolonStockHub)
cast call 0x02C83604Ba74a952f931Ab3D77C1Efe31935793D 'governance()(address)' --rpc-url $ARC  # = $G (DeskNFT)
```
`MIN_DELAY` is a constant and `updateDelay` refuses anything below it. The guardian Safe
`0x544e…29E4` (2/3) holds GUARDIAN and CANCELLER only. Before a large position, list
pending operations: `GET /api/v3/events?contract=V3Governance&event=CallScheduled` (or
`cast logs` on `$G`) and read what each one would change.

**V3-4. Reserves are 1:1 on two chains.** For each listed stock (NVDA shown):
```bash
cast call 0x2312290792Cf429605D09A42Fa43dAB810486c18 'totalSupply()(uint256)' --rpc-url $ARC          # NVDA.sol on Arc
cast call 0x9E8D7502A702d195631937aCb69bf30FfAd3786c 'supplyOf(address)(uint256)' 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC --rpc-url $ARC
cast call 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC 'balanceOf(address)(uint256)' 0x3504aA69ca9C5A5Bc3dA312a6c761e9633251cFc --rpc-url $RH   # RH ReserveVault
```
Pass: the third is at least the first. (The second is the hub's own view and simply
returns the first; it only shows the hub reads the token you think it does.) 2026-10-07: 3.769168 /
3.769168 / 4.400128 NVDA. `node tools/pad-read.mjs --reserves` prints all three stocks.

**V3-5. Before each trade (not scripted).**
- Simulate it: `V3Quoter.quote` for coins, `POST /api/v3/stocks/quote` plus your own
  RH-pool check for stock orders. Never sign a `minOut` of 0.
- `GET /api/v3/oracle/prices`: `Stale` means US markets are closed and stock orders fill at
  the Robinhood Chain pool price; size accordingly.
- `GET /api/v3/config` → `paused` empty, and `limits` cover your order.

**V3-6. Read API spot-check.** The API is convenience, the chain is truth. Once per
session: run one `verify[].cmd` from `/api/v3/stocks/reserves/assets` and compare; compare
one coin's `/api/launches` price with `StateView.getSlot0(poolId)`; check the envelope's
`asOfBlock` is within ~240 blocks of `eth_blockNumber` (`stale: false`). A mismatch means:
trust the chain, distrust the endpoint, stop trading through it until they agree.

## §G. Original SOLON staking pool checks (before staking there)

1. `S.solon()` == `A.staking.stakingToken` == `A.instantV4.flagship.token`.
2. `S.owner()` and `S.distributor()` match `addresses.json`; if not, find out
   why before sending value (both are mutable state). The distributor is also
   the SOLON fee keeper (§S below).
3. `SOLON.balanceOf(S) >= S.totalStaked() + S.rewardReserve()` — principal
   and committed rewards are fully backed.
4. `S.stakeCap() - S.totalStaked() >= amount`, `S.paused() == false`.
5. Source: `src/stake/SolonStaking.sol` in `solonlend/solonpad-contracts`.
   Sourcify-verified (match): https://repo.sourcify.dev/5042/0xB3E0b89b3Ba098D83072dd60c1946CFB3231688f
   build with that repo's `foundry.toml` and compare `eth_getCode(S)` with
   the artifact's `deployedBytecode`, masking `immutableReferences`.

## §S. SOLON's own pool fees: the keeper split (not scripted)

Since 2026-10-07 an off-chain keeper `K = 0xdD43ee6f3fc4786c62D0727F07F4c668EE9F4F13`
splits SOLON's own pool fees 57.5 / 5 / 20 / 17.5 (escrow / lane 0 / burn / protocol,
`SKILL.md` "SOLON's own pool fees"). No contract enforces that ratio. What you can check is
each leg, then compare the legs with each other:

```bash
SOLON=0xd36687146385F7Dc84A18FEA3D00319d39D6d1a0; S=0xB3E0b89b3Ba098D83072dd60c1946CFB3231688f
E=0x1efabB43f156102D4Cbd215cf5EA4972C4C6b6e8; K=0xdD43ee6f3fc4786c62D0727F07F4c668EE9F4F13; D=0x000000000000000000000000000000000000dEaD
# 57.5%: native USDC into V31StakingEscrow, from the keeper (page the range: < 10,000 blocks per call)
cast logs --address $E 'Deposited(address indexed from, address indexed asset, uint256 amount, uint256 totalIn)' $K 0x0000000000000000000000000000000000000000 --from-block <b> --to-block <b+9999> --rpc-url $ARC
cast call $E 'distributor()(address)' --rpc-url $ARC        # 0x0 until governance designates one (48h); nothing can leave before
# 5%: lane-0 injections into the original pool
cast logs --address $S 'RewardAdded(uint8 indexed lane, uint256 amount, bytes32 buybackTx)' 0 --from-block <b> --to-block <b+9999> --rpc-url $ARC
cast call $S 'laneInfo(uint8)(uint256,uint256,uint256,uint256)' 0 --rpc-url $ARC   # rate, periodFinish, duration, injected
# 20%: SOLON burned to the dead address by the keeper
cast logs --address $SOLON 'Transfer(address indexed from, address indexed to, uint256 value)' $K $D --from-block <b> --to-block <b+9999> --rpc-url $ARC
```

The 17.5% protocol leg stays in `K` and is booked off-chain only. The SOLON burn legs go to
`0x…dEaD`, not `BurnSink`: total SOLON burned = dead-address burns + `BurnSink` balance.
The dead address held 41,180,180.36 SOLON before the keeper's first burn (block 24712161),
so count the keeper's `Transfer` events rather than reading the balance.

10-07 inventory settlement, reproduce by hand (both from `K`, status 1):
`cast receipt 0x77778ae193251c633b719569d6b981ab935b14e611f025668ebd4e9a45deabf4 --rpc-url $ARC`
→ `RewardAdded(0, 1,018,306.43 SOLON)`, block 24712152;
`cast receipt 0xb68514196bce0b4d22402a59cd740f80ffaaf3ee70e43ee42e03fa6ff5a8d669 --rpc-url $ARC`
→ `Transfer(K → 0x…dEaD, 325,858.06 SOLON)`, block 24712162. Checked 2026-10-07.

