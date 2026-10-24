'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { spawnSync } = require('node:child_process');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const {
  startRecoveryStorageIdle,
  IDLE_INTERVAL_MS,
} = require('../lib/proxy/context-recovery-storage-idle');

const safe = (error) => {
  assert.equal(error.code, 'context_recovery_storage_unavailable');
  assert.equal(error.message, error.code);
  assert.equal(error.cause, undefined);
  return true;
};
const ack = () => ({ removedRecords: 0, removedBytes: 0 });
test('idle observation handshake acknowledges completed callbacks and leaves other timers intact', () => {
  const helper = path.resolve(__dirname, 'helpers/context-recovery-idle-timer.cjs');
  const source = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    const buffer = new SharedArrayBuffer(4);
    const state = new Int32Array(buffer);
    const diagnostics = new SharedArrayBuffer(40);
    const counters = new Int32Array(diagnostics);
    const data = { idleObservation: buffer, idleDiagnostics: diagnostics };
    Module._load = function(request) {
      if (request === 'node:worker_threads') return { workerData: data };
      return original.apply(this, arguments);
    };
    const schedule = (callback, milliseconds, ...args) => ({ callback, milliseconds, args });
    globalThis.setInterval = schedule;
    const helper = ${JSON.stringify(helper)};
    require(helper);
    assert.equal(data.idleObservation, undefined);
    assert.equal(data.idleDiagnostics, undefined);
    let calls = 0, otherCalls = 0, throwing = false, armDuringCallback = false;
    const receiver = {};
    const timer = setInterval(function(value) {
      assert.equal(this, receiver);
      assert.equal(value, 'argument');
      if (throwing) throw Error('fixture_callback_failed');
      if (armDuringCallback) Atomics.store(state, 0, 1);
      calls++;
    }, 60000, 'argument');
    assert.equal(timer.milliseconds, 25);
    const tick = () => timer.callback.apply(receiver, timer.args);
    tick();
    assert.equal(calls, 1);
    assert.equal(Atomics.load(state, 0), 0);
    armDuringCallback = true;
    tick();
    assert.equal(calls, 2);
    assert.equal(Atomics.load(state, 0), 1, 'an earlier callback cannot ACK a later request');
    armDuringCallback = false;
    tick();
    assert.equal(calls, 3);
    assert.equal(Atomics.load(state, 0), 2);
    tick();
    assert.equal(calls, 3);
    const callback = () => otherCalls++;
    const other = setInterval(callback, 1000);
    assert.equal(other.callback, callback);
    assert.equal(other.milliseconds, 1000);
    other.callback();
    assert.equal(otherCalls, 1);
    Atomics.store(state, 0, 0);
    tick();
    assert.equal(calls, 4);
    Atomics.store(state, 0, 1);
    throwing = true;
    assert.throws(tick, /fixture_callback_failed/);
    assert.equal(Atomics.load(state, 0), 1);
    assert.equal(Atomics.load(counters, 0), 5);
    assert.equal(Atomics.load(counters, 1), 4);
    assert.equal(Atomics.load(counters, 2), 1);
    assert.ok(Atomics.load(counters, 3) >= 0);
    assert.ok(Atomics.load(counters, 4) >= Atomics.load(counters, 3));
    assert.equal(Atomics.load(counters, 5), 1);
    for (const value of [null, {}, new SharedArrayBuffer(8)]) {
      data.idleDiagnostics = value;
      delete require.cache[helper];
      globalThis.setInterval = schedule;
      assert.throws(() => require(helper), /Invalid idle diagnostics control/);
    }
    delete data.idleDiagnostics;
    for (const value of [null, {}, new SharedArrayBuffer(12)]) {
      data.idleObservation = value;
      delete require.cache[helper];
      globalThis.setInterval = schedule;
      assert.throws(() => require(helper), /Invalid idle observation control/);
    }
    Module._load = original;
    const completion = Atomics.waitAsync(state, 0, 1, 1000);
    assert.equal(completion.async, true);
    throwing = false;
    tick();
    completion.value.then(result => {
      assert.equal(result, 'ok', 'the completed callback must notify its waiting observer');
      assert.equal(Atomics.load(state, 0), 2);
      process.stdout.write('idle_observation_verified');
    });
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 16384,
    windowsHide: true,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'idle_observation_verified');
  assert.equal(child.stderr, '');
});

