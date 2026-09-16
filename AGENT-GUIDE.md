# SolonPad — agent call sequences

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
  0,          # pairTokenId 0 = native USDC
  address(0))
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
