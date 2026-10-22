'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { exerciseRecovery } = require('../scripts/lib/nsis-recovery-fixture-state');
const { discoverTestFiles } = require('../lib/test-discovery');
const { unpinnedActionReferences } = require('../lib/ci-governance');
const {
  safePath,
  child,
  digest,
  parseDriverArguments,
  verifyInstallation,
  compareReceipts,
  nativeKeyInvocation,
} = require('../scripts/lib/nsis-encrypted-contract');
const hash = (value) => createHash('sha256').update(value).digest('hex');
test('synthetic session driver saves and reads real checkpoint bytes without extending deadline or budget', () => {
  const database = new DatabaseSync(':memory:');
  const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
  const api = {
    sessions: require('../lib/proxy/context-recovery-sessions'),
    ...require('../lib/proxy/context-recovery-root-checkpoint'),
    ...require('../lib/proxy/context-recovery-storage-record'),
    LIST: require('../lib/proxy/context-evidence-tools').LIST_EVIDENCE_TOOL,
    READ: require('../lib/proxy/context-evidence-tools').READ_EVIDENCE_TOOL,
  };
  const store = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
  });
  try {
    const seed = exerciseRecovery(api, store, 'seed');
    assert.deepEqual(exerciseRecovery(api, store, 'resave'), seed);
    assert.deepEqual(exerciseRecovery(api, store, 'read'), seed);
    assert.throws(() => exerciseRecovery(api, store, 'unknown'));
    const empty = { execute: () => [] };
    assert.throws(() => exerciseRecovery(api, empty, 'read'));
    const broken = {
      execute: () => {
        throw new Error('synthetic-sql-failure');
      },
    };
    assert.throws(() => exerciseRecovery(api, broken, 'read'));
  } finally {
    store.close();
    database.close();
  }
});
function fakeInstallation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-encrypted-unit-'));
  for (const directory of ['lib/proxy', 'runtime/node', 'runtime/native', 'store'])
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  for (const file of [
    'lib/proxy/fixture.js',
    'runtime/node/node.exe',
    'runtime/native/hpm-context-recovery-key.exe',
    'package-lock.json',
  ])
    fs.writeFileSync(path.join(root, file), 'synthetic-artifact');
  const manifest = {
    schemaVersion: 2,
    sourceSha256: { 'lib/proxy/fixture.js': hash('synthetic-artifact') },
    nodeSha256: hash('synthetic-artifact'),
    contextRecoveryNativeSha256: hash('synthetic-artifact'),
    packageLockSha256: hash('synthetic-artifact'),
  };
  const save = () => {
    fs.writeFileSync(path.join(root, 'release-runtime-manifest.json'), JSON.stringify(manifest));
    return digest(path.join(root, 'release-runtime-manifest.json'));
  };
  return { root, manifest, save, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('installed closure and argument boundaries reject missing, invalid, hostile and changed bytes', () => {
  const f = fakeInstallation();
  try {
    const expected = f.save();
    for (const relative of [
      '',
      'lib',
      'lib/proxy',
      'runtime/node',
      'runtime/node/node.exe',
      'package-lock.json',
    ]) {
      const target = path.join(f.root, relative);
      assert.equal(fs.realpathSync.native(target), fs.realpathSync(target));
    }
    assert.equal(verifyInstallation(f.root, expected).sourceCount, 1);
    assert.equal(
      parseDriverArguments(['read', f.root, path.join(f.root, 'store'), expected]).operation,
      'read'
    );
    for (const value of [
      [],
      null,
      ['read'],
      ['execute', f.root, f.root, expected],
      ['seed', '', f.root, expected],
      ['read', f.root, f.root, 'A'.repeat(64)],
      ['read', f.root, f.root, expected, 'extra'],
    ])
      assert.throws(() => parseDriverArguments(value));
    for (const value of ['', '../escape', '/absolute', 'a/../escape', 'a\\escape', 'a//b', 'a/\0b'])
      assert.throws(() => child(f.root, value));
    assert.throws(() => safePath('relative'));
    assert.throws(() => verifyInstallation(f.root, '0'.repeat(64)));
    f.manifest.sourceSha256['../escape'] = 'a'.repeat(64);
    assert.throws(() => verifyInstallation(f.root, f.save()));
    delete f.manifest.sourceSha256['../escape'];
    f.manifest.sourceSha256 = {};
    assert.throws(() => verifyInstallation(f.root, f.save()));
    f.manifest.sourceSha256 = { 'lib/proxy/fixture.js': hash('synthetic-artifact') };
    const restored = f.save();
    fs.appendFileSync(path.join(f.root, 'runtime/native/hpm-context-recovery-key.exe'), 'tampered');
    assert.throws(() => verifyInstallation(f.root, restored));
    fs.unlinkSync(path.join(f.root, 'runtime/node/node.exe'));
    assert.throws(() => verifyInstallation(f.root, restored));
    const original = path.join(f.root, 'package-lock.json');
    const linked = path.join(f.root, 'hardlink');
    fs.linkSync(original, linked);
    assert.throws(() => digest(original));
    fs.unlinkSync(linked);
    assert.equal(digest(original), hash('synthetic-artifact'));
    const junction = path.join(f.root, 'junction');
    fs.symlinkSync(path.join(f.root, 'lib'), junction, 'junction');
    assert.throws(() => safePath(junction, true));
    assert.throws(() => safePath(path.join(junction, 'proxy/fixture.js')));
  } finally {
    f.cleanup();
  }
});
function digestFixture(t) {
  const fixture = fakeInstallation();
  t.after(() => {
    assert.equal(path.dirname(fixture.root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixture.root).startsWith('hpm-encrypted-unit-'));
    fixture.cleanup();
  });
  return { ...fixture, file: path.join(fixture.root, 'package-lock.json') };
}

function changedStat(stat, changes) {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes);
}

