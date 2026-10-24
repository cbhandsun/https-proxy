'use strict';
const { structuredClone } = globalThis;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const {
  exerciseNativeControl,
  controlReceipt,
  workerReceipt,
  storeWitness,
} = require('../scripts/lib/nsis-native-control-contract');
const { executeNativeControl } = require('../scripts/lib/nsis-native-control-transport');
const {
  phaseWriter,
  assertWriterOwned,
  checkHealth,
  parseProbeArguments,
} = require('../scripts/lib/nsis-native-control-probe');
const failure = { message: 'native_control_probe_failed' };
const installation = { manifestSha256: 'a'.repeat(64), sourceCount: 550 };
const stored = {
  budgetSha256: 'b'.repeat(64),
  callCount: 1,
  expiresAt: Date.now() + 86400000,
  keySha256: 'c'.repeat(64),
  originalSha256: 'd'.repeat(64),
  rootId: 'hbs_' + 'e'.repeat(32),
  sourceId: 'hce_' + 'f'.repeat(32),
};
const witness = {
  schemaVersion: 3,
  hasBlobs: 1,
  blobs: 1,
  revision: 1,
  createdAt: stored.expiresAt - 86400000,
  expiresAt: stored.expiresAt,
};
function worker() {
  return {
    backend: 'default-worker',
    ...installation,
    receipt: { ...stored },
    observation: {
      workerStarted: true,
      nativeKeyCompleted: true,
      databaseOpened: true,
      engineReady: true,
      ready: true,
      refused: false,
      anchorOpened: true,
      anchorPersisted: true,
    },
  };
}
function scenario() {
  const events = [],
    phases = [];
  let round = 0;
  return {
    events,
    phases,
    operations: {
      fixture(operation) {
        events.push('fixture:' + operation);
        return worker();
      },
      control(command) {
        events.push('control:' + command);
        return { schemaVersion: 1, command, ok: true, gracefulDrain: command === 'stop' };
      },
      async ready() {
        events.push('ready');
        return { pid: 1234, instanceId: (++round === 1 ? 'a' : 'b').repeat(32) };
      },
      inspect() {
        events.push('inspect');
        return { ...witness };
      },
      verify() {
        events.push('verify');
      },
      phase(value) {
        phases.push(value);
      },
    },
  };
}
test('native control requires two real stop receipts, fresh instances and unchanged fixed source/expiry/budget/state', async () => {
  const f = scenario(),
    receipt = await exerciseNativeControl(f.operations, installation);
  assert.equal(receipt.scope, 'installed_native_idle_stop_storage_reopen');
  assert.equal(receipt.normalStops, 2);
  assert.deepEqual(
    f.events.filter((x) => x.startsWith('control:')),
    ['control:start', 'control:stop', 'control:start', 'control:stop']
  );
  assert.deepEqual(
    f.events.filter((x) => x.startsWith('fixture:')),
    ['fixture:seed', 'fixture:read', 'fixture:read']
  );
  assert.deepEqual(f.phases, [
    'seed',
    'start-1',
    'ready-1',
    'stop-1',
    'read-1',
    'start-2',
    'ready-2',
    'stop-2',
    'read-2',
    'complete',
  ]);
  for (const key of ['restartRetention', 'clientQualified', 'retention24hQualified'])
    assert.equal(receipt[key], false);
  assert.equal(receipt.modelRequests, 0);
  assert.equal(JSON.stringify(receipt).includes(stored.rootId), false);
});
test('each operation failure stops immediately without retries or accepting forced cleanup', async () => {
  for (const [name, at] of [
    ['fixture', 1],
    ['fixture', 2],
    ['fixture', 3],
    ['control', 1],
    ['control', 2],
    ['control', 3],
    ['control', 4],
    ['ready', 1],
    ['ready', 2],
    ['inspect', 1],
    ['inspect', 2],
    ['inspect', 3],
    ['verify', 1],
    ['verify', 2],
    ['verify', 3],
    ['verify', 4],
    ['verify', 5],
  ]) {
    const f = scenario(),
      original = f.operations[name];
    let calls = 0;
    f.operations[name] = (...args) => {
      if (++calls === at) throw new Error('private');
      return original(...args);
    };
    await assert.rejects(exerciseNativeControl(f.operations, installation));
    assert.equal(calls, at);
    assert.equal(f.phases.includes('complete'), false);
  }
  for (const alter of [
    (r) => {
      r.gracefulDrain = false;
    },
    (r) => {
      r.ok = false;
    },
    (r) => {
      r.cleanupSemantics = 'forced_cleanup';
    },
    (r) => {
      r.command = 'start';
    },
  ]) {
    const f = scenario(),
      control = f.operations.control;
    f.operations.control = (command) => {
      const value = control(command);
      if (command === 'stop') alter(value);
      return value;
    };
    await assert.rejects(exerciseNativeControl(f.operations, installation), failure);
    assert.equal(f.events.includes('fixture:read'), false);
  }
});
test('reopen rejects expiry, budget, key, state or nonce drift and malformed native observations', async () => {
  for (const alter of [
    (r) => {
      r.receipt.expiresAt++;
    },
    (r) => {
      r.receipt.budgetSha256 = '0'.repeat(64);
    },
    (r) => {
      r.receipt.keySha256 = '0'.repeat(64);
    },
    (r) => {
      r.observation.workerStarted = false;
    },
    (r) => {
      r.observation.anchorPersisted = false;
    },
    (r) => {
      r.backend = 'memory';
    },
  ]) {
    const f = scenario();
    f.operations.fixture = (operation) => {
      const value = worker();
      if (operation === 'read') alter(value);
      return value;
    };
    await assert.rejects(exerciseNativeControl(f.operations, installation), failure);
  }
  const f = scenario();
  f.operations.ready = async () => ({ pid: 1234, instanceId: 'a'.repeat(32) });
  await assert.rejects(exerciseNativeControl(f.operations, installation), failure);
  for (const delta of [
    { revision: 2 },
    { expiresAt: witness.expiresAt + 1 },
    { schemaVersion: 1 },
    { blobs: NaN },
    { createdAt: witness.expiresAt },
  ])
    assert.throws(() => storeWitness({ ...witness, ...delta }, stored), failure);
  let calls = 0;
  const value = worker();
  Object.defineProperty(value.receipt, 'expiresAt', {
    get() {
      calls++;
      return stored.expiresAt;
    },
    enumerable: true,
  });
  assert.throws(() => workerReceipt(value, installation), failure);
  assert.equal(calls, 0);
  for (const input of [
    null,
    {},
    [],
    { schemaVersion: 1, command: 'stop', ok: true, gracefulDrain: false },
  ])
    assert.throws(() => controlReceipt(input, 'stop'), failure);
});
test('native transport retains fixed program, no shell, bounded deadline and exact private protocol', () => {
  let calls = 0;
  const start = (program, args, options) => {
    calls++;
    assert.equal(program, 'owned.exe');
    assert.deepEqual(args, ['--hpm-proxy-control-v1']);
    assert.equal(options.timeout, 12000);
    assert.equal(options.shell, false);
    assert.equal(options.input, '{"command":"stop"}\n');
    return {
      status: 0,
      signal: null,
      stderr: '',
      stdout: '{"schemaVersion":1,"command":"stop","ok":true,"gracefulDrain":true}\n',
    };
  };
  assert.equal(executeNativeControl('owned.exe', 'stop', {}, 'owned', start).ok, true);
  assert.equal(calls, 1);
  for (const change of [
    { status: 1 },
    { signal: 'SIGTERM' },
    { error: new Error('private') },
    { stderr: 'private' },
    { stdout: '' },
    { stdout: 'x'.repeat(513) },
    { stdout: '{}\n' },
    { stdout: '{"schemaVersion":1,"schemaVersion":1}\n' },
  ]) {
    let attempts = 0;
    assert.throws(
      () =>
        executeNativeControl('owned.exe', 'stop', {}, 'owned', () => {
          attempts++;
          return {
            ...start('owned.exe', ['--hpm-proxy-control-v1'], {
              timeout: 12000,
              shell: false,
              input: '{"command":"stop"}\n',
            }),
            ...change,
          };
        }),
      failure
    );
    assert.equal(attempts, 1);
  }
  assert.throws(
    () =>
      executeNativeControl('owned.exe', 'stop', {}, 'owned', () => {
        throw new Error('private');
      }),
    failure
  );
});
test('phase evidence is finite, pinned and refuses collisions or replacement; actual writer lock is required', (t) => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-native-control-unit-')
  );

  const phase = phaseWriter(root);
  for (const invalid of [null, {}, '', 'private', 'x'.repeat(4096)])
    assert.throws(() => phase(invalid), failure);
  phase('seed');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, 'native-control-phase.json'), 'utf8')),
    { schemaVersion: 1, phase: 'seed' }
  );
  phase('stop-1');
  assert.throws(() => phaseWriter(root), failure);
  const database = new DatabaseSync(path.join(root, '.writer.sqlite'));
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.throws(() => assertWriterOwned(root), failure);
  database.exec('BEGIN EXCLUSIVE');
  assertWriterOwned(root);
  database.exec('ROLLBACK');
  assert.throws(() => assertWriterOwned(root), failure);
});
test('probe arguments reject malformed, unsafe and executable shapes before path access', () => {
  const root = path.resolve('/owned'),
    args = [
      root,
      path.join(root, 'payload'),
      path.join(root, 'executor'),
      'a'.repeat(64),
      'b'.repeat(40),
      'c'.repeat(64),
    ];
  assert.equal(parseProbeArguments(args, (x) => x).manifest, args[3]);
  let hooks = 0;
  const getter = [...args];
  Object.defineProperty(getter, '0', {
    get() {
      hooks++;
      return root;
    },
    enumerable: true,
  });
  for (const input of [
    null,
    {},
    [],
    new Array(6),
    getter,
    new Proxy(args, {
      get() {
        hooks++;
        throw new Error('private');
      },
    }),
    [...args, 'extra'],
    [...args.slice(0, 3), 'x', args[4], args[5]],
    ['x'.repeat(4097), ...args.slice(1)],
  ])
    assert.throws(() =>
      parseProbeArguments(input, () => {
        throw new Error('path_not_expected');
      })
    );
  assert.equal(hooks, 0);
  assert.throws(
    () =>
      parseProbeArguments(
        [root, args[1], path.join(args[1], 'inside'), ...args.slice(3)],
        (x) => x
      ),
    failure
  );
});
test('health witness requires actual root, native instance, persistent mode and original restricted claims', () => {
  const pid = process.pid === 1234 ? 1235 : 1234;
  const install = path.resolve('/owned/install'),
    body = {
      appId: 'https-proxy-manager',
      pid,
      shutdown: { pid, instanceId: 'a'.repeat(32) },
      runtime: {
        entrypoint: path.join(install, 'openai-proxy.js'),
        cwd: install,
        configDir: install,
        runtimeDir: path.join(install, '.hpm-runtime'),
        contextRecoveryDirectory: path.join(install, '.hpm-runtime/context-recovery-v1'),
      },
      ports: {
        management: 32001,
        entries: [{ host: '127.0.0.1', listenPort: 32002, tls: false, protocol: 'openai-chat' }],
      },
      contextRecovery: {
        configValid: true,
        requestedEnabled: true,
        appliedEnabled: true,
        storage: 'persistent',
        state: 'enabled_restricted',
        restartRetention: false,
      },
    };
  assert.equal(checkHealth(body, install, 32001, 32002).ready, true);
  for (const change of [
    (x) => {
      x.pid++;
    },
    (x) => {
      x.runtime.cwd = 'other';
    },
    (x) => {
      x.contextRecovery.restartRetention = true;
    },
    (x) => {
      x.contextRecovery.state = 'failed';
    },
  ]) {
    const value = structuredClone(body);
    change(value);
    assert.throws(() => checkHealth(value, install, 32001, 32002));
  }
  let hooks = 0;
  assert.throws(() =>
    checkHealth(
      {
        get runtime() {
          hooks++;
          return body.runtime;
        },
      },
      install,
      32001,
      32002
    )
  );
  assert.equal(hooks, 0);
});
test('standalone driver refuses non-hosted execution with no product data or native replies', () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve('scripts/lib/nsis-native-control-probe.cjs')],
    {
      input: '1',
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', CI: '' },
      timeout: 5000,
    }
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'native_control_probe_failed\n');
});
