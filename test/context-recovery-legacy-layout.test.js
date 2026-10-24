'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BASELINE,
  parseLegacyLayoutArguments,
  runLegacyLayoutQualification,
  runLegacyWorkerLayoutQualification,
} = require('../scripts/lib/context-recovery-legacy-layout');

const args = [path.resolve('baseline'), path.resolve('current'), 'a'.repeat(64)];
const failure = { message: 'context_recovery_legacy_layout_failed' };
function fixture(change = {}) {
  const operations = [];
  let inspections = 0,
    verifications = 0;
  const receipt = {
    budgetSha256: 'b'.repeat(64),
    callCount: 1,
    expiresAt: Date.now() + 3600000,
    keySha256: 'c'.repeat(64),
    originalSha256: 'd'.repeat(64),
    rootId: 'hbs_' + 'e'.repeat(32),
    sourceId: 'hce_' + 'f'.repeat(32),
  };
  const dependencies = {
    platform: 'win32',
    verify() {
      verifications++;
      return {
        baseline: { manifestSha256: BASELINE.manifest, sourceCount: 582, node: 'old-node' },
        current: { manifestSha256: args[2], sourceCount: 700, node: 'new-node' },
      };
    },
    create() {
      return { store: 'owned-fresh-store', verify() {} };
    },
    execute({ installation, operation, owned }) {
      assert.equal(owned.store, 'owned-fresh-store');
      operations.push(operation);
      return {
        manifestSha256: installation.manifestSha256,
        sourceCount: installation.sourceCount,
        nativeCalls: 1,
        receipt: operation.startsWith('refuse-')
          ? { refused: true, preserved: true, statusCode: 503, fileCount: 3 }
          : { ...receipt },
      };
    },
    inspect() {
      const index = inspections++;
      return {
        schemaVersion: index < 3 ? 1 : 3,
        hasBlobs: index < 3 ? 0 : 1,
        blobs: index < 4 ? 0 : 1,
        revision: index < 4 ? 1 : 2,
        createdAt: receipt.expiresAt - 3600000,
        expiresAt: receipt.expiresAt,
      };
    },
    ...change,
  };
  return { dependencies, operations, receipt, verifications: () => verifications };
}

test('fixed legacy runner preserves receipts through all eight stages and exact layout/revision transition', () => {
  const f = fixture();
  const result = runLegacyLayoutQualification(args, f.dependencies);
  assert.deepEqual(f.operations, [
    'seed',
    'read',
    'refuse-legacy',
    'enroll-legacy',
    'resave',
    'read',
    'refuse-new-format',
    'read',
  ]);
  assert.equal(f.verifications(), 17);
  assert.equal(result.stages, 8);
  assert.equal(result.revisionDelta, 1);
  assert.equal(result.baselineManifestSha256, BASELINE.manifest);
  assert.equal(result.currentManifestSha256, args[2]);
  assert.equal(result.scope, 'packaged_runtime_legacy_layout_migration');
  for (const name of [
    'nsisQualified',
    'workerQualified',
    'retention24hQualified',
    'clientQualified',
  ])
    assert.equal(result[name], false);
  const encoded = JSON.stringify(result);
  for (const value of [
    f.receipt.rootId,
    f.receipt.sourceId,
    f.receipt.keySha256,
    'owned-fresh-store',
  ])
    assert.equal(encoded.includes(value), false);
});

test('arguments reject empty, extra, sparse, invalid, unpinned and unsafe paths without evaluating getters', () => {
  let calls = 0;
  const accessor = [...args];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() {
      calls++;
      return args[0];
    },
  });
  const proxy = new Proxy(args, {
    get() {
      calls++;
      throw new Error('private');
    },
  });
  for (const input of [
    null,
    {},
    [],
    [args[0]],
    [...args, 'database'],
    new Array(3),
    accessor,
    proxy,
    ['relative', args[1], args[2]],
    [args[0], args[0], args[2]],
    [args[0], args[1], BASELINE.manifest],
    [args[0], args[1], 'A'.repeat(64)],
    [args[0], args[1], '0'.repeat(65)],
    [args[0] + '\n', args[1], args[2]],
    ['//network/share', args[1], args[2]],
    [args[0] + '/..', args[1], args[2]],
    ['x'.repeat(5000), args[1], args[2]],
  ])
    assert.throws(() => parseLegacyLayoutArguments(input), failure);
  assert.equal(calls, 0);
  assert.deepEqual(parseLegacyLayoutArguments(args), {
    baseline: args[0],
    current: args[1],
    manifestSha256: args[2],
  });
});