test('digest hashes empty, small and chunk boundary files with a bounded buffer', async (t) => {
  for (const size of [0, 17, 1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1, 2 * 1024 * 1024 + 17])
    await t.test(`size ${size}`, (sub) => {
      const { file } = digestFixture(sub);
      const bytes = Buffer.alloc(size, 97);
      fs.writeFileSync(file, bytes);
      const allocate = Buffer.alloc;
      const read = fs.readSync;
      const allocations = [];
      const lengths = [];
      sub.mock.method(Buffer, 'alloc', function (length, ...args) {
        allocations.push(length);
        return Reflect.apply(allocate, this, [length, ...args]);
      });
      sub.mock.method(fs, 'readSync', function (...args) {
        lengths.push(args[3]);
        return Reflect.apply(read, this, args);
      });
      assert.equal(digest(file), hash(bytes));
      assert.deepEqual(allocations, [Math.min(size, 1024 * 1024)]);
      assert.equal(
        lengths.reduce((sum, length) => sum + length, 0),
        size
      );
      assert.equal(lengths.length, Math.ceil(size / (1024 * 1024)));
      assert.ok(lengths.every((length) => length > 0 && length <= 1024 * 1024));
    });
});

test('digest retains both complete physical path walks and reuses the terminal preguard stat', (t) => {
  const { file } = digestFixture(t);
  const lstat = fs.lstatSync;
  const realpath = fs.realpathSync.native;
  const observed = [];
  t.mock.method(fs, 'lstatSync', function (name, ...args) {
    observed.push(['lstat', name]);
    return Reflect.apply(lstat, this, [name, ...args]);
  });
  t.mock.method(fs.realpathSync, 'native', function (name, ...args) {
    observed.push(['realpath', name]);
    return Reflect.apply(realpath, this, [name, ...args]);
  });
  t.mock.method(fs, 'statSync', () => {
    assert.fail('digest must reuse the terminal preguard lstat');
  });
  assert.equal(digest(file), hash('synthetic-artifact'));
  const walk = [];
  for (let current = file; current !== path.dirname(current); current = path.dirname(current)) {
    walk.push(['lstat', current], ['realpath', current]);
  }
  walk.push(['lstat', file]);
  assert.deepEqual(observed, [...walk, ...walk]);
});

