'use strict';
const { types } = require('node:util');
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');
const fail = () => new Error('native_day_advance_failed');
function fields(input, names) {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input))
    throw fail();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some((key) => !names.includes(key))) throw fail();
  const out = Object.create(null);
  for (const key of names) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    out[key] = slot.value;
  }
  return out;
}
function callback(fn, asyncAllowed = false) {
  if (
    typeof fn !== 'function' ||
    types.isProxy(fn) ||
    types.isGeneratorFunction(fn) ||
    (!asyncAllowed && types.isAsyncFunction(fn))
  )
    throw fail();
}
// Coordination witness only: it never retries, advances a synthetic clock,
// alters a storage operation or grants qualification after any failed phase.
function createNativeDayAdvance(input) {
  const config = fields(input, ['clock', 'verifyIdentity', 'emit', 'onFailure']);
  const clock = fields(config.clock, ['advance', 'now', 'inspect']);
  callback(clock.advance, true);
  for (const fn of [clock.now, clock.inspect, config.verifyIdentity, config.emit, config.onFailure])
    callback(fn);
  let failed = false,
    running = false;
  function invokeSync(fn, ...args) {
    const value = fn(...args);
    if (nativeReaderPromise(value)) {
      Promise.prototype.then.call(
        value,
        () => {},
        () => {}
      );
      throw fail();
    }
    return value;
  }
  return async function advance(offsetMs) {
    if (failed || running) {
      failed = true;
      throw fail();
    }
    running = true;
    let phase = 'offset-admission';
    try {
      if (!Number.isSafeInteger(offsetMs) || offsetMs < 0 || offsetMs > 86400000) throw fail();
      phase = 'identity-before-wait';
      if (invokeSync(config.verifyIdentity) !== undefined || failed) throw fail();
      phase = 'wait';
      const pending = clock.advance(offsetMs);
      if (!nativeReaderPromise(pending) || (await pending) !== undefined) throw fail();
      if (failed) throw fail();
      phase = 'identity-after-wait';
      if (invokeSync(config.verifyIdentity) !== undefined || failed) throw fail();
      phase = 'progress-now';
      const time = invokeSync(clock.now);
      if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) throw fail();
      const atUtc = new Date(time).toISOString();
      phase = 'progress-inspect';
      const progress = fields(invokeSync(clock.inspect), [
        'started',
        'scheduledMs',
        'elapsedMs',
        'maximumLatenessMs',
      ]);
      if (
        progress.started !== true ||
        progress.scheduledMs !== offsetMs ||
        ![progress.elapsedMs, progress.maximumLatenessMs].every(
          (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
        ) ||
        progress.elapsedMs < offsetMs
      )
        throw fail();
      if (failed) throw fail();
      phase = 'progress-emit';
      if (
        invokeSync(config.emit, {
          event: offsetMs === 0 ? 'native_day_started' : 'capacity_tick',
          atUtc,
          realtime24hStarted: true,
          ...progress,
        }) !== undefined ||
        failed
      )
        throw fail();
    } catch {
      failed = true;
      try {
        invokeSync(
          config.onFailure,
          Object.freeze({
            phase,
            scheduledMs:
              Number.isSafeInteger(offsetMs) && offsetMs >= 0 && offsetMs <= 86400000
                ? offsetMs
                : null,
          })
        );
      } catch {
        // Diagnostic output cannot replace or clear the selected failure.
      }
      throw fail();
    } finally {
      running = false;
    }
  };
}
module.exports = { createNativeDayAdvance };