test('non-Windows refuses before creating roots or inspecting packages', () => {
  const f = fixture({
    platform: 'darwin',
    verify() {
      throw new Error('must not inspect');
    },
  });
  assert.throws(() => runLegacyLayoutQualification(args, f.dependencies), failure);
  assert.equal(f.operations.length, 0);
});

test('every driver failure stops at the exact failed operation without retry or subsequent inspection', () => {
  for (let failedIndex = 0; failedIndex < 8; failedIndex++) {
    const f = fixture();
    const execute = f.dependencies.execute;
    let inspections = 0;
    const inspect = f.dependencies.inspect;
    f.dependencies.inspect = () => {
      inspections++;
      return inspect();
    };
    f.dependencies.execute = (input) => {
      const result = execute(input);
      if (f.operations.length === failedIndex + 1) throw new Error('private raw native failure');
      return result;
    };
    assert.throws(() => runLegacyLayoutQualification(args, f.dependencies), failure);
    assert.equal(f.operations.length, failedIndex + 1);
    assert.equal(inspections, failedIndex);
  }
});

test('package identity changes fail before another operation and owned-directory replacement fails closed', () => {
  const f = fixture();
  const verify = f.dependencies.verify;
  f.dependencies.verify = () => {
    const result = verify();
    if (f.verifications() === 3) result.current.node = 'replaced';
    return result;
  };
  assert.throws(() => runLegacyLayoutQualification(args, f.dependencies), failure);
  assert.deepEqual(f.operations, ['seed']);
  const replaced = fixture({
    create: () => ({
      verify() {
        throw new Error('replaced');
      },
    }),
  });
  assert.throws(() => runLegacyLayoutQualification(args, replaced.dependencies), failure);
  assert.equal(replaced.operations.length, 0);
});

test('receipt rejects wrong identity, expiry extension, budget drift, malformed refusal and private fields', () => {
  for (const alter of [
    (r) => {
      r.manifestSha256 = 'f'.repeat(64);
    },
    (r) => {
      r.sourceCount++;
    },
    (r) => {
      r.nativeCalls = 0;
    },
    (r) => {
      r.nativeCalls = 5;
    },
    (r) => {
      r.receipt.expiresAt++;
    },
    (r) => {
      r.receipt.budgetSha256 = 'f'.repeat(64);
    },
    (r) => {
      r.receipt.keySha256 = 'f'.repeat(64);
    },
    (r) => {
      r.receipt.private = 'secret';
    },
    (r) => {
      r.extra = 'secret';
    },
  ]) {
    const f = fixture(),
      execute = f.dependencies.execute;
    f.dependencies.execute = (input) => {
      const result = execute(input);
      if (f.operations.length === 2) alter(result);
      return result;
    };
    assert.throws(() => runLegacyLayoutQualification(args, f.dependencies), failure);
    assert.equal(f.operations.length, 2);
  }
  const f = fixture(),
    execute = f.dependencies.execute;
  f.dependencies.execute = (input) => {
    const result = execute(input);
    if (input.operation === 'refuse-legacy') result.receipt.preserved = false;
    return result;
  };
  assert.throws(() => runLegacyLayoutQualification(args, f.dependencies), failure);
  assert.equal(f.operations.length, 3);
});

