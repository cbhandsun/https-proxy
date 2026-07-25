const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  encryptKey,
  decryptKey,
  decryptKeysStrict,
  clearDecryptCache,
  getCryptoBackend,
  DPAPI_PREFIX,
  AES_PREFIX,
  SECRET_DECRYPTION_ERROR_CODE,
  _encryptAes,
  _decryptAes,
} = require('../lib/proxy/secret-crypto');
const {
  decryptConfigSecretsInPlace,
  encryptConfigSecretsForStorage,
} = require('../lib/proxy/config');

clearDecryptCache();

// 1. Round-trip via AES fallback (forced)
const sampleAes = 'sk-test-aes-1234567890!@#$%^&*()_+';
const aesEnc = _encryptAes(sampleAes);
assert.ok(aesEnc.startsWith(AES_PREFIX), 'AES encryption must use hpm-enc: prefix: ' + aesEnc);
assert.strictEqual(_decryptAes(aesEnc), sampleAes, 'AES round-trip must succeed');
console.log('[secret-crypto.test] AES round-trip ok');

// 2. Decrypt of plaintext (non-encrypted) returns as-is
assert.strictEqual(decryptKey('plain-text-api-key'), 'plain-text-api-key');
assert.strictEqual(decryptKey(''), '');
assert.strictEqual(decryptKey(null), null);
assert.strictEqual(decryptKey(undefined), undefined);
console.log('[secret-crypto.test] decryptKey passthrough ok');

// 3. encryptKey on already-encrypted returns unchanged
const alreadyEnc = _encryptAes('foo');
assert.strictEqual(
  encryptKey(alreadyEnc),
  alreadyEnc,
  'encryptKey must skip already-encrypted values'
);
console.log('[secret-crypto.test] encryptKey idempotent ok');

// 4. encryptKey on empty / non-string
assert.strictEqual(encryptKey(''), '');
assert.strictEqual(encryptKey(null), '');
assert.strictEqual(encryptKey(123), '', 'encryptKey on non-string must return empty');
assert.strictEqual(encryptKey(undefined), '');
console.log('[secret-crypto.test] encryptKey guards ok');

// 5. Decryption cache (AES path)
clearDecryptCache();
const cached = _encryptAes('cache-test-1234');
const first = decryptKey(cached);
const second = decryptKey(cached);
assert.strictEqual(first, 'cache-test-1234');
assert.strictEqual(second, 'cache-test-1234');
console.log('[secret-crypto.test] decrypt cache ok');

// 6. End-to-end encryptKey -> decryptKey on the AES path
//    (DPAPI path may or may not be available; both must work)
clearDecryptCache();
const apiKey = 'sk-end-to-end-' + Date.now();
const cipher = encryptKey(apiKey);
assert.ok(cipher !== apiKey, 'encryption must mutate');
assert.ok(
  cipher.startsWith(DPAPI_PREFIX) || cipher.startsWith(AES_PREFIX),
  'cipher must use known prefix: ' + cipher.substring(0, 16)
);
const [plain, duplicatePlain] = decryptKeysStrict([cipher, cipher]);
assert.strictEqual(plain, apiKey, 'end-to-end round-trip must match');
assert.strictEqual(duplicatePlain, apiKey, 'strict decryption must preserve duplicate ordering');
assert.strictEqual(decryptKey(cipher), apiKey, 'graceful decryption must reuse strict cache');
console.log('[secret-crypto.test] end-to-end round-trip ok prefix=' + cipher.substring(0, 9));

// 7. Backward compatibility: legacy hpm-enc: ciphertext must still decrypt
clearDecryptCache();
const legacyCipher = _encryptAes('legacy-key-987');
assert.ok(legacyCipher.startsWith(AES_PREFIX));
const legacyPlain = decryptKey(legacyCipher);
assert.strictEqual(legacyPlain, 'legacy-key-987');
console.log('[secret-crypto.test] legacy hpm-enc: backward compat ok');

// 8. Bad ciphertext returns as-is (no throw)
assert.strictEqual(decryptKey('hpm-enc:bad'), 'hpm-enc:bad');
assert.strictEqual(decryptKey('hpm-enc:'), 'hpm-enc:');
assert.strictEqual(decryptKey('hpm-dpapi:invalid'), 'hpm-dpapi:invalid');
assert.throws(
  () => decryptKeysStrict(['hpm-dpapi:invalid']),
  (error) => error && error.code === SECRET_DECRYPTION_ERROR_CODE
);
console.log('[secret-crypto.test] bad ciphertext graceful ok');

