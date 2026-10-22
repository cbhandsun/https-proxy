'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
const { createCompactionFailure } = require('../lib/proxy/context-compaction-failure');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const request = (extra = {}) => ({
  owner: 'owner',
  scope: 'scope',
  operationId: 'op',
  snapshotDigest: 'a'.repeat(64),
  produce: async () => 'valid',
  validate: (value) => value === 'valid',
  ...extra,
});

test('safe summary rejection details survive coalescing without caching failures or swallowing foreign errors', async () => {
  const coordinator = createContextCompactionCoordinator();
  const pending = deferred();
  let calls = 0;
  const input = request({
    produce: async () => {
      calls++;
      await pending.promise;
      throw createCompactionFailure('summary_reference_invalid');
    },
  });
  try {
    const first = coordinator.run(input);
    const second = coordinator.run(input);
    pending.resolve();
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(
      results,
      Array(2).fill({
        ok: false,
        reason: 'invalid_compaction_candidate',
        failureReason: 'summary_reference_invalid',
      })
    );
    assert.equal(coordinator.stats().entries, 0);
    assert.equal((await coordinator.run(request())).ok, true);
    const foreign = new Error('SECRET provider error');
    foreign.reason = 'summary_reference_invalid';
    await assert.rejects(
      coordinator.run(
        request({
          operationId: 'foreign',
          produce: async () => {
            throw foreign;
          },
        })
      ),
      (error) => error === foreign
    );
  } finally {
    coordinator.close();
  }
});

test('single-flight, exact retries and caller revalidation never mix owners or snapshots', async () => {
  const coordinator = createContextCompactionCoordinator();
  const pending = deferred();
  let calls = 0;
  const input = request({
    produce: () => {
      calls += 1;
      return pending.promise;
    },
  });
  const first = coordinator.run(input);
  const second = coordinator.run(input);
  assert.equal(
    (await coordinator.run(request({ snapshotDigest: 'b'.repeat(64) }))).reason,
    'compaction_id_conflict'
  );
  assert.equal(
    (await coordinator.run(request({ operationId: 'other' }))).reason,
    'compaction_busy'
  );
  const otherOwner = await coordinator.run(request({ owner: 'other' }));
  assert.equal(otherOwner.ok, true);
  pending.resolve('valid');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  const retry = await coordinator.run(input);
  assert.equal(retry.reused, true);
  assert.equal(retry.generation, a.generation);
  assert.equal(calls, 1);
  assert.equal(
    (await coordinator.run(request({ validate: () => false }))).reason,
    'invalid_compaction_candidate'
  );
  assert.equal(
    (await coordinator.run(request({ snapshotDigest: 'b'.repeat(64) }))).reason,
    'compaction_id_conflict'
  );
  coordinator.close();
  assert.deepEqual(coordinator.stats(), { active: 0, entries: 0, cacheBytes: 0 });
});

test('subscriber cancellation is independent; only the last subscriber aborts the producer', async () => {
  const coordinator = createContextCompactionCoordinator();
  const pending = deferred();
  let producerSignal;
  const left = new globalThis.AbortController();
  const right = new globalThis.AbortController();
  const input = request({
    produce: (signal) => {
      producerSignal = signal;
      return pending.promise;
    },
  });
  const a = coordinator.run({ ...input, signal: left.signal });
  const b = coordinator.run({ ...input, signal: right.signal });
  await tick();
  left.abort();
  assert.equal((await a).reason, 'compaction_cancelled');
  assert.equal(producerSignal.aborted, false);
  pending.resolve('valid');
  assert.equal((await b).ok, true);

  const abandoned = deferred();
  const cancel = new globalThis.AbortController();
  const c = coordinator.run(
    request({
      operationId: 'abandoned',
      signal: cancel.signal,
      produce: (signal) => {
        producerSignal = signal;
        return abandoned.promise;
      },
    })
  );
  await tick();
  cancel.abort();
  assert.equal((await c).reason, 'compaction_cancelled');
  await tick();
  assert.equal(producerSignal.aborted, true);
  assert.equal(coordinator.stats().active, 0);
  abandoned.reject(new Error('late provider failure is observed'));
  await tick();
  coordinator.close();
});

