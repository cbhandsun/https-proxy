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
function createIdle(input, asyncMode) {
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
    if (closed || running) return asyncMode ? false : undefined;
    running = true;
    let waiting = false;
    try {
      const result = execute({ operation: 'sweep' });
      if (asyncMode) {
        if (result === null) return false; // Busy serial owner: skip, never queue idle work.
        if (!nativeReaderPromise(result)) throw storageFailure();
        waiting = true;
        return Promise.prototype.then.call(
          result,
          (value) => {
            try {
              if (closed) return false;
              validateStorageResult('sweep', value);
              return true;
            } catch {
              fail();
              return false;
            } finally {
              running = false;
            }
          },
          () => {
            running = false;
            if (!closed) fail();
            return false;
          }
        );
      }
      if (consume(result)) throw storageFailure();
      validateStorageResult('sweep', result);
    } catch {
      fail();
      return asyncMode ? false : undefined;
    } finally {
      if (!waiting) running = false;
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

function startRecoveryStorageIdle(input) {
  return createIdle(input, false);
}
function startRecoveryStorageAsyncIdle(input) {
  return createIdle(input, true);
}

module.exports = { startRecoveryStorageIdle, startRecoveryStorageAsyncIdle, IDLE_INTERVAL_MS };
