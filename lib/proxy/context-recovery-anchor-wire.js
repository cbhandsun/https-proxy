'use strict';

const { parseAnchorSnapshot } = require('./context-recovery-anchor-contract');
const { storageFailure } = require('./context-recovery-storage-contract');

// The v2 authenticated envelope uses a fixed tuple. Removing only the top-level
// field names pays for the header witness: it is no larger than the same v1
// snapshot. All identities, row fields and existing native byte limits remain.
function encodeAnchorSnapshot(input) {
  const value = parseAnchorSnapshot(input);
  return JSON.stringify(
    value.version === 1
      ? value
      : [
          2,
          value.storeId,
          value.keyIdentity,
          value.locationHash,
          value.maxTime,
          value.headerTag,
          value.scopes,
        ]
  );
}
function decodeAnchorSnapshot(text) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 - 28) throw storageFailure();
    const value = JSON.parse(text);
    if (JSON.stringify(value) !== text) throw storageFailure();
    if (Array.isArray(value)) {
      if (value.length !== 7 || value[0] !== 2) throw storageFailure();
      const [version, storeId, keyIdentity, locationHash, maxTime, headerTag, scopes] = value;
      return parseAnchorSnapshot({
        version,
        storeId,
        keyIdentity,
        locationHash,
        maxTime,
        headerTag,
        scopes,
      });
    }
    if (!value || typeof value !== 'object' || value.version !== 1) throw storageFailure();
    return parseAnchorSnapshot(value);
  } catch {
    throw storageFailure();
  }
}
module.exports = { encodeAnchorSnapshot, decodeAnchorSnapshot };
