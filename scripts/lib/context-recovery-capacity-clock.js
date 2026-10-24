'use strict';

const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');

const fail = () => new Error('capacity_realtime_clock_failed');
const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// A wall-clock jump cannot skip a scheduled interval: pacing uses elapsed
// monotonic time, while session timestamps remain actual wall-clock readings.
// Every sleep is bounded and rechecked. No timer catch-up changes the workload.
function createCapacityRealtimeClock(options = {}) {
  if (
    !options ||
    typeof options !== 'object' ||
    types.isProxy(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw fail();
  const clock = { wall: Date.now, monotonic: () => performance.now(), sleep: defaultSleep };
  for (const name of Reflect.ownKeys(options)) {
    const slot = Object.getOwnPropertyDescriptor(options, name);
    if (
      !Object.hasOwn(clock, name) ||
      !slot?.enumerable ||
      !Object.hasOwn(slot, 'value') ||
      typeof slot.value !== 'function' ||
      types.isProxy(slot.value) ||
      types.isGeneratorFunction(slot.value) ||
      (name !== 'sleep' && types.isAsyncFunction(slot.value))
    )
      throw fail();
    clock[name] = slot.value;
  }
  let lastWall;
  let lastMonotonic;
  let started;
  let offset;
  let maximumLatenessMs = 0;
  let running = false;
  let failed = false;
  function read() {
    try {
      if (failed) throw fail();
      const wall = clock.wall();
      const monotonic = clock.monotonic();
      if (
        !Number.isSafeInteger(wall) ||
        wall < 0 ||
        !Number.isFinite(monotonic) ||
        monotonic < 0 ||
        monotonic > Number.MAX_SAFE_INTEGER ||
        (lastWall !== undefined && wall < lastWall) ||
        (lastMonotonic !== undefined && monotonic < lastMonotonic)
      )
        throw fail();
      lastWall = wall;
      lastMonotonic = monotonic;
      return { wall, monotonic };
    } catch {
      failed = true;
      throw fail();
    }
  }
  return Object.freeze({
    now() {
      return read().wall;
    },
    async advance(offsetMs) {
      if (
        failed ||
        running ||
        !Number.isSafeInteger(offsetMs) ||
        offsetMs < 0 ||
        offsetMs > 86400000 ||
        (offset === undefined ? offsetMs !== 0 : offsetMs <= offset)
      ) {
        failed = true;
        throw fail();
      }
      running = true;
      try {
        let sample = read();
        if (started === undefined) started = sample.monotonic;
        const target = started + offsetMs;
        if (!Number.isFinite(target) || target > Number.MAX_SAFE_INTEGER) throw fail();
        while (sample.monotonic < target) {
          const pending = clock.sleep(Math.min(60000, Math.ceil(target - sample.monotonic)));
          if (!nativeReaderPromise(pending) || (await pending) !== undefined) throw fail();
          const next = read();
          if (next.monotonic <= sample.monotonic) throw fail();
          sample = next;
        }
        maximumLatenessMs = Math.max(maximumLatenessMs, sample.monotonic - target);
        offset = offsetMs;
      } catch {
        failed = true;
        throw fail();
      } finally {
        running = false;
      }
    },
    inspect() {
      const sample = read();
      return Object.freeze({
        started: started !== undefined,
        scheduledMs: offset ?? 0,
        elapsedMs: started === undefined ? 0 : sample.monotonic - started,
        maximumLatenessMs,
      });
    },
  });
}

module.exports = { createCapacityRealtimeClock };