test('initial idle pause excludes sweeps until explicit resume without changing the sweep', () => {
  const helper = path.resolve(__dirname, 'helpers/context-recovery-idle-timer.cjs');
  const idle = require.resolve('../lib/proxy/context-recovery-storage-idle');
  const source = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    const observation = new SharedArrayBuffer(4);
    const control = new Int32Array(observation);
    const diagnostics = new SharedArrayBuffer(40);
    const counters = new Int32Array(diagnostics);
    const data = { idleObservation: observation, idleDiagnostics: diagnostics };
    Atomics.store(control, 0, 2);
    Module._load = function(request) {
      if (request === 'node:worker_threads') return { workerData: data };
      return Reflect.apply(load, this, arguments);
    };
    let timer, unref = 0, cancelled = 0, sweeps = 0, failures = 0;
    globalThis.setInterval = (callback, milliseconds) => {
      timer = { callback, milliseconds, unref() { unref++; } };
      return timer;
    };
    globalThis.clearInterval = value => { assert.equal(value, timer); cancelled++; };
    require(${JSON.stringify(helper)});
    const { startRecoveryStorageIdle } = require(${JSON.stringify(idle)});
    const service = startRecoveryStorageIdle({
      execute(request) {
        assert.deepEqual(request, { operation: 'sweep' });
        sweeps++;
        return { removedRecords: 0, removedBytes: 0 };
      },
      onFailure() { failures++; }
    });
    assert.equal(data.idleObservation, undefined);
    assert.equal(data.idleDiagnostics, undefined);
    assert.equal(timer.milliseconds, 25);
    assert.equal(unref, 1);
    timer.callback(); timer.callback();
    assert.equal(sweeps, 0, 'no sweep may race the external corruption transaction');
    assert.deepEqual(Array.from(counters), Array(10).fill(0));
    Atomics.store(control, 0, 0);
    timer.callback();
    assert.equal(sweeps, 1, 'resume must execute the original production sweep');
    assert.equal(Atomics.load(counters, 0), 1);
    assert.equal(Atomics.load(counters, 1), 1);
    Atomics.store(control, 0, 2);
    timer.callback();
    assert.equal(sweeps, 1);
    assert.equal(failures, 0);
    service.close();
    assert.equal(cancelled, 1);
    Module._load = load;
    process.stdout.write('initial_idle_pause_verified');
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 16384,
    windowsHide: true,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'initial_idle_pause_verified');
  assert.equal(child.stderr, '');
});

