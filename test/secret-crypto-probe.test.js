'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const file = path.resolve(__dirname, '../lib/proxy/secret-crypto.js');
const source = fs.readFileSync(file, 'utf8');
const localRequire = createRequire(file);
const probePlaintext = Buffer.from('hpm-dpapi-probe', 'utf16le').toString('base64');

function cryptoFixture(
  responses,
  platform = 'win32',
  nativeProtect = () => null,
  nativeUnprotect = () => null
) {
  const module = { exports: {} };
  let calls = 0;
  const diagnostics = [];
  let time = 0;
  const context = {
    module,
    exports: module.exports,
    Buffer,
    process: {
      platform,
      env: { HPM_MASTER_KEY_BASE64: Buffer.alloc(32, 17).toString('base64') },
    },
    require(name) {
      if (name === './profile-secret-native')
        return {
          protectProfileSecretNative: nativeProtect,
          unprotectProfileSecretsNative: nativeUnprotect,
        };
      if (name === 'node:perf_hooks') return { performance: { now: () => time } };
      if (name === 'child_process')
        return {
          execFileSync() {
            const result = responses[calls++];
            if (result instanceof Error) throw result;
            return result;
          },
        };
      if (name === './logger')
        return {
          createLogger: () => ({
            warn: (...values) => diagnostics.push(values),
            error: (...values) => diagnostics.push(values),
          }),
        };
      if (name === './secure-files')
        return {
          ensurePrivateDirectorySync: () => assert.fail('probe must not create a directory'),
          ensurePrivateFileSync: () => assert.fail('probe must not open a key file'),
        };
      return localRequire(name);
    },
  };
  vm.runInNewContext(source, context, { filename: file });
  return {
    crypto: module.exports,
    calls: () => calls,
    diagnostics,
    advance: (elapsed) => {
      time += elapsed;
    },
  };
}

test('packaged config decryption uses one native batch without PowerShell and preserves cache ownership', () => {
  let nativeCalls = 0;
  const wrapped = Buffer.alloc(32, 7).toString('base64');
  const f = cryptoFixture([], 'win32', undefined, (values, options) => {
    nativeCalls++;
    assert.deepEqual([...values], [wrapped]);
    assert.equal(options.platform, 'win32');
    return ['profile-private-🙂'];
  });
  const encrypted = f.crypto.DPAPI_PREFIX + wrapped;
  assert.deepEqual(
    [...f.crypto.decryptKeysStrict([encrypted, encrypted])],
    ['profile-private-🙂', 'profile-private-🙂']
  );
  assert.equal(f.crypto.decryptKey(encrypted), 'profile-private-🙂');
  assert.equal(nativeCalls, 1);
  assert.equal(f.calls(), 0);
  assert.equal(f.diagnostics.length, 0);
});

test('native batch decryption failure is terminal without compatibility retry or plaintext disclosure', () => {
  let nativeCalls = 0;
  const f = cryptoFixture([], 'win32', undefined, () => {
    nativeCalls++;
    throw new Error('PRIVATE_NATIVE_SENTINEL');
  });
  assert.throws(
    () => f.crypto.decryptKeysStrict([f.crypto.DPAPI_PREFIX + Buffer.alloc(32).toString('base64')]),
    {
      message: 'Failed to decrypt protected configuration secrets',
      code: 'ERR_SECRET_DECRYPTION_FAILED',
    }
  );
  assert.equal(nativeCalls, 1);
  assert.equal(f.calls(), 0);
  assert.equal(f.diagnostics.length, 0);
});

test('packaged profile encryption uses native CurrentUser roundtrip without PowerShell probes', () => {
  let nativeCalls = 0;
  const f = cryptoFixture([], 'win32', (value, options) => {
    nativeCalls++;
    assert.equal(value, 'profile-native-🙂');
    assert.equal(options.platform, 'win32');
    assert.equal(typeof options.execute, 'function');
    return Buffer.alloc(32, 7).toString('base64');
  });
  assert.equal(
    f.crypto.encryptKey('profile-native-🙂'),
    f.crypto.DPAPI_PREFIX + Buffer.alloc(32, 7).toString('base64')
  );
  assert.equal(nativeCalls, 1);
  assert.equal(f.calls(), 0);
  assert.equal(f.crypto.getCryptoBackend().prefersDpapi, true);
});

test('native encryption failure is fixed and cannot silently downgrade to compatibility crypto', () => {
  const f = cryptoFixture([], 'win32', () => {
    throw new Error('PRIVATE_NATIVE_SENTINEL');
  });
  assert.throws(() => f.crypto.encryptKey('profile-native'), {
    message: 'secret_encryption_failed',
    code: 'ERR_SECRET_ENCRYPTION_FAILED',
  });
  assert.equal(f.calls(), 0);
});

test('large legacy secrets retain compatibility encryption without native protocol truncation', () => {
  const f = cryptoFixture(['cHJvdGVjdGVk', probePlaintext, 'Y2lwaGVy'], 'win32', () => {
    assert.fail('legacy secret exceeds the bounded native profile protocol');
  });
  assert.equal(f.crypto.encryptKey('x'.repeat(4097)), f.crypto.DPAPI_PREFIX + 'Y2lwaGVy');
  assert.equal(f.calls(), 3);
});

for (const [name, response] of [
  [
    'process timeout',
    Object.assign(new Error('synthetic-private-error-marker'), { code: 'ETIMEDOUT' }),
  ],
  ['empty output', ''],
  ['whitespace output', ' \r\n\t'],
  ['missing output', undefined],
  ['invalid output type', {}],
])
  test(`DPAPI probe stops after failed protection: ${name}`, () => {
    const f = cryptoFixture([response, probePlaintext]);
    assert.equal(f.crypto._dpapiProbe(), false);
    assert.equal(f.calls(), 1, 'failed protection must not launch an unprotect process');
    assert.equal(f.crypto.getCryptoBackend().prefersDpapi, false);
    assert.ok(!JSON.stringify(f.diagnostics).includes('synthetic-private-error-marker'));
    assert.ok(
      !JSON.stringify(f.crypto.getCryptoBackend()).includes('synthetic-private-error-marker')
    );
  });

