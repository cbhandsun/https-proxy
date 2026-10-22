'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const { discoverTestFiles } = require('../lib/test-discovery');
const {
  RUNTIME_BOUNDARY_CASES,
  parseRuntimeBoundaryArguments,
  verifyRuntimeBoundaryInstallation,
  parseRuntimeBoundaryReceipt,
} = require('../scripts/lib/nsis-runtime-boundary-contract');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const safe = (error) => {
  assert.equal(error.message, 'nsis_runtime_boundary_contract_failed');
  assert.equal(error.cause, undefined);
  assert.equal(error.code, undefined);
  return true;
};
function fixture(t) {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-boundary-contract-'));
  const install = path.join(owned, 'installed');
  const caseRoot = path.join(owned, 'case');
  fs.mkdirSync(caseRoot);
  for (const directory of ['lib/proxy', 'runtime/node', 'runtime/native'])
    fs.mkdirSync(path.join(install, directory), { recursive: true });
  const contents = 'synthetic-identity-only-never-executed';
  for (const file of [
    'lib/proxy/fixture.js',
    'runtime/node/node.exe',
    'runtime/native/hpm-context-recovery-key.exe',
    'package-lock.json',
  ])
    fs.writeFileSync(path.join(install, file), contents);
  const manifest = {
    schemaVersion: 2,
    sourceSha256: { 'lib/proxy/fixture.js': sha256(contents) },
    nodeSha256: sha256(contents),
    contextRecoveryNativeSha256: sha256(contents),
    packageLockSha256: sha256(contents),
  };
  const manifestPath = path.join(install, 'release-runtime-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
  const args = (caseId = 'settings-matrix') => [
    caseId,
    install,
    caseRoot,
    sha256(fs.readFileSync(manifestPath)),
  ];
  return { owned, install, caseRoot, manifestPath, args };
}
const receipt = () => ({
  schemaVersion: 1,
  caseId: 'settings-matrix',
  manifestSha256: 'a'.repeat(64),
  status: 'not_run',
  code: 'not_implemented',
});

function instrumentedBoundary() {
  const calls = { serial: 0, parallel: 0 };
  let reject = false;
  const verify = (name) => (install, manifestSha256) => {
    calls[name]++;
    if (reject) throw Error('PRIVATE_VERIFIER_ERROR');
    return { manifestSha256, sourceCount: 1, node: path.join(install, 'runtime/node/node.exe') };
  };
  const target = { exports: {} };
  vm.compileFunction(fs.readFileSync('scripts/lib/nsis-runtime-boundary-contract.js', 'utf8'), [
    'require',
    'module',
  ])((name) => {
    if (name === './nsis-encrypted-contract')
      return {
        safePath: require('../scripts/lib/nsis-encrypted-contract').safePath,
        verifyInstallation: verify('serial'),
      };
    if (name === './nsis-installation-parallel')
      return { verifyInstallationParallel: verify('parallel') };
    return require(name);
  }, target);
  return {
    api: target.exports,
    calls,
    reject: () => {
      reject = true;
    },
  };
}

test('lightweight: public serial and parallel APIs fix their validators and sanitize failures', (t) => {
  const f = fixture(t);
  const input = parseRuntimeBoundaryArguments(f.args());
  const target = instrumentedBoundary();
  const forbidden = () => assert.fail('external validator must not be accepted');
  target.api.verifyRuntimeBoundaryInstallation(input, f.owned, forbidden);
  assert.deepEqual(target.calls, { serial: 1, parallel: 0 });
  const verified = target.api.verifyRuntimeBoundaryInstallationParallel(input, f.owned, forbidden);
  assert.deepEqual(target.calls, { serial: 1, parallel: 1 });
  assert.equal(verified.install, f.install);
  assert.equal(verified.caseRoot, f.caseRoot);
  assert.equal(Object.isFrozen(verified), true);
  target.reject();
  assert.throws(() => target.api.verifyRuntimeBoundaryInstallationParallel(input, f.owned), safe);
  assert.deepEqual(target.calls, { serial: 1, parallel: 2 });
});

test('lightweight: fixed parallel API keeps original request, ownership, overlap and physical path guards', (t) => {
  const f = fixture(t);
  const input = parseRuntimeBoundaryArguments(f.args());
  const target = instrumentedBoundary();
  const verify = target.api.verifyRuntimeBoundaryInstallationParallel;
  for (const bad of [
    null,
    {},
    { ...input, private: 'PRIVATE' },
    { ...input, caseId: '../script' },
    { ...input, manifestSha256: '' },
    { ...input, install: 'relative' },
    { ...input, caseRoot: f.owned },
    { ...input, caseRoot: f.install },
    { ...input, caseRoot: path.join(f.install, 'runtime') },
    { ...input, install: f.owned },
    { ...input, caseRoot: os.tmpdir() },
    { ...input, caseRoot: path.join(f.owned, 'missing') },
  ])
    assert.throws(() => verify(bad, f.owned), safe);
  for (const owner of [undefined, '', f.install, f.caseRoot])
    assert.throws(() => verify(input, owner), safe);
  let accesses = 0;
  const hostile = { ...input };
  Object.defineProperty(hostile, 'install', {
    enumerable: true,
    get() {
      accesses++;
      throw Error('PRIVATE');
    },
  });
  assert.throws(() => verify(hostile, f.owned), safe);
  assert.throws(
    () =>
      verify(
        new Proxy(input, {
          ownKeys() {
            accesses++;
            throw Error('PRIVATE');
          },
        }),
        f.owned
      ),
    safe
  );
  assert.equal(accesses, 0);
  const alias = path.join(f.owned, 'alias');
  fs.symlinkSync(f.caseRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verify({ ...input, caseRoot: alias }, f.owned), safe);
  const installAlias = path.join(f.owned, 'install-alias');
  fs.symlinkSync(f.install, installAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verify({ ...input, install: installAlias }, f.owned), safe);
  assert.deepEqual(target.calls, { serial: 0, parallel: 0 });
});

test('fixed cases and primitive CLI parse do not execute or inspect installation', (t) => {
  const f = fixture(t);
  assert.equal(Object.isFrozen(RUNTIME_BOUNDARY_CASES), true);
  assert.deepEqual(RUNTIME_BOUNDARY_CASES, [
    'defaults-migration',
    'settings-matrix',
    'switch-revoke',
    'reopen-clear',
    'initialization-failure',
    'kill-after-durable-ack',
  ]);
  for (const caseId of RUNTIME_BOUNDARY_CASES) {
    const parsed = parseRuntimeBoundaryArguments(f.args(caseId));
    assert.deepEqual(parsed, {
      caseId,
      install: f.install,
      caseRoot: f.caseRoot,
      manifestSha256: f.args()[3],
    });
    assert.equal(Object.isFrozen(parsed), true);
  }
  const missing = path.join(f.owned, 'does-not-exist');
  assert.equal(
    parseRuntimeBoundaryArguments(['settings-matrix', missing, f.caseRoot, 'a'.repeat(64)]).install,
    missing
  );
});

test('CLI rejects empty, malformed, arbitrary script/PID and extreme inputs safely', (t) => {
  const f = fixture(t);
  const invalid = [
    undefined,
    null,
    {},
    [],
    f.args().slice(0, 3),
    [...f.args(), 'extra'],
    ['../arbitrary.cjs', ...f.args().slice(1)],
    ['12345', ...f.args().slice(1)],
    ['settings-matrix\u2028', ...f.args().slice(1)],
    ['x'.repeat(4097), ...f.args().slice(1)],
    ['settings-matrix', '', f.caseRoot, f.args()[3]],
    ['settings-matrix', 'relative', f.caseRoot, f.args()[3]],
    ['settings-matrix', '\\drive-root-without-drive', f.caseRoot, f.args()[3]],
    ['settings-matrix', f.install + 'é'.repeat(2048), f.caseRoot, f.args()[3]],
    [
      'settings-matrix',
      path.join(f.install, '..', 'installed') + path.sep + '..',
      f.caseRoot,
      f.args()[3],
    ],
    ['settings-matrix', f.install + path.sep + '.' + path.sep, f.caseRoot, f.args()[3]],
    ['settings-matrix', f.install + '\0private', f.caseRoot, f.args()[3]],
    ['settings-matrix', f.install + '\nprivate', f.caseRoot, f.args()[3]],
    ['settings-matrix', f.install + ':secret', f.caseRoot, f.args()[3]],
    ['settings-matrix', '\\\\server\\share', f.caseRoot, f.args()[3]],
    ['settings-matrix', '\\\\?\\C:\\private', f.caseRoot, f.args()[3]],
    ['settings-matrix', f.install + '\ud800', f.caseRoot, f.args()[3]],
    ['settings-matrix', f.install, f.caseRoot, 'A'.repeat(64)],
    ['settings-matrix', f.install, f.caseRoot, 'a'.repeat(64) + '\n'],
    ['settings-matrix', f.install, f.caseRoot, 'a'.repeat(65)],
    [
      'settings-matrix',
      f.install,
      f.caseRoot,
      {
        toString() {
          throw Error('PRIVATE');
        },
      },
    ],
  ];
  for (const value of invalid) assert.throws(() => parseRuntimeBoundaryArguments(value), safe);
});

test('CLI and receipt reject getters, proxies, hidden/extra keys without executing them', (t) => {
  const f = fixture(t);
  let executed = 0;
  const args = f.args();
  Object.defineProperty(args, '0', {
    get() {
      executed++;
      throw Error('PRIVATE');
    },
  });
  assert.throws(() => parseRuntimeBoundaryArguments(args), safe);
  const extra = f.args();
  Object.defineProperty(extra, 'extra', { value: 'PRIVATE' });
  assert.throws(() => parseRuntimeBoundaryArguments(extra), safe);
  const proxy = new Proxy(f.args(), {
    ownKeys() {
      executed++;
      throw Error('PRIVATE');
    },
  });
  assert.throws(() => parseRuntimeBoundaryArguments(proxy), safe);
  const hidden = receipt();
  Object.defineProperty(hidden, 'private', { value: 'PRIVATE' });
  assert.throws(() => parseRuntimeBoundaryReceipt(hidden), safe);
  const accessor = receipt();
  Object.defineProperty(accessor, 'status', {
    enumerable: true,
    get() {
      executed++;
      throw Error('PRIVATE');
    },
  });
  assert.throws(() => parseRuntimeBoundaryReceipt(accessor), safe);
  assert.throws(
    () =>
      parseRuntimeBoundaryReceipt(
        new Proxy(receipt(), {
          ownKeys() {
            executed++;
            throw Error('PRIVATE');
          },
        })
      ),
    safe
  );
  assert.equal(executed, 0);
});

test('installation verification authenticates all declared bytes and returns no case success', (t) => {
  const f = fixture(t);
  const parsed = parseRuntimeBoundaryArguments(f.args());
  const verified = verifyRuntimeBoundaryInstallation(parsed, f.owned);
  assert.equal(verified.caseId, parsed.caseId);
  assert.equal(verified.sourceCount, 1);
  assert.equal(verified.manifestSha256, parsed.manifestSha256);
  assert.equal(verified.node, path.join(f.install, 'runtime/node/node.exe'));
  assert.equal(
    verified.native,
    path.join(f.install, 'runtime/native/hpm-context-recovery-key.exe')
  );
  assert.equal(verified.caseRoot, f.caseRoot);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.hasOwn(verified, 'passed'), false);
  assert.equal(Object.hasOwn(verified, 'status'), false);
  fs.writeFileSync(path.join(f.install, 'lib/proxy/fixture.js'), 'changed');
  assert.throws(() => verifyRuntimeBoundaryInstallation(parsed, f.owned), safe);
});

