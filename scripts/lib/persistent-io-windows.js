'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { OPERATION_TYPES } = require('./persistent-io-operation-summary');
const fail = () => new Error('persistent_io_windows_invalid');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a, b) =>
  b.elapsedMs - a.elapsedMs ||
  a.startedAtMs - b.startedAtMs ||
  compare(a.operation, b.operation) ||
  compare(a.kind, b.kind) ||
  a.status - b.status;

// Positive observations only. No IRP, file, process or thread identity leaves
// the accumulator; overlapping times alone cannot identify a request's I/O.
function createPersistentIoWindows() {
  const windows = [];
  return {
    record(operation, kind, startedAtMs, finishedAtMs, status) {
      windows.push({
        operation,
        kind,
        startedAtMs,
        finishedAtMs,
        elapsedMs: finishedAtMs - startedAtMs,
        status: status >>> 0,
      });
      windows.sort(order);
      windows.length = Math.min(8, windows.length);
    },
    snapshot: () => windows.map((row) => ({ ...row })),
  };
}

function validatePersistentIoWindows(input, summary) {
  const windows = normalizeCompactionData(input, 4096);
  if (!Array.isArray(windows) || !windows.length || windows.length > 8) throw fail();
  const counts = new Map();
  let failedFlushes = 0;
  for (let index = 0; index < windows.length; index++) {
    const row = windows[index];
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(',') !==
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
