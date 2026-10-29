'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecoveryStorageSerial } = require('../lib/proxy/context-recovery-storage-serial');
const { startRecoveryStorageAsyncIdle } = require('../lib/proxy/context-recovery-storage-idle');
const safe = (error) =>
  error.code === 'context_recovery_storage_unavailable' && error.message === error.code;
const turn = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const events = [],
    gates = [];
  let closes = 0;
  const serial = createRecoveryStorageSerial({
    async execute(request) {
      const held = gate();
      gates.push(held);
      events.push(request.operation);
      return held.promise;
    },
    async close() {
      closes++;
    },
  });
  return { serial, events, gates, closes: () => closes };
}
test('eight client slots serialize through ACK, idle has no backlog and close drains existing work', async () => {
  const f = fixture(),
    jobs = Array.from({ length: 8 }, (_, i) => f.serial.execute({ operation: String(i) }));
  await assert.rejects(f.serial.execute({ operation: 'overflow' }), safe);
  assert.equal(f.serial.idle(), null);
  await turn();
  assert.deepEqual(f.events, ['0']);
  const closing = f.serial.close();
  assert.equal(f.serial.close(), closing);
  await assert.rejects(f.serial.execute({ operation: 'late' }), safe);
  for (let i = 0; i < 8; i++) {
    assert.equal(f.closes(), 0);
    f.gates[i].resolve(i);
    assert.equal(await jobs[i], i);
    await turn();
  }
  await closing;
  assert.deepEqual(f.events, ['0', '1', '2', '3', '4', '5', '6', '7']);
  assert.equal(f.closes(), 1);
});
test('one idle sweep may precede eight clients without overlapping them or reducing admission', async () => {
  const f = fixture(),
    idle = f.serial.idle();
  assert.equal(f.serial.idle(), null);
  const jobs = Array.from({ length: 8 }, () => f.serial.execute({ operation: 'inspect' }));
  await turn();
  assert.deepEqual(f.events, ['sweep']);
  f.gates[0].resolve({ removedRecords: 0, removedBytes: 0 });
  await idle;
  for (let i = 1; i <= 8; i++) {
    await turn();
    f.gates[i].resolve(i);
    await jobs[i - 1];
  }
  await f.serial.close();
  assert.equal(f.events.length, 9);
});
test('a rejected request is not retried and later queued work remains usable', async () => {
  const f = fixture(),
    first = assert.rejects(f.serial.execute({ operation: 'save' }), safe),
    second = f.serial.execute({ operation: 'load' });
  await turn();
  f.gates[0].reject(Error('PRIVATE'));
  await first;
  await turn();
  assert.deepEqual(f.events, ['save', 'load']);
  f.gates[1].resolve(null);
  assert.equal(await second, null);
  await f.serial.close();
});
test('idle failure prevents any queued request executing; abort cleanup remains explicit', async () => {
  const f = fixture(),
    idle = assert.rejects(f.serial.idle(), safe),
    request = assert.rejects(f.serial.execute({ operation: 'save' }), safe);
  await turn();
  f.gates[0].reject(Error('PRIVATE'));
  await idle;
  await request;
  assert.deepEqual(f.events, ['sweep']);
  await f.serial.abort();
  assert.equal(f.closes(), 1);
});
test('abort invokes immediate owned cleanup, refuses backlog and cannot become a graceful success', async () => {
  const f = fixture(),
    first = assert.rejects(f.serial.execute({ operation: 'save' }), safe),
    second = assert.rejects(f.serial.execute({ operation: 'load' }), safe);
  await turn();
  const closing = assert.rejects(f.serial.close(), safe);
  await f.serial.abort();
  assert.equal(f.closes(), 1);
  f.gates[0].reject(Error('cancelled'));
  await first;
  await second;
  await closing;
  assert.deepEqual(f.events, ['save']);
});
test('async idle skips a busy queue and coalesces timer ticks until the same durable ACK', async () => {
  const f = fixture();
  let tick,
    failures = 0,
    cancelled = 0;
  const idle = startRecoveryStorageAsyncIdle({
    execute: () => f.serial.idle(),
    onFailure: async () => {
      failures++;
      await f.serial.abort();
    },
    startTimer: (action) => {
      tick = action;
      return () => {
        cancelled++;
      };
    },
  });
  const request = f.serial.execute({ operation: 'save' });
  tick();
  await turn();
  assert.deepEqual(f.events, ['save']);
  f.gates[0].resolve(null);
  await request;
  tick();
  tick();
  await turn();
  assert.deepEqual(f.events, ['save', 'sweep']);
  f.gates[1].resolve({ removedRecords: 0, removedBytes: 0 });
  await turn();
  assert.equal(failures, 0);
  tick();
  await turn();
  f.gates[2].reject(Error('PRIVATE'));
  await turn();
  assert.equal(failures, 1);
  assert.equal(cancelled, 1);
  idle.close();
});
test('malformed capabilities never invoke proxies/accessors and arbitrary thenables are not assimilated', async () => {
  let hooks = 0;
  const accessor = { close: async () => {} };
  Object.defineProperty(accessor, 'execute', {
    enumerable: true,
    get() {
      hooks++;
      return undefined;
    },
  });
  for (const value of [
    null,
    {},
    [],
    accessor,
    new Proxy(
      {},
      {
        getPrototypeOf() {
          hooks++;
        },
      }
    ),
  ])
    assert.throws(() => createRecoveryStorageSerial(value), safe);
  const serial = createRecoveryStorageSerial({
    execute: () => ({
      then() {
        hooks++;
      },
    }),
    close: async () => {},
  });
  await assert.rejects(serial.execute({ operation: 'inspect' }), safe);
  await serial.close();
  assert.equal(hooks, 0);
});

test('abort refuses a later successful in-flight result and close never acknowledges graceful completion', async () => {
  const f = fixture(),
    rejected = assert.rejects(f.serial.execute({ operation: 'save' }), safe);
  await turn();
  await f.serial.abort();
  f.gates[0].resolve({ revision: 1 });
  await rejected;
  await assert.rejects(f.serial.close(), safe);
  assert.equal(f.closes(), 1);
});

test('native promises are awaited without assimilating an overridden own then property', async () => {
  let hooks = 0;
  const result = Promise.resolve({ revision: 1 });
  Object.defineProperty(result, 'then', {
    value(resolve) {
      hooks++;
      resolve({ revision: 99 });
    },
  });
  const serial = createRecoveryStorageSerial({ execute: () => result, close: async () => {} });
  assert.deepEqual(await serial.execute({ operation: 'save' }), { revision: 1 });
  await serial.close();
  assert.equal(hooks, 0);
});

test('close errors and invalid close promises stay fixed and never retry owned cleanup', async () => {
  let hooks = 0;
  for (const close of [
    () => {
      throw Error('PRIVATE');
    },
    () => ({
      then() {
        hooks++;
      },
    }),
  ]) {
    let calls = 0;
    const serial = createRecoveryStorageSerial({
      execute: async () => null,
      close() {
        calls++;
        return close();
      },
    });
    await assert.rejects(serial.close(), safe);
    await assert.rejects(serial.close(), safe);
    await assert.rejects(serial.abort(), safe);
    assert.equal(calls, 1);
  }
  assert.equal(hooks, 0);
});
