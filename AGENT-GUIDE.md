# SolonPad — agent call sequences

Two launch modes. **Instant v4 (below) is the default since 2026-09-16**; the
progressive bonding curve (Pons V2) remains available and is documented in the
second half of this file. `A = addresses.json`, `V = A.instantV4`. Native USDC
amounts are 18-dec `msg.value` throughout.

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
   V4Quoter for v4 pools, `eth_call curve.buy` for curves) and list every fee
   line (LP fee, curve fee, creator/snipe tax) — do not net them silently.
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

## §G. SOLON staking — stake SOLON, earn the streamed buyback (v0.7)

`S = A.staking.solonStaking`, `SOLON = A.staking.stakingToken`, ABI
`abis/SolonStaking.json`. All amounts are 18-dec SOLON wei. Run `VERIFY.md`
§G first. `[FINANCIAL EXECUTION]` for every write below.

### G1. Read

```
totalStaked()                 # principal, all stakers
stakedOf(you) / earned(you)   # your principal / accrued reward
rewardRate()                  # combined SOLON wei/sec of both lanes, now
laneInfo(0|1)                 # (rate, periodFinish, duration, injected) — 0=BUYBACK 7d, 1=GENESIS 30d
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
`RewardAdded(0, amount, buybackTx)` carries the hash of the on-chain buyback
the SOLON came from: fetch that tx and check it is a USDC→SOLON market buy
from the treasury. `seedGenesis` (owner, once) funded lane 1 with
12,690,000 SOLON over 30 days. Reward streamed while nothing is staked
accrues to `idleRewards` and can only be put back into the BUYBACK lane.

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
genesis lane ends (`laneInfo(1).periodFinish`). Treat `totalStaked` near
zero as "APR undefined", not as a huge number.

