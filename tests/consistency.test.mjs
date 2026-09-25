// Offline consistency checks: no network, no keys. Run: cd tools && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const json = (p) => JSON.parse(read(p));
const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const docs = ['SKILL.md', 'AGENT-GUIDE.md', 'README.md', 'VERIFY.md'];

test('every JSON file parses', () => {
  json('addresses.json'); json('errors.json'); json('tools/package.json');
  for (const f of readdirSync(new URL('abis/', root))) json(`abis/${f}`);
});

test('addresses.json is Arc-only and every address is well-formed', () => {
  const A = json('addresses.json');
  assert.equal(A.chain.chainId, 5042);
  for (const k of ['robinhood', 'aggregator', 'rail']) assert.equal(A[k], undefined, `retired section ${k}`);
  const walk = (v, path) => {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) assert.ok(isAddress(v), path);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(A, 'A');
  const qi = Object.entries(A.instantV4.quoteInstances).filter(([k]) => !k.startsWith('_'));
  assert.ok(qi.length > 0);
  for (const [sym, q] of qi) for (const f of ['quote', 'strategy', 'splitter']) assert.ok(isAddress(q[f]), `${sym}.${f}`);
});

test('errors.json entries are selector → {sig, contracts}', () => {
  for (const [sel, v] of Object.entries(json('errors.json'))) {
    assert.match(sel, /^0x[0-9a-f]{8}$/);
    assert.equal(typeof v.sig, 'string');
    assert.ok(Array.isArray(v.contracts) && v.contracts.length > 0, sel);
  }
});

test('docs reference only files that exist', () => {
  for (const d of docs) {
    for (const [, p] of read(d).matchAll(/`((?:tools|abis|tests)\/[\w./-]+\.(?:mjs|json|md))`/g)) {
      assert.ok(existsSync(new URL(p, root)), `${d} references missing ${p}`);
    }
  }
});

test('no retired surface is documented or shipped', () => {
  const retired = /crossbuy|crosssell|sweepback|rail-lib|relay-protocol|x402-pay|x402-prices|\/api\/(factsheet|changes|rail|premium|points|rpc|referral|leaderboard|coverage|agents)|RAIL_PK|--factsheet/;
  for (const f of [...docs.filter((d) => d !== 'README.md'), 'addresses.json', 'tools/pad-read.mjs', 'tools/verify.mjs']) {
    assert.doesNotMatch(read(f), retired, f);
  }
  assert.deepEqual(readdirSync(new URL('tools/', root)).filter((f) => f.endsWith('.mjs')).sort(), ['pad-read.mjs', 'verify.mjs']);
});

test('SKILL.md frontmatter is Arc-only v1.0.0', () => {
  const fm = read('SKILL.md').split('---')[1];
  assert.match(fm, /^version: 1\.0\.0$/m);
  assert.doesNotMatch(fm, /Robinhood|x402|Solana|BSC|aggregator (AND|and one)/);
});