test('deadline, close, exceptions and invalid candidates release capacity even for a never-settling producer', async () => {
  const coordinator = createContextCompactionCoordinator({ deadlineMs: 10 });
  let signal;
  const timeout = await coordinator.run(
    request({
      produce: (child) => {
        signal = child;
        return new Promise(() => {});
      },
    })
  );
  assert.equal(timeout.reason, 'compaction_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(coordinator.stats().active, 0);
  for (const value of [null, '', ' ', {}, 'x'.repeat(32769)])
    assert.equal(
      (await coordinator.run(request({ produce: async () => value }))).reason,
      'invalid_compaction_candidate'
    );
  await assert.rejects(
    coordinator.run(
      request({
        produce: async () => {
          throw new Error('provider');
        },
      })
    ),
    /provider/
  );
  await assert.rejects(
    coordinator.run(
      request({
        validate: () => {
          throw new Error('validator');
        },
      })
    ),
    /validator/
  );
  const active = coordinator.run(request({ produce: () => new Promise(() => {}) }));
  coordinator.close();
  assert.equal((await active).reason, 'compaction_closed');
  assert.equal((await coordinator.run(request())).reason, 'compaction_closed');
});

test('invalid inputs, bounded quota, expiration and clock rollback fail closed without logging content', async () => {
  let now = 100;
  const coordinator = createContextCompactionCoordinator({
    now: () => now,
    ttlMs: 10,
    maxEntries: 1,
    maxValueBytes: 5,
    maxCacheBytes: 5,
  });
  for (const invalid of [
    null,
    [],
    42,
    request({ owner: '' }),
    request({ scope: 'bad\n' }),
    request({ operationId: 'x'.repeat(257) }),
    request({ snapshotDigest: 'not-hash' }),
    request({ produce: null }),
    request({ validate: null }),
    request({ signal: {} }),
  ])
    assert.equal((await coordinator.run(invalid)).reason, 'invalid_compaction_request');
  const cancelled = new globalThis.AbortController();
  cancelled.abort();
  assert.equal(
    (await coordinator.run(request({ signal: cancelled.signal }))).reason,
    'compaction_cancelled'
  );
  assert.equal((await coordinator.run(request())).ok, true);
  assert.equal(
    (await coordinator.run(request({ operationId: 'other', owner: 'other' }))).reason,
    'compaction_busy'
  );
  now = 111;
  assert.equal((await coordinator.run(request())).reused, false);
  now = 90;
  assert.equal((await coordinator.run(request())).reason, 'compaction_clock_invalid');
  assert.equal(coordinator.stats().entries, 0);
  now = Number.MAX_SAFE_INTEGER;
  assert.equal((await coordinator.run(request())).reason, 'compaction_clock_invalid');
  coordinator.close();
});

test('coalesced and cached callers revalidate; clock change during production cannot cache success', async () => {
  let now = 100;
  const coordinator = createContextCompactionCoordinator({ now: () => now });
  const pending = deferred();
  const first = coordinator.run(request({ produce: () => pending.promise }));
  const second = coordinator.run(request({ validate: () => false }));
  pending.resolve('valid');
  assert.equal((await first).ok, true);
  assert.equal((await second).reason, 'invalid_compaction_candidate');
  await assert.rejects(
    coordinator.run(
      request({
        validate: () => {
          throw new Error('cached validator');
        },
      })
    ),
    /cached validator/
  );
  const backwards = coordinator.run(
    request({
      operationId: 'clock',
      produce: async () => {
        now = 50;
        return 'valid';
      },
    })
  );
  assert.equal((await backwards).reason, 'compaction_clock_invalid');
  coordinator.close();
});
