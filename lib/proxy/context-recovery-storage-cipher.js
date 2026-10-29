'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { keyRequest } = require('./context-recovery-key-contract');
const {
  storageFailure,
  storageContext,
  storageState,
} = require('./context-recovery-storage-contract');
const {
  storageManifestMaximum,
  RECOVERY_MANIFEST_BYTES,
} = require('./context-recovery-storage-data');

// Binary envelope: 12-byte random GCM nonce, 16-byte authentication tag, ciphertext.
// All routing metadata is authenticated, including store identity and revocation kind.
function createStorageCipher(inputKey) {
  let key;
  try {
    key = Buffer.from(keyRequest({ operation: 'protect', value: inputKey }).value, 'base64');
  } catch {
    throw storageFailure();
  }
  let closed = false;
  function context(value) {
    if (closed) throw storageFailure();
    const parsed = storageContext(value);
    return Buffer.from(
      JSON.stringify([
        'hpm.context.storage.v1',
        parsed.storeId,
        parsed.scope,
        parsed.revision,
        parsed.createdAt,
        parsed.expiresAt,
        parsed.kind,
        parsed.version,
      ])
    );
  }
  return {
    seal(inputContext, inputState) {
      try {
        const aad = context(inputContext);
        const state = storageState(inputState);
        const plain = Buffer.from(JSON.stringify(state));
        try {
          // Originals remain partitioned. Only a v10 manifest can select the
          // expanded plaintext bound; ordinary states keep the legacy bound.
          if (plain.length > storageManifestMaximum(state)) throw storageFailure();
          const nonce = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', key, nonce);
          cipher.setAAD(aad);
          const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
          return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
        } finally {
          plain.fill(0);
        }
      } catch {
        throw storageFailure();
      }
    },
    open(inputContext, envelope) {
      let plain;
      try {
        const aad = context(inputContext);
        if (
          !(envelope instanceof Uint8Array) ||
          envelope.length < 30 ||
          envelope.length > RECOVERY_MANIFEST_BYTES + 28
        )
          throw storageFailure();
        const bytes = Buffer.from(envelope);
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        cipher.setAAD(aad);
        cipher.setAuthTag(bytes.subarray(12, 28));
        plain = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
        const state = storageState(JSON.parse(text));
        // The authenticated plaintext selects capacity, never untrusted routing
        // metadata or ciphertext length. Recheck the original encoded length.
        if (plain.length > storageManifestMaximum(state)) throw storageFailure();
        return state;
      } catch {
        throw storageFailure();
      } finally {
        plain?.fill(0);
      }
    },
    close() {
      closed = true;
      key.fill(0);
    },
  };
}

module.exports = { createStorageCipher };