test('DPAPI probe retains successful roundtrip validation and successful probe cache', () => {
  const f = cryptoFixture(['cHJvdGVjdGVk', probePlaintext]);
  assert.equal(f.crypto._dpapiProbe(), true);
  assert.equal(f.calls(), 2);
  assert.equal(f.crypto._dpapiProbe(), true);
  assert.equal(f.calls(), 2);
});

test('DPAPI probe rejects failed, mismatched and malformed unprotect output', () => {
  for (const response of [
    undefined,
    '',
    '!!!',
    Buffer.from('different', 'utf16le').toString('base64'),
    new Error('synthetic-private-error-marker'),
  ]) {
    const f = cryptoFixture(['cHJvdGVjdGVk', response]);
    assert.equal(f.crypto._dpapiProbe(), false);
    assert.equal(f.calls(), 2);
    assert.equal(f.crypto.getCryptoBackend().prefersDpapi, false);
  }
});

test('failed protection retains encrypted AES fallback and exact strict decryption', () => {
  const f = cryptoFixture([new Error('synthetic-private-error-marker')]);
  const plaintext = 'synthetic-probe-fallback-🙂';
  const encrypted = f.crypto.encryptKey(plaintext);
  assert.ok(encrypted.startsWith(f.crypto.AES_V2_PREFIX));
  assert.notEqual(encrypted, plaintext);
  assert.equal(f.crypto.decryptKeysStrict([encrypted])[0], plaintext);
  assert.equal(f.calls(), 1);
  assert.equal(f.crypto.encryptKey(encrypted), encrypted);
  assert.equal(f.calls(), 1);
});

test('DPAPI probe on other platforms performs no process invocation', () => {
  const f = cryptoFixture([], 'linux');
  assert.equal(f.crypto._dpapiProbe(), false);
  assert.equal(f.calls(), 0);
});

test('failed DPAPI probes cool down repeated encryption but retry at the monotonic deadline', () => {
  const f = cryptoFixture([
    new Error('synthetic-private-error-marker'),
    'cHJvdGVjdGVk',
    probePlaintext,
    'Y2lwaGVy',
  ]);
  const first = f.crypto.encryptKey('first-🙂');
  const second = f.crypto.encryptKey('second-🙂');
  assert.ok(first.startsWith(f.crypto.AES_V2_PREFIX));
  assert.ok(second.startsWith(f.crypto.AES_V2_PREFIX));
  assert.deepEqual([...f.crypto.decryptKeysStrict([first, second])], ['first-🙂', 'second-🙂']);
  assert.equal(f.calls(), 1);
  for (const value of ['', null, undefined, 123]) assert.equal(f.crypto.encryptKey(value), '');
  assert.equal(f.crypto.encryptKey(first), first);
  f.crypto.clearDecryptCache();
  f.advance(29999);
  assert.equal(f.crypto._dpapiProbe(), false);
  assert.equal(f.calls(), 1);
  f.advance(1);
  assert.equal(f.crypto.encryptKey('third'), f.crypto.DPAPI_PREFIX + 'Y2lwaGVy');
  assert.equal(f.calls(), 4);
  assert.equal(f.crypto.getCryptoBackend().prefersDpapi, true);
  assert.equal(f.crypto.getCryptoBackend().dpapiDisabledReason, null);
  assert.ok(!JSON.stringify(f.diagnostics).includes('synthetic-private-error-marker'));
});

test('failed DPAPI roundtrip and real protection renew the bounded probe cooldown', () => {
  for (const outputs of [
    ['cHJvdGVjdGVk', ''],
    ['cHJvdGVjdGVk', probePlaintext, ''],
  ]) {
    const f = cryptoFixture([...outputs, new Error('private'), 'cHJvdGVjdGVk', probePlaintext]);
    assert.ok(f.crypto.encryptKey('one').startsWith(f.crypto.AES_V2_PREFIX));
    assert.equal(f.calls(), outputs.length);
    assert.ok(f.crypto.encryptKey('two').startsWith(f.crypto.AES_V2_PREFIX));
    assert.equal(f.calls(), outputs.length);
    f.advance(30000);
    assert.equal(f.crypto._dpapiProbe(), false);
    assert.equal(f.calls(), outputs.length + 1);
    f.advance(29999);
    assert.equal(f.crypto._dpapiProbe(), false);
    assert.equal(f.calls(), outputs.length + 1);
    f.advance(1);
    assert.equal(f.crypto._dpapiProbe(), true);
    assert.equal(f.calls(), outputs.length + 3);
  }
});

test('probe cooldown never suppresses protected-secret decryption and successful decryption reopens DPAPI', () => {
  const plain = 'synthetic-decryption-🙂';
  const f = cryptoFixture([
    new Error('private'),
    new Error('private'),
    new Error('private'),
    JSON.stringify({ values: [Buffer.from(plain, 'utf16le').toString('base64')] }),
  ]);
  assert.equal(f.crypto._dpapiProbe(), false);
  assert.equal(f.crypto.decryptKeysStrict([f.crypto.DPAPI_PREFIX + 'Y2lwaGVy'])[0], plain);
  assert.equal(f.calls(), 4, 'the existing three decryption attempts must remain available');
  assert.equal(f.crypto._dpapiProbe(), true);
  assert.equal(f.calls(), 4);
});