test('layout witnesses reject wrong schema, absent blob migration, extra revision and clock/expiry drift', () => {
  for (const [index, delta] of [
    [0, { schemaVersion: 2 }],
    [0, { revision: 2 }],
    [0, { hasBlobs: 1 }],
    [1, { revision: 2 }],
    [3, { schemaVersion: 1 }],
    [3, { revision: 2 }],
    [4, { blobs: 0 }],
    [4, { revision: 3 }],
    [5, { revision: 3 }],
    [6, { createdAt: 0 }],
    [7, { expiresAt: Number.MAX_SAFE_INTEGER }],
    [0, { blobs: NaN }],
  ]) {
    const f = fixture(),
      inspect = f.dependencies.inspect;
    let at = 0;
    f.dependencies.inspect = () => ({ ...inspect(), ...(at++ === index ? delta : {}) });
    assert.throws(() => runLegacyLayoutQualification(args, f.dependencies), failure);
    assert.equal(f.operations.length, index + 1);
  }
});

test('CLI rejects missing arguments with only a fixed safe error', () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../scripts/qualify-context-recovery-legacy-layout.cjs')],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '{"schemaVersion":1,"passed":false,"stage":0}\n');
  assert.equal(result.stderr, 'context_recovery_legacy_layout_failed\n');
});

