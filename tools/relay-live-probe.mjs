#!/usr/bin/env node
// Unsigned production quote probe. Uses public throwaway addresses only; never
// reads wallet keys or sends transactions. --capture refreshes both fixture sets.
// Offline regression tests freeze Date.now to each fixture's capturedAt.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateRelayIntent, exactInputFloor, ethUsdBsc, bscPublic } from './rail-lib.mjs';
import { validateRelayProtocol } from './relay-protocol.mjs';

const endpoint = 'https://api.relay.link/quote';
const evm = '0x1111111111111111111111111111111111111111';
const sol = 'GxZs8NVvvrszzJLhpvpkfnXe3fLpxnnnKrVqKoTWAKVX';
const zero = '0x0000000000000000000000000000000000000000';
const usdt = '0x55d398326f99059ff775485246999027b3197955';
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const arcUsdc = '0x3600000000000000000000000000000000000000';
// ETH/USD comes from Pancake on BSC, independent of relay, like the real lanes.
const ethUsd = await ethUsdBsc(bscPublic()).catch(() => undefined);
const floors = {
  'arc-bsc': exactInputFloor({ usdIn: 10, outDecimals: 18 }),
  'arc-rh': ethUsd ? exactInputFloor({ usdIn: 10, outUsdPrice: ethUsd, outDecimals: 18 }) : undefined,
  'arc-sol': exactInputFloor({ usdIn: 10, outDecimals: 6 }),
  'bsc-arc': exactInputFloor({ usdIn: 10, outDecimals: 6 }),
  'sol-arc': exactInputFloor({ usdIn: 10, outDecimals: 6 }),
};
const lanes = [
  ['arc-bsc', 5042, 56, zero, usdt, '10000000000000000000', evm, evm],
  ['arc-rh', 5042, 4663, zero, zero, '10000000000000000000', evm, evm],
  ['arc-sol', 5042, 792703809, zero, usdc, '10000000000000000000', evm, sol],
  ['bsc-arc', 56, 5042, usdt, arcUsdc, '10000000000000000000', evm, evm],
  ['sol-arc', 792703809, 5042, usdc, arcUsdc, '10000000', sol, evm],
];
let failures = 0;
for (const [lane, fromChain, toChain, fromCurrency, toCurrency, amountWei, user, recipient] of lanes) {
  try {
    if (floors[lane] === undefined) throw new Error('independent reference price unavailable for this lane');
    const intent = { user, recipient, fromChain, toChain, fromCurrency, toCurrency, amountWei, minOutput: floors[lane].toString() };
    const request = { user, recipient, originChainId: fromChain, destinationChainId: toChain,
      originCurrency: fromCurrency, destinationCurrency: toCurrency, amount: amountWei,
      tradeType: 'EXACT_INPUT', includeProtocolData: true };
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    const quote = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(quote).slice(0, 180)}`);
    if (process.argv.includes('--capture')) {
      const fixture = { lane, capturedAt: new Date().toISOString(), endpoint, request, intent, quote };
      for (const path of ['../../web/tests/fixtures/relay/', '../tests/fixtures/relay/']) {
        const directory = new URL(path, import.meta.url);
        mkdirSync(directory, { recursive: true });
        writeFileSync(fileURLToPath(new URL(`${lane}.json`, directory)), `${JSON.stringify(fixture, null, 2)}\n`);
      }
    }
    validateRelayIntent(quote, intent);
    const result = await validateRelayProtocol(quote, intent);
    if (result?.verified !== true) throw new Error(`verification refused: ${result?.reason || 'not verified'}`);
    console.log(`${lane} verified:true protocol.v2:${!!quote.protocol?.v2}`);
  } catch (error) {
    failures++;
    console.error(`${lane} verified:false ${error.message}`);
  }
}
process.exitCode = failures ? 1 : 0;
