'use strict';

const { parseCompletedEvidenceSource } = require('./context-evidence-source');

const identity = (value, maximum) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  /^[A-Za-z0-9_.:-]+$/.test(value);

// One restore operation only. The root/ledger importers still validate every
// descriptor, digest, byte count, timestamp and source association independently.
// Only successful policy checks on immutable primitive strings can be reused.
function createRecoverySourcePolicyValidator() {
  const accepted = new Map();
  let entries = 0,
    bytes = 0;
  return (callId, toolName, output) => {
    if (!identity(callId, 256) || !identity(toolName, 128) || typeof output !== 'string')
      return false;
    // IDs are ASCII. Their length affects the original whole-source encoded
    // limit, so a success with a shorter ID cannot authorize a longer one.
    const key = toolName + '\0' + callId.length;
    const outputs = accepted.get(key);
    if (outputs?.has(output)) return true;
    const parsed = parseCompletedEvidenceSource({
      callId,
      toolName,
      arguments: {},
      completed: true,
      output,
    });
    if (!parsed.ok) return false;
    const size = Buffer.byteLength(output) + Buffer.byteLength(key);
    if (entries < 128 && bytes + size <= 4 * 1024 * 1024) {
      const values = outputs ?? new Set();
      values.add(output);
      if (!outputs) accepted.set(key, values);
      entries++;
      bytes += size;
    }
    return true;
  };
}

module.exports = { createRecoverySourcePolicyValidator };