test('progress exposes only fixed stages and rejects a failed or asynchronous observer before execution', () => {
  const progress = [],
    f = fixture({
      onProgress: (event) => {
        progress.push(event);
      },
    });
  runLegacyLayoutQualification(args, f.dependencies);
  assert.deepEqual(
    progress.map((event) => event.stage),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
  for (const event of progress)
    assert.deepEqual(Object.keys(event), ['stage', 'role', 'operation']);
  for (const onProgress of [
    () => {
      throw new Error('private observer failure');
    },
    () => Promise.resolve(),
  ]) {
    const failed = fixture({ onProgress });
    assert.throws(() => runLegacyLayoutQualification(args, failed.dependencies), failure);
    assert.equal(failed.operations.length, 0);
  }
});

test('driver transport keeps the original deadline, uses packaged Node and suppresses all raw stderr', () => {
  const { executeDriver } = require('../scripts/lib/context-recovery-legacy-layout-runtime');
  const input = {
    installation: { node: 'pinned-node', manifestSha256: args[2] },
    install: args[1],
    operation: 'seed',
    owned: { store: 'fresh', environment: () => ({ HOME: 'fresh-home' }) },
  };
  let calls = 0;
  const start = (binary, parameters, options) => {
    calls++;
    assert.equal(binary, 'pinned-node');
    assert.equal(parameters[1], 'seed');
    assert.equal(parameters[3], 'fresh');
    assert.equal(options.timeout, 120000);
    assert.equal(options.shell, false);
    assert.equal(options.maxBuffer, 8192);
    assert.deepEqual(options.env, { HOME: 'fresh-home' });
    return { status: 0, signal: null, stdout: '{"ok":true}\n', stderr: 'PRIVATE NATIVE REPLY' };
  };
  assert.deepEqual(executeDriver(input, start), { ok: true });
  assert.equal(calls, 1);
  for (const alteration of [
    { error: new Error('PRIVATE timeout') },
    { status: 1 },
    { status: null, signal: 'SIGTERM' },
    { stdout: '' },
    { stdout: 'private malformed' },
    { stdout: 'x'.repeat(4097) },
    { stdout: '{"ok":false,"ok":true}\n' },
    { stdout: '{"ok":true}\nprivate' },
  ]) {
    let attempts = 0;
    assert.throws(
      () =>
        executeDriver(input, () => {
          attempts++;
          return { status: 0, signal: null, stdout: '{"ok":true}\n', ...alteration };
        }),
      failure
    );
    assert.equal(attempts, 1);
  }
  assert.throws(
    () =>
      executeDriver(input, () => {
        throw new Error('PRIVATE spawn error');
      }),
    failure
  );
});

test('fresh root isolation excludes inherited secrets and detects links or directory replacement', (t) => {
  const fs = require('node:fs');
  const { createOwnedRoot } = require('../scripts/lib/context-recovery-legacy-layout-runtime');
  const owned = createOwnedRoot(),
    root = path.dirname(owned.store);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  owned.verify();
  const env = owned.environment();
  for (const name of [
    'CODEX_HOME',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PROXY_CONFIG_DIR',
  ])
    assert.equal(Object.hasOwn(env, name), false);
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'])
    assert.ok(env[name].startsWith(root + path.sep));
  fs.renameSync(owned.store, path.join(root, 'previous-store'));
  fs.mkdirSync(owned.store);
  assert.throws(() => owned.verify(), failure);
});

test('read-only SQLite layout witness observes exact revisions and never changes store bytes', (t) => {
  const fs = require('node:fs');
  const { createHash } = require('node:crypto');
  const { DatabaseSync } = require('node:sqlite');
  const {
    createOwnedRoot,
    inspectOwnedStore,
  } = require('../scripts/lib/context-recovery-legacy-layout-runtime');
  const owned = createOwnedRoot(),
    root = path.dirname(owned.store);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(owned.store, 'checkpoint.sqlite');
  const database = new DatabaseSync(file);
  database.exec(
    "PRAGMA user_version=1; CREATE TABLE recovery_state(revision INTEGER,created_at INTEGER,expires_at INTEGER,kind TEXT); INSERT INTO recovery_state VALUES(7,100,999,'state')"
  );
  database.close();
  const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash();
  assert.deepEqual(inspectOwnedStore(owned), {
    schemaVersion: 1,
    hasBlobs: 0,
    blobs: 0,
    revision: 7,
    createdAt: 100,
    expiresAt: 999,
  });
  assert.equal(hash(), before);
  const changed = new DatabaseSync(file);
  changed.exec(
    "PRAGMA user_version=3; CREATE TABLE recovery_blob(envelope BLOB); INSERT INTO recovery_blob VALUES(X'0102'); UPDATE recovery_state SET revision=8"
  );
  changed.close();
  const next = hash();
  assert.deepEqual(inspectOwnedStore(owned), {
    schemaVersion: 3,
    hasBlobs: 1,
    blobs: 1,
    revision: 8,
    createdAt: 100,
    expiresAt: 999,
  });
  assert.equal(hash(), next);
  const invalid = new DatabaseSync(file);
  invalid.exec("INSERT INTO recovery_state VALUES(9,100,999,'state')");
  invalid.close();
  assert.throws(() => inspectOwnedStore(owned), failure);
});

test('package verification requires exact 582 manifest, source count, Node/native bytes and disjoint physical identities', () => {
  const { verifyPackages } = require('../scripts/lib/context-recovery-legacy-layout');
  const request = parseLegacyLayoutArguments(args);
  for (const rejected of [null, 'source-count', 'node', 'native', 'alias', 'verification-failed']) {
    const calls = [];
    const dependencies = {
      verify(directory, expected) {
        calls.push([directory, expected]);
        if (rejected === 'verification-failed') throw new Error('private package path');
        return directory === args[0]
          ? {
              sourceCount: rejected === 'source-count' ? 625 : 582,
              node: 'old-node',
              native: 'old-native',
            }
          : { sourceCount: 700, node: 'new-node', native: 'new-native' };
      },
      hash(file) {
        return file === 'old-node'
          ? rejected === 'node'
            ? '0'.repeat(64)
            : BASELINE.node
          : rejected === 'native'
            ? '0'.repeat(64)
            : BASELINE.native;
      },
      checkedPath(directory) {
        return rejected === 'alias' ? args[0] : directory;
      },
    };
    if (rejected) assert.throws(() => verifyPackages(request, dependencies));
    else {
      assert.equal(verifyPackages(request, dependencies).baseline.sourceCount, 582);
      assert.deepEqual(calls, [
        [args[0], BASELINE.manifest],
        [args[1], args[2]],
      ]);
    }
  }
});

function workerFixture() {
  const f = fixture();
  const execute = f.dependencies.execute;
  f.dependencies.execute = (input) => {
    const direct = execute(input);
    const refusal = input.operation.startsWith('refuse-');
    return {
      backend: 'default-worker',
      manifestSha256: direct.manifestSha256,
      sourceCount: direct.sourceCount,
      receipt: direct.receipt,
      observation: {
        workerStarted: true,
        nativeKeyCompleted: true,
        databaseOpened: true,
        engineReady: !refusal,
        ready: !refusal,
        refused: refusal,
        anchorOpened: input.install === args[1],
        anchorPersisted: input.install === args[1] && !refusal,
      },
    };
  };
  return f;
}

test('default worker migration preserves all eight exact state transitions without invented native call counts', () => {
  const f = workerFixture();
  const result = runLegacyWorkerLayoutQualification(args, f.dependencies);
  assert.equal(result.stages, 8);
  assert.equal(result.workerQualified, true);
  assert.equal(result.scope, 'packaged_runtime_default_worker_legacy_layout_migration');
  for (const key of ['nsisQualified', 'retention24hQualified', 'clientQualified'])
    assert.equal(result[key], false);
  assert.equal(f.verifications(), 17);
});

test('worker migration rejects absent, forged, extra and unsafe startup observations at every stage', () => {
  for (let stage = 1; stage <= 8; stage++) {
    for (const change of [
      (r) => {
        r.backend = 'direct-owner';
      },
      (r) => {
        r.nativeCalls = 1;
      },
      (r) => {
        r.observation = null;
      },
      (r) => {
        r.observation = {};
      },
      (r) => {
        r.observation.workerStarted = false;
      },
      (r) => {
        r.observation.nativeKeyCompleted = false;
      },
      (r) => {
        r.observation.databaseOpened = false;
      },
      (r) => {
        r.observation.engineReady = !r.observation.engineReady;
      },
      (r) => {
        r.observation.ready = !r.observation.ready;
      },
      (r) => {
        r.observation.refused = !r.observation.refused;
      },
      (r) => {
        r.observation.anchorOpened = !r.observation.anchorOpened;
      },
      (r) => {
        r.observation.anchorPersisted = !r.observation.anchorPersisted;
      },
      (r) => {
        r.receipt.private = 'must not leak';
      },
      (r) => {
        r.sourceCount = Number.MAX_SAFE_INTEGER;
      },
      (r) => {
        r.manifestSha256 = '0'.repeat(64);
      },
      (r) => {
        r.observation = new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('private');
            },
          }
        );
      },
      (r) => {
        Object.defineProperty(r.observation, 'ready', {
          get() {
            throw new Error('private');
          },
        });
      },
    ]) {
      const f = workerFixture(),
        execute = f.dependencies.execute;
      f.dependencies.execute = (input) => {
        const result = execute(input);
        if (f.operations.length === stage) change(result);
        return result;
      };
      assert.throws(() => runLegacyWorkerLayoutQualification(args, f.dependencies), failure);
      assert.equal(f.operations.length, stage);
    }
  }
});

