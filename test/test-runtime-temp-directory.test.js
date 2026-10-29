'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolvePhysicalTestTempDirectory, createIsolatedTestEnv } = require('../lib/test-runtime');
const { discoverTestFiles } = require('../lib/test-discovery');

const refused = { name: 'Error', message: 'test_temporary_directory_unavailable' };

function fixture(t) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'hpm-physical-temp-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('hpm-physical-temp-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const physical = path.join(root, 'physical');
  fs.mkdirSync(physical);
  return { root, physical };
}

test('physical test temporary directory resolves existing directories and owned aliases', (t) => {
  const { root, physical } = fixture(t);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolvePhysicalTestTempDirectory(physical), fs.realpathSync.native(physical));
  assert.equal(resolvePhysicalTestTempDirectory(alias), fs.realpathSync.native(physical));
  assert.equal(resolvePhysicalTestTempDirectory(), fs.realpathSync.native(os.tmpdir()));
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
});

test('physical test temporary directory rejects empty, malformed, extreme, missing and non-directory inputs safely', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'fixture');
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error('PRIVATE_INPUT');
      },
    }
  );
  for (const input of [
    '',
    '   ',
    null,
    false,
    1,
    [],
    {},
    hostile,
    () => {},
    'relative',
    'bad\0PRIVATE_INPUT',
    'bad\nPRIVATE_INPUT',
    'bad\rPRIVATE_INPUT',
    'x'.repeat(32769),
    path.join(root, 'missing'),
    file,
  ])
    assert.throws(() => resolvePhysicalTestTempDirectory(input), refused);
  assert.equal(traps, 0);
  assert.equal(fs.readdirSync(root).includes('missing'), false);
});

test('physical temporary directory I/O failure exposes only a fixed error', (t) => {
  const { physical } = fixture(t);
  const mocked = t.mock.method(fs.realpathSync, 'native', () => {
    throw new Error('PRIVATE_FILESYSTEM_PATH');
  });
  try {
    assert.throws(() => resolvePhysicalTestTempDirectory(physical), refused);
  } finally {
    mocked.mock.restore();
  }
});

test('isolated child environment canonicalizes existing temp aliases and removes case variants without parent mutation', (t) => {
  const { root, physical } = fixture(t);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const base = {
    ...process.env,
    TEMP: alias,
    TMP: alias,
    TMPDIR: alias,
    Temp: 'PRIVATE_UNUSED_CASE_ALIAS',
    tmp: 'PRIVATE_UNUSED_CASE_ALIAS',
    TmpDir: 'PRIVATE_UNUSED_CASE_ALIAS',
  };
  const before = { ...base };
  const env = createIsolatedTestEnv(base, path.join(root, 'workspace'));
  const canonical = fs.realpathSync.native(physical);
  assert.deepEqual(base, before);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(env[key], canonical);
  for (const key of ['Temp', 'tmp', 'TmpDir']) assert.equal(Object.hasOwn(env, key), false);
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      'const fs=require("node:fs"),os=require("node:os");process.stdout.write(JSON.stringify({tmp:os.tmpdir(),physical:fs.realpathSync.native(os.tmpdir())}));',
    ],
    { env, encoding: 'utf8', timeout: 10000, windowsHide: true }
  );
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), { tmp: canonical, physical: canonical });
});

test('isolated temp environment supports mixed-case-only keys, default existing temp and rejects invalid selected paths', (t) => {
  const { root, physical } = fixture(t);
  const env = createIsolatedTestEnv({ Temp: physical, Tmp: physical, TmpDir: physical }, root);
  for (const key of ['TEMP', 'TMP', 'TMPDIR'])
    assert.equal(env[key], fs.realpathSync.native(physical));
  for (const key of ['Temp', 'Tmp', 'TmpDir']) assert.equal(Object.hasOwn(env, key), false);
  const empty = createIsolatedTestEnv({}, root);
  for (const key of ['TEMP', 'TMP', 'TMPDIR'])
    assert.equal(empty[key], fs.realpathSync.native(os.tmpdir()));
  for (const value of ['', null, 3, 'relative', path.join(root, 'missing')])
    assert.throws(
      () => createIsolatedTestEnv({ TEMP: value, TMP: value, TMPDIR: value }, root),
      refused
    );
});

test('physical temp regression participates in unified test discovery', () => {
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/test-runtime-temp-directory.test.js'
    )
  );
});