test('idle observation requires the armed clock read and successful scheduled completion', () => {
  const clockHelper = path.resolve(__dirname, 'helpers/context-recovery-maintenance-clock.cjs');
  const timerHelper = path.resolve(__dirname, 'helpers/context-recovery-idle-timer.cjs');
  const sqlitePath = require.resolve('../lib/proxy/context-recovery-storage-sqlite');
  const source = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    const clock = new SharedArrayBuffer(8);
    const observation = new SharedArrayBuffer(8);
    const control = new Int32Array(observation);
    const time = new BigInt64Array(clock);
    Atomics.store(time, 0, 1000n);
    const data = { maintenanceClock: clock, idleObservation: observation };
    Module._load = function(request) {
      if (request === 'node:worker_threads') return { workerData: data };
      return Reflect.apply(load, this, arguments);
    };
    let mode = 'before', operation = 'sweep', calls = 0;
    const sqlite = require(${JSON.stringify(sqlitePath)});
    sqlite.createRecoverySqliteStore = options => ({ execute(request) {
      calls++;
      if (mode === 'before') Atomics.store(control, 0, 1);
      if (mode !== 'no-clock') assert.equal(options.now(), 1000);
      if (mode === 'after') Atomics.store(control, 0, 1);
      if (mode === 'throw') throw Error('synthetic_failure');
      return { removedRecords: 0, removedBytes: 0 };
    }});
    require(${JSON.stringify(clockHelper)});
    globalThis.setInterval = callback => ({ callback });
    require(${JSON.stringify(timerHelper)});
    const store = sqlite.createRecoverySqliteStore({});
    const timer = setInterval(() => store.execute({ operation }), 60000);
    const reset = () => { Atomics.store(control, 0, 0); Atomics.store(control, 1, 0); };
    timer.callback();
    assert.equal(Atomics.load(control, 0), 2, 'a callback begun earlier can finish the armed clock sweep');
    timer.callback();
    assert.equal(calls, 1, 'completed observation pauses future database work');
    reset(); mode = 'after'; timer.callback();
    assert.equal(Atomics.load(control, 0), 1, 'a stale clock cannot acknowledge observation');
    reset(); mode = 'throw'; Atomics.store(control, 0, 1);
    assert.throws(() => timer.callback(), /synthetic_failure/);
    assert.equal(Atomics.load(control, 0), 1, 'failed execution cannot acknowledge observation');
    reset(); mode = 'no-clock'; Atomics.store(control, 0, 1); timer.callback();
    assert.equal(Atomics.load(control, 0), 1, 'returning without reading the clock is insufficient');
    reset(); mode = 'before'; operation = 'load'; timer.callback();
    assert.equal(Atomics.load(control, 0), 1, 'ordinary commands cannot acknowledge a scheduled sweep');
    operation = 'sweep'; timer.callback();
    assert.equal(Atomics.load(control, 0), 2);
    Module._load = load;
    process.stdout.write('idle_clock_observation_verified');
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 16384,
    windowsHide: true,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'idle_clock_observation_verified');
});
function fixture(options = {}) {
  let tick,
    calls = 0,
    cancelled = 0,
    failed = 0;
  const idle = startRecoveryStorageIdle({
    execute(request) {
      calls++;
      assert.deepEqual(request, { operation: 'sweep' });
      return options.execute ? options.execute() : ack();
    },
    onFailure() {
      failed++;
      return options.onFailure?.();
    },
    startTimer(callback) {
      tick = callback;
      return () => {
        cancelled++;
        return options.cancel?.();
      };
    },
  });
  return { idle, tick: () => tick(), inspect: () => ({ calls, cancelled, failed }) };
}

test('idle scheduling is fixed, unreferenced and cancellation is idempotent', () => {
  const originalStart = globalThis.setInterval;
  const originalCancel = globalThis.clearInterval;
  let callback,
    milliseconds,
    unrefs = 0,
    cancellations = 0;
  const handle = {
    unref() {
      unrefs++;
    },
  };
  try {
    globalThis.setInterval = (fn, ms) => {
      callback = fn;
      milliseconds = ms;
      return handle;
    };
    globalThis.clearInterval = (value) => {
      assert.equal(value, handle);
      cancellations++;
    };
    const idle = startRecoveryStorageIdle({
      execute: ack,
      onFailure() {
        assert.fail('must not fail');
      },
    });
    assert.equal(milliseconds, 60000);
    assert.equal(IDLE_INTERVAL_MS, 60000);
    assert.equal(unrefs, 1);
    callback();
    idle.close();
    idle.close();
    callback();
    assert.equal(cancellations, 1);
  } finally {
    globalThis.setInterval = originalStart;
    globalThis.clearInterval = originalCancel;
  }
});

test('idle ticks only sweep, reject reentry and do nothing after shutdown', () => {
  const f = fixture({
    execute() {
      f.tick();
      return ack();
    },
  });
  f.tick();
  f.tick();
  assert.deepEqual(f.inspect(), { calls: 2, cancelled: 0, failed: 0 });
  f.idle.close();
  f.tick();
  assert.deepEqual(f.inspect(), { calls: 2, cancelled: 1, failed: 0 });
});

