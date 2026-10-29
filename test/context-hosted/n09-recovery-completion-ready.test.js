'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recoveryCompletionSnapshot,
  waitForRecoveryCompletion,
} = require('../../scripts/context-hosted/n09-business/recovery-completion-ready');

const names = [
  'bound',
  'completed',
  'failed',
  'reportingFailed',
  'publicationCleanupFailed',
  'httpPreparationFailed',
  'httpRunFailed',
  'httpEncodingFailed',
  'httpPrepareFailed',
  'httpSendingFailed',
  'httpPublishingFailed',
  'httpFinishFailed',
  'bindingUnavailable',
];
const baseline = { bound: 3, completed: 1 };
const failure = { message: 'n09_recovery_completion_unavailable' };
function health(bound = 3, completed = 1) {
  return {
    status: 200,
    body: {
      pid: 123,
      ok: true,
      appId: 'https-proxy-manager',
      status: 'running',
      contextRecovery: {
        appliedEnabled: true,
        storage: 'persistent',
        counterWindow: 'process_lifetime',
        counters: {
          responses: { ...Object.fromEntries(names.map((name) => [name, 0])), bound, completed },
        },
      },
    },
  };
}
function clock() {
  let time = 100;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}
function safe(error) {
  assert.equal(error.message, failure.message);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error.stack), /PRIVATE_/);
  return true;
}

test('readiness waits for exactly one completed isolated request and never claims a durable ACK', async () => {
  const replies = [health(3, 1), health(4, 1), health(4, 2)];
  let reads = 0;
  assert.deepEqual(recoveryCompletionSnapshot(health(), 123), baseline);
  assert.deepEqual(
    await waitForRecoveryCompletion(() => replies[reads++], baseline, 123, 1100, clock()),
    { completed: true, hostDurableAck: false }
  );
  assert.equal(reads, 3);
  assert.deepEqual(
    await waitForRecoveryCompletion(() => health(4, 2), baseline, 123, 1100, clock()),
    { completed: true, hostDurableAck: false }
  );
});

test('malformed, wrong-owner, inactive and failed health replies are rejected without private details', () => {
  for (const mutate of [
    (value) => {
      value.status = 503;
    },
    (value) => {
      value.body.pid = 124;
    },
    (value) => {
      value.body.ok = false;
    },
    (value) => {
      value.body.appId = 'other';
    },
    (value) => {
      value.body.status = 'stopping';
    },
    (value) => {
      value.body.contextRecovery.appliedEnabled = false;
    },
    (value) => {
      value.body.contextRecovery.storage = 'memory';
    },
    (value) => {
      value.body.contextRecovery.counterWindow = 'other';
    },
    ...names.flatMap((name) =>
      [undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER].map((bad) => (value) => {
        value.body.contextRecovery.counters.responses[name] = bad;
      })
    ),
    ...names
      .filter((name) => !['bound', 'completed'].includes(name))
      .map((name) => (value) => {
        value.body.contextRecovery.counters.responses[name] = 1;
      }),
  ]) {
    const value = health();
    mutate(value);
    assert.throws(() => recoveryCompletionSnapshot(value, 123), safe);
  }
  for (const value of [null, undefined, [], {}, 'PRIVATE_CONTENT'])
    assert.throws(() => recoveryCompletionSnapshot(value, 123), safe);
  for (const pid of [0, -1, NaN, 0.5, '123', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => recoveryCompletionSnapshot(health(), pid), safe);
});

test('getters and Proxy traps are never evaluated by the readiness boundary', async () => {
  let calls = 0;
  const hostile = {
    get body() {
      calls++;
      throw Error('PRIVATE_GETTER');
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        throw Error('PRIVATE_PROXY');
      },
    }
  );
  for (const value of [hostile, proxy]) {
    assert.throws(() => recoveryCompletionSnapshot(value, 123), safe);
    await assert.rejects(
      waitForRecoveryCompletion(() => health(), value, 123, 1100, clock()),
      safe
    );
    await assert.rejects(
      waitForRecoveryCompletion(() => value, baseline, 123, 1100, clock()),
      safe
    );
  }
  const nested = health();
  Object.defineProperty(nested.body.contextRecovery.counters, 'responses', {
    enumerable: true,
    get() {
      calls++;
      throw Error('PRIVATE_NESTED_GETTER');
    },
  });
  assert.throws(() => recoveryCompletionSnapshot(nested, 123), safe);
  assert.equal(calls, 0);
});

test('extra requests, stale/regressing counters and completion without admission cannot satisfy readiness', async () => {
  for (const reply of [health(2, 1), health(3, 0), health(5, 2), health(4, 3), health(3, 2)])
    await assert.rejects(
      waitForRecoveryCompletion(() => reply, baseline, 123, 1100, clock()),
      safe
    );
  await assert.rejects(
    waitForRecoveryCompletion(() => health(), baseline, 123, 200, clock()),
    safe
  );
  const backwards = [health(4, 1), health(3, 1)];
  await assert.rejects(
    waitForRecoveryCompletion(() => backwards.shift(), baseline, 123, 1100, clock()),
    safe
  );
});

test('deadline, polling and dependency failures remain bounded and sanitized', async () => {
  for (const deadline of [NaN, Infinity, 100, 99, 15101])
    await assert.rejects(
      waitForRecoveryCompletion(() => health(4, 2), baseline, 123, deadline, clock()),
      safe
    );
  for (const invalid of [
    null,
    {},
    { bound: 0, completed: -1 },
    { ...baseline, extra: true },
    { bound: Number.MAX_SAFE_INTEGER, completed: 0 },
  ])
    await assert.rejects(
      waitForRecoveryCompletion(() => health(4, 2), invalid, 123, 1100, clock()),
      safe
    );
  for (const dependencies of [
    null,
    { extra: true },
    { now: 123 },
    { sleep: 'bad' },
    {
      now() {
        throw Error('PRIVATE_CLOCK');
      },
    },
    {
      ...clock(),
      sleep() {
        throw Error('PRIVATE_SLEEP');
      },
    },
  ])
    await assert.rejects(
      waitForRecoveryCompletion(() => health(), baseline, 123, 1100, dependencies),
      safe
    );
  await assert.rejects(
    waitForRecoveryCompletion(
      () => {
        throw Error('PRIVATE_HTTP');
      },
      baseline,
      123,
      1100,
      clock()
    ),
    safe
  );
  let reads = 0;
  await assert.rejects(
    waitForRecoveryCompletion(
      () => {
        reads++;
        return health();
      },
      baseline,
      123,
      1100,
      { now: () => 100, sleep: async () => {} }
    ),
    safe
  );
  assert.equal(reads, 300);
  const times = [100, 100, 99];
  await assert.rejects(
    waitForRecoveryCompletion(() => health(4, 2), baseline, 123, 1100, {
      now: () => times.shift(),
      sleep: async () => {},
    }),
    safe
  );
  let time = 100;
  await assert.rejects(
    waitForRecoveryCompletion(
      () => {
        time = 1100;
        return health(4, 2);
      },
      baseline,
      123,
      1100,
      { now: () => time }
    ),
    safe
  );
});