test('installation verifier rejects missing identity, foreign root, overlap and forged records', (t) => {
  const f = fixture(t);
  const parsed = parseRuntimeBoundaryArguments(f.args());
  for (const value of [
    { ...parsed, manifestSha256: 'b'.repeat(64) },
    { ...parsed, caseRoot: f.owned },
    { ...parsed, caseRoot: f.install },
    { ...parsed, caseRoot: path.join(f.install, 'runtime') },
    { ...parsed, install: f.owned },
    { ...parsed, caseRoot: os.tmpdir() },
    { ...parsed, caseRoot: path.join(f.owned, 'missing') },
    { ...parsed, pid: 12345 },
    { ...parsed, caseId: '../script.cjs' },
  ])
    assert.throws(() => verifyRuntimeBoundaryInstallation(value, f.owned), safe);
  assert.throws(() => verifyRuntimeBoundaryInstallation(parsed), safe);
  fs.unlinkSync(f.manifestPath);
  assert.throws(() => verifyRuntimeBoundaryInstallation(parsed, f.owned), safe);
});

test('installation verifier rejects actual hardlinked file and directory junction', (t) => {
  const f = fixture(t);
  const parsed = parseRuntimeBoundaryArguments(f.args());
  const file = path.join(f.install, 'lib/proxy/fixture.js');
  fs.linkSync(file, path.join(f.owned, 'hardlink'));
  assert.throws(() => verifyRuntimeBoundaryInstallation(parsed, f.owned), safe);
  fs.unlinkSync(path.join(f.owned, 'hardlink'));
  const junction = path.join(f.owned, 'alias');
  fs.symlinkSync(f.caseRoot, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => verifyRuntimeBoundaryInstallation({ ...parsed, caseRoot: junction }, f.owned),
    safe
  );
});

