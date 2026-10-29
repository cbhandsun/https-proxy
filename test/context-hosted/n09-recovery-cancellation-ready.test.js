'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  recoveryCancellationSnapshot,
  waitForRecoveryCancellation,
} = require('../../scripts/context-hosted/n09-business/recovery-cancellation-ready');
const {
  recoveryCompletionSnapshot,
} = require('../../scripts/context-hosted/n09-business/recovery-completion-ready');
const {
  RECOVERY_FAILURE_COUNTERS,
} = require('../../scripts/context-hosted/n09-business/recovery-health-counters');
const safe = { message: 'n09_recovery_cancellation_unavailable' },
  baseline = { bound: 3, completed: 2 };
function health(bound = 3, failed = 0, stage = 0) {
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
          responses: {
            ...Object.fromEntries(RECOVERY_FAILURE_COUNTERS.map((k) => [k, 0])),
            bound,
            completed: 2,
            failed,
            httpSendingFailed: stage,
          },
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
test('one expected failure stage waits for original cleanup and final outcome without granting a durable ACK', async () => {
  const rows = [health(), health(4, 0, 1), health(4, 1, 1)];
  let reads = 0;
  assert.deepEqual(
    await waitForRecoveryCancellation(() => rows[reads++], baseline, 123, 1100, clock()),
    { cancelled: true, cleanupFinished: true, hostDurableAck: false }
  );
  assert.equal(reads, 3);
  assert.throws(() => recoveryCompletionSnapshot(health(4, 1, 1), 123), {
    message: 'n09_recovery_completion_unavailable',
  });
});
test('other failures, success, extra requests and illegal order never qualify', async () => {
  const bad = [];
  for (const name of RECOVERY_FAILURE_COUNTERS.filter(
    (k) => !['failed', 'httpSendingFailed'].includes(k)
  )) {
    const v = health(4, 1, 1);
    v.body.contextRecovery.counters.responses[name] = 1;
    bad.push(v);
  }
  const success = health(4);
  success.body.contextRecovery.counters.responses.completed = 3;
  bad.push(success, health(5, 1, 1), health(3, 1, 1), health(4, 1, 0), health(4, 2, 1));
  for (const value of bad)
    await assert.rejects(
      waitForRecoveryCancellation(() => value, baseline, 123, 1100, clock()),
      safe
    );
});
test('counter rollback is terminal rather than retried until a later good result', async () => {
  const rows = [health(4, 0, 1), health(4, 0, 0), health(4, 1, 1)];
  let reads = 0;
  await assert.rejects(
    waitForRecoveryCancellation(() => rows[reads++], baseline, 123, 1100, clock()),
    safe
  );
  assert.equal(reads, 2);
});
test('wrong owner, inactive persistence, malformed and extreme counts are refused', () => {
  for (const mutate of [
    (v) => {
      v.body.pid = 124;
    },
    (v) => {
      v.body.contextRecovery.storage = 'memory';
    },
    (v) => {
      v.body.contextRecovery.appliedEnabled = false;
    },
    (v) => {
      v.body.contextRecovery.counterWindow = 'other';
    },
    ...[-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER].map((value) => (v) => {
      v.body.contextRecovery.counters.responses.bound = value;
    }),
  ]) {
    const v = health();
    mutate(v);
    assert.throws(() => recoveryCancellationSnapshot(v, 123), safe);
  }
});
test('absent progress and never-settling read/sleep promises are bounded by the original remaining deadline', async () => {
  await assert.rejects(
    waitForRecoveryCancellation(() => health(), baseline, 123, 150, clock()),
    safe
  );
  await assert.rejects(
    waitForRecoveryCancellation(() => new Promise(() => {}), baseline, 123, Date.now() + 25),
    safe
  );
  await assert.rejects(
    waitForRecoveryCancellation(() => health(), baseline, 123, Date.now() + 25, {
      sleep: () => new Promise(() => {}),
    }),
    safe
  );
  await assert.rejects(
    waitForRecoveryCancellation(() => health(), baseline, 123, 15101, { now: () => 100 }),
    safe
  );
});
test('unknown then hooks and mutated fulfilled data are never assimilated while reading health', async () => {
  let touched = 0;
  const data = health(4, 1, 1),
    pending = Promise.resolve(data);
  Object.defineProperty(data, 'then', {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  await assert.rejects(
    waitForRecoveryCancellation(() => pending, baseline, 123, 1100, clock()),
    safe
  );
  const getter = Object.defineProperty(health(), 'body', {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  await assert.rejects(
    waitForRecoveryCancellation(() => getter, baseline, 123, 1100, clock()),
    safe
  );
  const thenable = {
    get then() {
      touched++;
      throw Error('PRIVATE');
    },
  };
  await assert.rejects(
    waitForRecoveryCancellation(() => thenable, baseline, 123, 1100, clock()),
    safe
  );
  assert.equal(touched, 0);
});
test('invalid baselines, proxy dependencies, errors and rollback clocks expose only a fixed refusal', async () => {
  let touched = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        touched++;
        throw Error('PRIVATE');
      },
    }
  );
  for (const input of [null, {}, proxy, { bound: -1, completed: 2 }, { ...baseline, extra: 1 }])
    await assert.rejects(
      waitForRecoveryCancellation(() => health(), input, 123, 1100, clock()),
      safe
    );
  await assert.rejects(
    waitForRecoveryCancellation(
      () => {
        throw Error('PRIVATE');
      },
      baseline,
      123,
      1100,
      clock()
    ),
    safe
  );
  let time = 100;
  await assert.rejects(
    waitForRecoveryCancellation(
      () => {
        time = 99;
        return health();
      },
      baseline,
      123,
      1100,
      { now: () => time, sleep: async () => {} }
    ),
    safe
  );
  assert.equal(touched, 0);
});
