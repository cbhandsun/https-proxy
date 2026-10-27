'use strict';
const { types } = require('node:util');
const { performance } = require('node:perf_hooks');
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');
const fail = () => new Error('publication_sql_progress_invalid');
const PHASES = new Set(['begin-read', 'begin-write', 'commit', 'rollback', 'clock-write']);
const EXEC = new Map([
  ['BEGIN', 'begin-read'],
  ['BEGIN IMMEDIATE', 'begin-write'],
  ['COMMIT', 'commit'],
  ['ROLLBACK', 'rollback'],
]);
const CLOCK_SQL = 'UPDATE recovery_header SET envelope=? WHERE singleton=1';
function plain(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
}
function createPublicationSqlProgress() {
  let sequence = 0,
    active = null,
    last = null;
  const samples = [];
  return {
    observe(input) {
      plain(input);
      const keys = Reflect.ownKeys(input);
      if (
        keys.length !== 4 ||
        keys.some((key) => !['sequence', 'phase', 'status', 'elapsedMs'].includes(key))
      )
        throw fail();
      const value = {};
      for (const key of ['sequence', 'phase', 'status', 'elapsedMs']) {
        const slot = Object.getOwnPropertyDescriptor(input, key);
        if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
        value[key] = slot.value;
      }
      if (
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1 ||
        value.sequence > 512 ||
        typeof value.phase !== 'string' ||
        !PHASES.has(value.phase) ||
        !['started', 'returned', 'threw'].includes(value.status) ||
        !Number.isSafeInteger(value.elapsedMs) ||
        value.elapsedMs < 0 ||
        value.elapsedMs > 60000 ||
        (last && value.elapsedMs < last.elapsedMs)
      )
        throw fail();
      if (value.status === 'started') {
        if (active || value.sequence !== sequence + 1) throw fail();
        sequence = value.sequence;
        active = value;
      } else {
        if (!active || value.sequence !== active.sequence || value.phase !== active.phase)
          throw fail();
        active = null;
      }
      last = value;
      samples.push(value);
      if (samples.length > 32) samples.shift();
    },
    describe: () => (last ? { ...last } : null),
    snapshot: () => samples.map((value) => ({ ...value })),
  };
}
function method(object, name, prototype = false) {
  if (!object || typeof object !== 'object' || types.isProxy(object)) throw fail();
  let slot = Object.getOwnPropertyDescriptor(object, name);
  if (!slot && prototype) {
    const parent = Object.getPrototypeOf(object);
    if (!parent || types.isProxy(parent)) throw fail();
    slot = Object.getOwnPropertyDescriptor(parent, name);
  }
  if (
    !slot ||
    !Object.hasOwn(slot, 'value') ||
    typeof slot.value !== 'function' ||
    types.isProxy(slot.value) ||
    types.isAsyncFunction(slot.value) ||
    types.isGeneratorFunction(slot.value)
  )
    throw fail();
  return slot.value;
}
// Trusted fixture capabilities only. Calls are synchronous, exactly once and
// retain their original receiver/results/errors. No SQL, arguments, rows or
// exception values cross the observation boundary. Returned is not a durable ACK.
function observePublicationSql(database, emit, now = () => performance.now()) {
  plain(database);
  const keys = Reflect.ownKeys(database);
  if (keys.length !== 2 || keys.some((key) => !['exec', 'prepare'].includes(key))) throw fail();
  const exec = method(database, 'exec'),
    prepare = method(database, 'prepare');
  for (const callback of [emit, now])
    if (typeof callback !== 'function' || types.isProxy(callback)) throw fail();
  const origin = now();
  if (!Number.isFinite(origin) || origin < 0) throw fail();
  const progress = createPublicationSqlProgress();
  let sequence = 0,
    observing = true;
  function publish(phase, status) {
    if (!observing) return;
    try {
      const current = now();
      if (!Number.isFinite(current) || current < origin) throw fail();
      const elapsed = current - origin;
      progress.observe({
        sequence,
        phase,
        status,
        elapsedMs: Math.min(60000, Math.floor(elapsed)),
      });
    } catch {
      observing = false;
      return;
    }
    try {
      const result = emit(Object.freeze(progress.describe()));
      if (nativeReaderPromise(result))
        Promise.prototype.then.call(
          result,
          () => {},
          () => {}
        );
    } catch {
      /* Observation failure cannot change a SQL call or its error. */
    }
  }
  function measured(phase, action, receiver, args) {
    sequence++;
    publish(phase, 'started');
    try {
      const result = Reflect.apply(action, receiver, args);
      publish(phase, 'returned');
      return result;
    } catch (error) {
      publish(phase, 'threw');
      throw error;
    }
  }
  return {
    exec(...args) {
      const phase = EXEC.get(args[0]);
      return phase ? measured(phase, exec, database, args) : Reflect.apply(exec, database, args);
    },
    prepare(...args) {
      const statement = Reflect.apply(prepare, database, args);
      if (args[0] !== CLOCK_SQL) return statement;
      const run = method(statement, 'run', true);
      return { run: (...values) => measured('clock-write', run, statement, values) };
    },
  };
}
module.exports = { createPublicationSqlProgress, observePublicationSql };
