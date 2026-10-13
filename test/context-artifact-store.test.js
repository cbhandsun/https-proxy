'use strict';

const assert = require('assert');
const {
  LOCATOR_PATTERN,
  createContextArtifactStore,
} = require('../lib/proxy/context-artifact-store');

let currentTime = 1000;
const store = createContextArtifactStore({
  now: () => currentTime,
  ttlMs: 100,
  maxArtifactBytes: 128,
  maxBytes: 180,
  maxEntries: 2,
});

const first = store.put('owner-a', 'session-a', { text: 'first', nested: { value: 1 } });
assert.match(first.locator, LOCATOR_PATTERN);
assert.match(first.digest, /^[0-9a-f]{64}$/);
assert.ok(first.bytes > 0);

const read = store.read('owner-a', 'session-a', first.locator, first.digest);
assert.equal(read.ok, true);
assert.deepStrictEqual(read.value, { text: 'first', nested: { value: 1 } });
read.value.nested.value = 99;
assert.equal(store.read('owner-a', 'session-a', first.locator).value.nested.value, 1);

assert.deepStrictEqual(store.read('owner-b', 'session-a', first.locator), {
  ok: false,
  reason: 'not_found',
});
assert.deepStrictEqual(store.read('owner-a', 'session-b', first.locator), {
  ok: false,
  reason: 'not_found',
});
assert.deepStrictEqual(store.read('owner-a', 'session-a', 'hca_' + '0'.repeat(32)), {
  ok: false,
  reason: 'not_found',
});
assert.equal(
  store.read('owner-a', 'session-a', first.locator, '0'.repeat(64)).reason,
  'digest_mismatch'
);

assert.equal(store.put('', 'session-a', 'x'), null);
assert.equal(store.put('owner-a', '', 'x'), null);
assert.equal(store.put('owner-a', 'session-a', ''), null);
assert.equal(store.put('owner-a', 'session-a', 'x'.repeat(129)), null);
assert.equal(store.put('owner-a', 'session-a', 1n), null);
const cyclic = [];
cyclic.push(cyclic);
assert.equal(store.put('owner-a', 'session-a', cyclic), null);

const poisoned = JSON.parse('{"__proto__":{"polluted":true},"safe":"yes"}');
const poisonRecord = store.put('owner-a', 'session-a', poisoned);
assert.equal(store.read('owner-a', 'session-a', poisonRecord.locator).value.safe, 'yes');
assert.equal({}.polluted, undefined);

const second = store.put('owner-a', 'session-a', 'second-' + 's'.repeat(70));
assert.equal(second, null, 'quota exhaustion must not invalidate a live receipt');
assert.ok(store.stats().entries <= 2);
assert.ok(store.stats().retainedBytes <= 180);
assert.equal(store.read('owner-a', 'session-a', first.locator).ok, true, 'live lease is preserved');

currentTime += 101;
assert.equal(store.read('owner-a', 'session-a', first.locator).reason, 'not_found');
assert.deepStrictEqual(store.stats(), {
  entries: 0,
  retainedBytes: 0,
  maxEntries: 2,
  maxBytes: 180,
  maxArtifactBytes: 128,
});

const one = store.put('owner-a', 'session-x', 'one');
const two = store.put('owner-a', 'session-x', 'two');
assert.ok(one && two);
assert.equal(store.discardSession('owner-b', 'session-x'), 0);
assert.equal(store.discardSession('owner-a', 'session-x'), 2);
assert.equal(store.discard('owner-a', 'session-x', one.locator), false);

const futureStore = createContextArtifactStore({ now: () => 10, ttlMs: 10 });
const future = futureStore.put('owner', 'session', 'future');
assert.ok(future);
const skewedStore = createContextArtifactStore({ now: () => 5, ttlMs: 10 });
assert.deepStrictEqual(skewedStore.stats().entries, 0);

console.log('[context-artifact-store.test] ok');