test('digest refuses terminal preguard stat drift and oversized files before opening', async (t) => {
  for (const size of [19, 256 * 1024 * 1024 + 1])
    await t.test(`terminal size ${size}`, (sub) => {
      const { file } = digestFixture(sub);
      const lstat = fs.lstatSync;
      let leafCalls = 0;
      let openCalls = 0;
      const open = fs.openSync;
      sub.mock.method(fs, 'lstatSync', function (name, ...args) {
        const stat = Reflect.apply(lstat, this, [name, ...args]);
        return name === file && ++leafCalls === 2 ? changedStat(stat, { size }) : stat;
      });
      sub.mock.method(fs, 'openSync', function (...args) {
        openCalls++;
        return Reflect.apply(open, this, args);
      });
      assert.throws(() => digest(file), /nsis_encrypted_qualification_failed/);
      assert.equal(openCalls, size > 256 * 1024 * 1024 ? 0 : 1);
    });
});

test('digest refuses opened descriptor and final metadata drift and always closes', async (t) => {
  const changes = [
    [1, 'ino'],
    [1, 'dev'],
    [1, 'size'],
    [1, 'nlink'],
    [2, 'size'],
    [2, 'mtimeMs'],
    [2, 'ctimeMs'],
    [2, 'nlink'],
  ];
  for (const [at, field] of changes)
    await t.test(`fstat ${at} ${field}`, (sub) => {
      const { file } = digestFixture(sub);
      const fstat = fs.fstatSync;
      const close = fs.closeSync;
      let calls = 0;
      let closed = 0;
      sub.mock.method(fs, 'fstatSync', function (...args) {
        const stat = Reflect.apply(fstat, this, args);
        // Windows inode numbers may exceed Number.MAX_SAFE_INTEGER; adding one
        // can round back to the same value instead of simulating a replacement.
        const changed = field === 'ino' ? (stat[field] === 0 ? 1 : 0) : stat[field] + 1;
        return ++calls === at ? changedStat(stat, { [field]: changed }) : stat;
      });
      sub.mock.method(fs, 'closeSync', function (...args) {
        closed++;
        return Reflect.apply(close, this, args);
      });
      assert.throws(() => digest(file), /nsis_encrypted_qualification_failed/);
      assert.equal(closed, 1);
    });
});

test('digest refuses replacement before open and linked paths after reading', async (t) => {
  for (const phase of ['before-open', 'postguard-junction', 'postguard-hardlink'])
    await t.test(phase, (sub) => {
      const fixture = digestFixture(sub);
      const file = path.join(fixture.root, 'lib/proxy/fixture.js');
      const open = fs.openSync;
      const close = fs.closeSync;
      if (phase === 'before-open') {
        let replaced = false;
        sub.mock.method(fs, 'openSync', function (name, ...args) {
          if (name === file && !replaced) {
            replaced = true;
            fs.renameSync(file, file + '.old');
            fs.writeFileSync(file, 'synthetic-artifact');
          }
          return Reflect.apply(open, this, [name, ...args]);
        });
      } else {
        sub.mock.method(fs, 'closeSync', function (...args) {
          const value = Reflect.apply(close, this, args);
          if (phase === 'postguard-hardlink')
            fs.linkSync(file, path.join(fixture.root, 'hardlink'));
          else {
            const old = path.join(fixture.root, 'lib');
            const moved = path.join(fixture.root, 'moved-lib');
            fs.renameSync(old, moved);
            fs.symlinkSync(moved, old, process.platform === 'win32' ? 'junction' : 'dir');
          }
          return value;
        });
      }
      assert.throws(() => digest(file), /nsis_encrypted_qualification_failed/);
    });
});

test('digest propagates path and descriptor I/O failures', async (t) => {
  for (const method of ['lstatSync', 'openSync', 'fstatSync', 'readSync'])
    await t.test(method, (sub) => {
      const { file } = digestFixture(sub);
      sub.mock.method(fs, method, () => {
        throw Object.assign(new Error('synthetic_digest_io_failure'), { code: 'EACCES' });
      });
      assert.throws(() => digest(file), { code: 'EACCES' });
    });
});

