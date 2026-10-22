'use strict';

const { performance } = require('node:perf_hooks');
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');

const OPERATIONS = new Set([
  'catalog',
  'scan',
  'inspect',
  'load',
  'save',
  'revoke',
  'revoke-all',
  'revoke-scopes',
  'sweep',
]);
const PHASES = new Set([
  'worker_started',
  'paths_ready',
  'ownership_acquired',
  'key_protect_started',
  'key_protect_finished',
  'key_unprotect_started',
  'key_unprotect_finished',
  'database_opened',
  'engine_ready',
  'ready',
  'failed',
  'opened',
  'reopened',
  ...['first', 'capture', 'resume'].flatMap((name) =>
    ['start', 'headers', 'body', 'committed', 'aborted', 'failed'].map(
      (phase) => name + '_' + phase
    )
  ),
]);

// Test-only bounded timing: fixed vocabulary and integer durations, never
// command data, errors, response bodies, identities, filenames or credentials.
function createRecoveryFixtureTiming(
  now = () => performance.now(),
  cpu = () => process.cpuUsage()
) {
  const rows = [];
  let started;
  let initialCpu;
  function readCpu() {
    try {
      const value = cpu();
      if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
      const fields = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(fields).sort().join(',') !== 'system,user') return null;
      for (const name of ['user', 'system']) {
        const slot = fields[name];
        if (
          !slot.enumerable ||
          !Object.hasOwn(slot, 'value') ||
          !Number.isSafeInteger(slot.value) ||
          slot.value < 0
        )
          return null;
      }
      return { user: fields.user.value, system: fields.system.value };
    } catch {
      return null;
    }
  }
  function record(phase) {
    try {
      const time = now();
      if (!Number.isFinite(time)) return;
      started ??= time;
      const elapsedMs = Math.floor(time - started);
      if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || rows.length >= 256) return;
      const usage = readCpu();
      if (!rows.length) initialCpu = usage;
      const row = { phase, elapsedMs };
      if (
        initialCpu &&
        usage &&
        usage.user >= initialCpu.user &&
        usage.system >= initialCpu.system
      ) {
        row.cpuUserMs = Math.floor((usage.user - initialCpu.user) / 1000);
        row.cpuSystemMs = Math.floor((usage.system - initialCpu.system) / 1000);
      }
      rows.push(row);
    } catch {
      // Observation failure must not alter the fixture operation or its error.
    }
  }
  return {
    mark(phase) {
      if (typeof phase === 'string' && PHASES.has(phase)) record(phase);
    },
    run(operation, execute) {
      const label =
        typeof operation === 'string' && OPERATIONS.has(operation) ? operation : 'unknown';
      record('storage_' + label + '_start');
      try {
        const result = execute();
        if (nativeReaderPromise(result))
          return Promise.prototype.then.call(
            result,
            (value) => {
              record('storage_' + label + '_end');
              return value;
            },
            (error) => {
              record('storage_' + label + '_failed');
              throw error;
            }
          );
        record('storage_' + label + '_end');
        return result;
      } catch (error) {
        record('storage_' + label + '_failed');
        throw error;
      }
    },
    snapshot: () => rows.map((row) => ({ ...row })),
  };
}

module.exports = { createRecoveryFixtureTiming };
