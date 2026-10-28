'use strict';

const { types } = require('node:util');

// JSON deliberately escapes C0 controls. Numeric endpoints make that intended
// range explicit; no request value participates in either regular expression.
const JSON_ESCAPE_SOURCE =
  '["\\\\' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + '\ud800-\udfff]';

// Explicit full-root capability. Request/policy normalizers keep their smaller
// limits. Count encoded bytes during descriptor-only cloning, not by building a
// second JSON representation of all retained originals.
const RECOVERY_STATE_BYTES = 112 * 1024 * 1024;
function invalid() {
  return new TypeError('invalid_context_recovery_state_data');
}
function cloneRecoveryStateData(input, maximum = RECOVERY_STATE_BYTES, facts) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > RECOVERY_STATE_BYTES + 4096)
    throw invalid();
  let remaining = maximum,
    nodes = 65536;
  const ancestors = new Set();
  // Short checkpoint IDs must not consume every memo slot before repeated
  // original bodies arrive. Keep both tiers local to this parse, with the
  // original combined 128-entry and 4 MiB raw-text bounds.
  const smallSizes = new Map();
  const largeSizes = new Map();
  let cachedBytes = 0;
  // Optional facts are internal provenance for this clone only. Public callers
  // use the same encoder without facts and retain fully mutable results.
  if (facts !== undefined && !(facts instanceof WeakMap)) throw invalid();
  const rawProofCache = facts ? new Map() : null;
  const scratch = facts ? [0, 0, 0, 0, 0] : null;
  let latestRaw = 0;
  function spend(bytes) {
    remaining -= bytes;
    if (remaining < 0) throw invalid();
  }
  function stringBytes(text, collect = false) {
    const sizes = text.length >= 1024 ? largeSizes : smallSizes;
    const prior = sizes.get(text);
    if (prior !== undefined) {
      if (collect) {
        let raw = rawProofCache.get(text);
        if (raw === undefined) {
          raw = Buffer.byteLength(text);
          rawProofCache.set(text, raw);
        }
        latestRaw = raw;
      }
      return prior;
    }
    const raw = Buffer.byteLength(text);
    if (collect) latestRaw = raw;
    let bytes = raw + 2;
    if (bytes > remaining) throw invalid();
    // Keep the ordinary printable ASCII fast path native. The second scan
    // visits actual escapes only, skipping unescaped C1 and ordinary Unicode.
    if (/[^\u0020-\u0021\u0023-\u005b\u005d-\u007e]/.test(text)) {
      const escaped = new RegExp(JSON_ESCAPE_SOURCE, 'g');
      let hits = 0,
        groupStart = 0;
      for (let match; (match = escaped.exec(text)) !== null; ) {
        const unit = match[0].charCodeAt(0);
        if (unit === 34 || unit === 92) bytes++;
        else if (unit < 32) bytes += [8, 9, 10, 12, 13].includes(unit) ? 1 : 5;
        else if (unit <= 0xdbff) {
          const next = text.charCodeAt(escaped.lastIndex);
          if (next >= 0xdc00 && next <= 0xdfff) escaped.lastIndex++;
          else bytes += 3;
        } else bytes += 3;
        // Bound match allocations on dense escaped or surrogate text. The
        // remaining suffix keeps the original exact scalar accounting.
        if (++hits === 32) {
          if (escaped.lastIndex - groupStart <= 1024) {
            for (let index = escaped.lastIndex; index < text.length; index++) {
              const unit = text.charCodeAt(index);
              if (unit === 34 || unit === 92) bytes++;
              else if (unit < 32) bytes += [8, 9, 10, 12, 13].includes(unit) ? 1 : 5;
              else if (unit >= 0xd800 && unit <= 0xdbff) {
                const next = text.charCodeAt(index + 1);
                if (next >= 0xdc00 && next <= 0xdfff) index++;
                else bytes += 3;
              } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 3;
            }
            break;
          }
          hits = 0;
          groupStart = escaped.lastIndex;
        }
      }
    }
    if (sizes.size < 64 && cachedBytes + raw <= 4 * 1024 * 1024) {
      sizes.set(text, bytes);
      if (collect) rawProofCache.set(text, raw);
      cachedBytes += raw;
    }
    return bytes;
  }
  function clone(item, depth, collect = false) {
    if (depth > 64 || --nodes < 0) throw invalid();
    if (typeof item === 'string') {
      const bytes = stringBytes(item, collect);
      spend(bytes);
      if (collect) {
        scratch[0] = bytes;
        scratch[1] = latestRaw;
        scratch[2] = 1;
        scratch[3] = 1;
        scratch[4] = 0;
      }
      return item;
    }
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      const bytes = JSON.stringify(item).length;
      spend(bytes);
      if (collect) {
        scratch[0] = bytes;
        scratch[1] = 0;
        scratch[2] = 1;
        scratch[3] = 1;
        scratch[4] = 0;
      }
      return item;
    }
    // Reject proxies before Array.isArray or descriptor/prototype reflection.
    // Revoked proxies receive the same parser error without executing traps.
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item))
      throw invalid();
    const array = Array.isArray(item);
    if (
      array
        ? Object.getPrototypeOf(item) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      throw invalid();
    const keys = Reflect.ownKeys(item);
    if (keys.length > nodes || (array && (item.length > nodes || keys.length !== item.length + 1)))
      throw invalid();
    // Encoded bytes, raw compaction bytes, occurrence nodes, minimum initial
    // node budget, relative depth; sources additionally carry output raw/JSON.
    // The node-prefix requirement includes array length's own key.
    const proof = collect ? [2, 0, 1, Math.max(1, keys.length + 1), 0] : null;
    ancestors.add(item);
    spend(2);
    function read(name, index) {
      const slot = Object.getOwnPropertyDescriptor(item, name);
      if (typeof name !== 'string' || !slot?.enumerable || !Object.hasOwn(slot, 'value'))
        throw invalid();
      if (index) spend(1);
      const keyBytes = array ? 0 : stringBytes(name, collect) + 1;
      if (!array) spend(keyBytes);
      const keyRaw = collect ? (array ? Buffer.byteLength(name) : latestRaw) : 0;
      const child = clone(
        slot.value,
        depth + 1,
        collect || Boolean(facts && depth === 0 && name === 'ledger')
      );
      if (proof) {
        proof[0] += (index ? 1 : 0) + keyBytes + scratch[0];
        proof[1] += keyRaw + scratch[1];
        proof[3] = Math.max(proof[3], proof[2] + scratch[3]);
        proof[2] += scratch[2];
        proof[4] = Math.max(proof[4], 1 + scratch[4]);
        if (name === 'output') {
          proof[5] = scratch[1];
          proof[6] = scratch[0];
        }
      }
      return child;
    }
    // Array.from defines own data slots without inherited numeric setters.
    // Its null-prototype carrier cannot select a caller/inherited iterator;
    // every source slot still passes the same descriptor and shared budgets.
    const output = array
      ? Array.from({ __proto__: null, length: item.length }, (_, index) =>
          read(String(index), index)
        )
      : Object.create(null);
    if (!array)
      for (let index = 0; index < keys.length; index++)
        output[keys[index]] = read(keys[index], index);
    ancestors.delete(item);
    if (proof) {
      Object.freeze(output);
      facts.set(output, proof);
      for (let index = 0; index < 5; index++) scratch[index] = proof[index];
    } else if (facts && depth === 0) Object.freeze(output);
    return output;
  }
  return clone(input, 0);
}

module.exports = { RECOVERY_STATE_BYTES, cloneRecoveryStateData };
