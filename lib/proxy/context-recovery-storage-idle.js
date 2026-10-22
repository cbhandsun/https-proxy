'use strict';

const { storageFailure } = require('./context-recovery-storage-contract');
const { validateStorageResult } = require('./context-recovery-storage');
const { nativeReaderPromise } = require('./context-recovery-reader-result');

const IDLE_INTERVAL_MS = 60000;
function startTimer(tick) {
  const timer = setInterval(tick, IDLE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
function consume(value) {
  if (nativeReaderPromise(value)) {
    Promise.prototype.then.call(
      value,
      () => {},
      () => {}
    );
    return true;
  }
  return false;
}

// Runs beside the synchronous SQLite owner in its worker. No request replay,
// timer backlog, asynchronous overlap, model access or expiry renewal.
function startRecoveryStorageIdle(input) {
  let execute, onFailure, schedule;
  try {
    if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
      throw storageFailure();
    const values = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      const slot = Object.getOwnPropertyDescriptor(input, key);
      if (
        !['execute', 'onFailure', 'startTimer'].includes(key) ||
        !slot.enumerable ||
        !Object.hasOwn(slot, 'value')
      )
        throw storageFailure();
      values[key] = slot.value;
    }
    execute = values.execute;
    onFailure = values.onFailure;
    schedule = values.startTimer === undefined ? startTimer : values.startTimer;
    if ([execute, onFailure, schedule].some((value) => typeof value !== 'function'))
      throw storageFailure();
  } catch {
    throw storageFailure();
  }

  let closed = false;
  let closeFailed = false;
  let running = false;
  let failed = false;
  let cancel;
  function cancelScheduled() {
    if (!cancel) return;
    const action = cancel;
    cancel = undefined;
    const result = action();
    if (consume(result) || result !== undefined) throw storageFailure();
  }
  function close() {
    if (closeFailed) throw storageFailure();
    if (closed) return;
    closed = true;
    try {
      cancelScheduled();
    } catch {
      closeFailed = true;
      throw storageFailure();
    }
  }
  function fail() {
    if (failed) return;
    failed = true;
    try {
      close();
    } catch {
      /* Terminal worker teardown remains mandatory. */
    }
    try {
      consume(onFailure());
    } catch {
      /* No observer error can resume this owner. */
    }
  }
  function tick() {
    if (closed || running) return;
    running = true;
    try {
      const result = execute({ operation: 'sweep' });
      if (consume(result)) throw storageFailure();
      validateStorageResult('sweep', result);
    } catch {
      fail();
    } finally {
      running = false;
    }
  }
  try {
    const scheduled = schedule(tick);
    if (typeof scheduled !== 'function') {
      consume(scheduled);
      throw storageFailure();
    }
    cancel = scheduled;
    // An injected scheduler can fire synchronously before returning its handle.
    if (closed) cancelScheduled();
  } catch {
    fail();
    throw storageFailure();
  }
  return { close };
}

module.exports = { startRecoveryStorageIdle, IDLE_INTERVAL_MS };
