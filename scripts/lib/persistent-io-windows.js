'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { parseIoAssociation, validFixtureTag } = require('./persistent-io-association');
const { OPERATION_TYPES } = require('./persistent-io-operation-summary');
const fail = () => new Error('persistent_io_windows_invalid');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a, b) =>
  b.elapsedMs - a.elapsedMs ||
  a.startedAtMs - b.startedAtMs ||
  compare(a.operation, b.operation) ||
  compare(a.kind, b.kind) ||
  a.status - b.status;

// Positive observations only. Optional association contains a synthetic fixture
// tag and labelled ETW scalar IDs, never a path, pointer or inferred owner PID.
// Neither a matching tag nor overlapping time proves physical file identity.
function createPersistentIoWindows() {
  const windows = [];
  return {
    hasAssociations: () => windows.some((row) => row.association),
    record(operation, kind, startedAtMs, finishedAtMs, status, identity = null) {
      windows.push({
        operation,
        kind,
        startedAtMs,
        finishedAtMs,
        elapsedMs: finishedAtMs - startedAtMs,
        status: status >>> 0,
        ...(identity ? { association: { ...identity } } : {}),
      });
      windows.sort(order);
      windows.length = Math.min(8, windows.length);
    },
    snapshot: () =>
      windows.map((row) => ({
        ...row,
        ...(row.association ? { association: { ...row.association } } : {}),
      })),
  };
}

function validatePersistentIoWindows(input, summary) {
  const windows = normalizeCompactionData(input, 4096);
  if (!Array.isArray(windows) || !windows.length || windows.length > 8) throw fail();
  if (summary.schemaVersion === 7 && !windows.some((row) => row?.association)) throw fail();
  const counts = new Map();
  let failedFlushes = 0;
  for (let index = 0; index < windows.length; index++) {
    const row = windows[index];
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(',') !==
        (Object.hasOwn(row, 'association') ? 'association,' : '') +
          'elapsedMs,finishedAtMs,kind,operation,startedAtMs,status' ||
      !['flush', ...OPERATION_TYPES].includes(row.operation) ||
      !['database', 'journal'].includes(row.kind) ||
      !['startedAtMs', 'finishedAtMs', 'elapsedMs', 'status'].every(
        (key) => Number.isSafeInteger(row[key]) && row[key] >= 0
      ) ||
      row.status > 0xffffffff ||
      row.elapsedMs !== row.finishedAtMs - row.startedAtMs ||
      (index && order(windows[index - 1], row) > 0)
    )
      throw fail();
    if (Object.hasOwn(row, 'association')) {
      if (summary.schemaVersion !== 7) throw fail();
      const { fixtureTag: tag, ...ids } = row.association;
      if (tag !== null && !validFixtureTag(tag)) throw fail();
      parseIoAssociation(ids);
    }
    const key = [row.operation, row.kind, row.status].join(':');
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (row.operation === 'flush') {
      if (row.status) {
        if (++failedFlushes > summary.failedFlushes) throw fail();
      } else if (count > summary[row.kind].count || row.elapsedMs > summary[row.kind].maxMs)
        throw fail();
    } else {
      const stats = summary.ioOperations?.[row.operation]?.[row.kind];
      if (
        !stats ||
        count >
          (row.status
            ? (stats.statuses.find((slot) => slot.code === row.status)?.count ?? 0)
            : stats.count) ||
        row.elapsedMs > (row.status ? stats.maxNonZeroStatusMs : stats.maxMs)
      )
        throw fail();
    }
  }
  return windows;
}

module.exports = { createPersistentIoWindows, validatePersistentIoWindows };
