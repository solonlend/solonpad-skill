# Relay production quote captures

These JSON files were obtained using unsigned `POST https://api.relay.link/quote`
with `includeProtocolData: true` on 2026-09-19. Each file includes the exact public
request, original intent, response, and `capturedAt` timestamp. EVM/Solana payer
and recipient addresses are public throwaway values; no private keys, RPC keys,
cookies, or user balances were read. Responses contain public Relay order
signatures and calldata; they are not user-signed transactions.

Re-run the five native production lanes:

```sh
node skill/tools/relay-live-probe.mjs
```

Append `--capture` to refresh both this directory and
`skill/tests/fixtures/relay/`. The probe makes quotes only, never signs/broadcasts,
fails if any validator throws or returns anything other than `verified: true`,
and prints one explicit result per lane. Offline tests freeze the clock to
`capturedAt` so expiry checks remain meaningful without rewriting signed orders.

## Observed source shapes

- `arc-bsc`, `arc-rh`: Relay Router V3 `multicall`, a Kyber `swap` of native Arc
  USDC into its 6-decimal ERC20 view, then router `cleanupErc20sViaCall` targeting
  the canonical Relay depository's all-balance `depositErc20` overload. The raw
  captures advertise 10,000,000 input units in the protocol order, while the
  origin swap only enforces 9,799,999 units and quotes 9,999,999. These captures
  are accepted by batch 3b only after the complete conversion/deposit shape,
  max spend, committed minimum receive and refund recipients are verified.
  Order input is bounded by the declared origin output range (9,800,000 through
  10,000,000); exact direct-deposit binding remains unchanged. See
  `docs/RELAY-VERIFICATION.md` for the economic decision and verification limits.
- `arc-sol`: direct `depositNative` to canonical EVM depository.
- `bsc-arc`: exact USDT approval to depository, then `depositErc20` with explicit
  amount.
- `sol-arc`: single Solana depository instruction with Anchor discriminator,
  little-endian amount, and order ID. `protocol.v2` is present.

## Independently consulted sources

- Relay pinned deployments: <https://api.relay.link/chains>
- Router verified ABI/source:
  <https://abscan.org/address/0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f#code>
- Router project (current version may differ from deployed V3):
  <https://github.com/relayprotocol/relay-periphery/blob/main/src/RelayRouter.sol>
- Kyber outer swap verified ABI/source:
  <https://etherscan.io/address/0x6131b5fae19ea4f9d964eac0408e4408b66337b5#code>
- Kyber executor address pin:
  <https://github.com/KyberNetwork/ks-aggregation-router/blob/main/script/config/executors.json>
- Kyber Arc native/ERC20 representation and decimal scale:
  <https://github.com/KyberNetwork/kyberswap-dex-lib/blob/main/pkg/valueobject/wrapped_native.go>
- Quote request options including `disableOriginSwaps`:
  <https://docs.relay.link/references/api/get-quote>

`disableOriginSwaps: true` was additionally tested: Arc→BSC and Arc→SOL returned
canonical direct native deposits; Arc→RH returned `NO_SWAP_ROUTES_FOUND`.
`slippageTolerance: "0"` kept the Arc→BSC router shape and enforced 9,999,999,
still below its 10,000,000-unit advertised protocol input. These exploratory
requests do not replace the raw fixtures above. No execution or settlement was
attempted.

## Batch 3b packed executor evidence

`skill/tools/relay-arc-conversion.mjs` decodes/re-encodes the entire packed route,
including its single module, single native conversion leg and empty output-token
leg. Address/selector/flag/value fields are pinned or derived from native spend;
no extra calls, opaque execution bytes or trailing data are accepted. The
executor address has an official source above. The packed layout was
reconstructed from these unchanged captures and checked against fresh unsigned
quotes at 2, 25 and 10.123456 native USDC; module implementation source was not
independently verified. The fixed-size provider authorization signature is
passed to the contracts for authentication. These limits must not be confused
with a source audit or a completed settlement/refund test.
