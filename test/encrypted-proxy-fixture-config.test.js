'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const {
  prepareEncryptedProxyFixtureConfig: prepare,
} = require('./helpers/encrypted-proxy-fixture-config.cjs');
const safe = (error) =>
  error.message === 'encrypted_proxy_fixture_preparation_failed' && error.cause === undefined;

test(
  'fixture preparation and strict decrypt share an isolated user/key domain without parent crypto state',
  { timeout: 60000 },
  (t) => {
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-config-domain-')
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const base = {};
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'])
      if (typeof process.env[name] === 'string') base[name] = process.env[name];
    const env = createIsolatedTestEnv(base, root);
    fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
    prepare(
      {
        profiles: [{ apiKey: 'synthetic-upstream' }],
        entryAuth: { keys: [{ key: 'synthetic-entry' }] },
      },
      env
    );
    const config = JSON.parse(
      fs.readFileSync(path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'), 'utf8')
    );
    assert.match(config.profiles[0].apiKey, /^hpm-(dpapi|aes-v2):/);
    assert.match(config.entryAuth.keys[0].key, /^hpm-(dpapi|aes-v2):/);
    const code =
      "const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const c=JSON.parse(fs.readFileSync(path.join(process.env.PROXY_CONFIG_DIR,'proxy.config.json')));const s=require(process.argv[1]);assert.deepEqual(s.decryptKeysStrict([c.profiles[0].apiKey,c.entryAuth.keys[0].key]),['synthetic-upstream','synthetic-entry']);process.stdout.write('isolated_fixture_decrypt_verified');";
    const result = spawnSync(
      process.execPath,
      ['-e', code, path.resolve(__dirname, '../lib/proxy/secret-crypto.js')],
      { env, encoding: 'utf8', timeout: 30000, maxBuffer: 65536, shell: false, windowsHide: true }
    );
    assert.equal(result.status, 0, 'strict fixture decryption must succeed in its own domain');
    assert.equal(result.stdout, 'isolated_fixture_decrypt_verified');
  }
);

test('preparation pins the given environment, fixed shell-free command and bounded stdin', () => {
  const env = { PROXY_CONFIG_DIR: path.resolve('synthetic-config'), SystemRoot: 'C:\\Windows' };
  let calls = 0;
  prepare({}, env, (file, args, options) => {
    calls++;
    assert.equal(file, process.execPath);
    assert.equal(args[0], '-e');
    assert.deepEqual({ ...options.env }, env);
    assert.equal(options.input, '{}');
    assert.equal(options.timeout, 30000);
    assert.equal(options.maxBuffer, 65536);
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    return { status: 0, signal: null };
  });
  assert.equal(calls, 1);
});

test('empty, hostile, illegal and oversized fixture input rejects before any child or accessor executes', () => {
  let hooks = 0;
  const execute = () => {
    hooks++;
    return { status: 0 };
  };
  const env = { PROXY_CONFIG_DIR: path.resolve('synthetic-config') };
  const getter = Object.defineProperty({}, 'profiles', {
    enumerable: true,
    get() {
      hooks++;
      return [];
    },
  });
  for (const value of [
    null,
    [],
    false,
    '',
    getter,
    new Proxy(
      {},
      {
        ownKeys() {
          hooks++;
        },
      }
    ),
    { padding: 'x'.repeat(65537) },
  ])
    assert.throws(() => prepare(value, env, execute), safe);
  for (const value of [
    null,
    {},
    [],
    { PROXY_CONFIG_DIR: 'relative' },
    { ...env, OTHER: 42 },
    new Proxy(
      {},
      {
        getPrototypeOf() {
          hooks++;
        },
      }
    ),
  ])
    assert.throws(() => prepare({}, value, execute), safe);
  assert.equal(hooks, 0);
});

test('failed preparation never forwards stdout, stderr, secrets or original exceptions', () => {
  const env = { PROXY_CONFIG_DIR: path.resolve('synthetic-config') };
  for (const execute of [
    () => {
      throw Error('PRIVATE');
    },
    () => ({ status: 1, stderr: 'PRIVATE' }),
    () => ({ status: 0, error: Error('PRIVATE') }),
    () => ({ status: null, signal: 'SIGTERM' }),
    () => null,
  ])
    assert.throws(() => prepare({}, env, execute), safe);
});