// 9. Config storage encrypts nested secrets and is idempotent.
const storedConfig = encryptConfigSecretsForStorage({
  profiles: [{ id: 'main', apiKey: 'profile-secret' }],
  claudeDesktop: {
    token: 'desktop-token',
    directApiKey: 'direct-secret',
  },
  entryAuth: {
    enabled: true,
    keys: [{ id: 'remote-client', key: 'entry-secret' }],
  },
});

assert.match(storedConfig.profiles[0].apiKey, /^hpm-(dpapi|enc):/);
assert.match(storedConfig.claudeDesktop.token, /^hpm-(dpapi|enc):/);
assert.match(storedConfig.claudeDesktop.directApiKey, /^hpm-(dpapi|enc):/);
assert.match(storedConfig.entryAuth.keys[0].key, /^hpm-(dpapi|enc):/);
assert.notStrictEqual(storedConfig.profiles[0].apiKey, 'profile-secret');
assert.notStrictEqual(storedConfig.claudeDesktop.token, 'desktop-token');
assert.notStrictEqual(storedConfig.claudeDesktop.directApiKey, 'direct-secret');
assert.ok(!JSON.stringify(storedConfig).includes('profile-secret'));
assert.ok(!JSON.stringify(storedConfig).includes('desktop-token'));
assert.ok(!JSON.stringify(storedConfig).includes('direct-secret'));

const storedConfigAgain = encryptConfigSecretsForStorage(storedConfig);
assert.strictEqual(storedConfigAgain.profiles[0].apiKey, storedConfig.profiles[0].apiKey);
assert.strictEqual(storedConfigAgain.claudeDesktop.token, storedConfig.claudeDesktop.token);
assert.strictEqual(
  storedConfigAgain.claudeDesktop.directApiKey,
  storedConfig.claudeDesktop.directApiKey
);
assert.strictEqual(storedConfigAgain.entryAuth.keys[0].key, storedConfig.entryAuth.keys[0].key);

const loadedConfig = decryptConfigSecretsInPlace(storedConfigAgain);
assert.strictEqual(loadedConfig.profiles[0].apiKey, 'profile-secret');
assert.strictEqual(loadedConfig.claudeDesktop.token, 'desktop-token');
assert.strictEqual(loadedConfig.claudeDesktop.directApiKey, 'direct-secret');
assert.strictEqual(loadedConfig.entryAuth.keys[0].key, 'entry-secret');
console.log('[secret-crypto.test] config storage encryption ok');

// 10. Protected config failures must never fall back to the unauthenticated defaults.
const badConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-bad-secret-'));
try {
  fs.writeFileSync(
    path.join(badConfigRoot, 'proxy.config.json'),
    JSON.stringify({
      entryAuth: {
        enabled: true,
        keys: [{ id: 'broken', key: 'hpm-dpapi:invalid' }],
      },
    }),
    'utf8'
  );
  const configModulePath = path.resolve(__dirname, '../lib/proxy/config.js');
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `const { loadConfig } = require(${JSON.stringify(configModulePath)});` +
        `try { loadConfig(); process.exit(2); } catch (error) {` +
        `process.exit(error && error.code === ${JSON.stringify(SECRET_DECRYPTION_ERROR_CODE)} ? 0 : 3);` +
        `}`,
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PROXY_CONFIG_DIR: badConfigRoot },
      encoding: 'utf8',
      timeout: 15000,
    }
  );
  assert.strictEqual(child.status, 0, child.stderr || child.stdout || 'strict load failed');
} finally {
  fs.rmSync(badConfigRoot, { recursive: true, force: true });
}
console.log('[secret-crypto.test] protected config failure is fail-closed');

// 11. getCryptoBackend reports status
const backend = getCryptoBackend();
assert.ok(typeof backend === 'object' && backend !== null);
assert.ok('isWindows' in backend);
assert.ok('prefersDpapi' in backend);
console.log('[secret-crypto.test] backend status:', JSON.stringify(backend));

console.log('[secret-crypto.test] ok');
