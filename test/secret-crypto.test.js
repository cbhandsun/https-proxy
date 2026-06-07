const assert = require('assert');
const {
  encryptKey,
  decryptKey,
  clearDecryptCache,
  getCryptoBackend,
  DPAPI_PREFIX,
  AES_PREFIX,
  _encryptAes,
  _decryptAes,
} = require('../lib/proxy/secret-crypto');

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
assert.strictEqual(encryptKey(alreadyEnc), alreadyEnc, 'encryptKey must skip already-encrypted values');
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
assert.ok(cipher.startsWith(DPAPI_PREFIX) || cipher.startsWith(AES_PREFIX),
  'cipher must use known prefix: ' + cipher.substring(0, 16));
const plain = decryptKey(cipher);
assert.strictEqual(plain, apiKey, 'end-to-end round-trip must match');
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
console.log('[secret-crypto.test] bad ciphertext graceful ok');

// 9. getCryptoBackend reports status
const backend = getCryptoBackend();
assert.ok(typeof backend === 'object' && backend !== null);
assert.ok('isWindows' in backend);
assert.ok('prefersDpapi' in backend);
console.log('[secret-crypto.test] backend status:', JSON.stringify(backend));

console.log('[secret-crypto.test] ok');
