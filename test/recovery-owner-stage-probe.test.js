'use strict';

// Pure instrumentation tests: no storage worker, DPAPI, registry or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  installOwnerStageProbe,
  parseStageLine,
  createObservedStorageWorker,
} = require('./helpers/recovery-owner-stage-probe');
const workerFile = path.resolve(__dirname, '../lib/proxy/context-recovery-storage-worker.js');
const helperFile = path.resolve(__dirname, 'helpers/recovery-owner-stage-probe.js');
function fixture() {
  const rows = [],
    calls = [],
    result = { opaque: true };
  let now = 0;
  const engine = {
    execute(input) {
      assert.equal(this, engine);
      calls.push(input);
      if (input.fail) throw result;
      return result;
    },
    snapshot() {
      assert.equal(this, engine);
      return result;
    },
    close() {
      calls.push('close');
    },
  };
  const admission = Object.freeze({
    initialStoreId: undefined,
    persist(value) {
      assert.equal(this, admission);
      assert.equal(value, result);
      calls.push('persist');
    },
    validateStartup() {},
    close() {},
  });
  const engineModule = { createRecoverySqliteStore: () => engine };
  const admissionModule = { createRecoveryAnchorAdmission: () => admission };
  const load = (file) => {
    assert.equal(path.isAbsolute(file), true);
    if (file.endsWith('context-recovery-storage-sqlite.js')) return engineModule;
    if (file.endsWith('context-recovery-anchor-admission.js')) return admissionModule;
    throw new Error('unexpected_test_import');
  };
  return {
    rows,
    calls,
    result,
    load,
    engineModule,
    admissionModule,
    emit: (row) => rows.push(row),
    now: () => now++,
  };
}

test('probe preserves original receivers, results, throws and close; logs fixed nonoverlapping stages', () => {
  const f = fixture();
  installOwnerStageProbe(f.load, f.emit, f.now);
  const engine = f.engineModule.createRecoverySqliteStore();
  const admission = f.admissionModule.createRecoveryAnchorAdmission();
  admission.persist(engine.snapshot());
  const request = { operation: 'read-source', privateContent: 'PRIVATE_NEVER_LOG' };
  assert.equal(engine.execute(request), f.result);
  admission.persist(engine.snapshot());
  assert.throws(
    () => engine.execute({ operation: 'save', fail: true }),
    (error) => error === f.result
  );
  engine.close();
  assert.deepEqual(f.calls, [
    'persist',
    request,
    'persist',
    { operation: 'save', fail: true },
    'close',
  ]);
  assert.deepEqual(
    f.rows.map((row) => [row.sequence, row.operation, row.stage]),
    [
      [0, 'startup', 'engine_snapshot'],
      [0, 'startup', 'anchor_persist'],
      [1, 'read-source', 'engine_execute'],
      [1, 'read-source', 'engine_snapshot'],
      [1, 'read-source', 'anchor_persist'],
      [2, 'save', 'engine_execute'],
    ]
  );
  for (const row of f.rows) assert.deepEqual(parseStageLine(JSON.stringify(row)), row);
  assert.equal(JSON.stringify(f.rows).includes('PRIVATE'), false);
});

test('worker bootstrap instruments actual module path before unchanged original worker entry', () => {
  const f = fixture();
  class FakeWorker {
    constructor(script, options) {
      this.stderr = new EventEmitter();
      this.script = script;
      this.options = options;
    }
  }
  const diagnostics = [];
  const Type = createObservedStorageWorker((value) => diagnostics.push(value), FakeWorker);
  const workerData = { directory: 'PRIVATE_PATH_NEVER_LOG' };
  const worker = new Type(workerFile, { workerData, stdout: true, stderr: true, execArgv: [] });
  assert.equal(worker.options.workerData, workerData);
  assert.equal(worker.options.eval, true);
  assert.deepEqual(worker.options.execArgv, []);
  let started = false;
  vm.runInNewContext(worker.script, {
    require(file) {
      if (file === helperFile)
        return {
          installOwnerStageProbe: (_load, emit) => installOwnerStageProbe(f.load, emit, f.now),
        };
      assert.equal(file, workerFile);
      started = true;
      f.engineModule.createRecoverySqliteStore().execute({ operation: 'inspect' });
    },
    process: { stderr: { write: (value) => worker.stderr.emit('data', Buffer.from(value)) } },
  });
  assert.equal(started, true);
  assert.equal(diagnostics[0].stage, 'engine_execute');
  worker.stderr.emit('data', Buffer.from('PRIVATE_NATIVE_WARNING\nHPM_STA'));
  worker.stderr.emit('data', Buffer.from('GE {"secret":"PRIVATE"}\n'));
  worker.stderr.emit('data', Buffer.from('x'.repeat(5000)));
  assert.deepEqual(diagnostics.at(-1), { phase: 'owner-stage-invalid' });
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'), false);
  assert.throws(() => new Type('PRIVATE_WORKER', {}));
});

test('stage parser rejects empty, malformed, oversized and unknown content without disclosure', () => {
  const row = { sequence: 0, operation: 'startup', stage: 'engine_snapshot', elapsedMs: 1 };
  for (const input of [
    null,
    '',
    '{',
    'PRIVATE'.repeat(1000),
    '[]',
    JSON.stringify({ ...row, token: 'PRIVATE' }),
    ...[
      { stage: 'PRIVATE' },
      { operation: 'PRIVATE' },
      { elapsedMs: -1 },
      { elapsedMs: 1.5 },
      { sequence: -1 },
    ].map((extra) => JSON.stringify({ ...row, ...extra })),
  ])
    assert.throws(() => parseStageLine(input), { message: 'recovery_stage_probe_failed' });
});

test('observed engine rejects untrusted operation descriptors without getter/proxy execution', () => {
  const f = fixture();
  installOwnerStageProbe(f.load, f.emit, f.now);
  const engine = f.engineModule.createRecoverySqliteStore();
  let traps = 0;
  for (const value of [
    null,
    {},
    { operation: 'PRIVATE' },
    {
      get operation() {
        traps++;
        return 'save';
      },
    },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          traps++;
          return undefined;
        },
      }
    ),
  ])
    assert.throws(() => engine.execute(value), { message: 'recovery_stage_probe_failed' });
  assert.equal(traps, 0);
  assert.equal(f.rows.length, 0);
});