test('throwing or invalid maintenance ACKs stop once and never retry', () => {
  for (const value of [
    undefined,
    null,
    {},
    [],
    { removedRecords: 257, removedBytes: 0 },
    { removedRecords: 0, removedBytes: 1 },
  ]) {
    const f = fixture({ execute: () => value });
    f.tick();
    f.tick();
    f.idle.close();
    assert.deepEqual(f.inspect(), { calls: 1, cancelled: 1, failed: 1 });
  }
  const f = fixture({
    execute() {
      throw new Error('secret-value');
    },
    onFailure() {
      throw new Error('secret-observer');
    },
  });
  assert.doesNotThrow(f.tick);
  f.tick();
  assert.deepEqual(f.inspect(), { calls: 1, cancelled: 1, failed: 1 });
});

test('async ACKs and observer failures are contained without thenable execution', async () => {
  let ran = 0;
  for (const execute of [
    () => Promise.reject(new Error('secret')),
    () => Promise.resolve(ack()),
    () => ({
      get then() {
        ran++;
        return () => {};
      },
    }),
    () => ({
      get removedRecords() {
        ran++;
        return 0;
      },
      removedBytes: 0,
    }),
  ]) {
    const f = fixture({ execute, onFailure: () => Promise.reject(new Error('secret-observer')) });
    f.tick();
    f.tick();
    assert.deepEqual(f.inspect(), { calls: 1, cancelled: 1, failed: 1 });
  }
  await delay(0);
  assert.equal(ran, 0);
});

test('options reject malformed, unknown, accessor and non-function inputs without executing code', () => {
  let ran = 0;
  for (const value of [
    undefined,
    null,
    [],
    {},
    new Date(),
    { execute: ack },
    { execute: null, onFailure() {} },
    { execute: ack, onFailure: false },
    { execute: ack, onFailure() {}, startTimer: 1 },
    { execute: ack, onFailure() {}, extra: true },
    {
      get execute() {
        ran++;
        return ack;
      },
      onFailure() {},
    },
    Object.defineProperty({ onFailure() {} }, 'execute', { value: ack, enumerable: false }),
  ])
    assert.throws(() => startRecoveryStorageIdle(value), safe);
  assert.equal(ran, 0);
});

test('timer acquisition failures are safe and asynchronous handles are never adopted', async () => {
  for (const schedule of [
    () => null,
    () => Promise.reject(new Error('secret')),
    () => {
      throw new Error('secret');
    },
  ]) {
    let failures = 0;
    assert.throws(
      () =>
        startRecoveryStorageIdle({
          execute: ack,
          onFailure() {
            failures++;
          },
          startTimer: schedule,
        }),
      safe
    );
    assert.equal(failures, 1);
  }
  await delay(0);
});

test('synchronous timer callbacks release the later returned cancellation handle', () => {
  let failed = 0,
    cancelled = 0;
  const idle = startRecoveryStorageIdle({
    execute() {
      throw new Error('secret');
    },
    onFailure() {
      failed++;
    },
    startTimer(tick) {
      tick();
      return () => {
        cancelled++;
      };
    },
  });
  assert.equal(failed, 1);
  assert.equal(cancelled, 1);
  idle.close();
  assert.equal(cancelled, 1);
});

test('cancellation failures stay failed and cannot turn repeated close into success', async () => {
  for (const cancel of [
    () => {
      throw new Error('secret');
    },
    () => Promise.reject(new Error('secret')),
    () => false,
  ]) {
    const f = fixture({ cancel });
    assert.throws(() => f.idle.close(), safe);
    assert.throws(() => f.idle.close(), safe);
    f.tick();
    assert.deepEqual(f.inspect(), { calls: 0, cancelled: 1, failed: 0 });
  }
  await delay(0);
});

