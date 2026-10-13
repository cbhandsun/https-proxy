'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContextExecutionLedger } = require('../lib/client/context-execution-ledger');
const outcome = (overrides = {}) => ({
  state: 'completed',
  retention: 'unavailable',
  sourceId: null,
  digest: null,
  ...overrides,
});

test('execution observations distinguish completion, failure and uncertainty from verification', () => {
  const ledger = createContextExecutionLedger();
  for (const state of ['completed', 'failed', 'unknown']) {
    const callId = ledger.begin('tool');
    ledger.finish(callId, outcome({ state }));
    assert.throws(() => ledger.finish(callId, outcome()));
  }
  const list = ledger.list();
  assert.deepEqual(
    list.records.map((x) => x.state),
    ['completed', 'failed', 'unknown']
  );
  assert.ok(list.records.every((x) => x.verification === 'not_verified'));
  assert.equal(list.scope, 'connection');
  ledger.close();
  assert.throws(() => ledger.begin('tool'));
  assert.throws(() => ledger.list());
});

test('execution records retain only validated evidence references', () => {
  const ledger = createContextExecutionLedger();
  const callId = ledger.begin('tool');
  const sourceId = 'hce_' + 'a'.repeat(32);
  const digest = 'b'.repeat(64);
  ledger.finish(callId, outcome({ retention: 'retained', sourceId, digest }));
  assert.equal(ledger.list().records[0].sourceId, sourceId);
  const id2 = ledger.begin('tool');
  for (const value of [
    null,
    [],
    outcome({ state: 'success' }),
    outcome({ retention: 'retained' }),
    outcome({ sourceId }),
    outcome({ extra: 'secret' }),
    outcome({ digest }),
  ])
    assert.throws(() => ledger.finish(id2, value));
  assert.throws(() => ledger.finish('foreign', outcome()));
  ledger.finish(id2, outcome({ state: 'failed', retention: 'excluded' }));
});

test('execution pagination, bounded capacity, absolute expiry and stale cursors', () => {
  let now = 0;
  const ledger = createContextExecutionLedger({ now: () => now, ttlMs: 20 });
  for (let i = 0; i < 128; i++) ledger.finish(ledger.begin('tool'), outcome());
  assert.throws(() => ledger.begin('tool'));
  let cursor;
  let count = 0;
  do {
    const result = ledger.list(cursor ? { afterCallId: cursor, limit: 7 } : { limit: 7 });
    count += result.records.length;
    cursor = result.nextAfterCallId;
  } while (cursor);
  assert.equal(count, 128);
  const old = ledger.list().records[0].callId;
  now = 20;
  assert.equal(ledger.list().records.length, 0);
  assert.throws(() => ledger.list({ afterCallId: old }));
  assert.throws(() => ledger.finish(old, outcome()));
  assert.ok(ledger.begin('tool'));
  now = 19;
  assert.throws(() => ledger.list());
  assert.throws(() => ledger.list());
});

test('execution boundary rejects unsafe inputs, extreme clocks and executable data', () => {
  let optionsGetterCalls = 0;
  const optionsGetter = Object.defineProperty({}, 'now', {
    get() {
      optionsGetterCalls++;
      return Date.now;
    },
  });
  for (const options of [null, [], { owner: 'foreign' }, optionsGetter])
    assert.throws(() => createContextExecutionLedger(options));
  assert.equal(optionsGetterCalls, 0);
  for (const options of [{ now: 1 }, { ttlMs: 0 }, { ttlMs: 7200001 }, { ttlMs: NaN }])
    assert.throws(() => createContextExecutionLedger(options));
  for (const clock of [
    () => -1,
    () => Infinity,
    () => Number.MAX_SAFE_INTEGER,
    () => {
      throw new Error('never expose');
    },
  ])
    assert.throws(() => createContextExecutionLedger({ now: clock }).list(), /unavailable/);
  const ledger = createContextExecutionLedger();
  for (const name of ['', '../path', 'a'.repeat(129), null])
    assert.throws(() => ledger.begin(name));
  for (const args of [
    null,
    [],
    { limit: '1' },
    { limit: 0 },
    { limit: 17 },
    { limit: 1.5 },
    { afterCallId: 'foreign' },
    { owner: 'foreign' },
  ])
    assert.throws(() => ledger.list(args));
  let invoked = 0;
  const getter = Object.defineProperty({}, 'limit', {
    enumerable: true,
    get() {
      invoked++;
      return 1;
    },
  });
  assert.throws(() => ledger.list(getter));
  assert.equal(invoked, 0);
});
