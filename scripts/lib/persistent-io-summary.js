'use strict';

const { types } = require('node:util');
const { SCHEDULING_TYPES, createPersistentIoScheduling } = require('./persistent-io-scheduling');
const {
  OPERATION_TYPES,
  createPersistentIoOperations,
} = require('./persistent-io-operation-summary');
const fail = () => new Error('persistent_io_trace_invalid');
function data(input, names) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some((key) => !names.includes(key))) throw fail();
  const value = Object.create(null);
  for (const key of names) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    value[key] = slot.value;
  }
  return value;
}
function pointer(input) {
  if (typeof input !== 'string' || !/^(?:0x[0-9a-fA-F]{1,16}|[0-9]{1,20})$/.test(input))
    throw fail();
  const value = BigInt(input);
  if (value <= 0n || value > 0xffffffffffffffffn) throw fail();
  return value.toString(16);
}

// Positive observations only. Circular ETW loss means this summary can never
// establish the absence of slow I/O or qualify a five-second request.
function createPersistentIoSummary() {
  const names = new Map(),
    pending = new Map();
  const operations = createPersistentIoOperations();
  const scheduling = createPersistentIoScheduling();
  const stats = {
    database: { count: 0, maxMs: 0, over100Ms: 0, over1000Ms: 0 },
    journal: { count: 0, maxMs: 0, over100Ms: 0, over1000Ms: 0 },
  };
  let events = 0,
    collisions = 0,
    unmatchedEnds = 0,
    failedFlushes = 0;
  return {
    observe(input) {
      const value = data(input, ['type', 'key', 'timeMs', 'name']);
      const type = value.type;
      if (
        !['name', 'flush', 'end', 'invalidate', ...OPERATION_TYPES, ...SCHEDULING_TYPES].includes(
          type
        ) ||
        ++events > 100000 ||
        !Number.isSafeInteger(value.timeMs) ||
        value.timeMs < 0 ||
        typeof value.name !== 'string' ||
        value.name.length > 4096
      )
        throw fail();
      const key = pointer(value.key);
      if (SCHEDULING_TYPES.includes(type)) {
        scheduling.observe(type, key, value.timeMs, value.name);
        return;
      }
      if (type === 'name') {
        names.delete(key); // Name reuse must not inherit an old file association.
        if (
          /(?:^|[\\/])hpm-wbipc-core-[A-Za-z0-9]{6}[\\/]context[\\/]checkpoint\.sqlite(?:-journal)?$/i.test(
            value.name
          )
        ) {
          if (names.size >= 256) throw fail();
          names.set(key, value.name.toLowerCase().endsWith('-journal') ? 'journal' : 'database');
        }
        return;
      }
      if (type === 'invalidate') {
        if (value.name !== '') throw fail();
        if (pending.delete(key)) collisions++;
        operations.invalidate(key);
        return;
      }
      if (type === 'flush' || OPERATION_TYPES.includes(type)) {
        if (pending.delete(key)) collisions++;
        operations.invalidate(key);
        // For flush events the file key is supplied as name, never a path.
        const kind = type === 'create' ? value.name : names.get(pointer(value.name));
        if (type === 'create' && !['database', 'journal'].includes(kind)) throw fail();
        if (!kind) return;
        if (pending.size + operations.size() >= 8192) throw fail();
        if (type === 'flush') pending.set(key, { kind, start: value.timeMs });
        else operations.begin(type, key, value.timeMs, kind);
        return;
      }
      if (!/^(?:-?[0-9]{1,10}|0x[0-9a-fA-F]{1,8})$/.test(value.name)) throw fail();
      const status = Number(value.name);
      if (status < -2147483648 || status > 4294967295) throw fail();
      if (operations.end(key, value.timeMs, status)) return;
      const start = pending.get(key);
      if (!start) {
        unmatchedEnds++;
        return;
      }
      pending.delete(key);
      if (status !== 0) {
        failedFlushes++;
        return;
      }
      const elapsed = value.timeMs - start.start;
      if (!Number.isSafeInteger(elapsed) || elapsed < 0) throw fail();
      const result = stats[start.kind];
      result.count++;
      result.maxMs = Math.max(result.maxMs, elapsed);
      if (elapsed >= 100) result.over100Ms++;
      if (elapsed >= 1000) result.over1000Ms++;
    },
    snapshot() {
      const ioOperations = operations.snapshot();
      const ioScheduling = scheduling.snapshot();
      return {
        schemaVersion: ioScheduling ? 5 : ioOperations ? 4 : 1,
        scope:
          ioScheduling || ioOperations
            ? 'synthetic_sqlite_etw_file_operations'
            : 'synthetic_sqlite_etw_flush_pairs',
        events,
        pairedFlushes: stats.database.count + stats.journal.count,
        database: { ...stats.database },
        journal: { ...stats.journal },
        collisions,
        unmatchedEnds,
        failedFlushes,
        unfinishedFlushes: pending.size,
        traceCompletenessVerified: false,
        fiveSecondQualified: false,
        realModelRequests: 0,
        ...(ioScheduling ? { ioOperations, ioScheduling } : ioOperations ? { ioOperations } : {}),
      };
    },
  };
}
module.exports = { createPersistentIoSummary };
