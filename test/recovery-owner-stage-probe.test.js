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
  createOwnerDiagnosticScope,
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

test('database probe separates commit and watermark costs without exposing SQL or changing results', () => {
  const f = fixture();
  const cause = new Error('PRIVATE_SQL_FAILURE');
  const actions = [];
  let rejectCommit = false;
  const statement = {
    run(value) {
      assert.equal(this, statement);
      actions.push(value);
      return f.result;
    },
    get() {
      assert.equal(this, statement);
      return f.result;
    },
    all() {
      assert.equal(this, statement);
      return f.result;
    },
  };
  const database = {
    exec(sql) {
      assert.equal(this, database);
      actions.push(sql);
      if (sql === 'COMMIT' && rejectCommit) throw cause;
      return f.result;
    },
    prepare() {
      assert.equal(this, database);
      return statement;
    },
  };
  let observed;
  f.engineModule.createRecoverySqliteStore = (options) => {
    assert.equal(options.now, f.now);
    observed = options.database;
    return {
      execute() {
        observed.exec('BEGIN IMMEDIATE');
        const clock = observed.prepare('UPDATE recovery_header SET envelope=? WHERE singleton=1');
        assert.equal(clock.get(), f.result);
        assert.equal(clock.all(), f.result);
        assert.equal(clock.run('PRIVATE_CIPHERTEXT'), f.result);
        try {
          return observed.exec('COMMIT');
        } catch (error) {
          observed.exec('ROLLBACK');
          throw error;
        }
      },
      snapshot() {},
    };
  };
  installOwnerStageProbe(f.load, f.emit, f.now);
  const options = { database, now: f.now };
  const engine = f.engineModule.createRecoverySqliteStore(options);
  assert.equal(options.database, database);
  assert.equal(engine.execute({ operation: 'load-reference' }), f.result);
  rejectCommit = true;
  assert.throws(
    () => engine.execute({ operation: 'load-reference' }),
    (error) => error === cause
  );
  const before = f.rows.length;
  assert.equal(observed.exec('toString'), f.result);
  assert.equal(observed.prepare('PRIVATE_SQL'), statement);
  assert.equal(f.rows.length, before);
  assert.deepEqual(actions.slice(0, 3), ['BEGIN IMMEDIATE', 'PRIVATE_CIPHERTEXT', 'COMMIT']);
  assert.deepEqual(
    f.rows.map((row) => row.stage),
    [
      'sqlite_begin',
      'sqlite_clock_write',
      'sqlite_commit',
      'engine_execute',
      'sqlite_begin',
      'sqlite_clock_write',
      'sqlite_commit',
      'sqlite_rollback',
      'engine_execute',
    ]
  );
  for (const row of f.rows) assert.deepEqual(parseStageLine(JSON.stringify(row)), row);
  assert.equal(JSON.stringify(f.rows).includes('PRIVATE'), false);
});

test('database probe retains actual in-memory SQLite transactions and rollback', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { randomBytes } = require('node:crypto');
  const sqlite = { ...require('../lib/proxy/context-recovery-storage-sqlite') };
  const f = fixture();
  const database = new DatabaseSync(':memory:');
  let engine;
  try {
    installOwnerStageProbe(
      (file) => (file.endsWith('context-recovery-storage-sqlite.js') ? sqlite : f.load(file)),
      f.emit,
      f.now
    );
    engine = sqlite.createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
      now: () => 100,
    });
    const scope = 'a'.repeat(64);
    assert.equal(engine.execute({ operation: 'load-reference', scope }), null);
    assert.equal(
      engine.execute({
        operation: 'save',
        scope,
        expectedRevision: 0,
        expiresAt: 1000,
        state: { safe: 'synthetic' },
      }).revision,
      1
    );
    assert.throws(
      () =>
        engine.execute({
          operation: 'save',
          scope,
          expectedRevision: 0,
          expiresAt: 1000,
          state: { safe: 'rejected' },
        }),
      { code: 'context_recovery_storage_unavailable' }
    );
    assert.equal(engine.snapshot().scopes[0].revision, 1);
    assert.equal(engine.execute({ operation: 'load', scope }).state.safe, 'synthetic');
    for (const stage of ['sqlite_begin', 'sqlite_clock_write', 'sqlite_commit', 'sqlite_rollback'])
      assert.equal(
        f.rows.some((row) => row.stage === stage),
        true
      );
    assert.equal(JSON.stringify(f.rows).includes('synthetic'), false);
  } finally {
    engine?.close();
    database.close();
  }
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
  const native = (load, emit) => {
    assert.equal(load, f.load);
    emit('anchor_native_read', 0);
  };
  vm.runInNewContext(worker.script, {
    require(file) {
      if (file === helperFile)
        return {
          installOwnerStageProbe: (_load, emit, _now, _cpu, installNative) => {
            assert.equal(installNative, native);
            installOwnerStageProbe(f.load, emit, f.now, undefined, installNative);
          },
        };
      if (file === path.join(path.dirname(helperFile), 'recovery-anchor-stage-probe.js'))
        return { installAnchorStageProbe: native };
      assert.equal(file, workerFile);
      started = true;
      f.engineModule.createRecoverySqliteStore().execute({ operation: 'inspect' });
    },
    process: { stderr: { write: (value) => worker.stderr.emit('data', Buffer.from(value)) } },
  });
  assert.equal(started, true);
  assert.equal(diagnostics[0].stage, 'anchor_native_read');
  assert.equal(diagnostics[1].stage, 'engine_execute');
  worker.stderr.emit('data', Buffer.from('PRIVATE_NATIVE_WARNING\nHPM_STA'));
  worker.stderr.emit('data', Buffer.from('GE {"secret":"PRIVATE"}\n'));
  worker.stderr.emit('data', Buffer.from('x'.repeat(5000)));
  assert.deepEqual(diagnostics.at(-1), { phase: 'owner-stage-invalid' });
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'), false);
  assert.throws(() => new Type('PRIVATE_WORKER', {}));
});

