'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { resolveTestPython, parsePythonTestCount } = require('../lib/test-python-runtime');

test('Python discovery evidence requires a positive safe test count in its runner summary', () => {
  assert.equal(parsePythonTestCount('...\nRan 27 tests in 0.015s\n\nOK\n'), 27);
  assert.equal(parsePythonTestCount('Ran 1 test in 1s\r\n\r\nOK\r\n'), 1);
  for (const output of [
    undefined,
    null,
    false,
    27,
    {},
    [],
    '',
    'Ran 0 tests in 0.000s\nOK',
    'NO TESTS RAN',
    'Ran -1 tests in 0.001s',
    'Ran 9007199254740992 tests in 0.001s',
    'prefix Ran 1 test in 0.001s',
    'Ran 1 test in 0.001s suffix',
    'Ran 1 test in NaNs',
  ])
    assert.equal(parsePythonTestCount(output), 0);
});

function ownedDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith(prefix));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('Python selection covers Windows bundles, Unix launchers and conflicting aliases without host access', () => {
  const bundled =
    'C:\\owned\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
  assert.equal(
    resolveTestPython(
      { LOCALAPPDATA: 'C:\\owned\\AppData\\Local' },
      { platform: 'win32', isFile: (file) => file === bundled }
    ),
    bundled
  );
  assert.equal(resolveTestPython({}, { platform: 'linux', isFile: () => false }), 'python3');
  assert.equal(resolveTestPython({}, { platform: 'win32', isFile: () => false }), 'python');
  assert.equal(
    resolveTestPython(
      { LOCALAPPDATA: 'relative' },
      { platform: 'win32', isFile: () => assert.fail('relative lookup') }
    ),
    'python'
  );
  assert.throws(
    () =>
      resolveTestPython(
        { HPM_TEST_PYTHON: 'C:\\python.exe', hpm_test_python: 'C:\\other.exe' },
        { platform: 'win32', isFile: () => true }
      ),
    /environment_invalid/
  );
  for (const env of [null, [], false, 'invalid'])
    assert.throws(() => resolveTestPython(env), /environment_invalid/);
});

test('Actual isolated generic child executes Python tests through the same environment as the unit runner', (t) => {
  const root = ownedDirectory(t, 'hpm-python-child-');
  const env = createIsolatedTestEnv(process.env, root);
  // Independent runner: do not inherit the parent's binary test IPC context.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'helpers', 'python-runtime-child.cjs')],
    {
      cwd: path.resolve(__dirname, '..'),
      env,
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, 'Isolated generic Python regression failed');
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(evidence), ['pythonTests']);
  assert.ok(Number.isSafeInteger(evidence.pythonTests) && evidence.pythonTests > 0);
});

test('Python executable is resolved before home isolation and survives nested fixtures', (t) => {
  const root = ownedDirectory(t, 'hpm-python-env-');
  const python = path.join(
    root,
    'runtime with spaces',
    process.platform === 'win32' ? 'python.exe' : 'python'
  );
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, 'synthetic executable sentinel');
  const source = {
    HPM_TEST_PYTHON: python,
    LOCALAPPDATA: path.join(root, 'outside', 'AppData', 'Local'),
  };
  const first = createIsolatedTestEnv(source, path.join(root, 'first'));
  const second = createIsolatedTestEnv(first, path.join(root, 'second'));
  assert.equal(first.HPM_TEST_PYTHON, python);
  assert.equal(second.HPM_TEST_PYTHON, python);
  assert.notEqual(second.LOCALAPPDATA, source.LOCALAPPDATA);
  assert.equal(fs.readFileSync(python, 'utf8'), 'synthetic executable sentinel');
});

test('Bundled Python discovery uses the original environment before it is replaced', (t) => {
  const root = ownedDirectory(t, 'hpm-python-bundle-');
  const python = path.join(
    root,
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    'python.exe'
  );
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, 'synthetic executable sentinel');
  const base = { LOCALAPPDATA: path.join(root, 'AppData', 'Local') };
  const original = { ...base };
  const isolated = createIsolatedTestEnv(base, path.join(root, 'fixture'));
  assert.equal(isolated.HPM_TEST_PYTHON, process.platform === 'win32' ? python : undefined);
  assert.deepEqual(base, original);
});

test('Explicit malformed, missing or directory Python paths fail instead of silently choosing a launcher', () => {
  for (const HPM_TEST_PYTHON of [
    '',
    false,
    12,
    'python --version',
    'PRIVATE\0',
    path.resolve('missing-python-executable'),
    os.tmpdir(),
  ])
    assert.throws(() => createIsolatedTestEnv({ HPM_TEST_PYTHON }, 'fixture'), /test_python_/);
});
