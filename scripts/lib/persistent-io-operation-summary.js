'use strict';

const OPERATION_TYPES = Object.freeze(['read', 'write', 'set-info', 'delete', 'cleanup', 'close']);
const empty = () => ({
  count: 0,
  maxMs: 0,
  over100Ms: 0,
  over1000Ms: 0,
  nonZeroStatus: 0,
  maxNonZeroStatusMs: 0,
  accessDenied: 0,
  sharingViolation: 0,
  lockConflict: 0,
});

// Only normalized scalar records reach this private accumulator. No file names,
// pointers, raw statuses or payloads are returned in its observation summary.
function createPersistentIoOperations() {
  const pending = new Map();
  const stats = Object.fromEntries(
    OPERATION_TYPES.map((type) => [
      type,
      {
        database: empty(),
        journal: empty(),
      },
    ])
  );
  let collisions = 0,
    observed = false;
  function invalidate(key) {
    if (pending.delete(key)) collisions++;
  }
  return {
    invalidate,
    size: () => pending.size,
    begin(type, key, time, kind) {
      invalidate(key);
      if (!kind) return;
      observed = true;
      pending.set(key, { type, kind, time });
    },
    end(key, time, status) {
      const start = pending.get(key);
      if (!start) return false;
      pending.delete(key);
      const elapsed = time - start.time;
      if (!Number.isSafeInteger(elapsed) || elapsed < 0) throw Error('persistent_io_trace_invalid');
      const value = stats[start.type][start.kind];
      if (status === 0) {
        value.count++;
        value.maxMs = Math.max(value.maxMs, elapsed);
        if (elapsed >= 100) value.over100Ms++;
        if (elapsed >= 1000) value.over1000Ms++;
      } else {
        value.nonZeroStatus++;
        value.maxNonZeroStatusMs = Math.max(value.maxNonZeroStatusMs, elapsed);
        const unsigned = status >>> 0;
        if (unsigned === 0xc0000022) value.accessDenied++;
        if (unsigned === 0xc0000043) value.sharingViolation++;
        if (unsigned === 0xc0000054) value.lockConflict++;
      }
      return true;
    },
    snapshot() {
      if (!observed) return null;
      return {
        collisions,
        unfinished: pending.size,
        ...Object.fromEntries(
          OPERATION_TYPES.map((type) => [
            type,
            {
              database: { ...stats[type].database },
              journal: { ...stats[type].journal },
            },
          ])
        ),
      };
    },
  };
}

module.exports = { OPERATION_TYPES, createPersistentIoOperations };
