'use strict';

const { createHash } = require('node:crypto');
const { isWellFormedEvidenceText } = require('./context-evidence-utf8');

// One parser invocation only. Repeated originals share immutable UTF-8 facts,
// never source ownership, timestamps, read progress or restore authority.
function createEvidencePayloadVerifier() {
  const verified = new Map();
  let cachedBytes = 0;
  return (text, bytes, digest, coveredThrough) => {
    if (
      typeof text !== 'string' ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > 2 * 1024 * 1024 ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !Number.isSafeInteger(coveredThrough) ||
      coveredThrough < 0 ||
      coveredThrough > bytes
    )
      return false;
    let facts = verified.get(text);
    if (!facts) {
      if (Buffer.byteLength(text) !== bytes) return false;
      if (!isWellFormedEvidenceText(text)) return false;
      const payload = Buffer.from(text, 'utf8');
      facts = { payload, digest: createHash('sha256').update(payload).digest('hex') };
      if (verified.size < 128 && cachedBytes + payload.length <= 4 * 1024 * 1024) {
        verified.set(text, facts);
        cachedBytes += payload.length;
      }
    }
    return (
      facts.payload.length === bytes &&
      facts.digest === digest &&
      // A valid UTF-8 prefix ends at the payload end or before a leading byte.
      // Continuation bytes identify all and only the forbidden split offsets.
      (coveredThrough === bytes || (facts.payload[coveredThrough] & 0xc0) !== 0x80)
    );
  };
}

module.exports = { createEvidencePayloadVerifier };
