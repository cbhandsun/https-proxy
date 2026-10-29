'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSummaryFrontier } = require('../lib/proxy/context-summary-frontier');
const { discoverTestFiles } = require('../lib/test-discovery');
const manifest = require('../scripts/release-proxy-sources.json');
const path = require('node:path');

const contract = 'a'.repeat(64);
const limits = { maxBytes: 393216, maxTokens: 98304 };
const prefixes = [
  { index: 1, digest: 'b'.repeat(64) },
  { index: 3, digest: 'c'.repeat(64) },
];

test('frontier binds bounded semantic prefixes, contract, position and source controls without retaining caller objects', () => {
  const original = globalThis.structuredClone(prefixes);
  const budgets = { ...limits };
  const frontier = createSummaryFrontier(original, budgets, contract, 4);
  const binding = [
    'owner-route-policy-control',
    'raw-prefix',
    [1],
    limits.maxBytes,
    limits.maxTokens,
  ];
  const key = frontier.key(3, binding);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(frontier.key(0, binding), null, 'absent source is not a shared null identity');
  assert.equal(frontier.key(3, [...binding]), key);
  assert.notEqual(frontier.key(1, binding), key);
  assert.notEqual(frontier.key(3, ['changed']), key);
  assert.notEqual(createSummaryFrontier(prefixes, limits, 'd'.repeat(64), 4).key(3, binding), key);
  assert.equal(
    createSummaryFrontier(prefixes, limits, contract, 5).key(3, binding),
    key,
    'appending messages does not invalidate an unchanged prefix'
  );
  original[1].digest = 'e'.repeat(64);
  budgets.maxBytes = 1;
  assert.equal(frontier.key(3, binding), key);
  assert.equal(frontier.limits.maxBytes, limits.maxBytes);
  assert.equal(Object.isFrozen(frontier.limits), true);
  const manyPins = Array.from({ length: 16384 }, (_, index) => index);
  assert.match(frontier.key(3, ['controls', manyPins]), /^[a-f0-9]{64}$/);
});

test('frontier validates empty, malformed, extreme and unknown metadata without coercion or hooks', () => {
  for (const sourceMessages of [undefined, 0, -1, 1.5, NaN, Infinity, 16385])
    assert.throws(() => createSummaryFrontier(prefixes, limits, contract, sourceMessages));
  for (const value of [null, '', 'A'.repeat(64), 'a'.repeat(63), {}])
    assert.throws(() => createSummaryFrontier(prefixes, limits, value, 4));
  for (const value of [
    null,
    [],
    {},
    [{ index: -1, digest: 'b'.repeat(64) }],
    [{ index: 4, digest: 'b'.repeat(64) }],
    [{ index: 1.1, digest: 'b'.repeat(64) }],
    [{ index: 1, digest: 'x'.repeat(64) }],
    [{ index: 1, digest: 1 }],
    [prefixes[0], prefixes[0]],
    [prefixes[1], prefixes[0]],
    [{ ...prefixes[0], content: 'SECRET' }],
    Array(2),
    Array.from({ length: 16385 }, (_, index) => ({ index, digest: 'b'.repeat(64) })),
  ])
    assert.throws(() => createSummaryFrontier(value, limits, contract, 4));
  for (const value of [
    null,
    [],
    {},
    { ...limits, extra: 1 },
    { ...limits, maxBytes: 0 },
    { ...limits, maxTokens: '1' },
    { ...limits, maxTokens: 16777217 },
  ])
    assert.throws(() => createSummaryFrontier(prefixes, value, contract, 4));
  const frontier = createSummaryFrontier(prefixes, limits, contract, 4);
  for (const index of [-1, 4, 1.5, NaN, '1']) assert.throws(() => frontier.key(index, []));
  let hooks = 0;
  const getter = Object.defineProperty({}, 'index', {
    enumerable: true,
    get() {
      hooks++;
      return 1;
    },
  });
  const executable = {
    toJSON() {
      hooks++;
      return [];
    },
  };
  assert.throws(() => createSummaryFrontier([getter], limits, contract, 4));
  assert.throws(() => createSummaryFrontier(executable, limits, contract, 4));
  assert.throws(() => frontier.key(1, getter));
  assert.throws(() => frontier.key(1, executable));
  assert.equal(hooks, 0);
  const maximum = createSummaryFrontier(
    Array.from({ length: 16384 }, (_, index) => ({ index, digest: 'b'.repeat(64) })),
    { maxBytes: 16777216, maxTokens: 16777216 },
    contract,
    16384
  );
  assert.match(maximum.key(16383, []), /^[a-f0-9]{64}$/);
});

test('frontier regressions enter unified discovery and runtime release inventory', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/context-summary-frontier.test.js'
    )
  );
  assert.ok(JSON.stringify(manifest).includes('lib/proxy/context-summary-frontier.js'));
});