test('safe receipts support only unimplemented/failure and never manufacture pass', () => {
  assert.deepEqual(parseRuntimeBoundaryReceipt(receipt()), receipt());
  assert.equal(Object.isFrozen(parseRuntimeBoundaryReceipt(receipt())), true);
  for (const code of ['input_rejected', 'identity_mismatch', 'boundary_failed', 'timeout']) {
    const value = { ...receipt(), status: 'failed', code };
    assert.deepEqual(parseRuntimeBoundaryReceipt(value), value);
  }
  for (const value of [
    undefined,
    null,
    {},
    [],
    { ...receipt(), status: 'passed' },
    { ...receipt(), status: 'success' },
    { ...receipt(), status: 'failed' },
    { ...receipt(), code: 'PRIVATE raw error' },
    { ...receipt(), schemaVersion: '1' },
    { ...receipt(), schemaVersion: 2 },
    { ...receipt(), caseId: '../script.cjs' },
    { ...receipt(), manifestSha256: 'x'.repeat(64) },
    { ...receipt(), token: 'PRIVATE' },
    { ...receipt(), passed: true },
    { ...receipt(), error: new Error('PRIVATE') },
    { ...receipt(), pid: 12345 },
  ])
    assert.throws(() => parseRuntimeBoundaryReceipt(value), safe);
});

test('boundary tests are included in unified test discovery', () => {
  const root = path.resolve(__dirname, '..');
  assert.ok(discoverTestFiles(root).includes('test/nsis-runtime-boundaries.test.js'));
});
