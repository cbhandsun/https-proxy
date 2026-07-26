const MAX_PERF_RECORDS = 200;
const PERF_REPORT_RECORDS = 50;
const PERF_DATASET_RECORDS = 20;

const perfRecords = [];
let taskErrorHandler = null;

function normalizeLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label) throw new TypeError('performance label must be a non-empty string');
  return label.slice(0, 200);
}

function exposePerfRecords() {
  window.__hpmPerf = {
    records: perfRecords,
    report: () => perfRecords.slice(-PERF_REPORT_RECORDS),
    clear: () => {
      perfRecords.length = 0;
      exposePerfRecords();
    },
  };
  if (document.documentElement) {
    document.documentElement.dataset.perfRecords = JSON.stringify(
      perfRecords.slice(-PERF_DATASET_RECORDS)
    );
  }
}

export function initPerformanceRuntime(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('performance runtime options must be an object');
  }
  if (options.onTaskError != null && typeof options.onTaskError !== 'function') {
    throw new TypeError('onTaskError must be a function');
  }
  taskErrorHandler = options.onTaskError || null;
  exposePerfRecords();
}

export function recordPerf(label, duration, meta = {}) {
  const safeMeta = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const numericDuration = Number(duration);
  const entry = {
    label: normalizeLabel(label),
    duration: Number.isFinite(numericDuration) ? Math.round(numericDuration * 10) / 10 : 0,
    at: new Date().toISOString(),
    ...safeMeta,
  };
  perfRecords.push(entry);
  if (perfRecords.length > MAX_PERF_RECORDS) perfRecords.shift();
  exposePerfRecords();
}

export function perfStart(label) {
  const normalizedLabel = normalizeLabel(label);
  const start = performance.now();
  return (meta) => recordPerf(normalizedLabel, performance.now() - start, meta);
}

export async function perfTrack(label, task) {
  if (typeof task !== 'function') throw new TypeError('performance task must be a function');
  const normalizedLabel = normalizeLabel(label);
  recordPerf(`${normalizedLabel}.start`, 0);
  const finish = perfStart(normalizedLabel);
  try {
    return await task();
  } finally {
    finish();
  }
}

export function promiseWithTimeout(promise, timeoutMs, message) {
  const normalizedTimeout = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeout) || normalizedTimeout < 0) {
    throw new TypeError('timeoutMs must be a non-negative finite number');
  }
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(
      () =>
        reject(new Error(typeof message === 'string' && message ? message : 'Operation timed out')),
      normalizedTimeout
    );
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timerId));
}

export function scheduleStartupTask(label, task, options = {}) {
  const normalizedLabel = normalizeLabel(label);
  if (typeof task !== 'function') throw new TypeError('startup task must be a function');
  const safeOptions =
    options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const timeout = Number.isFinite(safeOptions.timeout) ? Math.max(0, safeOptions.timeout) : 1500;
  const delay = Number.isFinite(safeOptions.delay) ? Math.max(0, safeOptions.delay) : 80;
  let started = false;
  const run = () => {
    if (started) return;
    started = true;
    const finish = perfStart(normalizedLabel);
    Promise.resolve()
      .then(task)
      .catch((error) => {
        recordPerf(`${normalizedLabel}.error`, 0, {
          errorType: error instanceof Error ? error.name : typeof error,
        });
        if (taskErrorHandler) taskErrorHandler(normalizedLabel, error);
      })
      .finally(() => finish());
  };
  if (safeOptions.eager === true) {
    setTimeout(run, delay);
    return;
  }
  const scheduleIdle = () => {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(run, { timeout });
    } else {
      setTimeout(run, delay);
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(scheduleIdle));
}
