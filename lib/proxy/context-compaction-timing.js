'use strict';

const { performance } = require('node:perf_hooks');
const records = new WeakMap();
const phases = new Set([
  'conversion',
  'planning',
  'summaryRequest',
  'validation',
  'coordination',
  'commit',
]);
const MAX_MS = 3600000;
const summaryStages = new Set(['planning', 'request', 'validation', 'completed']);

function createCompactionTiming(clock = () => performance.now()) {
  if (typeof clock !== 'function') throw new TypeError('Invalid compaction timing clock');
  const token = Object.freeze({});
  records.set(token, {
    clock,
    totals: Object.create(null),
    chunks: [],
    attempts: 0,
    completed: 0,
    valid: true,
  });
  return token;
}

// Only a one-based ordinal and fixed stage are retained, never source text,
// request parameters or provider errors. This is last observed progress, not a
// success/failure verdict; cancellation and coordinator timeout stay separate.
function recordCompactionSummaryProgress(token, chunk, stage, reused = false) {
  if (token === undefined) return;
  const data = records.get(token);
  if (
    !data ||
    !Number.isSafeInteger(chunk) ||
    chunk < 1 ||
    chunk > 16 ||
    !summaryStages.has(stage) ||
    typeof reused !== 'boolean'
  )
    throw new TypeError('Invalid compaction summary progress');
  data.progress = {
    summaryLastChunk: chunk,
    summaryLastStage: stage,
    summaryLastChunkReused: reused,
  };
}

function startCompactionTiming(token, phase) {
  if (token === undefined) return () => {};
  const data = records.get(token);
  if (!data || !phases.has(phase)) throw new TypeError('Invalid compaction timing phase');
  const started = data.clock();
  if (phase === 'summaryRequest') data.attempts = Math.min(16, data.attempts + 1);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    if (phase === 'summaryRequest') data.completed = Math.min(16, data.completed + 1);
    const end = data.clock();
    if (!Number.isFinite(started) || started < 0 || !Number.isFinite(end) || end < started) {
      data.valid = false;
      return;
    }
    const duration = Math.min(MAX_MS, Math.ceil(end - started));
    data.totals[phase] = Math.min(MAX_MS, (data.totals[phase] || 0) + duration);
    if (phase === 'summaryRequest' && data.chunks.length < 16) data.chunks.push(duration);
  };
}

function measureCompactionTiming(token, phase, callback) {
  const finish = startCompactionTiming(token, phase);
  try {
    return callback();
  } finally {
    finish();
  }
}

function snapshotCompactionTiming(token) {
  const data = records.get(token);
  if (!data) throw new TypeError('Invalid compaction timing capability');
  return {
    valid: data.valid,
    conversionMs: data.totals.conversion || 0,
    planningMs: data.totals.planning || 0,
    summaryRequestMs: data.totals.summaryRequest || 0,
    validationMs: data.totals.validation || 0,
    coordinationMs: data.totals.coordination || 0,
    commitMs: data.totals.commit || 0,
    summaryRequests: data.attempts,
    summaryPendingRequests: data.attempts - data.completed,
    summaryChunkMs: [...data.chunks],
    ...data.progress,
  };
}

function dataField(value, name) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return undefined;
  return Object.getOwnPropertyDescriptor(value, name)?.value;
}

function sanitizeCompactionTiming(value) {
  if (dataField(value, 'valid') === undefined) return undefined;
  const output = { valid: dataField(value, 'valid') === true };
  for (const name of [
    'conversionMs',
    'planningMs',
    'summaryRequestMs',
    'validationMs',
    'coordinationMs',
    'commitMs',
    'summaryRequests',
    'summaryPendingRequests',
  ]) {
    const numeric = dataField(value, name);
    const maximum = name.endsWith('Requests') ? 16 : MAX_MS;
    output[name] = Number.isSafeInteger(numeric) && numeric >= 0 ? Math.min(numeric, maximum) : 0;
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > maximum) output.valid = false;
  }
  if (output.summaryPendingRequests > output.summaryRequests) {
    output.summaryPendingRequests = output.summaryRequests;
    output.valid = false;
  }
  const chunks = dataField(value, 'summaryChunkMs');
  output.summaryChunkMs = [];
  if (
    Array.isArray(chunks) &&
    Object.getPrototypeOf(chunks) === Array.prototype &&
    chunks.length <= 16
  ) {
    for (let index = 0; index < chunks.length; index++) {
      const duration = Object.getOwnPropertyDescriptor(chunks, String(index))?.value;
      if (!Number.isSafeInteger(duration) || duration < 0) {
        output.valid = false;
        output.summaryChunkMs = [];
        break;
      }
      if (duration > MAX_MS) output.valid = false;
      output.summaryChunkMs.push(Math.min(duration, MAX_MS));
    }
  } else output.valid = false;
  const chunk = dataField(value, 'summaryLastChunk');
  const stage = dataField(value, 'summaryLastStage');
  const reused = dataField(value, 'summaryLastChunkReused');
  if (chunk !== undefined || stage !== undefined || reused !== undefined) {
    if (
      Number.isSafeInteger(chunk) &&
      chunk >= 1 &&
      chunk <= 16 &&
      summaryStages.has(stage) &&
      typeof reused === 'boolean'
    ) {
      output.summaryLastChunk = chunk;
      output.summaryLastStage = stage;
      output.summaryLastChunkReused = reused;
    } else output.valid = false;
  }
  output.commitDeferred = dataField(value, 'commitDeferred') === true;
  return output;
}

module.exports = {
  createCompactionTiming,
  startCompactionTiming,
  measureCompactionTiming,
  snapshotCompactionTiming,
  sanitizeCompactionTiming,
  recordCompactionSummaryProgress,
};
