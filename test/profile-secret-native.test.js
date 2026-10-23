'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { protectProfileSecretNative } = require('../lib/proxy/profile-secret-native');
const bad = { message: 'secret_encryption_failed', code: 'ERR_SECRET_ENCRYPTION_FAILED' };
const cipher = Buffer.alloc(32, 7).toString('base64');
function fixture(mutation = () => {}) {
  const calls = [];
  const stats = [];
  const dependencies = {
    platform: 'win32',
    filesystem: {
      lstatSync(file) {
        stats.push(file);
        const executable = file.endsWith('.exe');
        const stat = {
          isFile: () => executable,
          isDirectory: () => !executable,
          isSymbolicLink: () => false,
          nlink: 1,
        };
        mutation('stat', stat, file);
        return stat;
      },
    },
    execute(file, args, options) {
      calls.push({ file, args, options });
      const reply = { text: JSON.stringify({ ok: true, value: cipher }) };
      mutation('execute', reply);
      return reply.text;
    },
  };
  return { calls, stats, dependencies };
}
test('native profile protection uses fixed executable and stdin only with bounded private pipes', () => {
  for (const plain of ['profile-🙂', 'x'.repeat(4096)]) {
    const f = fixture();
    assert.equal(protectProfileSecretNative(plain, f.dependencies), cipher);
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(
      call.file,
      path.resolve(__dirname, '../runtime/native/hpm-context-recovery-key.exe')
    );
    assert.deepEqual(call.args, ['--hpm-profile-secret-v1']);
    assert.equal(JSON.stringify(call.args).includes(plain), false);
    const request = JSON.parse(call.options.input);
    assert.deepEqual(Object.keys(request), ['operation', 'value']);
    assert.equal(request.operation, 'protect');
    assert.equal(Buffer.from(request.value, 'base64').toString('utf16le'), plain);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 10000);
    assert.equal(call.options.maxBuffer, 24000);
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(f.stats.at(-1), path.parse(call.file).root);
  }
});
test('native profile protection preserves source-only and non-Windows compatibility without execution', () => {
  const f = fixture();
  f.dependencies.platform = 'linux';
  assert.equal(protectProfileSecretNative('profile', f.dependencies), null);
  assert.equal(f.stats.length, 0);
  f.dependencies.platform = 'win32';
  f.dependencies.filesystem.lstatSync = () => {
    throw Object.assign(new Error('private'), { code: 'ENOENT' });
  };
  assert.equal(protectProfileSecretNative('profile', f.dependencies), null);
  assert.equal(f.calls.length, 0);
});
test('native profile protection rejects malformed, oversized and ambiguous replies', () => {
  for (const text of [
    undefined,
    {},
    '',
    'PRIVATE_REPLY',
    'x'.repeat(24001),
    'null',
    '[]',
    '{"ok":false}',
    JSON.stringify({ ok: true, value: cipher, extra: true }),
    '{"ok":false,"ok":true,"value":"' + cipher + '"}',
    JSON.stringify({ ok: true, value: '!!!' }),
    JSON.stringify({ ok: true, value: 'YQ==' }),
    JSON.stringify({ ok: true, value: cipher + '\n' }),
    JSON.stringify({ ok: 1, value: cipher }),
    JSON.stringify({ ok: true, value: Buffer.alloc(16385).toString('base64') }),
  ]) {
    const f = fixture((at, reply) => {
      if (at === 'execute') reply.text = text;
    });
    assert.throws(() => protectProfileSecretNative('profile', f.dependencies), bad);
    assert.equal(f.calls.length, 1);
  }
});
test('native profile protection rejects unsafe physical metadata and sanitizes process failures', () => {
  for (const change of [
    (stat, file) => {
      if (file.endsWith('.exe')) stat.nlink = 2;
    },
    (stat) => {
      stat.isSymbolicLink = () => true;
    },
    (stat, file) => {
      if (file.endsWith('.exe')) stat.isFile = () => false;
    },
    (stat, file) => {
      if (!file.endsWith('.exe')) stat.isDirectory = () => false;
    },
  ]) {
    const f = fixture((at, stat, file) => {
      if (at === 'stat') change(stat, file);
    });
    assert.throws(() => protectProfileSecretNative('profile', f.dependencies), bad);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.dependencies.execute = () => {
    throw new Error('PRIVATE_PROCESS_SENTINEL');
  };
  assert.throws(() => protectProfileSecretNative('profile', f.dependencies), bad);
  const denied = fixture();
  denied.dependencies.filesystem.lstatSync = () => {
    throw Object.assign(new Error('PRIVATE_PATH'), { code: 'EACCES' });
  };
  assert.throws(() => protectProfileSecretNative('profile', denied.dependencies), bad);
});
test('native profile protection rejects invalid input and executable dependency boundaries before traps', () => {
  let traps = 0;
  for (const value of [null, undefined, 0, {}, '', 'x'.repeat(4097)]) {
    const f = fixture();
    assert.throws(() => protectProfileSecretNative(value, f.dependencies), bad);
    assert.equal(f.stats.length, 0);
    assert.equal(f.calls.length, 0);
  }
  for (const dependencies of [
    null,
    [],
    { platform: null },
    { extra: true },
    {
      get platform() {
        traps++;
        return 'win32';
      },
    },
    new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          return [];
        },
      }
    ),
    { platform: 'win32', filesystem: null },
    { platform: 'win32', execute: null },
    {
      platform: 'win32',
      filesystem: {
        get lstatSync() {
          traps++;
          return () => {};
        },
      },
    },
  ])
    assert.throws(() => protectProfileSecretNative('profile', dependencies), bad);
  assert.equal(traps, 0);
  const f = fixture();
  f.dependencies.filesystem.lstatSync = () => {
    throw {
      get code() {
        traps++;
        return 'ENOENT';
      },
    };
  };
  assert.throws(() => protectProfileSecretNative('profile', f.dependencies), bad);
  assert.equal(traps, 0);
});
