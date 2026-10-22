'use strict';

// Owned test preload: accelerate only the production idle interval. Native
// protection, storage deadlines and all request timers retain their real values.
const original = globalThis.setInterval;
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
  return original(
    function (...values) {
      const phase = Atomics.load(control, 0);
      if (phase === 2) return;
      if (control.length === 2) Atomics.store(control, 1, 0);
      const started = Date.now();
      if (counters) {
        Atomics.add(counters, 0, 1);
        Atomics.store(counters, 2, phase);
      }
      try {
        callback.apply(this, values);
        if (counters) Atomics.add(counters, 1, 1);
      } catch (error) {
        if (counters) Atomics.add(counters, 5, 1);
        throw error;
      } finally {
        if (counters) {
          const elapsed = Math.max(0, Date.now() - started);
          Atomics.store(counters, 3, elapsed);
          Atomics.store(counters, 4, Math.max(Atomics.load(counters, 4), elapsed));
        }
      }
      // Clock-coupled probes require a successful sweep that actually read the
      // armed clock. An older callback can qualify if it read that new clock;
      // a stale-clock callback or an ordinary command cannot acknowledge it.
      const observed = control.length === 2 ? Atomics.load(control, 1) === 1 : phase === 1;
      if (observed && Atomics.compareExchange(control, 0, 1, 2) === 1) Atomics.notify(control, 0);
    },
    25,
    ...args
  );
};
