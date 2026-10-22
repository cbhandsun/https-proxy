'use strict';

const { LEGACY_RECOVERY_TTL_MS, RECOVERY_TTL_MS } = require('./context-recovery-limits');
const legacy = Object.freeze({
  maxEntries: 256,
  maxBytes: 4 * 1024 * 1024,
  maxCalls: 64,
  stateBytes: 6 * 1024 * 1024,
});
const daily = Object.freeze({
  maxEntries: 512,
  maxBytes: 8 * 1024 * 1024,
  maxCalls: 1024,
  stateBytes: 12 * 1024 * 1024,
});
const rootId = (value) => typeof value === 'string' && /^hbs_[a-f0-9]{32}$/.test(value);
const invalid = () => new TypeError('invalid_private_history_capacity');

function privateHistoryCapacity(version) {
  if (version === 1 || version === 2) return legacy;
  if (version === 3) return daily;
  throw invalid();
}
function privateHistoryTtl(version) {
  privateHistoryCapacity(version);
  return version === 1 ? LEGACY_RECOVERY_TTL_MS : RECOVERY_TTL_MS;
}
function data(input, key) {
  const slot = Object.getOwnPropertyDescriptor(input, key);
  if (!slot || !slot.enumerable || !Object.hasOwn(slot, 'value')) throw invalid();
  return slot.value;
}

// Internal immutable accounting projection only. No tail, owner, tool arguments
// or output is read here. Legacy entries retain their shared budget even when
// new root-scoped entries coexist; no eviction or implicit capacity migration.
function validatePrivateHistoryUsage(input, capacityVersion = 1) {
  if (
    ![1, 2].includes(capacityVersion) ||
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > 2048 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw invalid();
  let bytes = 0,
    legacyBytes = 0,
    legacyEntries = 0;
  const roots = new Map();
  for (let index = 0; index < input.length; index++) {
    const entry = data(input, String(index));
    if (!entry || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) throw invalid();
    const version = data(entry, 'version'),
      size = data(entry, 'bytes');
    privateHistoryCapacity(version);
    if (!Number.isSafeInteger(size) || size < 0) throw invalid();
    bytes += size;
    if (version === 3) {
      const id = data(entry, 'rootId');
      if (capacityVersion !== 2 || !rootId(id)) throw invalid();
      const usage = roots.get(id) ?? { bytes: 0, entries: 0 };
      usage.bytes += size;
      usage.entries++;
      if (usage.bytes > daily.maxBytes || usage.entries > daily.maxEntries) throw invalid();
      roots.set(id, usage);
      if (roots.size > 4) throw invalid();
    } else {
      legacyBytes += size;
      legacyEntries++;
    }
  }
  if (
    legacyBytes > legacy.maxBytes ||
    legacyEntries > legacy.maxEntries ||
    bytes > (capacityVersion === 2 ? 32 : 4) * 1024 * 1024
  )
    throw invalid();
  return { entries: input.length, bytes };
}

module.exports = {
  privateHistoryCapacity,
  privateHistoryTtl,
  validatePrivateHistoryUsage,
  isPrivateHistoryRootId: rootId,
};