test(
  'actual encrypted idle worker removes expired rows without another command, preserving live state and reopen',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async (t) => {
    const initialTime = Date.now();
    const maintenanceClock = new SharedArrayBuffer(8);
    const clock = new BigInt64Array(maintenanceClock);
    Atomics.store(clock, 0, BigInt(initialTime));
    const idleObservation = new SharedArrayBuffer(8);
    const observation = new Int32Array(idleObservation);
    const idleDiagnostics = new SharedArrayBuffer(40);
    const counters = new Int32Array(idleDiagnostics);
    let stage = 'opening';
    let failedStage;
    const onStartup = ({ phase, elapsedMs }) =>
      t.diagnostic(JSON.stringify({ stage, startupPhase: phase, elapsedMs }));
    t.after(() => t.diagnostic(JSON.stringify({ stage, failedStage: failedStage ?? null })));
    class AcceleratedIdleWorker extends Worker {
      constructor(file, options) {
        super(file, {
          ...options,
          workerData: { ...options.workerData, maintenanceClock, idleObservation, idleDiagnostics },
          execArgv: [
            '--require',
            path.join(__dirname, 'helpers/context-recovery-maintenance-clock.cjs'),
            '--require',
            path.join(__dirname, 'helpers/context-recovery-idle-timer.cjs'),
          ],
        });
      }
      postMessage(message) {
        // Exercise transport latency longer than the record's logical TTL.
        // Only the test SQLite clock is frozen; real deadlines still run.
        if (message.request?.operation === 'save' && message.request.scope === 'a'.repeat(64)) {
          setTimeout(() => super.postMessage(message), 300);
          return;
        }
        super.postMessage(message);
      }
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-idle-worker-'));
    const directory = path.join(root, 'store');
    let storage, database;
    // Let node:test report cleanup failures separately from the original
    // assertion or SQLite error; a finally rejection would replace it.
    t.after(async () => {
      try {
        database?.close();
      } finally {
        try {
          await storage?.close();
        } finally {
          const resolved = path.resolve(root);
          assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
          assert.ok(path.basename(resolved).startsWith('hpm-idle-worker-'));
          fs.rmSync(resolved, { recursive: true, force: true });
        }
      }
    });
    try {
      storage = await openContextRecoveryStorage({
        directory,
        WorkerType: AcceleratedIdleWorker,
        onStartup,
      });
      const expiresAt = initialTime + 250;
      const expired = {
        operation: 'save',
        scope: 'a'.repeat(64),
        expectedRevision: 0,
        expiresAt,
        state: { synthetic: 'expired-only', budget: { calls: 9 } },
      };
      stage = 'expired_save';
      await storage.execute(expired);
      const scope = 'b'.repeat(64);
      stage = 'live_save';
      await storage.execute({
        ...expired,
        scope,
        expiresAt: initialTime + 60000,
        state: { synthetic: 'live-only', budget: { calls: 17 } },
      });
      stage = 'live_load';
      const live = await storage.execute({ operation: 'load', scope });
      assert.equal(live.createdAt, initialTime);
      assert.equal(live.expiresAt, initialTime + 60000);
      const pendingExpiry = await storage.execute({ operation: 'load', scope: expired.scope });
      assert.equal(pendingExpiry.createdAt, initialTime);
      assert.equal(pendingExpiry.expiresAt, expiresAt);
      const idleBefore = Array.from(counters);
      Atomics.store(clock, 0, BigInt(expiresAt + 1));
      Atomics.store(observation, 0, 1);
      stage = 'idle_wait';
      // Wait for the actual clock-coupled idle callback, not a wall-clock guess.
      // This sends no command to the owner, so a request cannot mask collection.
      const completed = Atomics.waitAsync(observation, 0, 1, 5000);
      if (completed.async) await completed.value;
      t.diagnostic(
        JSON.stringify({
          idleBefore,
          idleObserved: Array.from(counters),
          observation: Atomics.load(observation, 0),
        })
      );
      assert.equal(
        Atomics.load(observation, 0),
        2,
        'a scheduled expired sweep must finish before observation'
      );
      // Read through an independent SQLite connection: no owner command may
      // opportunistically collect the row and mask a missing idle scheduler.
      // Later idle ticks wait only during this external reader's observation;
      // the probe itself must not lock out and terminate the single writer.
      stage = 'external_probe';
      database = new DatabaseSync(path.join(directory, 'checkpoint.sqlite'), { readOnly: true });
      database.exec('PRAGMA busy_timeout=1000');
      assert.equal(
        database
          .prepare('SELECT count(*) AS n FROM recovery_state WHERE scope=?')
          .get(expired.scope).n,
        0
      );
      database.close();
      database = undefined;
      Atomics.store(observation, 0, 0);
      assert.deepEqual(await storage.execute({ operation: 'load', scope }), live);
      stage = 'close_first';
      await storage.close();
      storage = undefined;
      stage = 'reopen';
      storage = await openContextRecoveryStorage({
        directory,
        WorkerType: AcceleratedIdleWorker,
        onStartup,
      });
      assert.deepEqual(await storage.execute({ operation: 'load', scope }), live);
      assert.equal(await storage.execute({ operation: 'load', scope: expired.scope }), null);
      stage = 'reject_expired_rewrite';
      await assert.rejects(storage.execute(expired), {
        code: 'context_recovery_storage_unavailable',
      });
      stage = 'completed';
    } catch (error) {
      failedStage = stage;
      throw error;
    }
  }
);

test(
  'idle corruption terminates the actual worker, rejects later operations and releases its writer lock',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async () => {
    let nativeWorker;
    const idleObservation = new SharedArrayBuffer(4);
    const observation = new Int32Array(idleObservation);
    const idleDiagnostics = new SharedArrayBuffer(40);
    const counters = new Int32Array(idleDiagnostics);
    // Pause before worker construction: fault injection must own its external
    // write transaction before the real scheduled sweep can examine corruption.
    Atomics.store(observation, 0, 2);
    class ObservedIdleWorker extends Worker {
      constructor(file, options) {
        super(file, {
          ...options,
          execArgv: ['--require', path.join(__dirname, 'helpers/context-recovery-idle-timer.cjs')],
          workerData: { ...options.workerData, idleObservation, idleDiagnostics },
        });
        nativeWorker = this;
      }
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-idle-worker-failure-'));
    const directory = path.join(root, 'store');
    const file = path.join(directory, 'checkpoint.sqlite');
    const scope = 'c'.repeat(64);
    let storage, database;
    try {
      storage = await openContextRecoveryStorage({ directory, WorkerType: ObservedIdleWorker });
      await storage.execute({
        operation: 'save',
        scope,
        expectedRevision: 0,
        expiresAt: Date.now() + 60000,
        state: { synthetic: 'fixture', budget: { calls: 23 } },
      });
      const saved = await storage.execute({ operation: 'load', scope });
      assert.equal(Atomics.load(counters, 0), 0, 'idle must remain paused before fault injection');
      const exited = once(nativeWorker, 'exit');
      database = new DatabaseSync(file);
      database.exec('PRAGMA busy_timeout=1000');
      const envelope = Buffer.from(
        database.prepare('SELECT envelope FROM recovery_state WHERE scope=?').get(scope).envelope
      );
      const corrupt = Buffer.from(envelope);
      corrupt[corrupt.length - 1] ^= 1;
      database.prepare('UPDATE recovery_state SET envelope=? WHERE scope=?').run(corrupt, scope);
      database.close();
      database = undefined;
      assert.equal(Atomics.load(counters, 0), 0, 'idle must remain paused until external DB close');
      Atomics.store(observation, 0, 0);
      await exited;
      assert.ok(
        Atomics.load(counters, 0) > 0,
        'a real scheduled sweep must trigger worker failure'
      );
      await assert.rejects(storage.execute({ operation: 'inspect' }), safe);
      await assert.rejects(storage.close(), safe);
      storage = undefined;
      // Restore only the owned synthetic fixture to prove the failed worker
      // released its OS-backed writer lock, without retrying its operation.
      database = new DatabaseSync(file);
      database.prepare('UPDATE recovery_state SET envelope=? WHERE scope=?').run(envelope, scope);
      database.close();
      database = undefined;
      storage = await openContextRecoveryStorage({ directory });
      assert.deepEqual(await storage.execute({ operation: 'load', scope }), saved);
    } finally {
      database?.close();
      await storage?.close();
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('hpm-idle-worker-failure-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
);
