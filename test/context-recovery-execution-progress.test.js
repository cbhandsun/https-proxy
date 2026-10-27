'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const {
  createStorageExecutionProgress,
  createStorageExecutionObserver,
} = require('../lib/proxy/context-recovery-execution-progress');
const phases = [
  'verify_before_started',
  'verify_before_finished',
  'engine_execute_started',
  'engine_execute_finished',
  'engine_snapshot_started',
  'engine_snapshot_finished',
  'anchor_persist_started',
  'anchor_persist_finished',
  'verify_after_started',
  'verify_after_finished',
];
test('execution progress contains only bounded fixed metadata and never grants an ACK', () => {
  const events = [];
  const observe = createStorageExecutionObserver((e) => events.push(e));
  const progress = createStorageExecutionProgress(observe);
  const run = progress.begin();
  for (const phase of phases) run.advance(phase);
  run.finish(true);
  assert.deepEqual(
    events.map((e) => e.phase),
    [...phases, 'completed']
  );
  for (const e of events) {
    assert.deepEqual(Object.keys(e), ['sequence', 'phase', 'elapsedMs']);
    assert.equal(e.sequence, 1);
    assert.ok(Object.isFrozen(e));
    assert.ok(e.elapsedMs >= 0);
  }
  const failed = progress.begin();
  failed.advance(phases[0]);
  failed.finish(false);
  failed.finish(false);
  assert.equal(events.at(-1).phase, 'failed');
  assert.equal(events.at(-1).sequence, 2);
});
test('execution observer rejects empty, hostile, illegal, duplicate, reordered and extreme metadata without reading hooks', () => {
  let hooks = 0;
  const accessor = Object.defineProperty({}, 'phase', {
    enumerable: true,
    get() {
      hooks++;
      throw Error('PRIVATE');
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        hooks++;
        throw Error('PRIVATE');
      },
    }
  );
  for (const input of [
    null,
    undefined,
    [],
    {},
    accessor,
    proxy,
    { sequence: 0, phase: phases[0], elapsedMs: 0 },
    { sequence: 1, phase: 'PRIVATE', elapsedMs: 0 },
    { sequence: 1, phase: phases[0], elapsedMs: Infinity },
    { sequence: 1, phase: phases[0], elapsedMs: -1 },
    { sequence: 1, phase: phases[0], elapsedMs: 60001 },
    { sequence: Number.MAX_SAFE_INTEGER, phase: phases[0], elapsedMs: 0 },
    { sequence: 1, phase: phases[0], elapsedMs: 0, raw: 'PRIVATE' },
  ])
    assert.throws(() => createStorageExecutionObserver(() => {})(input), /storage_unavailable/);
  const observe = createStorageExecutionObserver(() => {});
  observe({ sequence: 1, phase: phases[0], elapsedMs: 0 });
  for (const e of [
    { sequence: 1, phase: phases[0], elapsedMs: 0 },
    { sequence: 1, phase: phases[2], elapsedMs: 1 },
    { sequence: 2, phase: phases[0], elapsedMs: 0 },
    { sequence: 1, phase: 'completed', elapsedMs: 1 },
  ])
    assert.throws(() => observe(e), /storage_unavailable/);
  observe({ sequence: 1, phase: phases[1], elapsedMs: 2 });
  assert.throws(
    () => observe({ sequence: 1, phase: phases[2], elapsedMs: 1 }),
    /storage_unavailable/
  );
  assert.equal(hooks, 0);
});
test('throwing and rejected asynchronous observers cannot change execution progress', async () => {
  for (const callback of [
    () => {
      throw Error('PRIVATE');
    },
    () => Promise.reject(Error('PRIVATE')),
  ]) {
    const p = createStorageExecutionProgress(callback);
    const run = p.begin();
    for (const phase of phases) run.advance(phase);
    run.finish(true);
    const receive = createStorageExecutionObserver(callback);
    receive({ sequence: 1, phase: phases[0], elapsedMs: 0 });
    receive({ sequence: 1, phase: 'failed', elapsedMs: 0 });
  }
  await new Promise((resolve) => setImmediate(resolve));
  const noop = createStorageExecutionProgress().begin();
  noop.advance('ignored');
  noop.finish(true);
  assert.throws(() => createStorageExecutionProgress('PRIVATE'), /storage_unavailable/);
});

function workerFixture() {
  let worker;
  class Fake extends EventEmitter {
    constructor(_file, options) {
      super();
      worker = this;
      this.options = options;
      this.requests = [];
      this.terminated = false;
      queueMicrotask(() => this.emit('message', { id: 0, ok: true }));
    }
    postMessage(message) {
      this.requests.push(message);
      if (message.request.operation === 'close')
        queueMicrotask(() => {
          this.emit('message', { id: message.id, ok: true, result: null });
          this.emit('exit', 0);
        });
    }
    terminate() {
      this.terminated = true;
      return Promise.resolve(0);
    }
    progress(value) {
      this.emit('message', { id: 0, ok: true, execution: value });
    }
  }
  return { Fake, worker: () => worker };
}
test('worker execution metadata is opt-in and completed observation cannot resolve a durable request', async () => {
  const f = workerFixture();
  const events = [];
  const service = await openContextRecoveryStorage({
    directory: os.tmpdir(),
    WorkerType: f.Fake,
    onExecutionProgress: (event) => events.push(event),
  });
  const worker = f.worker();
  assert.equal(worker.options.workerData.executionProgress, true);
  let resolved = false;
  const pending = service.execute({ operation: 'inspect' }).then((value) => {
    resolved = true;
    return value;
  });
  const emitter = createStorageExecutionProgress((value) => worker.progress(value));
  const run = emitter.begin();
  for (const phase of phases) run.advance(phase);
  run.finish(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(events.at(-1).phase, 'completed');
  const request = worker.requests[0];
  worker.emit('message', { id: request.id, ok: true, result: { records: 0, bytes: 0 } });
  assert.deepEqual({ ...(await pending) }, { records: 0, bytes: 0 });
  await service.close();
});
test('invalid or unsolicited worker progress retains fail-closed request handling', async () => {
  for (const observe of [false, true]) {
    const f = workerFixture();
    const service = await openContextRecoveryStorage({
      directory: os.tmpdir(),
      WorkerType: f.Fake,
      ...(observe ? { onExecutionProgress() {} } : {}),
    });
    const worker = f.worker();
    assert.equal(Object.hasOwn(worker.options.workerData, 'executionProgress'), observe);
    const pending = service.execute({ operation: 'inspect' });
    worker.progress({ sequence: 1, phase: observe ? 'PRIVATE' : phases[0], elapsedMs: 0 });
    await assert.rejects(pending, /storage_unavailable/);
    assert.equal(worker.terminated, true);
  }
  let hooks = 0;
  for (const value of [
    'PRIVATE',
    null,
    new Proxy(() => {}, {
      apply() {
        hooks++;
      },
    }),
  ]) {
    const f = workerFixture();
    await assert.rejects(
      openContextRecoveryStorage({
        directory: os.tmpdir(),
        WorkerType: f.Fake,
        onExecutionProgress: value,
      }),
      /storage_unavailable/
    );
    assert.equal(f.worker(), undefined);
  }
  const options = { directory: os.tmpdir() };
  Object.defineProperty(options, 'onExecutionProgress', {
    enumerable: true,
    get() {
      hooks++;
      throw Error('PRIVATE');
    },
  });
  await assert.rejects(openContextRecoveryStorage(options), /storage_unavailable/);
  assert.equal(hooks, 0);
});
