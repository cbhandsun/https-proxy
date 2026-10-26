'use strict';

// Owned test preload: accelerate only the production idle interval. Native
// protection, storage deadlines and all request timers retain their real values.
const original = globalThis.setInterval;
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');
const { workerData } = require('node:worker_threads');
const observation = workerData?.idleObservation;
const diagnostics = workerData?.idleDiagnostics;
let control;
let counters;
if (diagnostics !== undefined) {
  if (!(diagnostics instanceof SharedArrayBuffer) || diagnostics.byteLength !== 40)
    throw new Error('Invalid idle diagnostics control');
  delete workerData.idleDiagnostics;
  counters = new Int32Array(diagnostics);
}
if (observation !== undefined) {
  if (!(observation instanceof SharedArrayBuffer) || ![4, 8].includes(observation.byteLength))
    throw new Error('Invalid idle observation control');
  delete workerData.idleObservation;
  control = new Int32Array(observation);
}
globalThis.setInterval = (callback, milliseconds, ...args) => {
  if (milliseconds !== 60000) return original(callback, milliseconds, ...args);
  if (!control) return original(callback, 25, ...args);
  let pending = false;
  return original(
    function (...values) {
      const phase = Atomics.load(control, 0);
      if (phase === 2 || pending) return;
      if (control.length === 2) Atomics.store(control, 1, 0);
      const started = Date.now();
      if (counters) {
        Atomics.add(counters, 0, 1);
        Atomics.store(counters, 2, phase);
      }
      function completed(success) {
        if (counters) {
          const elapsed = Math.max(0, Date.now() - started);
          Atomics.store(counters, 3, elapsed);
          Atomics.store(counters, 4, Math.max(Atomics.load(counters, 4), elapsed));
          if (success) Atomics.add(counters, 1, 1);
        }
        if (!success) return;
        // Qualification requires actual async ACK and this sweep's armed clock.
        const observed = control.length === 2 ? Atomics.load(control, 1) === 1 : phase === 1;
        if (observed && Atomics.compareExchange(control, 0, 1, 2) === 1) Atomics.notify(control, 0);
      }
      try {
        const result = callback.apply(this, values);
        if (nativeReaderPromise(result)) {
          pending = true;
          Promise.prototype.then.call(
            result,
            (success) => {
              pending = false;
              completed(success === true);
            },
            () => {
              // An unexpected rejected callback is not a successful sweep. Leave
              // this observation permanently unqualified, without replaying it.
              if (counters) Atomics.add(counters, 5, 1);
              completed(false);
            }
          );
        } else completed(result !== false);
      } catch (error) {
        if (counters) Atomics.add(counters, 5, 1);
        completed(false);
        throw error;
      }
    },
    25,
    ...args
  );
};
