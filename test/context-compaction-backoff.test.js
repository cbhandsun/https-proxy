'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compactionBackoffKey,
  createContextCompactionBackoff,
} = require('../lib/proxy/context-compaction-backoff');
const binding = {
  owner: 'owner',
  provider: 'workbuddy-wbipc',
  model: 'model',
  endpoint: 'https://host/v2',
};
const fingerprint = (extra = {}, message = 'a', controls = 'b', plan = 'c') =>
  compactionBackoffKey(
    { ...binding, ...extra },
    message.repeat(64),
    controls.repeat(64),
    plan.repeat(64)
  );
const failure = {
  ok: false,
  reason: 'invalid_compaction_candidate',
  failureReason: 'summary_schema_invalid',
};

test('exact retries reuse only safe failures until fixed expiry, not summary content or new snapshots', async () => {
  let now = 1000,
    calls = 0;
  const backoff = createContextCompactionBackoff({ now: () => now, cooldownMs: 100 });
  const input = {
    key: fingerprint(),
    produce: async () => {
      calls++;
      return { ...failure };
    },
  };
  assert.deepEqual(await backoff.run(input), failure);
  now = 1020;
  assert.deepEqual(await backoff.run(input), {
    ...failure,
    backoffApplied: true,
    retryAfterMs: 80,
  });
  now = 1099;
  assert.equal((await backoff.run(input)).retryAfterMs, 1, 'hits never extend the cooldown');
  assert.equal(calls, 1);
  for (const key of [
    fingerprint({ owner: 'other' }),
    fingerprint({ provider: 'other' }),
    fingerprint({ model: 'other' }),
    fingerprint({ endpoint: 'https://other/v2' }),
    fingerprint({}, 'd'),
    fingerprint({}, 'a', 'd'),
    fingerprint({}, 'a', 'b', 'd'),
  ])
    assert.equal((await backoff.run({ ...input, key })).backoffApplied, undefined);
  assert.equal(calls, 8);
  now = 1100;
  assert.equal((await backoff.run(input)).backoffApplied, undefined);
  assert.equal(calls, 9);
  assert.ok(!JSON.stringify(backoff.stats()).includes('owner'));
});

test('success, cancellation, busy, unknown failures and thrown errors are never negatively cached', async () => {
  const backoff = createContextCompactionBackoff();
  for (const result of [
    { ok: true, value: 'SECRET summary' },
    { ok: false, reason: 'compaction_cancelled' },
    { ok: false, reason: 'compaction_busy' },
    { ok: false, reason: 'invalid_compaction_candidate' },
    { ...failure, failureReason: 'SECRET' },
    { ...failure, body: 'SECRET provider body' },
  ]) {
    let calls = 0;
    const input = {
      key: fingerprint(),
      produce: async () => {
        calls++;
        return result;
      },
    };
    assert.equal(await backoff.run(input), result);
    assert.equal(await backoff.run(input), result);
    assert.equal(calls, 2);
    assert.equal(backoff.stats().entries, 0);
  }
  const controller = new globalThis.AbortController();
  await backoff.run({
    key: fingerprint(),
    signal: controller.signal,
    produce: async () => {
      controller.abort();
      return failure;
    },
  });
  assert.equal(backoff.stats().entries, 0);
  let calls = 0;
  assert.equal(
    (
      await backoff.run({
        key: fingerprint(),
        signal: controller.signal,
        produce: async () => {
          calls++;
          return failure;
        },
      })
    ).reason,
    'compaction_cancelled'
  );
  assert.equal(calls, 0);
  const foreign = new Error('SECRET');
  await assert.rejects(
    backoff.run({
      key: fingerprint(),
      produce: async () => {
        throw foreign;
      },
    }),
    (error) => error === foreign
  );
  assert.equal(backoff.stats().entries, 0);
});

test('timeout cooldown and quota are bounded; clock anomalies clear state without preventing real work', async () => {
  let now = 100;
  const backoff = createContextCompactionBackoff({ now: () => now, maxEntries: 1 });
  let calls = 0;
  const input = {
    key: fingerprint(),
    produce: async () => {
      calls++;
      return { ok: false, reason: 'compaction_timeout' };
    },
  };
  await backoff.run(input);
  assert.equal((await backoff.run(input)).backoffApplied, true);
  await backoff.run({ ...input, key: fingerprint({ owner: 'other' }) });
  assert.equal(backoff.stats().entries, 1);
  assert.equal((await backoff.run(input)).backoffApplied, undefined);
  assert.equal(calls, 3);
  for (const time of [99, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    now = time;
    assert.equal((await backoff.run(input)).backoffApplied, undefined);
    assert.equal(backoff.stats().entries, 0);
  }
  now = 101;
  await backoff.run(input);
  backoff.clear();
  assert.equal(backoff.stats().entries, 0);
});

test('backoff input boundaries reject malformed data and accessors without invoking hooks', async () => {
  let hooks = 0;
  const hostile = Object.defineProperty({}, 'now', {
    get() {
      hooks++;
      return Date.now;
    },
  });
  for (const options of [
    null,
    [],
    hostile,
    { now: 1 },
    { cooldownMs: 0 },
    { cooldownMs: 30001 },
    { maxEntries: 257 },
    { maxEntries: '1' },
    { secret: 'SECRET' },
  ])
    assert.throws(() => createContextCompactionBackoff(options), TypeError);
  const backoff = createContextCompactionBackoff();
  for (const input of [
    null,
    [],
    {},
    { key: 'SECRET', produce: () => failure },
    { key: fingerprint(), produce: null },
    { key: fingerprint(), signal: {}, produce: () => failure },
    Object.defineProperty({}, 'key', {
      get() {
        hooks++;
        return fingerprint();
      },
    }),
  ])
    await assert.rejects(backoff.run(input), TypeError);
  for (const value of ['', 'x'.repeat(65), 0, null, {}])
    assert.throws(
      () => compactionBackoffKey(binding, value, 'b'.repeat(64), 'c'.repeat(64)),
      TypeError
    );
  assert.throws(() =>
    compactionBackoffKey({ ...binding, owner: '' }, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64))
  );
  assert.equal(hooks, 0);
});
