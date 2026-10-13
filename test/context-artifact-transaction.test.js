'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { collectContextArtifactReferences } = require('../lib/proxy/context-artifact-references');
const {
  EVIDENCE_MARKER,
  CHECKPOINT_MARKER,
  CHECKPOINT_SCHEMA,
} = require('../lib/proxy/context-checkpoint');
const reference = (receipt, scope = 'scope') => ({
  locator: receipt.locator,
  digest: receipt.digest,
  scope,
});

test('staged evidence is invisible; only the validated write set is published atomically', () => {
  const store = createContextArtifactStore();
  const previous = store.put('owner', 'scope', 'previous');
  const tx = store.beginTransaction('owner', 'scope');
  const first = tx.put('owner', 'scope', 'selected evidence');
  const unused = tx.put('owner', 'scope', 'unused evidence');
  assert.equal(store.read('owner', 'scope', first.locator, first.digest).ok, false);
  assert.equal(store.readPage('owner', 'scope', first.locator, first.digest, {}).ok, false);
  assert.equal(store.stats().entries, 1);
  const committed = tx.commit([reference(first), reference(previous)]);
  assert.deepEqual(committed, { ok: true, committedEntries: 1, discardedEntries: 1 });
  assert.equal(
    store.read('owner', 'scope', first.locator, first.digest).value,
    'selected evidence'
  );
  assert.equal(store.read('owner', 'scope', unused.locator).ok, false);
  assert.equal(store.stats().entries, 2);
  assert.equal(tx.rollback(), false);
  assert.deepEqual(tx.commit([reference(previous), reference(first), reference(first)]), committed);
  assert.equal(tx.commit([]).reason, 'settled', 'different retry is a conflict');
  assert.equal(tx.put('owner', 'scope', 'late'), null);
});

test('concurrent staging reserves shared quota and rollback releases it without touching live evidence', () => {
  const store = createContextArtifactStore({ maxEntries: 2 });
  const live = store.put('owner', 'scope', 'live');
  const first = store.beginTransaction('owner', 'scope');
  const second = store.beginTransaction('owner', 'scope');
  const staged = first.put('owner', 'scope', 'pending');
  assert.ok(staged);
  assert.equal(second.put('owner', 'scope', 'overbooked'), null);
  assert.equal(store.put('other-owner', 'other-scope', 'overbooked'), null);
  assert.equal(first.rollback(), true);
  assert.equal(first.rollback(), false);
  const admitted = second.put('owner', 'scope', 'now fits');
  assert.ok(admitted);
  assert.equal(second.commit([reference(admitted)]).ok, true);
  assert.equal(store.read('owner', 'scope', live.locator, live.digest).value, 'live');
});

test('empty, invalid, extreme and unauthorized transaction inputs fail without publication', () => {
  const store = createContextArtifactStore({ maxArtifactBytes: 128, maxEntries: 2 });
  for (const owner of ['', null, {}, Symbol('owner'), 'o'.repeat(257), '\u0000'])
    assert.equal(store.beginTransaction(owner, 'scope'), null);
  const tx = store.beginTransaction('owner', 'scope');
  assert.equal(tx.put('other-owner', 'scope', 'wrong'), null);
  assert.equal(tx.put('owner', 'other-scope', 'wrong'), null);
  for (const value of ['', undefined, 1n, 'x'.repeat(129)])
    assert.equal(tx.put('owner', 'scope', value), null);
  assert.deepEqual(tx.commit([]), { ok: true, committedEntries: 0, discardedEntries: 0 });
  for (const references of [
    null,
    {},
    [null],
    [{ locator: Symbol('locator') }],
    Array(3).fill({}),
  ]) {
    const invalid = store.beginTransaction('owner', 'scope');
    invalid.put('owner', 'scope', 'pending');
    assert.equal(invalid.commit(references).ok, false);
    assert.equal(store.stats().entries, 0);
    assert.ok(store.put('owner', 'scope', 'quota released'));
    store.discardSession('owner', 'scope');
  }
  for (const override of [{ scope: 'other-scope' }, { digest: '0'.repeat(64) }]) {
    const wrong = store.beginTransaction('owner', 'scope');
    const first = wrong.put('owner', 'scope', 'first');
    const second = wrong.put('owner', 'scope', 'second');
    assert.equal(wrong.commit([reference(first), { ...reference(second), ...override }]).ok, false);
    assert.equal(store.stats().entries, 0, 'no partial publication');
  }
});

test('expired, cancelled, closed and clock-skewed reservations cannot publish', () => {
  for (const action of ['expired', 'cancelled', 'closed', 'skewed']) {
    let time = 1000;
    const store = createContextArtifactStore({ now: () => time, ttlMs: 10 });
    const tx = store.beginTransaction('owner', 'scope');
    const receipt = tx.put('owner', 'scope', 'pending');
    if (action === 'expired') time += 10;
    if (action === 'cancelled') store.discardSession('owner', 'scope');
    if (action === 'closed') store.close();
    if (action === 'skewed') time -= 1;
    assert.equal(tx.commit([reference(receipt)]).ok, false);
    assert.equal(store.stats().entries, 0);
  }
});

test('reference collector accepts bound receipts/checkpoints but not arbitrary locator mentions or hostile markers', () => {
  const receipt = {
    kind: 'historical_tool_evidence',
    callId: 'call',
    bytes: 10,
    locator: 'hca_' + 'a'.repeat(32),
    digest: 'b'.repeat(64),
    scope: 'scope',
  };
  const text = `${EVIDENCE_MARKER} ${JSON.stringify(receipt)}`;
  const checkpoint = {
    schema: CHECKPOINT_SCHEMA,
    version: 1,
    sourceRole: 'assistant',
    entries: [{ callReceipt: receipt }],
    evidenceReceipts: [receipt],
  };
  const messages = [
    { role: 'tool', tool_call_id: 'call', content: text },
    { role: 'assistant', content: `${CHECKPOINT_MARKER}\n${JSON.stringify(checkpoint)}` },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: text }] },
    { role: 'tool', tool_call_id: 'call', content: [{ type: 'text', text }] },
  ];
  assert.deepEqual(collectContextArtifactReferences(messages, 'scope'), [reference(receipt)]);
  assert.deepEqual(collectContextArtifactReferences(messages, 'other-scope'), []);
  for (const content of [
    text,
    receipt.locator,
    EVIDENCE_MARKER + ' {',
    EVIDENCE_MARKER + ' '.repeat(5000),
  ]) {
    assert.deepEqual(collectContextArtifactReferences([{ role: 'user', content }], 'scope'), []);
    assert.deepEqual(
      collectContextArtifactReferences(
        [{ role: 'tool', tool_call_id: 'wrong-call', content }],
        'scope'
      ),
      []
    );
  }
  assert.deepEqual(collectContextArtifactReferences(null, 'scope'), []);
});