test('worker diagnostics preserve large batches of bounded lines and reject oversized frames through newline', () => {
  class FakeWorker {
    constructor() {
      this.stderr = new EventEmitter();
    }
  }
  const rows = [];
  const Type = createObservedStorageWorker((row) => rows.push(row), FakeWorker);
  const worker = new Type(workerFile, {});
  const line =
    'HPM_STAGE ' +
    JSON.stringify({ sequence: 1, operation: 'save', stage: 'anchor_native_flush', elapsedMs: 1 }) +
    '\n';
  worker.stderr.emit('data', Buffer.from(line.repeat(50)));
  assert.equal(rows.length, 50);
  worker.stderr.emit('data', Buffer.from('PRIVATE'.repeat(1000)));
  worker.stderr.emit('data', Buffer.from(line));
  assert.equal(rows.length, 50, 'oversized unterminated frame cannot manufacture a prefixed line');
  worker.stderr.emit('data', Buffer.from(line.slice(0, 17)));
  worker.stderr.emit('data', Buffer.from(line.slice(17)));
  assert.equal(rows.length, 51);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
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

test('commit reports only its worker thread CPU delta while preserving wall time and thrown cause', () => {
  const f = fixture();
  const cause = new Error('PRIVATE_COMMIT_FAILURE');
  let observed;
  f.engineModule.createRecoverySqliteStore = ({ database }) => {
    observed = database;
    return { execute: () => observed.exec('COMMIT'), snapshot() {} };
  };
  const samples = [
    { user: 100, system: 200 },
    { user: 130, system: 250 },
    { user: 300, system: 400 },
    { user: 320, system: 410 },
  ];
  installOwnerStageProbe(f.load, f.emit, f.now, () => samples.shift());
  let failed = false;
  const database = {
    exec(sql) {
      assert.equal(this, database);
      assert.equal(sql, 'COMMIT');
      if (failed) throw cause;
      return f.result;
    },
  };
  const engine = f.engineModule.createRecoverySqliteStore({ database });
  assert.equal(engine.execute({ operation: 'save' }), f.result);
  failed = true;
  assert.throws(
    () => engine.execute({ operation: 'save' }),
    (error) => error === cause
  );
  const commits = f.rows.filter((row) => row.stage === 'sqlite_commit');
  assert.deepEqual(
    commits.map((row) => [row.threadCpuUserUs, row.threadCpuSystemUs]),
    [
      [30, 50],
      [20, 10],
    ]
  );
  assert.ok(commits.every((row) => row.elapsedMs === 1));
  for (const row of f.rows) {
    assert.deepEqual(parseStageLine(JSON.stringify(row)), row);
    if (row.stage !== 'sqlite_commit') assert.equal(Object.hasOwn(row, 'threadCpuUserUs'), false);
  }
  assert.equal(JSON.stringify(f.rows).includes('PRIVATE'), false);
});

test('commit CPU parser refuses partial, negative, fractional, unsafe and misplaced counters', () => {
  const row = {
    sequence: 1,
    operation: 'save',
    stage: 'sqlite_commit',
    elapsedMs: 1,
    threadCpuUserUs: 0,
    threadCpuSystemUs: 0,
  };
  assert.deepEqual(parseStageLine(JSON.stringify(row)), row);
  for (const invalid of [
    { ...row, threadCpuUserUs: -1 },
    { ...row, threadCpuSystemUs: 0.5 },
    { ...row, threadCpuUserUs: Number.MAX_SAFE_INTEGER + 1 },
    { ...row, threadCpuSystemUs: null },
    { ...row, stage: 'engine_execute' },
    { ...row, private: 'PRIVATE' },
    Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'threadCpuSystemUs')),
  ])
    assert.throws(() => parseStageLine(JSON.stringify(invalid)), {
      message: 'recovery_stage_probe_failed',
    });
});

