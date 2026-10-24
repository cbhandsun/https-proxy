'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual, types } = require('node:util');
const { fail, safePath, digest } = require('./nsis-encrypted-contract');

// Closed-store inventories remain local. Only the fixed preservation receipt is
// returned; filenames, file digests, native replies and user bytes are not logged.
function inventoryStore(directory) {
  safePath(directory, true);
  const names = fs.readdirSync(directory).sort();
  if (
    names.length < 3 ||
    names.length > 16 ||
    !['.data-key', '.writer.sqlite', 'checkpoint.sqlite'].every((name) => names.includes(name))
  )
    throw fail();
  return names.map((name) => {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(name)) throw fail();
    const file = safePath(path.join(directory, name));
    const size = fs.statSync(file).size;
    const sha256 = digest(file);
    if (fs.statSync(file).size !== size) throw fail();
    return Object.freeze({ name, size, sha256 });
  });
}

function isStorageRefusal(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return false;
  const value = (name) => Object.getOwnPropertyDescriptor(error, name)?.value;
  return (
    value('message') === 'context_recovery_storage_unavailable' &&
    value('code') === 'context_recovery_storage_unavailable' &&
    value('statusCode') === 503 &&
    !Object.hasOwn(error, 'cause')
  );
}

function assertStorageRefusal(
  { open, inventory, evidence, verifyClosed },
  expectedMissingAnchorReads
) {
  const before = inventory();
  let refused = false;
  let unexpected;
  let openReturned = false;
  try {
    const owner = open();
    openReturned = true;
    owner.close();
  } catch (error) {
    // A close failure after a successful open is never an admission refusal.
    unexpected = error;
  }
  // open must throw before returning an owner, and its production catch closes
  // every owner resource before the inventory is observed again.
  if (unexpected !== undefined) refused = isStorageRefusal(unexpected);
  verifyClosed();
  const after = inventory();
  const observed = evidence();
  if (
    !refused ||
    !isDeepStrictEqual(before, after) ||
    openReturned ||
    !Number.isSafeInteger(observed.nativeCalls) ||
    observed.nativeCalls < 1 ||
    observed.nativeCalls > 4 ||
    observed.missingAnchorReads !== expectedMissingAnchorReads ||
    observed.anchorWrites !== 0 ||
    observed.databaseOpened !== true ||
    observed.engineReady !== false
  )
    throw fail();
  return Object.freeze({
    refused: true,
    preserved: true,
    statusCode: 503,
    fileCount: before.length,
  });
}

function assertLegacyRefusal(input) {
  return assertStorageRefusal(input, 1);
}

// The pinned pre-anchor baseline has no anchor backend. Its schema guard must
// reject the sealed current format without altering bytes or returning ready.
function assertUnknownFormatRefusal(input) {
  return assertStorageRefusal(input, 0);
}

module.exports = {
  inventoryStore,
  isStorageRefusal,
  assertLegacyRefusal,
  assertUnknownFormatRefusal,
};
