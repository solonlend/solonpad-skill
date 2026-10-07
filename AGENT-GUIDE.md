# SolonPad: agent call sequences

**V3.1 is the launch stack since 2026-10-07** and comes first in this file. V3.0 (default
2026-10-03 to 10-07) follows: its coins still trade and pay, its launch call is retired.
The legacy V2 modes (instant v4 since 2026-09-16, and the Pons V2 bonding curve) remain
callable and come last. `A = addresses.json`, `V31 = A.v31`, `V3 = A.v3`. Native USDC
amounts are 18-dec `msg.value` throughout; every stock token is 18-dec; USDG on Robinhood
Chain is 6-dec.

Every write below is `[FINANCIAL EXECUTION]`: it needs your principal's explicit
authorization (see Execution rules below). Run `node tools/verify.mjs` first; every check must be green.

# V3.1: the current launch stack

Eight contracts, `V31.contracts`, ABIs in `abis/v31/` (plus `V31Token.json` for every coin).
No owner; V3Governance (48h timelock) is the only authority, the guardian can only stop
things (V31-7). What it reuses from V3.0: RewardRoundManager / RewardVault /
RewardPayoutVault / RewardDistributor (kind-0 holder rounds), DeskRewards, ProtocolVault,
BurnSink, SolonFeeRouter (buyback leg), SolonStockHub (market state), LaunchPayoutChoice.

## V31-0. Discover coins

```
logs = eth_getLogs({ address: V31.contracts.V31LaunchFactory, fromBlock: V31.deployedAtBlock,
         topics: [TokenLaunched(address indexed token, address indexed deployer, bytes32 indexed poolId,
                                address pairToken, address holderSource, uint256 positionId, uint256 payoutChoiceId)] })
         # pairToken 0x0 = USDC (kind 0), NVDA.sol = kind 1; no metadataHash field
key  = V31LaunchFactory.poolKeyFor(token, pairToken)   # {sorted, fee 10000, tickSpacing 100, hooks 0x0}
assert V31LaunchFactory.tokenOfPool(poolId) == token    # the authority: the key shape equals a legacy instant v4 pool
V31FeeSplitter.launchOf(poolId) → (key, positionId, token, quote, creator /* launcher, not the current right holder */)
token.logo() / description() / getTokenInfo()           # metadata lives in the token
```

`node tools/pad-read.mjs --v31` does the paged scan; `pad-read.mjs 0xCoin 25` prints one coin
with a V4Quoter buy quote. Price: `StateView.getSlot0(poolId)` (same math as V3-0).

## V31-1. Launch a coin (1 tx, no launch fee, optional first buy)

```
p = LaunchParams {
  name, symbol, logo, description,
  socials: { twitter, telegram, discord, website, farcaster },   # strings, may be empty
  salt,                    # random bytes32; the CREATE2 salt is keccak256(msg.sender, salt)
  payoutChoiceId,          # kind 0: GET /api/v3/payout-choices (0 = default rotation); kind 1: must be 0
  minFirstBuyOut,          # coins out floor for the first buy; 0 only when there is no first buy
  quote,                   # 0x0 = native USDC (kind 0) | V31.wiring.stockQuote = NVDA.sol (kind 1)
  firstBuyStock }          # kind 1 first buy in NVDA.sol raw; kind 0 must be 0

# kind 0: first buy = msg.value (0 for none)
r = eth_call V31LaunchFactory.launch(p) {value: firstBuy}      # simulate: r.firstBuyOut
p.minFirstBuyOut = r.firstBuyOut × (1 − s)
V31LaunchFactory.launch(p) {value: firstBuy}
  → Result { token, poolId, positionId, holderSource, firstBuyOut }

# kind 1 (NVDA.sol pair): precheck, approve, msg.value 0
V31LaunchFactory.stockLaunchTick()             # view; must not revert (see below)
NVDA.sol.approve(V31LaunchFactory, firstBuyStock)
V31LaunchFactory.launch(p) {value: 0}
```

