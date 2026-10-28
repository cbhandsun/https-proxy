'use strict';

const { createHash } = require('node:crypto');
const { types } = require('node:util');
const fail = () => new Error('persistent_io_association_invalid');
const ID_KEYS = ['eventProcessId', 'eventThreadId', 'issuingThreadId'];
const validFixtureTag = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// A synthetic fixture suffix is shared by NT-device and Win32 spellings. This
// is a fixture association, NOT a physical file ID or proof of an I/O issuer.
function fixtureTag(filename) {
  if (typeof filename !== 'string' || filename.length > 4096 || /[\0\r\n]/.test(filename))
    return null;
  const match =
    /[\\/](hpm-wbipc-core-[a-z0-9]{6}[\\/]context|hpm-publication-interior-[a-z0-9]{6})[\\/]checkpoint\.sqlite(?:-journal)?$/i.exec(
      filename
    );
  if (!match) return null;
  return createHash('sha256').update(match[1].replaceAll('\\', '/').toLowerCase()).digest('hex');
}

function parseIoAssociation(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== ID_KEYS.length || keys.some((key) => !ID_KEYS.includes(key))) throw fail();
  const result = {};
  for (const key of ID_KEYS) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    const value = slot.value;
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0 || value >= 0xffffffff))
      throw fail();
    result[key] = value;
  }
  return result;
}

module.exports = { fixtureTag, validFixtureTag, parseIoAssociation };
