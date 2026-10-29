'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRuntimeReopenProgress,
  PHASES,
} = require('../scripts/lib/nsis-runtime-reopen-progress');
const failure = { message: 'runtime_reopen_assertion_failed' };
test('reopen diagnostics are opt-in and preserve returned values without reading the diagnostic clock', async () => {
  const value = { private: 'PRIVATE' };
  let times = 0;
  const progress = createRuntimeReopenProgress(undefined, () => {
    times++;
    throw new Error('PRIVATE');
  });
  assert.equal(await progress.run('revoke', 'initial-ready', () => value), value);
  assert.equal(times, 0);
});
test('reopen progress emits bounded fixed phase, action, event and monotonic numerical data only', async () => {
  const events = [];
  let time = 10;
  const progress = createRuntimeReopenProgress(
    {
      onPhase: (event) => {
        events.push(event);
      },
    },
    () => time++
  );
  for (const action of ['revoke', 'clear'])
    for (const phase of PHASES) assert.equal(await progress.run(action, phase, () => 42), 42);
  assert.equal(events.length, PHASES.length * 4);
  assert.ok(events.length <= 128);
  events.forEach((event, index) => {
    assert.deepEqual(Object.keys(event), [
      'version',
      'action',
      'phase',
      'event',
      'sequence',
      'elapsedMs',
    ]);
    assert.equal(event.sequence, index + 1);
    assert.equal(event.elapsedMs, index);
    assert.equal(Object.isFrozen(event), true);
    assert.equal(event.event, index % 2 ? 'end' : 'start');
  });
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|receipt|scope|directory|token|headers/);
});
test('reopen rejected operations emit fixed failure without leaking exception contents', async () => {
  const events = [];
  const progress = createRuntimeReopenProgress({
    onPhase: (event) => {
      events.push(event);
    },
  });
  await assert.rejects(
    progress.run('clear', 'direct-open', () => {
      throw new Error('PRIVATE database path');
    }),
    failure
  );
  assert.deepEqual(
    events.map((x) => x.event),
    ['start', 'failure']
  );
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});
test('reopen observer failures remain sticky while subsequent real cleanup still executes', async () => {
  for (const callback of [
    () => {
      throw new Error('PRIVATE');
    },
    () => false,
  ]) {
    const progress = createRuntimeReopenProgress({ onPhase: callback });
    let cleanup = 0,
      operation = 0;
    await assert.rejects(
      progress.run('revoke', 'initial-ready', () => {
        operation++;
      }),
      failure
    );
    await assert.rejects(
      progress.run('revoke', 'cleanup-owner', () => {
        cleanup++;
      }),
      failure
    );
    assert.equal(operation, 1);
    assert.equal(cleanup, 1);
  }
});
test('reopen diagnostic limit, nonfinite clock and clock rollback fail closed without exceeding 128 events', async () => {
  const events = [];
  const progress = createRuntimeReopenProgress(
    {
      onPhase: (event) => {
        events.push(event);
      },
    },
    () => 1
  );
  for (let n = 0; n < 64; n++) await progress.run('clear', 'seed-read', () => true);
  let cleaned = 0;
  await assert.rejects(
    progress.run('clear', 'cleanup-storage', () => {
      cleaned++;
    }),
    failure
  );
  assert.equal(events.length, 128);
  assert.equal(cleaned, 1);
  for (const values of [[Infinity], [NaN], [2, 1]]) {
    let count = 0;
    const progress = createRuntimeReopenProgress({ onPhase: () => {} }, () => values[count++]);
    await assert.rejects(
      progress.run('revoke', 'initial-ready', () => true),
      failure
    );
  }
});
test('reopen diagnostic admission rejects empty, executable, hidden, proxy and arbitrary phase inputs', async () => {
  let access = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'onPhase', {
    enumerable: true,
    get() {
      access++;
      return () => {};
    },
  });
  for (const input of [
    null,
    {},
    [],
    { onPhase: 1 },
    { onPhase: () => {}, extra: true },
    hostile,
    new Proxy(
      { onPhase: () => {} },
      {
        ownKeys() {
          access++;
          return ['onPhase'];
        },
      }
    ),
  ])
    assert.throws(() => createRuntimeReopenProgress(input), failure);
  assert.equal(access, 0);
  const progress = createRuntimeReopenProgress();
  let executed = 0;
  for (const [action, phase] of [
    ['private', 'initial-ready'],
    ['revoke', 'PRIVATE'],
    ['', ''],
  ])
    await assert.rejects(
      progress.run(action, phase, () => {
        executed++;
      }),
      failure
    );
  assert.equal(executed, 0);
});