- Supply fixed at 1,000,000,000 × 1e18. The factory mints all of it into one single-sided
  position (USDC coins: tick range [-160100, 123800], opening tick 123800, ≈ $4.2K FDV;
  kind 1 opens at the launch oracle's NVDA.sol price for the same USD FDV) and the position
  NFT goes to `V31FeeSplitter`, which has no decrease, withdraw or owner path. Rounding dust
  goes to `0xdEaD`.
- You (the sender) receive the pool's `V31CreatorRightsNFT` (the 10% stream). There is no
  `creator` argument: the launcher is `msg.sender`.
- First buy: executed inside the launch through the PoolManager at the full price range,
  so `minFirstBuyOut` is your only floor (`InvalidLaunch` below it). A USDC coin's opening
  pool is fixed, so the simulation is exact at that block; a kind-1 coin's opening price can
  move between simulation and block. Unspent input is refunded. Without a first buy the coin
  opens with no holder; scanners may flag a pool nobody has sold into.
- Reverts: `Paused()` (guardian paused launches), `InvalidLaunch()` (kind-1 rules above,
  disabled payout choice, first buy below floor), `PoolPreInitialized()` (someone
  initialized your predicted pool and both re-derived salts in this block: retry next block
  or with a new salt); kind 1 also `StockMarketClosed(open, transferable)`,
  `StockPriceNotLive(status)` (2 Stale, 3 Divergent, 4 Suspect, 5 Paused),
  `StockPriceStale(updatedAt, window)`, `StockPriceInvalid(answer)`. On 2026-10-07
  `stockLaunchTick()` reverted `StockPriceNotLive(2)`; `verify.mjs` prints its current state.
- Measured: the one mainnet V3.1 launch (`PROBE31`, block 24317117, 5 USDC first buy) used
  1,799,435 gas.

## V31-2. Trade (Uniswap v4: UniversalRouter v2.1.2 + Permit2)

V3Router / V3Quoter do not serve V3.1 pools (no hook). Use Uniswap's periphery
(`V31.trade`):

```
key        = V31LaunchFactory.poolKeyFor(coin, quote)
zeroForOne = (key.currency0 == input currency)          # buy: input = quote; sell: input = coin
out        = eth_call V4Quoter.quoteExactInputSingle({poolKey: key, zeroForOne, exactAmount: amountIn, hookData: 0x})[0]
minOut     = out × (1 − s)                              # never 0

actions = abi.encodePacked(uint8 0x06 SWAP_EXACT_IN_SINGLE, uint8 0x0c SETTLE_ALL, uint8 0x0f TAKE_ALL)
params  = [ abi.encode(ExactInputSingleParams{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut,
                                               minHopPriceX36: 0, hookData: 0x }),   # UR >= 2.1.1 layout
            abi.encode(inputCurrency, amountIn),         # SETTLE_ALL: at most amountIn
            abi.encode(outputCurrency, minOut) ]         # TAKE_ALL: at least minOut, paid to msg.sender
v4swap  = abi.encode(actions, params)

# buy with native USDC: commands = 0x10 V4_SWAP, 0x04 SWEEP (returns unspent native value)
UniversalRouter.execute{value: amountIn}(0x1004, [v4swap, abi.encode(0x0, you, 0)], deadline)
# sell (or a kind-1 buy paying NVDA.sol): one-time approvals, then V4_SWAP only
coin.approve(Permit2, amount)                                  # the site approves max; exact is safer
Permit2.approve(coin, UniversalRouter, uint160 amount, uint48 expiration)
UniversalRouter.execute(0x10, [v4swap], deadline)
```

- Fee: the pool's 1% LP fee, in the input currency, is the only fee (no hook, no router fee).
  `quoteExactInputSingle` already nets it. There is no partial-fill guard: `minOut` is the
  floor; reverts surface as `ExecutionFailed(commandIndex, message)` with
  `V4TooLittleReceived` inside (re-quote), `TransactionDeadlinePassed()`,
  `AllowanceExpired` / `InsufficientAllowance` (Permit2).
- `TAKE_ALL` pays the caller of `execute`: the recipient is always you.
- Liquidity is single-sided from launch; anyone can add liquidity to the same pool.

## V31-3. The fee split, and when it happens

```
V31FeeSplitter.collect(poolId)   # permissionless; pulls the position's LP fees (never principal)
  quote-side fee q  → holders q×5750/1e4 → V31HolderRewards.fund / fundStock (immediately)
                      creator q×1000/1e4 → creatorAccrued[poolId]  (claim: V31-4)
                      desk 1000, staking 500, buyback 1000, protocol rest → pending buckets
  coin-side fee     → V31FeeSplitter.treasury (protocol 3/5 multisig), whole, not split
V31FeeSplitter.flush()       # permissionless: native buckets → DeskRewards, V31StakingEscrow, V31BuybackExecutor, ProtocolVault
V31FeeSplitter.flushStock()  # kind 1: NVDA.sol buckets → DeskRewards.depositRoyalty, escrow, buyback, multisig
```

| i | Bucket | kind 0 (USDC) destination | kind 1 (NVDA.sol) destination |
|---|---|---|---|
| 0 | holders 57.5% | `V31HolderRewards.fund` → shared reward round → stock | `V31HolderRewards.fundStock` → `claimStock` |
| 1 | creator 10% | rights NFT, USDC | rights NFT, NVDA.sol |
| 2 | Desk 10% | `DeskRewards` (one royalty stream for all V3.1 coins) | `DeskRewards.depositRoyalty(NVDA.sol)` |
| 3 | staking 5% | `V31StakingEscrow` (V31-6) | `V31StakingEscrow.depositStock` |
| 4 | buyback 10% | `V31BuybackExecutor` → SOLON → `BurnSink` | `V31BuybackExecutor.executeStock` (via pool A) |
| 5 | protocol 7.5% | `ProtocolVault` | protocol multisig (ProtocolVault has no ERC-20 exit) |

A failing destination keeps its bucket pending (`DeliveryDeferred`) without blocking the
others. Events: `FeesCollected(poolId, quote, quoteAmount, tokenToTreasury)`,
`FeeSplit(poolId, holders, creator, desk, staking, buyback, protocol)`. Until someone calls
`collect`, fees sit in the position and no bucket has been credited; the site's keepers
collect on a threshold and at each UTC day end. As of 2026-10-07 `totalCollected() == 0`:
no V3.1 fee has been split on mainnet yet.

## V31-4. Creator income (V31CreatorRightsNFT)

```
id        = V31CreatorRightsNFT.tokenOfPool(poolId)
owner     = ownerOf(id)                    # the current right holder (not launchOf().creator)
claimable = claimable(id)                  # collected and unpaid only; uncollected fees are not in it
V31FeeSplitter.collect(poolId)             # optional separate tx so claimable includes the latest fees
V31CreatorRightsNFT.claimCreator(id, asset = quoteAsset(id), amountRaw ≤ claimable, payoutMode)
          # collects again first; payoutMode 0 = native USDC 18-dec (or NVDA.sol raw); 1 = through the
          # 6-dec 0x3600 view (amount rounded down to 1e12, dust stays claimable). Caller: owner or approved
          # operator; payment always goes to the owner.
```

- Returns `false` and emits `CreatorClaimFailed(id, amount)` instead of reverting when
  delivery fails (debt kept): check the receipt for `CreatorClaimed`.
- Transfer the NFT (ERC-721) to transfer the right with its unclaimed income. Signed sale:
  `purchase(Purchase{tokenId, seller, buyer, asset, nonce, deadline, minAccrued,
  priceNative}, signature)` (EIP-712 domain "Solon Creator Rights" v1 on this contract;
  `minAccrued` is checked after an automatic collect); the owner voids open orders with
  `cancelOrders(id)`.
- Read side: `GET /api/v3/pools/{poolId}/fees` returns `version: "v31"` for these pools.

## V31-5. Holder dividends (V31HolderRewards, one contract for every V3.1 coin)

**Accrual.** The holders' 57.5% of each collected fee is added to the coin's budget for that
UTC day (`coinBudget(coin, epoch)`, `epoch = floor(ts / 86400)`). The day's budget is split by
**end-of-day balance** (`V31Token.balanceAtEpochEnd`) over the eligible supply (end-of-day
supply minus PoolManager, PositionManager, splitter, factory, multisig and 0xdEaD). No
registration or maturity is needed to earn. A day with no eligible holder rolls to the next.

**Kind 0 (USDC coins): through the shared V3.0 round.**
1. After the day: anyone `finalize(coins[], epoch)` moves each coin's budget into its cohort's
   entry (cohort 0 = default rotation; each non-default `payoutChoiceId` gets its own cohort).
2. From 30 min after the day, the keeper seals `(epoch, cohort)` in RewardRoundManager
   (`EntrySealed(entryId, source = V31HolderRewards, epoch, cohort, budget18, creditTotal)`);
   the round buys the payout stock exactly as in V3-5 step 3. An entry not sealed within 7
   days can be `rescind`ed back to the coins' budgets.
3. After the seal: anyone `accrue(coin, epoch, accounts[])` writes each account's share;
   `creditOf(you, epoch, cohort)` sums every V3.1 coin of that cohort you held.
4. Delivery: the daily push (RewardDistributor) pays registered holders (`register(coin,
   accounts[])`, permissionless; the keeper registers from Transfer events). Manually:

```
entryId = EntrySealed log on V3.rewards.RewardRoundManager with source == V31HolderRewards, your epoch and cohort
V31HolderRewards.accrue(coin, epoch, [you])                       # if accrued(coin, you, epoch) is false
RewardPayoutVault.stageCredit(V3.rewards.RewardVault, you, [entryId, ...] /* ≤ 20 */, stockToken)
RewardPayoutVault.claimFor(you, stockToken)                       # caller must be you
```

`/api/v3/pools/{coin}/rewards/{account}` does not serve V3.1 coins (404 by design): read
`coinBudget`, `inEntry`, `rewardSealed`, `accrued` and `creditOf` on-chain.

**Kind 1 (NVDA.sol coins): direct.**
```
V31HolderRewards.stockOwed(coin, you, epoch)          # finished days only
V31HolderRewards.claimStock(coin, you, epochs[] /* ≤ 64 */)   # anyone may call; always pays `you`
```

Not exercised on mainnet yet: as of 2026-10-07 no V3.1 fee has been collected, so no V3.1
round has sealed and no `claimStock` has paid. The sequence follows the deployed source
(`55297b7`) and the site's own fork tests, not a live payout.

## V31-6. The 5% staking share is escrowed

`V31StakingEscrow` receives bucket 3. It has one exit: `release(asset, amount)` by the
distributor that V3Governance designates (48h, `designateDistributor`); none is designated
(`distributor() == 0x0` on 2026-10-07), so nothing has left and SolonStakingV2 stakers earn
nothing from V3.1 fees until then. `totalIn(asset) − totalOut(asset)` is the escrowed amount
(`address(0)` = native USDC, 18-dec, including deposits through the 0x3600 view). The
guardian can `freezeReleases()`; only a new designation unfreezes.

Deposits are permissionless (`receive()`, `depositStock`), so the escrow also holds what
other senders put in. Since 2026-10-07 the SOLON fee keeper (`0xdD43ee6f3fc4786c62D0727F07F4c668EE9F4F13`)
deposits the 57.5% stakers' leg of SOLON's own pool fees here as native USDC (`SKILL.md`,
"SOLON's own pool fees"). Separate the two by `Deposited(from, asset, amount, totalIn)`:
`from` = `V31FeeSplitter` is V3.1's 5%, `from` = the keeper is SOLON's 57.5%. Both wait for
the same 48h designation; that governance step is in progress, not live. Measured
2026-10-07: `totalIn(0x0) = 0`, no `Deposited` event yet.

## V31-7. Governance and what can change

- Guardian allow-list on V3Governance (`guardianAction(target, selector)`, checked by
  `verify.mjs`): `V31LaunchFactory.pauseLaunches`, `V31StakingEscrow.freezeReleases`,
  `V31LaunchOracle.pause` / `tighten` / `tightenFeedAge`. Nothing else.
- 48h timelock only: `resumeLaunches`, launch-oracle `resume` / `setSource` / `setSigner` /
  `setParams`, escrow `designateDistributor`, buyback `rotateSigner`.
- Immutable: the split constant, 1% LP fee and tick spacing, supply, the splitter's custody
  of every launch position, every wiring address in `V31.wiring`.
- The launch oracle (`V31LaunchOracle`, fed by `V31StockOracleFeed` over SolonStockOracle)
  only prices kind-1 launches; no settlement path reads it.

---

# V3.0: coins that pay their holders in stock (existing coins)

## V3-0. Discover coins

```
logs  = eth_getLogs({ address: V3.launch.V3LaunchFactory, fromBlock: V3.deployedAtBlock,
                      topics: [LaunchState(bytes32 indexed poolId, address indexed token, uint8 state)] })
                      # page in windows < 10,000 blocks on the public RPC
coins = logs where state == 3 (Locked)          # each launch emits 1 Registered, 2 Initialized, 3 Locked in one tx
coin.poolId() / coin.quote() / coin.settlementKind()   # 0 = USDC quote (PurchaseStock), 1 = stock quote (DirectStock)
V3LaunchFactory.launches(poolId) → (token, poolId, positionId, initialTick, lower, upper, liquidity, dust, state, metadataHash)
```

Convenience: `GET /api/v3/coins` (same list with creator, swaps, `ready`), and
`/api/launches?chain=arc` rows with `v3: true` (adds price, fdv, holders, 24h windows).
`node tools/pad-read.mjs` does the paged scan for you.

Pool key of a USDC coin: `{currency0: 0x0, currency1: coin, fee: 0, tickSpacing: 100,
hooks: V3.launch.V3QuoteFeeHook}` (the factory sorts `(quote, coin)` by address, so native
USDC, 0x0, is always currency0). `poolId = keccak256(abi.encode(poolKey))`.
Price: `StateView.getSlot0(poolId)`; with native USDC as currency0, USDC per coin =
`2^192 / sqrtPriceX96^2` (both 18-dec).

## V3-1. Launch a coin (RETIRED 2026-10-07: new coins launch on V3.1, V31-1)

Kept so an agent can read the existing V3.0 launches. Do not launch new coins here: the
site no longer lists this path. The factory has no pause flag and still accepts calls.

```
choices = GET /api/v3/payout-choices      # id 0 = factory default (NVDA), 1 NVDA, 2 AAPL, 3 TSLA; use enabled ones
V3LaunchFactory.launch(
  name, symbol,
  metadataHash,                           # keccak256 of your metadata JSON (see below)
  salt,                                   # random bytes32; scoped to you, single use
  creator = you,                          # msg.sender MUST equal creator
  q = { kind: 0, asset: 0x0, assetId: 0x0, underlying: 0x0 },   # USDC quote
  payoutChoiceId)                         # which stock this coin's holders are paid in, fixed forever
→ Launch { token, poolId, positionId, initialTick 123800, lower -160100, upper 123800, liquidity, dust, state 3, metadataHash }
```

- Supply is fixed at 1,000,000,000 × 1e18, all of it in one single-sided position locked
  in `V3LPLocker` forever. You receive no allocation: buy on the market like everyone else
  (the site's optional "first buy" is simply a second transaction, V3-2).
- You receive the pool's `CreatorRightsNFT` token: the 10% creator stream. Transferring the
  NFT transfers the unclaimed balance with it.
- `metadataHash`: the site hashes the exact UTF-8 JSON
  `{"name","symbol","description","image","links":{"website","twitter","telegram"}}` and
  displays a description or image only for a document submitted through its launch form.
  Any other hash is valid on-chain; the coin then shows name and symbol only.
- Stock-quote launches (`kind: 1`, NVDA.sol-paired) are gated closed: `/api/v3/stock-quote-gate`
  reports `open: false`. The factory also reverts (`InvalidQuote` on a non-approved config or
  a closed market; the oracle's own error when it has no executable price). Do not attempt them.
- Revert `InvalidLaunch()`: sender ≠ creator, reused salt, or the factory readiness gate.

## V3-2. Trade (V3Router, full fill or revert)

```
SwapRequest { key: poolKey, buy: bool,
  amountSpecified,      # negative = exact input; positive = exact output (a sell's output is NET quote)
  sqrtPriceLimitX96: 0, # 0 = full range; any limit that truncates the fill reverts PartialFillUnsupported
  minOut,               # net output to you, raw units of the output asset
  maxIn,                # total input including the hook fee, raw units of the input asset
  recipient, deadline }

q = eth_call V3Quoter.quote(request, you) {value: request.buy && native ? maxIn : 0}
    # funded simulation: `you` must hold the input; for a sell, approve the router first
  → { quoteKind, quoteAsset, quoteDecimals: 18, grossQuote, netQuote, hookFee, minOut, maxIn, fullFillOnly: true, poolId }
    # simulated through the real router path, then reverted; q.minOut / q.maxIn are zero-slippage bounds
```

| Action | Request | Value / approval |
|---|---|---|
| Buy, exact in `X` USDC | `buy: true, amountSpecified: -X, maxIn: X, minOut: q.minOut × (1 − s)` | `msg.value = X` |
| Sell, exact in `N` coins | `buy: false, amountSpecified: -N, maxIn: N, minOut: q.minOut × (1 − s)` | `coin.approve(V3Router, N)`, value 0 |

- Fee lines to disclose before signing: `hookFee` (1% of the quote side, rounded up),
  `netQuote` (what reaches the pool on a buy / what you receive on a sell). There is no
  other fee: the pool's LP fee is 0.
- Reverts: `SlippageExceeded` (re-quote, do not just widen), `PartialFillUnsupported`
  (reduce size), `DeadlineExpired`, `NativeValueMismatch` (value only on native input),
  `UnknownPool` (wrong key: fee must be 0, tickSpacing 100, hooks the V3 hook).
- `V3MultiHopRouter.swapExactIn` (USDC → NVDA.sol → coin) exists for stock-quote coins only;
  none are open (V3-1).
- Reference implementation: `node tools/pad-read.mjs 0xCoin 25` runs exactly this quote and
  prints coins out, hook fee and net-to-pool for a 25 USDC buy.

## V3-3. The fee split, and where each bucket goes

`V3FeeLedger._credit` splits every fee lot with the constant
`[5750, 1000, 1000, 500, 1000, 750]` (Sourcify source `src/v3/V3FeeLedger.sol` line 238;
remainders carry per bucket, no setter) and emits
`FeeCredited(poolId, lotId, quote, amount, allocated[6])`. The order matches
`V3FeeLedger.poolInfo(poolId).beneficiaries`:

| i | Bucket | Beneficiary (USDC pools) | Becomes |
|---|---|---|---|
| 0 | holders 57.5% | the coin (`V3RewardToken`) | stock, per holder, V3-5 |
| 1 | creator 10% | `CreatorRightsNFT` | USDC, claimable, V3-4 |
| 2 | Desk 10% | `DeskRewards` | stock, per card, V3-7 |
| 3 | staking 5% | `SolonStakingV2` | stock, per staker, V3-8 |
| 4 | buyback 10% | `BuybackBurnExecutor` | SOLON bought, locked in `BurnSink` |
| 5 | protocol 7.5% | `ProtocolVault` | execution and operating costs |

Stock-quote pools (none open yet) pay buckets 0–3 directly in the quote stock and route
buckets 4–5 to `StockFeeConverter` for conversion to USDC first. Live per-day totals:
`GET /api/v3/revenue/daily` (`buckets.{holders,creator,desk,staking,buyback,protocol}`).

## V3-4. Creator income

```
id        = CreatorRightsNFT.tokenOfPool(poolId)
claimable = CreatorRightsNFT.claimable(id)            # quote raw units (USDC 18-dec)
CreatorRightsNFT.claimCreator(id, asset = quoteAsset(id) /* 0x0 */, amountRaw ≤ claimable, payoutMode)
          # payoutMode 0 = native USDC 18-dec; 1 = the 6-dec ERC-20 view (amount rounded down to 1e12)
          # caller: the NFT owner or an approved operator; pays the CURRENT owner
```

`claimCreator` returns `false` and emits `CreatorClaimFailed` instead of reverting when the
delivery fails: check for `CreatorClaimed` in the receipt. Read side:
`GET /api/v3/pools/{coin}/fees` → `{owner, accrued, claimable, paid}`.

## V3-5. Holder dividends

**Accrual.** Each fee lot credits the coin's holder index immediately, pro rata to
balances at that moment. Under eligibility mode B (live; switching to A is a 48h governance
operation) there is no maturity, no activation, no lock: hold the coin and you earn;
sell it and the credit already earned stays yours. System addresses (pool manager, locker,
ledger, reward vaults) are excluded from the weight. With zero eligible holders the share
enters a 7-day carry released to later holders.

**From credit to stock (USDC coins, `settlementKind 0`).**

1. Today's holder budget accumulates in `coin.epochBudget(epoch)` (`epoch = floor(ts / 86400)`).
2. After the UTC day ends a keeper seals it into a `RewardRoundManager` entry
   (`EntrySealed`). From 00:10 UTC the keeper checks entries every 15 minutes; an entry
   below the round minimum waits or joins a larger batch for the same stock
   (`reason: BelowMinimum` in `/api/v3/coins/{coin}/rounds`). One round is at most
   `runLimit` ($250 at launch).
3. `RewardBatcher` + `SolonStockAdapter` fund a reward-lane order on `SolonStockHub`; the
   Robinhood Chain `ReserveVault` buys the payout stock; the result returns over
   LayerZero and the Arc token is minted into `RewardVault`. `/api/v3/reports` shows each
   round with every step's tx.
4. Delivery: `RewardDistributor.batchDistribute` pushes daily from 00:10 UTC to every
   holder whose ready amount is worth at least `minimumUSD18` ($2 at launch) at the
   oracle price. Below that, or whenever you want, claim yourself:

```
GET /api/v3/pools/{coin}/rewards/{you}      # credits[]: roundId, roundStatus, orderIds (= allocation ids), readyRaw, stagedRaw, paidRaw
RewardPayoutVault.stageCredit(V3.rewards.RewardVault, you, allocationIds /* ≤ 20 */, stockToken)
RewardPayoutVault.claimFor(you, stockToken)  # caller must be you; reverts if delivery fails (claim([assets]) logs DeliveryBlocked instead)
```

`stageCredit` is permissionless and always credits the named account, never the caller.

**Stock-quote coins (`settlementKind 1`, none open yet).** No rounds: the holder share is
the quote stock itself. `coin.claim(epochs /* ≤ 20 */, assets /* ≤ 4 */)`.

**Push status.** `push` in the rewards response gives `{stage, readyRaw, readyUsd18,
thresholdUsd18, nextPushAt, willPush, reason}`; `reason: belowMinimum` means claim
manually or wait for more credit. `GET /api/v3/payouts` lists every stage, paid and
blocked transfer and the full push schedule.

## V3-6. Stock layer: buy, sell, redeem (SolonStockHub)

`H = V3.stockLayer.SolonStockHub`. Pass the **Robinhood Chain underlying** address
(`V3.stockLayer.stocks.NVDA.rh`), not the Arc token. Read live limits first:
`GET /api/v3/config` → `fees.stockServiceFeeBps` (25), `limits.singleUsd` (250),
`limits.minUsd` (20; both limits apply to a buy's principal after the fee, so the smallest
buy is `usdcIn` $20.06; sells have no size limit), `orderExits` (cancel 1800 s, escalate 21600 s), `paused`.

```
# quote (read-only POST, body amounts are 18-dec integer strings)
POST /api/v3/stocks/quote {"mode":"buy","assetId":"NVDA","amount18":"50000000000000000000"}
  → { input18, serviceFee18, messageFee18, total18, priceSource: "oracle"|"rhPool", priceUsd18,
      expectedOut18, minOut18, conditions[], route: { poolA: {...}, chosen, reason } }

# buy: one call; the order queues, funds on RH, fills, and NVDA.sol arrives on Arc
lzFee = H.quoteOrder(rhUnderlying)
H.requestBuy{value: usdcIn + 1e18 + lzFee}(rhUnderlying, usdcIn, minSharesOut)   # minSharesOut > 0, from your own quote
      # fee = usdcIn × 25 / 1e4, principal = usdcIn − fee rounded down to 1e12; the 1 USDC route
      # reserve and any unused message fee come back

# sell: the hub burns the shares itself (no approval)
H.requestSell{value: lzFee}(rhUnderlying, sharesIn, minUsdcOut)   # value 0 leaves it Pending until someone dispatches it

# take the underlying on Robinhood Chain instead (Circle CCTP + Ethereum canonical lane, slow;
# the sell fee is kept in shares)
H.canonicalRedeem{value: ≥ 1e18}(rhUnderlying, sharesIn, rhRecipient, 0 /* DeliverMode.Stock */)
```

- **Closed market.** The hub never reads the oracle. When US markets are closed the
  oracle reports `Stale` (`/api/v3/oracle/prices` → `priceSource: rhPool`,
  `notice: OracleStale`) and orders still execute against the Robinhood Chain Uniswap pool
  at its price. The `minOut` you sign is the only on-chain price floor: derive it from the
  pool quote (the quote endpoint already does), never from the stale oracle.
- **Sell floor.** `minUsdcOut` bounds the RH gross; the 25 bps fee is taken after. To net
  at least `N`, sign `ceil(N × 1e4 / (1e4 − 25))` rounded up to a whole USDG unit (1e12).
  The quote endpoint returns this as `minGross18`.
- **Lifecycle.** `GET /api/v3/orders/{id}` → `status` (`Pending → Funded → Dispatched →
  Filled`, or `Cancelled` / `Returning` / `Escalated`) and every Arc and RH step with tx.
  `cancel(id)` on a buy: a queued buy refunds at once after 1800 s from creation; a funded
  one counts 1800 s from dispatch and only records the request, the refund follows when
  the principal returns. `escalate(id, to)` / `escalateFunds(id, to)` after 21600 s move a
  stuck exit to the canonical lane (value ≥ 1 USDC, plus any unpaid locked sell fee for
  `escalateFunds`); `claim(id)` pays anything
  the hub owes you.
- **Arc-native alternative, Pool A.** NVDA.sol/USDC Uniswap v4 pool (`V3.stockLayer.poolA`,
  no hook, 1% LP fee) through the Uniswap UniversalRouter. Instant, but thin: the quote
  endpoint compares both routes (`route.chosen`). Check `/api/v3/stocks/pool-a` depth first.

## V3-7. Solon Desk

```
DeskNFT.surchargeUSDC18()                  # 50e18 at launch
SOLON.approve(DeskNFT, count × 100_000e18)
DeskNFT.mint{value: surchargeUSDC18 × count}(count /* 1..20 */, to)   # value must match exactly
DeskNFT.claim(tokenId, streamKeys /* ≤ 20 per call */)                # owner or approved operator; pays the owner
```

- 100,000 SOLON per card moves to `BurnSink` (permanently locked); of the $50, 90% enters
  the Desk reward pot and 10% the Desk protocol account.
- Cards are equal-weight: each Desk fee credit is split across the cards that exist at that
  moment. A new card does not share earlier credit. Unclaimed rewards travel with the card.
- Cap 5,000 cards in total, of which up to 1,000 may be protocol-vault cards; 50 per
  receiving address; 20 per call.
- Stream keys: the `stream` argument of `DeskRewards.DeskFeeCredit` events
  (`GET /api/v3/events?contract=DeskRewards&event=DeskFeeCredit`). Card owners are also
  pushed daily (`DeskPushed`). Per-card view: `GET /api/v3/desks/{tokenId}`.

## V3-8. SolonStakingV2

```
SOLON.approve(SolonStakingV2, amount)
SolonStakingV2.stake(amount)                 # weight counts from the next fee on
SolonStakingV2.unstake(amount, to)           # instant; reverts PrincipalError if amount > stakedOf(you)
```

- Earns the 5% staking bucket of every V3.0 fee as stock, accounted per lane and epoch. The
  V3.1 5% and the 57.5% leg of SOLON's own pool fees are escrowed in `V31StakingEscrow`
  (V31-6) and reach stakers only after a distributor is designated. Delivery is the same daily push at ≥ $2; manual
  claims follow the V3-5 pattern per source (`GET /api/v3/staking/{you}` → `v2.sources[]`
  with `credit`, `readyRaw`, `paidRaw`, `stage`).
- Principal is separate from rewards; no lock, no cooldown, no admin path to principal.
- Not the original SOLON staking pool (§G), which pays SOLON.

## V3-9. Read API, measured (2026-10-07, `https://solonpad.fun`)

Every path below returned HTTP 200 with the listed `data` fields. Envelope on all of them:
`chainId, deploymentVersion, asOfBlock, blockHash, updatedAt, finality, indexerLag,
schemaVersion (4), stale, source ("indexer"), rh, eth, tickers`. Treat `stale: true` as
"do not price from this". 503 `IndexerMissing` / 502 mean the data source is down: do not
fall back to guesses.

| Path | `data` (top-level fields) |
|---|---|
| `/api/v3/coins` | `[ {token, poolId, name, symbol, state, launchBlock, launchedAt, launchTx, quote, quoteSymbol, quoteDecimals, settlementKind, supply, metadataHash, creator, sender, tokenFirst, initSqrt, lastSqrt, swaps, ready} ]` |
| `/api/v3/coins/{coin}/rounds` | `coin, now, epoch, settlementKind, today{budget18,sealAt}, unsealed[], entries[], runLimit18, stats{totalCredited18,participants,eligible18,lastFeeAt,carry18,carryReleased18}, next{kind}` |
| `/api/v3/pools/{coin}/rewards/{account}` | `token, symbol, quoteKind, quote, balance18, eligible18, eligibility, credits[] {epoch, asset, assetId, settlementKind, creditRaw, deliveredRaw, readyRaw, stagedRaw, paidRaw, stage, orderIds, roundId, roundStatus, via}, push{stage, readyRaw, readyUsd18, thresholdUsd18, pushRaw, minPushRaw, willPush, reason, nextPushAt}, claimed[], unavailable` |
| `/api/v3/pools/{coin}/fees` | `creator{poolId, tokenId, owner, quoteAsset, quoteSymbol, accrued, claimable, paid}` |
| `/api/v3/reports?limit=` | `Paged{items[], next, total}`; items `kind` ∈ PurchaseStock (rounds: `budget18, minRawOut, status, entries[], steps{reserved,funding,hubLaunch,submitted,rhBuy,arcMint,result,finalized}, deliveredRaw`), Desk, DirectStock, Staking |
| `/api/v3/revenue/daily` | `[ {day, quote, pools, credits, fee, buckets{holders,creator,desk,staking,buyback,protocol}, remainder} ]` |
| `/api/v3/revenue/summary` | `byQuote[], hookFees{h24,d7,all}, recent[] {pool, lotId, quote, fee, allocated[6], at}` |
| `/api/v3/payouts` | `staged[], paid[], blocked[], batches[], pushSchedule{...}` |
| `/api/v3/stocks/reserves/assets` | `block, rpcNote, assets[] {ticker, token, underlying, totalSupply, hubSupply, reserveHeld, reserveVault, covered, capUsd18, price18, oracleStatus, verify[]{field, cmd}}` |
| `/api/v3/stocks/assets` | `[ {assetId, symbol, name, decimals, raw, wrapper, multiplier18, multiplierVersion, priceUsd18, priceAgeSeconds, market, tradingPaused, mintPaused, mintsHalted, oracle, assetCap, quotePair, limits} ]` |
| `/api/v3/oracle/prices` | `[ {ticker, token, underlying, live{price18,updatedAt,status}, orderable, blockedReason, buyable, priceSource, notice, nextOpenAt} ]` |
| `/api/v3/stocks/pool-prices` | `[ {assetId, priceUsd18, block, at} ]` (RH pool mid, display only) |
| `/api/v3/stocks/rh-quote?assetId=&mode=&amount18=` | RH QuoterV2 read: `chainId, assetId, mode, quoter, pool, fee, amountIn18, amountOut18, priceUsd18, block, spotUsd18, twapUsd18, deviationBps, impactBps` (envelope `chainId 4663`) |
| `POST /api/v3/stocks/quote` | see V3-6 |
| `/api/v3/stocks/pool-a` | `[ {ticker, token, vault, poolId, poolKey, live{tvlUsd18, usdc18, stockRaw, range, price, ...}, history{h24, d7, all, aprPct, aprDays}} ]` |
| `/api/v3/orders?user=` · `/orders/{id}` | `user, open, orders[]` with `status, phase, steps{...}, queue, review` (`?user=` is required: 400 without it) |
| `/api/v3/history?user=` | `user, orders[], rows{items[] {type, event, contract, at, amount, detail}}` |
| `/api/v3/staking/stats` | `stakers, staked18, epochs[]` |
| `/api/v3/staking/{account}` | `legacy{staked18, earned18}` (original pool), `v2{staked18, eligible18, sources[]}`, `eligibility` |
| `/api/v3/desks` | `minted, cap, protocolMinted, protocolMax, costSolon18, surchargeUsdc18, burnSink, royaltyBps` |
| `/api/v3/desks/{id}` · `/accounts/{a}/desks` | `tokenId, owner, mintedAt, mintTx, protocol, credits[] {assetId, settlementKind, credit, readyRaw, paidRaw}` |
| `/api/v3/desks/pool` | `asOf, pendingUsdc18, bought, direct, next, burn, contracts` |
| `/api/v3/buybacks/ledger` | `lots{items[], total}, unattributedPurchases[], sink[], totals{v3Buyback, solonV2FeeCoinBurn, deskMintBurn, deskOverflowBurn, unattributed}` |
| `/api/v3/payout-choices` | `[ {id, asset, ticker, calendar, enabled, scheduled, unavailable} ]` |
| `/api/v3/stock-quote-gate` | `asset, token, vault, router, poolId, open, checks[] {key, ok, measured, threshold, source}` |
| `/api/v3/config` | `contracts, quoteAssets, fees, launch, desk, rewards, claim, orderExits, limits, push, eligibility, paused, stockQuoteGate` |
| `/api/v3/overview` | `block, blockTs, protocolHoldings, launchPools, hookFees24h, poolAMultiHop24h` |
| `/api/v3/queue` | `public[], reward[], ratio` |
| `/api/v3/events?contract=&event=` | raw indexed rows `{block, txHash, logIndex, ts, address, contract, event, args}`: always filter |
| `/api/v3/developers` | every contract with ABI hash, and `cast` commands that recompute the public numbers |

Not served (measured): `/api/v3/stocks/reserves` (no `/assets`), `/api/v3/buybacks`,
`/api/v3/protocol/summary` → 503; `/api/v3/coins/{coin}` → 404 on the web host.

Spot-check against the chain once per session: one figure from
`/stocks/reserves/assets` (run its `verify[].cmd`), one coin's price against
`StateView.getSlot0`, and `asOfBlock` within ~240 blocks of `eth_blockNumber`.

## V3-10. Governance and what can change

- `V3Governance` (OpenZeppelin TimelockController, `MIN_DELAY = 48 hours`, enforced on
  every delay update). PROPOSER and CANCELLER: the 3/5 Safe `V3.governance.multisig`.
  EXECUTOR: anyone, once an operation is ready. GUARDIAN (2/3 Safe): cancel ordinary
  pending operations; call only selectors a target declares tighten-only (pause, lower a
  cap). It cannot propose, execute early, send value or loosen anything. The deployment
  bootstrap window is closed (`bootstrapClosed() == true`).
- Immutable: the six-way split, 1% hook fee, coin supply, pool keys, LP lock, per-coin
  payout choice, BurnSink.
- Governance-adjustable (48h, visible as `CallScheduled` events on `V3Governance` before
  they execute): stock-hub fees (lower only via `lowerFees`), capacity limits, listings,
  oracle and reward-schedule parameters, Desk mint cap per address, eligibility mode.
- Watch pending operations: `GET /api/v3/events?contract=V3Governance&event=CallScheduled`.

## V3-11. V3.1 cutover (2026-10-07)

New launches moved to V3.1 (the V31 sections at the top). V3.0 coins are unaffected: they
keep trading through V3Router, their fees keep crediting holders, the creator NFT, Desk,
SolonStakingV2, buyback and protocol through V3FeeLedger exactly as above.

---

# Legacy V2 (still callable)

Instant v4 (V2) was the default from 2026-09-16 to 2026-10-03. These pools pay a 1% LP fee
split 50/50 platform/creator and **no holder dividend**. The progressive bonding curve
(Pons V2) follows after them. `V = A.instantV4`. Native USDC amounts are 18-dec
`msg.value` throughout.

## V4-0. Discover instant launches

```
strategies = [V.instantLaunchStrategy] + [Q.strategy for Q in V.quoteInstances]
launched   = eth_getLogs({ address: strategies, topics: [TokenLaunched.topic], fromBlock: V.deployBlock })
# TokenLaunched(poolId indexed, token indexed, finalPositionRecipient indexed, key)
# a SolonPad launch = finalPositionRecipient == that instance's splitter
# (V.feeSplitter for native USDC, Q.splitter for quote instances)
```

`rpc.mainnet.arc.io` rejects `eth_getLogs` ranges above 5,000 blocks and
rate-limits bursts: page the range and back off (`tools/pad-read.mjs` does).

Pool key for every native-USDC launch: `{currency0: 0x0, currency1: token, fee: 10000,
tickSpacing: 100, hooks: 0x0}`; `poolId = keccak256(abi.encode(poolKey))`.
State: `StateView.getSlot0(poolId)` → price; `token.tokenURI()` → on-chain JSON
metadata (description / website / image).

## V4-1. Launch a token (1 multicall, no launch fee)

```
graffiti = launcher.getGraffiti(you)
token    = factory.getUERC20Address(name, symbol, 18, V.liquidityLauncher, graffiti)   # CREATE2 predict
tokenData = abi.encode(UERC20Metadata{description, website, image, extraData: 0x})
launcher.multicall([
  createToken(V.uerc20Factory, name, symbol, 18, 1e9*1e18, V.liquidityLauncher, tokenData),
  distributeToken(token, (V.instantLaunchStrategy, 1e9*1e18, abi.encode((feeBeneficiary))), bytes32(0)),
])
```

- Supply is FIXED at 1,000,000,000 × 1e18 (strategy hard constraint).
- The whole supply becomes a single-sided v4 position opening at ≈$4.2K FDV
  (tick 123800); the LP NFT is locked in the FeeSplitter forever. You receive
  no allocation — buy on market like everyone else.
- `feeBeneficiary` gets the creator half of the 1% LP fee via a transferable
  NFT in the BeneficiaryVault.

## V4-2. Trade

Any v4-compatible router works (it is a plain pool). Reference sequence with
the deployed PoolSwapTest router `V.swapRouterPoolSwapTest`:

```
# buy: exact-in native USDC
router.swap{value: in}(poolKey, {zeroForOne: true,  amountSpecified: -in,
  sqrtPriceLimitX96: limit}, {takeClaims: false, settleUsingBurn: false}, "")
# sell: approve token to router first, then zeroForOne: false
```

Set `sqrtPriceLimitX96` from your own quote ± slippage: the swap fills up to
the limit and refunds the unspent input (partial fills are possible — check
the received amount, not just success). Quote from `getSlot0` + position
liquidity with standard v4 math.

## V4-3. Creator fees

```
FeeSplitter.collectFees([tokenId])   # permissionless crank; caller gets nothing
BeneficiaryVault.claim(tokenId, min0, min1)   # beneficiary NFT owner only
```

`tokenId` is the LP NFT id from the launch receipt (PositionManager Transfer
to the FeeSplitter).

## V4-Q. Instant v4 quoted in a stock or meme

Same launcher, same 1B supply, same 1% LP fee and tick spacing 100 — only the
strategy instance differs. `Q = V.quoteInstances[SYMBOL]` (CRCL, TSLA, NVDA,
AAPL, SPY, ARGUS, LONG, DUKE — all 18-dec ERC-20s on Arc; verify
`strategy.quoteToken() == Q.quote` first, `tools/verify.mjs` does).

```
# launch: V4-1 unchanged except the strategy
launcher.multicall([
  createToken(V.uerc20Factory, name, symbol, 18, 1e9*1e18, V.liquidityLauncher, tokenData),
  distributeToken(token, (Q.strategy, 1e9*1e18, abi.encode((feeBeneficiary))), bytes32(0)),
])
# pool key: currencies sorted by address, no native leg
(c0, c1) = token < Q.quote ? (token, Q.quote) : (Q.quote, token)
poolKey  = {currency0: c0, currency1: c1, fee: 10000, tickSpacing: 100, hooks: 0x0}
# buy: approve Q.quote to the router (exact amount), msg.value = 0,
#      zeroForOne = (c0 == Q.quote); sell: approve token, opposite direction
```

The opening price is `Q.initialTick` (quote per token); the LP NFT is locked
in `Q.splitter` and creator fees claim exactly as in V4-3.

---

# Curve mode (Pons V2, progressive launch — optional)

All amounts below are **native USDC with 18 decimals** (`msg.value` units) unless marked
otherwise. `A = addresses.json`. ABIs in `abis/`. Run `VERIFY.md` first.

## 0. Discover launches

```
logs = eth_getLogs({ address: A.solonpad.launchFactory,
                     fromBlock: A.solonpad.deployBlock,
                     topics: [TokenLaunched.topic] })
# each log → (token, curve, creator, pairToken, …) per abis/PonsV2LaunchFactory.json
```

Per-token state (one multicall):
- `curve.getReserves()` → `(quoteReserve, tokenReserve)` — quote includes the 4,000
  phantom; price/token = `quoteReserve / tokenReserve`.
- `curve.realQuoteReserve()` → real USDC raised. Graduation progress =
  `real / (A.economics.graduationTargetUsdc * 1e18)`.
- `curve.graduated()` → if true, trade on Uniswap v4 instead (§4).

## 1. Launch a token (1 tx)

```
fee       = factory.launchFee()                       # re-read, do not hardcode
allowed   = factory.canLaunch(you)                    # false → factory paused for you
economics = factory.previewLaunchEconomics(0, 0x0)    # pin the curve params you expect

factory.launchToken{value: fee}(
  { name, symbol, logo: "https://…", description, socials: {5 strings},
    creatorFeeRecipient: you, creatorTaxBps: 0..500, buybackEnabled: true,
    expectedEconomics: economics, salt: random32bytes },
  0,          # launchConfigId
  address(0)) # pairToken: address(0) = native USDC; or an ERC-20 with
              # factory.approvedPairTokens(pair) == true (then preview with it,
              # and read factory.pairTokenEconomics(pair) for phantom/threshold)
→ returns (token, curve)
```

`expectedEconomics` makes the tx revert if the owner changes fees between your read and
your send — always pass the fresh preview, never a cached one.

## 2. Buy on the curve

```
quote  = eth_call curve.buy(amountIn, 0, you) {value: amountIn}     # exact output
minOut = quote * 9900 / 10000                                       # your slippage policy
curve.buy{value: amountIn}(amountIn, minOut, you)
```

- ERC-20-paired curves (`curve.isNativeQuote() == false`, quote = `curve.pairToken()`):
  `pair.approve(curve, amountIn)` and send **no** `msg.value` (else
  `UnexpectedNativeValue()`); graduation threshold = `curve.graduationThreshold()`.
- Oversized buys near graduation fill partially and **refund the unspent USDC** in the
  same tx, then auto-graduate the market.
- First minutes after launch a **snipe tax** applies:
  `curve.currentSnipeTaxBps(you)` — creators are exempt on their own launch.

Closed-form check (mirror of contract math, use to sanity-check the eth_call):
```
net    = in − in*feeBps/1e4 − in*creatorTaxBps/1e4 − in*snipeTaxBps/1e4
out    = net * tokenReserve / (quoteReserve + net)
```

## 3. Sell on the curve

```
token.approve(curve, amt)              # exact amount, not infinite
quote  = eth_call curve.sell(amt, 0, you)
curve.sell(amt, quote*99/100, you)     # USDC arrives as native balance
```

Sells work until the instant of graduation; after it, the curve is closed both ways.

## 4. After graduation

The full range LP is minted to the locker (permanent — verify with
`locker.isLocked(token)`). Trade via Uniswap v4:
pool key = `{currency0: 0x0 (native), currency1: token, fee: 0, tickSpacing: 200,
hooks: A.solonpad.memeHook}` through `A.uniswapV4Canonical.universalRouter`.
The hook takes the swap fee and splits protocol/creator shares automatically.

## 5. Creator fee claims (pull payment)

Curve fees accrue to the escrow under your address as they trade:
```
escrow.claim()            # your entire native-USDC balance
escrow.claim(amount)      # partial
```
`sweepFees(minBuybackTokensOut)` on a live curve is permissionless — calling it moves
accrued fees to the escrow and executes the buyback slice; anyone may crank it.

## 6. Monitoring rules an agent should hardcode

- Re-read `launchFee`/`feeBps`/taxes before every send (owner-adjustable within caps).
- Confirmations: 1 block (~0.5 s) is final enough for curve reads; use the receipt for
  value accounting.
- Keep ≥0.05 native USDC for gas — a buy that spends the entire balance strands you.
- A curve at >95% progress can graduate under you: send buys with `minOut` and accept
  the partial-fill refund path, never assume the full amount executes on-curve.


## Execution rules — `[FINANCIAL EXECUTION]`

Moving value requires your principal's explicit authorization. Without it,
stay read-only (`tools/pad-read.mjs`). With it, every step below is mandatory:

1. **Verify first**: `tools/verify.mjs` green in this session.
2. **Estimate**: quote at a pinned block (`pad-read.mjs 0xToken <amount>`,
   V4Quoter for v4 and V3.1 pools, V3Quoter for V3.0 coins, `eth_call curve.buy` for
   curves) and list every fee line (LP fee, hook fee, curve fee, creator/snipe tax) — do
   not net them silently.
3. **minOut** = estimate × (1 − slippage), slippage ≤ 5% unless your principal
   set another. **Never send minOut = 0** (v4: never an unbounded
   `sqrtPriceLimitX96`).
4. **Approve exact amounts.** ERC-20-quoted buys approve the quote token to
   the router/curve; sells approve the launched token. On Arc the native-USDC
   ERC-20 view `0x3600…0000` (6-dec) is the same balance as your gas.
5. **Reconcile the receipt**: received vs minOut vs estimate. Partial fills
   refund unspent input — check the received amount, not tx success.
6. **Decode reverts** with `errors.json` before retrying; re-quote after any
   slippage revert.

## §G. SOLON staking, original pool — stake SOLON, earn a SOLON stream

This is the **original** `SolonStaking` pool (SOLON in, SOLON out). It is not
`SolonStakingV2` (V3-8), which pays stock from the V3 fee split. `/api/v3/staking/{you}`
reports this pool as `legacy`. Since 2026-10-07 its lane 0 is funded by the 5% leg of the
off-chain keeper split of SOLON's own pool fees (`SKILL.md`, "SOLON's own pool fees"); it
does not receive the 57.5% stakers' leg, which accrues in `V31StakingEscrow` for stock.

`S = A.staking.solonStaking`, `SOLON = A.staking.stakingToken`, ABI
`abis/SolonStaking.json`. All amounts are 18-dec SOLON wei. Run `VERIFY.md`
§G first. `[FINANCIAL EXECUTION]` for every write below.

### G1. Read

```
totalStaked()                 # principal, all stakers
stakedOf(you) / earned(you)   # your principal / accrued reward
rewardRate()                  # combined SOLON wei/sec of both lanes, now
laneInfo(0|1)                 # (rate, periodFinish, duration, injected) — 0=BUYBACK 7d (contract name; keeper 5% leg), 1=GENESIS 30d
rewardReserve()               # rewards held for stakers (injected − paid − compounded)
stakeCap() / paused()         # paused blocks stake/compound/notify only, never exits
injectedOnDay(lane, ts/86400) # per-UTC-day injections
```

### G2. Write

```
SOLON.approve(S, amount)      # exact amount, not unlimited
S.stake(amount)               # reverts "cap" if totalStaked + amount > stakeCap
S.claim()                     # pays earned(you)
S.compound()                  # restakes earned(you); subject to stakeCap
S.unstake(amount)             # instant, no cooldown; pays principal + accrued reward
```

`unstake` settles and pays rewards through isolated self-calls under
try/catch: if the reward leg ever reverts you still get principal back and
the reward stays on the books (`RewardSettleFailed(you)`) — call `claim()`
later.

### G3. Funding (read-only for you)

`notifyBuyback(amount, buybackTx)` — distributor only, `amount >= 1000e18`.
Pulls SOLON and restarts the BUYBACK lane at `(amount + leftover) / 7 days`.
`RewardAdded(0, amount, buybackTx)` carries a hash the distributor supplies as the
source of the SOLON; the contract does not check it. The keeper passes the latest
buy, fee-collect or creator-claim tx the injected SOLON came from: fetch it and check it
was sent by the keeper. `seedGenesis` (owner, once) funded
lane 1 with 12,690,000 SOLON over 30 days (ends 2026-10-23 04:18 UTC). Reward streamed
while nothing is staked accrues to `idleRewards` and can only be put back into the
BUYBACK lane.

Where lane-0 SOLON comes from (since 2026-10-07). The distributor is the SOLON fee keeper
(`0xdD43…4F13`, `A.staking.distributor`). It splits all of SOLON's own pool fees off-chain
57.5 / 5 / 20 / 17.5 (escrow / lane 0 / burn to `0x…dEaD` / protocol); lane 0 gets the 5%
leg: USDC bought into SOLON (one swap shared with the burn leg, SOLON divided 1 : 4 by the
USDC each leg put in) plus 11.76% of the SOLON the keeper receives from the pool, injected
at most once per UTC day (from 00:10) once it clears the 1,000 SOLON minimum. The old policy (half of the platform side bought
SOLON for this lane) is retired. Each injection is an on-chain tx; the 5% ratio is not
enforced by any contract, so audit it against the keeper's escrow deposits and dead-address
transfers over the same window. One-off on 10-07: 1,018,306.43 SOLON of earlier bought
inventory injected (tx `0x77778ae193251c633b719569d6b981ab935b14e611f025668ebd4e9a45deabf4`),
restarting lane 0 at ≈ 145,473 SOLON/day until 2026-10-14.

### G4. APR (same basis as the page)

```
buyback7d = Σ RewardAdded(lane 0).amount with block time in the window
genesis7d = laneInfo(1).rate × seconds of the window the genesis lane was
            streaming (its one-off RewardAdded is NOT counted as a lump)
window    = last 7 UTC days incl. today (contract age if younger)
APR       = (buyback7d + genesis7d) / windowDays × 365 / totalStaked × 100%
```

Stake and reward are both SOLON, so this equals annualised USD inflow ÷
staked market value and needs no price feed. USD figures only: price SOLON
at `StateView.getSlot0(A.staking.priceReferencePoolId)` (currency0 = native
USDC, currency1 = SOLON, both 18-dec: USDC per SOLON = Q96² / sqrtPriceX96²).
Report it as historical: it falls as `totalStaked` grows and drops when the
genesis lane ends (`laneInfo(1).periodFinish`). The 2026-10-07 inventory
injection (1,018,306.43 SOLON) is a one-off inside every window that includes
that day; say so instead of presenting the result as a run rate. Treat
`totalStaked` near zero as "APR undefined", not as a huge number.

