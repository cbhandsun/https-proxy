'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const fail = () => new Error('persistent_io_scheduling_invalid');
const TYPES = Object.freeze([
  'schedule-start',
  'schedule-bind',
  'schedule-out',
  'schedule-in',
  'schedule-retire',
  'schedule-unmapped',
]);
const SHAPE =
  /^v(x|(?:0|[1-9]\d{0,2})):p(x|(?:0|[1-9]\d?)):t(?:none|bytes|string|u32|i32|byte|sbyte|u64|i64|u16|i16|other):e(?:header|version|properties|payload|scalar|fields)$/;
const validShape = (name) => {
  const match = SHAPE.exec(name);
  return (
    !!match &&
    (match[1] === 'x' || Number(match[1]) <= 255) &&
    (match[2] === 'x' || Number(match[2]) <= 64)
  );
};
const BINS = Object.freeze(['delayExecution', 'ready', 'otherWaiting', 'other']);
const binFor = (state, reason) =>
  state === 5
    ? [4, 11].includes(reason)
      ? 'delayExecution'
      : 'otherWaiting'
    : state === 1
      ? 'ready'
      : 'other';
const blank = () => ({ count: 0, totalMs: 0, maxMs: 0, over100Ms: 0, over1000Ms: 0 });
const integer = (value, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;
const exact = (value, keys) => {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw fail();
};

// Only threads positively bound by a selected SQLite flush are admitted. All
// intervals include possible ready-queue time; they are NOT COMMIT durations.
function createPersistentIoScheduling() {
  const threads = new Map(),
    bins = Object.fromEntries(BINS.map((key) => [key, blank()]));
  const windows = [],
    waitWindows = [];
  const metadata = new Map();
  let enabled = false,
    bindings = 0,
    retired = 0,
    switchOuts = 0,
    intervals = 0,
    gaps = 0,
    abandoned = 0,
    unmappedEpochs = 0,
    events = 0;
  return {
    observe(type, key, timeMs, name) {
      if (
        !TYPES.includes(type) ||
        typeof key !== 'string' ||
        !/^[a-f0-9]{1,8}$/.test(key) ||
        parseInt(key, 16) === 0 ||
        !integer(timeMs) ||
        typeof name !== 'string' ||
        ++events > 100000
      )
        throw fail();
      if (type === 'schedule-start') {
        if (enabled || key !== '1' || timeMs !== 0 || name !== '') throw fail();
        enabled = true;
        return;
      }
      if (!enabled) throw fail();
      if (type === 'schedule-unmapped') {
        if (key !== '1' || (name !== '' && !validShape(name))) throw fail();
        const shape = name || 'unknown';
        if (!metadata.has(shape) && metadata.size >= 16) throw fail();
        metadata.set(shape, (metadata.get(shape) || 0) + 1);
        unmappedEpochs++;
        for (const value of threads.values()) if (value.pending) abandoned++;
        retired += threads.size;
        threads.clear();
        return;
      }
      if (type === 'schedule-bind') {
        if (name !== '') throw fail();
        if (threads.has(key)) throw fail();
        {
          if (threads.size >= 256) throw fail();
          bindings++;
          threads.set(key, { timeMs, pending: null });
        }
        return;
      }
      const thread = threads.get(key);
      if (!thread || timeMs < thread.timeMs) throw fail();
      thread.timeMs = timeMs;
      if (type === 'schedule-out') {
        if (!/^(?:0|[1-9]\d{0,2}):(?:0|[1-9]\d{0,2})$/.test(name)) throw fail();
        const [state, reason] = name.split(':').map(Number);
        if (state > 255 || reason > 255) throw fail();
        if (thread.pending) gaps++;
        switchOuts++;
        thread.pending = { startedAtMs: timeMs, state, reason };
        return;
      }
      if (name !== '') throw fail();
      if (type === 'schedule-retire') {
        if (thread.pending) abandoned++;
        threads.delete(key);
        retired++;
        return;
      }
      if (!thread.pending) return;
      const { startedAtMs, state, reason } = thread.pending;
      const elapsedMs = timeMs - startedAtMs;
      if (!integer(elapsedMs, 600000)) throw fail();
      thread.pending = null;
      const bin = binFor(state, reason);
      const stats = bins[bin];
      stats.count++;
      stats.totalMs += elapsedMs;
      stats.maxMs = Math.max(stats.maxMs, elapsedMs);
      if (elapsedMs >= 100) stats.over100Ms++;
      if (elapsedMs >= 1000) stats.over1000Ms++;
      intervals++;
      waitWindows.push({
        kind: bin,
        threadState: state,
        waitReason: reason,
        startedAtMs,
        finishedAtMs: timeMs,
        elapsedMs,
      });
      waitWindows.sort(
        (a, b) =>
          b.elapsedMs - a.elapsedMs ||
          a.startedAtMs - b.startedAtMs ||
          (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
      );
      waitWindows.length = Math.min(8, waitWindows.length);
      if (bin === 'delayExecution') {
        windows.push({ startedAtMs, finishedAtMs: timeMs, elapsedMs });
        windows.sort((a, b) => b.elapsedMs - a.elapsedMs || a.startedAtMs - b.startedAtMs);
        windows.length = Math.min(windows.length, 8);
      }
    },
    snapshot() {
      if (!enabled) return null;
      return {
        schemaVersion: 3,
        waitWindows: waitWindows.map((row) => ({ ...row })),
        unmappedMetadata: [...metadata]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([shape, count]) => ({ shape, count })),
        scope: 'sqlite_associated_thread_switch_intervals',
        bindings,
        unmappedEpochs,
        retired,
        switchOuts,
        intervals,
        gaps,
        unfinished: abandoned + [...threads.values()].filter((x) => x.pending).length,
        ...Object.fromEntries(BINS.map((key) => [key, { ...bins[key] }])),
        delayExecutionWindows: windows.map((row) => ({ ...row })),
        traceCompletenessVerified: false,
        commitCorrelationQualified: false,
      };
    },
  };
}

function validatePersistentIoScheduling(input, events) {
  const value = normalizeCompactionData(input, 8192);
  exact(value, [
    'schemaVersion',
    ...([2, 3].includes(value?.schemaVersion) ? ['unmappedMetadata'] : []),
    ...(value?.schemaVersion === 3 ? ['waitWindows'] : []),
    'scope',
    'bindings',
    'unmappedEpochs',
    'retired',
    'switchOuts',
    'intervals',
    'gaps',
    'unfinished',
    ...BINS,
    'delayExecutionWindows',
    'traceCompletenessVerified',
    'commitCorrelationQualified',
  ]);
  if (
    ![1, 2, 3].includes(value.schemaVersion) ||
    value.scope !== 'sqlite_associated_thread_switch_intervals' ||
    value.traceCompletenessVerified !== false ||
    value.commitCorrelationQualified !== false ||
    !integer(events, 100000)
  )
    throw fail();
  for (const key of [
    'bindings',
    'retired',
    'switchOuts',
    'intervals',
    'gaps',
    'unfinished',
    'unmappedEpochs',
  ])
    if (!integer(value[key], events)) throw fail();
  if (
    value.retired > value.bindings ||
    value.bindings - value.retired > 256 ||
    value.switchOuts !== value.intervals + value.gaps + value.unfinished ||
    (!value.bindings && value.switchOuts !== 0)
  )
    throw fail();
  if ([2, 3].includes(value.schemaVersion)) {
    if (!Array.isArray(value.unmappedMetadata) || value.unmappedMetadata.length > 16) throw fail();
    let total = 0,
      prior = '';
    for (const row of value.unmappedMetadata) {
      exact(row, ['shape', 'count']);
      if (
        typeof row.shape !== 'string' ||
        (row.shape !== 'unknown' && !validShape(row.shape)) ||
        row.shape <= prior ||
        !integer(row.count, events) ||
        row.count === 0
      )
        throw fail();
      prior = row.shape;
      total += row.count;
    }
    if (total !== value.unmappedEpochs) throw fail();
  }
  let count = 0;
  for (const key of BINS) {
    const stats = value[key];
    exact(stats, Object.keys(blank()));
    if (
      !integer(stats.count, events) ||
      !integer(stats.totalMs, stats.count * 600000) ||
      !integer(stats.maxMs, 600000) ||
      stats.maxMs > stats.totalMs ||
      stats.totalMs > stats.count * stats.maxMs ||
      !integer(stats.over1000Ms, stats.count) ||
      !integer(stats.over100Ms, stats.count) ||
      stats.over1000Ms > stats.over100Ms ||
      (!stats.count && stats.maxMs !== 0) ||
      stats.over100Ms * 100 > stats.totalMs ||
      stats.over1000Ms * 1000 > stats.totalMs ||
      stats.maxMs >= 100 !== stats.over100Ms > 0 ||
      stats.maxMs >= 1000 !== stats.over1000Ms > 0
    )
      throw fail();
    count += stats.count;
  }
  if (
    count !== value.intervals ||
    !Array.isArray(value.delayExecutionWindows) ||
    value.delayExecutionWindows.length !== Math.min(8, value.delayExecution.count)
  )
    throw fail();
  let prior,
    total = 0;
  for (const row of value.delayExecutionWindows) {
    exact(row, ['startedAtMs', 'finishedAtMs', 'elapsedMs']);
    if (
      !integer(row.startedAtMs) ||
      !integer(row.finishedAtMs) ||
      !integer(row.elapsedMs, 600000) ||
      row.finishedAtMs - row.startedAtMs !== row.elapsedMs ||
      row.elapsedMs > value.delayExecution.maxMs ||
      (prior &&
        (row.elapsedMs > prior.elapsedMs ||
          (row.elapsedMs === prior.elapsedMs && row.startedAtMs < prior.startedAtMs)))
    )
      throw fail();
    total += row.elapsedMs;
    prior = row;
  }
  if (
    total > value.delayExecution.totalMs ||
    (value.delayExecutionWindows.length &&
      value.delayExecutionWindows[0].elapsedMs !== value.delayExecution.maxMs)
  )
    throw fail();
  if (value.schemaVersion === 3) {
    if (
      !Array.isArray(value.waitWindows) ||
      value.waitWindows.length !== Math.min(8, value.intervals)
    )
      throw fail();
    const selected = Object.fromEntries(BINS.map((key) => [key, { count: 0, totalMs: 0 }]));
    let previous;
    for (const row of value.waitWindows) {
      exact(row, ['kind', 'threadState', 'waitReason', 'startedAtMs', 'finishedAtMs', 'elapsedMs']);
      if (
        !BINS.includes(row.kind) ||
        !integer(row.threadState, 255) ||
        !integer(row.waitReason, 255) ||
        binFor(row.threadState, row.waitReason) !== row.kind ||
        !integer(row.startedAtMs) ||
        !integer(row.finishedAtMs) ||
        !integer(row.elapsedMs, 600000) ||
        row.finishedAtMs - row.startedAtMs !== row.elapsedMs ||
        row.elapsedMs > value[row.kind].maxMs ||
        (previous &&
          (row.elapsedMs > previous.elapsedMs ||
            (row.elapsedMs === previous.elapsedMs &&
              (row.startedAtMs < previous.startedAtMs ||
                (row.startedAtMs === previous.startedAtMs && row.kind < previous.kind)))))
      )
        throw fail();
      selected[row.kind].count++;
      selected[row.kind].totalMs += row.elapsedMs;
      previous = row;
    }
    for (const key of BINS)
      if (selected[key].count > value[key].count || selected[key].totalMs > value[key].totalMs)
        throw fail();
    if (
      value.waitWindows.length &&
      value.waitWindows[0].elapsedMs !== Math.max(...BINS.map((key) => value[key].maxMs))
    )
      throw fail();
  }
  return value;
}

module.exports = {
  SCHEDULING_TYPES: TYPES,
  createPersistentIoScheduling,
  validatePersistentIoScheduling,
};