test('worker migration CLI and fixture fail closed with fixed safe errors', () => {
  for (const [file, stdout, stderr] of [
    [
      'scripts/qualify-context-recovery-legacy-worker.cjs',
      '{"schemaVersion":1,"passed":false,"stage":0}\n',
      'context_recovery_legacy_layout_failed\n',
    ],
    ['scripts/lib/nsis-installed-worker-fixture.cjs', '', 'nsis_worker_qualification_failed\n'],
  ]) {
    const result = spawnSync(process.execPath, [path.resolve(file)], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, stdout);
    // node:sqlite may emit its fixed experimental warning on Node 22.
    assert.ok(result.stderr.endsWith(stderr));
    assert.equal(result.stderr.includes(' at '), false);
  }
});

test('worker executor selects only its fixed fixture and retains bounded transport', () => {
  const { executeWorkerDriver } = require('../scripts/lib/context-recovery-legacy-layout-runtime');
  let called = 0;
  const reply = executeWorkerDriver(
    {
      installation: { node: 'packaged-node', manifestSha256: args[2] },
      install: args[1],
      operation: 'read',
      owned: { store: 'fresh', environment: () => ({}) },
    },
    (node, parameters, options) => {
      called++;
      assert.equal(node, 'packaged-node');
      assert.equal(path.basename(parameters[0]), 'nsis-installed-worker-fixture.cjs');
      assert.equal(parameters[1], 'read');
      assert.equal(options.timeout, 120000);
      assert.equal(options.maxBuffer, 8192);
      assert.equal(options.shell, false);
      return { status: 0, signal: null, stdout: '{"ok":true}\n' };
    }
  );
  assert.equal(called, 1);
  assert.deepEqual(reply, { ok: true });
});
