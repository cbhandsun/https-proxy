'use strict';

// Owned worker preload: only the SQLite store's injected clock is controlled.
// Real worker/protector deadlines and the production message schema are intact.
const { workerData } = require('node:worker_threads');
const clock = workerData.maintenanceClock;
if (!(clock instanceof SharedArrayBuffer) || clock.byteLength !== 8)
  throw new Error('Invalid maintenance test clock');
delete workerData.maintenanceClock;
const time = new BigInt64Array(clock);
const sqlite = require('../../lib/proxy/context-recovery-storage-sqlite');
const { declareRecoveryScan } = require('../../lib/proxy/context-recovery-storage-contract');
const create = sqlite.createRecoverySqliteStore;
const diagnostics = workerData.idleDiagnostics;
const observation = workerData.idleObservation;
let control;
if (observation !== undefined) {
  if (!(observation instanceof SharedArrayBuffer) || observation.byteLength !== 8)
    throw new Error('Invalid maintenance observation control');
  control = new Int32Array(observation);
}
sqlite.createRecoverySqliteStore = (options) => {
  let sweeping = false,
    observed = false;
  const store = create({
    ...options,
    now: () => {
      const armed = control && Atomics.load(control, 0) === 1;
      const value = Number(Atomics.load(time, 0));
      if (sweeping && armed && Atomics.load(control, 0) === 1) observed = true;
      return value;
    },
  });
  if (diagnostics === undefined && control === undefined) return store;
  if (
    diagnostics !== undefined &&
    (!(diagnostics instanceof SharedArrayBuffer) || diagnostics.byteLength !== 40)
  )
    throw new Error('Invalid maintenance diagnostics control');
  const counters = diagnostics === undefined ? undefined : new Int32Array(diagnostics);
  const execute = store.execute;
  store.execute = declareRecoveryScan(function (...args) {
    if (counters) Atomics.add(counters, 6, 1);
    sweeping = args[0]?.operation === 'sweep';
    observed = false;
    const started = Date.now();
    try {
      const result = execute.apply(this, args);
      if (sweeping && observed) Atomics.store(control, 1, 1);
      return result;
    } finally {
      sweeping = false;
      if (counters) {
        const elapsed = Math.max(0, Date.now() - started);
        Atomics.store(counters, 8, elapsed);
        Atomics.store(counters, 9, Math.max(Atomics.load(counters, 9), elapsed));
        Atomics.add(counters, 7, 1);
      }
    }
  });
  return store;
};