test('receipt comparison cannot extend expiry, replace key, IDs or erase budget', () => {
  const receipt = {
    budgetSha256: 'a'.repeat(64),
    callCount: 1,
    expiresAt: Date.now() + 86400000,
    keySha256: 'b'.repeat(64),
    originalSha256: 'c'.repeat(64),
    rootId: 'hbs_' + 'd'.repeat(32),
    sourceId: 'hce_' + 'e'.repeat(32),
  };
  assert.equal(compareReceipts(receipt, { ...receipt }), true);
  for (const key of Object.keys(receipt)) {
    const changed = {
      ...receipt,
      [key]: typeof receipt[key] === 'number' ? receipt[key] + 1 : 'f'.repeat(64),
    };
    assert.throws(() => compareReceipts(receipt, changed));
  }
  for (const invalid of [
    null,
    {},
    [],
    { ...receipt, private: 'hidden' },
    { ...receipt, expiresAt: Infinity },
    { ...receipt, callCount: -1 },
  ])
    assert.throws(() => compareReceipts(receipt, invalid));
});
test('native qualification counts actual DPAPI calls separately from ACL calls and refuses fallback', () => {
  const native = path.resolve('synthetic-native.exe');
  assert.equal(nativeKeyInvocation(native, ['--hpm-context-key-v1'], native), true);
  assert.equal(nativeKeyInvocation(native, ['--hpm-context-private-path-v1'], native), false);
  for (const args of [[], null, ['--unknown'], ['--hpm-context-key-v1', 'extra']])
    assert.throws(() => nativeKeyInvocation(native, args, native));
  assert.throws(() =>
    nativeKeyInvocation(path.resolve('powershell.exe'), ['--hpm-context-key-v1'], native)
  );
});
test('PowerShell sequence and artifact contracts run without installer or network execution', () => {
  const files = [
    'scripts/lib/nsis-lifecycle-runner.psm1',
    'scripts/qualify-nsis-lifecycle.ps1',
    'scripts/lib/nsis-encrypted-lifecycle.psm1',
    'scripts/lib/nsis-private-artifact.psm1',
    'test/fixtures/nsis-encrypted-lifecycle-mocks.ps1',
  ];
  {
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'foreach($file in ($env:HPM_AST_PATHS | ConvertFrom-Json)){$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile($file,[ref]$t,[ref]$e);if($e.Count){exit 1}}',
      ],
      {
        env: {
          ...process.env,
          HPM_AST_PATHS: JSON.stringify(files.map((file) => path.resolve(file))),
        },
        encoding: 'utf8',
      }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-File', 'test/fixtures/nsis-encrypted-lifecycle-mocks.ps1'],
    { encoding: 'utf8' }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /encryptedExpectedFailures=\d+; installerExecutions=0; networkRequests=0/
  );
});
test('hosted lane is explicit, read-only, fully gated and never uploads generated secrets', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/nsis-encrypted-lifecycle.test.js'
    )
  );
  const workflow = fs.readFileSync('.github/workflows/windows-encrypted-lifecycle.yml', 'utf8');
  assert.deepEqual(unpinnedActionReferences(workflow), []);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /npm ci --prefix plugins\/hpm-local-evidence --ignore-scripts/);
  assert.ok(
    workflow.indexOf('npm ci --prefix plugins/hpm-local-evidence --ignore-scripts') <
      workflow.indexOf('npm run verify')
  );
  assert.match(
    workflow,
    /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Candidate local evidence plugin dependencies failed\.'/
  );
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.ok(workflow.indexOf('npm run verify') < workflow.indexOf('tauri.js build'));
  assert.doesNotMatch(
    workflow,
    /continue-on-error|secrets\.|upload-artifact|contents: write|pull_request:|push:/
  );
  const driver = spawnSync(
    process.execPath,
    ['scripts/lib/nsis-installed-recovery-fixture.cjs', 'invalid'],
    { encoding: 'utf8' }
  );
  assert.equal(driver.status, 1);
  assert.equal(driver.stdout, '');
  assert.equal(driver.stderr, 'nsis_encrypted_qualification_failed\n');
});