test('commit CPU samples reject malformed data without invoking accessors or proxy traps', () => {
  let traps = 0;
  for (const sample of [
    null,
    {},
    [],
    { user: -1, system: 0 },
    { user: 0, system: Infinity },
    { user: 0.5, system: 0 },
    { user: Number.MAX_SAFE_INTEGER + 1, system: 0 },
    {
      get user() {
        traps++;
        return 0;
      },
      system: 0,
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
  ]) {
    const f = fixture();
    let ran = false;
    f.engineModule.createRecoverySqliteStore = ({ database }) => ({
      execute: () => database.exec('COMMIT'),
      snapshot() {},
    });
    installOwnerStageProbe(f.load, f.emit, f.now, () => sample);
    const engine = f.engineModule.createRecoverySqliteStore({
      database: {
        exec() {
          ran = true;
        },
      },
    });
    assert.throws(() => engine.execute({ operation: 'save' }), {
      message: 'recovery_stage_probe_failed',
    });
    assert.equal(ran, false);
    assert.equal(
      f.rows.some((row) => row.stage === 'sqlite_commit'),
      false
    );
  }
  assert.equal(traps, 0);
});

test('commit CPU samples reject rollback and accept exact safe-integer boundaries', () => {
  for (const samples of [
    [
      { user: 10, system: 20 },
      { user: 9, system: 20 },
    ],
    [
      { user: 10, system: 20 },
      { user: 10, system: 19 },
    ],
    [
      { user: 0, system: 0 },
      { user: Number.MAX_SAFE_INTEGER, system: Number.MAX_SAFE_INTEGER },
    ],
  ]) {
    const f = fixture();
    f.engineModule.createRecoverySqliteStore = ({ database }) => ({
      execute: () => database.exec('COMMIT'),
      snapshot() {},
    });
    const maximum = samples[1].user === Number.MAX_SAFE_INTEGER;
    installOwnerStageProbe(f.load, f.emit, f.now, () => samples.shift());
    const engine = f.engineModule.createRecoverySqliteStore({ database: { exec: () => f.result } });
    if (!maximum)
      assert.throws(() => engine.execute({ operation: 'save' }), {
        message: 'recovery_stage_probe_failed',
      });
    else {
      assert.equal(engine.execute({ operation: 'save' }), f.result);
      const commit = f.rows.find((row) => row.stage === 'sqlite_commit');
      assert.equal(commit.threadCpuUserUs, Number.MAX_SAFE_INTEGER);
      assert.deepEqual(parseStageLine(JSON.stringify(commit)), commit);
    }
  }
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

test('owner scope distinguishes reopened sequence numbers and delayed events without reading diagnostic data', () => {
  const events = [];
  const allocate = createOwnerDiagnosticScope((ownerEpoch, value) => {
    events.push({ ownerEpoch, value });
    if (value === null) throw new Error('fixed_observer_failure');
  });
  const first = allocate();
  const second = allocate();
  const row = Object.freeze({
    sequence: 1,
    operation: 'save',
    stage: 'sqlite_commit',
    elapsedMs: 1,
  });
  second(row);
  first(row);
  assert.deepEqual(
    events.map(({ ownerEpoch }) => ownerEpoch),
    [2, 1]
  );
  assert.equal(events[0].value, row);
  assert.equal(events[1].value, row);
  let traps = 0;
  const opaque = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error('private');
      },
    }
  );
  first(opaque);
  assert.equal(events[2].value, opaque);
  assert.equal(traps, 0);
  assert.throws(() => second(null), { message: 'fixed_observer_failure' });
  const independent = createOwnerDiagnosticScope((ownerEpoch) => assert.equal(ownerEpoch, 1));
  independent()(undefined);
  for (const invalid of [undefined, null, {}, [], 1, 'private', new Proxy(() => {}, {})])
    assert.throws(() => createOwnerDiagnosticScope(invalid), {
      message: 'recovery_stage_probe_failed',
    });
});
