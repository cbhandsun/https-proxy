'use strict';

// Test-only observation. No product request, worker message or receipt is changed.
const path = require('node:path');
const { fixtureTag, validFixtureTag } = require('../../scripts/lib/persistent-io-association');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');
const OPERATIONS = new Set([
  'startup',
  'catalog',
  'scan',
  'scan-reference',
  'inspect',
  'load',
  'load-reference',
  'save',
  'save-reference',
  'save-reference-state',
  'read-source',
  'read-source-and-settle',
  'settle-reader',
  'revoke',
  'revoke-all',
  'revoke-scopes',
  'sweep',
]);
const STAGES = new Set([
  'engine_execute',
  'engine_snapshot',
  'anchor_persist',
  ...['acquire', 'read', 'write', 'flush', 'readback', 'total', 'dispatch'].map(
    (stage) => 'anchor_native_' + stage
  ),
  'sqlite_begin',
  'sqlite_commit',
  'sqlite_rollback',
  'sqlite_clock_write',
]);
const fail = () => new Error('recovery_stage_probe_failed');

function installOwnerStageProbe(
  load,
  emit,
  now = () => performance.now(),
  threadCpu = () => process.threadCpuUsage(),
  installNative,
  wallNow
) {
  if (
    [load, emit, now, threadCpu].some(
      (value) => typeof value !== 'function' || types.isProxy(value)
    )
  )
    throw fail();
  if (wallNow !== undefined && (typeof wallNow !== 'function' || types.isProxy(wallNow)))
    throw fail();
  function wallSample() {
    const value = wallNow();
    if (!Number.isSafeInteger(value) || value < 0) throw fail();
    return value;
  }
  function cpuSample() {
    const value = threadCpu();
    if (!value || typeof value !== 'object' || types.isProxy(value)) throw fail();
    const sample = {};
    for (const name of ['user', 'system']) {
      const slot = Object.getOwnPropertyDescriptor(value, name);
      if (
        !slot ||
        !Object.hasOwn(slot, 'value') ||
        !Number.isSafeInteger(slot.value) ||
        slot.value < 0
      )
        throw fail();
      sample[name] = slot.value;
    }
    return sample;
  }
  let sequence = 0,
    operation = 'startup';
  if (installNative !== undefined) {
    if (typeof installNative !== 'function' || types.isProxy(installNative)) throw fail();
    installNative(load, (stage, elapsedMs) => emit({ sequence, operation, stage, elapsedMs }));
  }
  function measured(stage, action, receiver, args) {
    // Measure only this worker thread around SQLite's two observed write
    // boundaries. Other worker/process CPU cannot explain their wall time.
    const cpuStarted = ['sqlite_commit', 'sqlite_clock_write'].includes(stage) ? cpuSample() : null;
    const wallStarted = cpuStarted && wallNow ? wallSample() : null;
    const start = now();
    let result,
      failed = false,
      cause;
    try {
      result = Reflect.apply(action, receiver, args);
    } catch (error) {
      failed = true;
      cause = error;
    }
    const elapsed = now() - start;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw fail();
    const wallFinished = wallStarted === null ? null : wallSample();
    const cpu = cpuStarted ? cpuSample() : null;
    if (cpu && (cpu.user < cpuStarted.user || cpu.system < cpuStarted.system)) throw fail();
    emit({
      sequence,
      operation,
      stage,
      elapsedMs: Math.round(elapsed),
      ...(wallStarted === null
        ? {}
        : {
            startedAtUnixMs: wallStarted,
            finishedAtUnixMs: wallFinished,
            wallClockRollbackObserved: wallFinished < wallStarted,
          }),
      ...(cpu
        ? {
            threadCpuUserUs: cpu.user - cpuStarted.user,
            threadCpuSystemUs: cpu.system - cpuStarted.system,
          }
        : {}),
    });
    if (failed) throw cause;
    return result;
  }
  const engineModule = load(
    path.resolve(__dirname, '../../lib/proxy/context-recovery-storage-sqlite.js')
  );
  const admissionModule = load(
    path.resolve(__dirname, '../../lib/proxy/context-recovery-anchor-admission.js')
  );
  const createEngine = engineModule.createRecoverySqliteStore;
  function observedDatabase(database) {
    return {
      exec(...args) {
        const stage = new Map([
          ['BEGIN', 'sqlite_begin'],
          ['BEGIN IMMEDIATE', 'sqlite_begin'],
          ['COMMIT', 'sqlite_commit'],
          ['ROLLBACK', 'sqlite_rollback'],
        ]).get(args[0]);
        return stage
          ? measured(stage, database.exec, database, args)
          : Reflect.apply(database.exec, database, args);
      },
      prepare(...args) {
        const statement = Reflect.apply(database.prepare, database, args);
        if (args[0] !== 'UPDATE recovery_header SET envelope=? WHERE singleton=1') return statement;
        return {
          get: (...values) => Reflect.apply(statement.get, statement, values),
          all: (...values) => Reflect.apply(statement.all, statement, values),
          run: (...values) => measured('sqlite_clock_write', statement.run, statement, values),
        };
      },
    };
  }
  engineModule.createRecoverySqliteStore = function (...args) {
    const options = args[0];
    const supplied = options?.database
      ? [{ ...options, database: observedDatabase(options.database) }, ...args.slice(1)]
      : args;
    const engine = Reflect.apply(createEngine, this, supplied);
    const execute = engine.execute,
      snapshot = engine.snapshot;
    return {
      ...engine,
      execute(...values) {
        if (!values[0] || typeof values[0] !== 'object' || types.isProxy(values[0])) throw fail();
        const slot = Object.getOwnPropertyDescriptor(values[0], 'operation');
        if (!slot || !Object.hasOwn(slot, 'value') || !OPERATIONS.has(slot.value)) throw fail();
        sequence++;
        operation = slot.value;
        return measured('engine_execute', execute, engine, values);
      },
      snapshot(...values) {
        return measured('engine_snapshot', snapshot, engine, values);
      },
    };
  };
  for (const name of ['createRecoveryAnchorAdmission', 'createRecoveryAsyncAnchorAdmission']) {
    const createAdmission = admissionModule[name];
    if (typeof createAdmission !== 'function') continue;
    admissionModule[name] = function (...args) {
      const admission = Reflect.apply(createAdmission, this, args);
      return {
        ...admission,
        persist(...values) {
          return measured('anchor_persist', admission.persist, admission, values);
        },
        ...(admission.persistAsync
          ? {
              async persistAsync(...values) {
                const currentSequence = sequence,
                  currentOperation = operation,
                  start = now();
                let value,
                  failed = false,
                  cause;
                try {
                  const result = Reflect.apply(admission.persistAsync, admission, values);
                  if (!nativeReaderPromise(result)) throw fail();
                  value = await result;
                } catch (error) {
                  failed = true;
                  cause = error;
                }
                const elapsed = now() - start;
                if (!Number.isFinite(elapsed) || elapsed < 0) throw fail();
                emit({
                  sequence: currentSequence,
                  operation: currentOperation,
                  stage: 'anchor_persist',
                  elapsedMs: Math.round(elapsed),
                });
                if (failed) throw cause;
                return value;
              },
            }
          : {}),
      };
    };
  }
}

function parseStageLine(line) {
  try {
    if (typeof line !== 'string' || Buffer.byteLength(line) > 512) throw fail();
    const value = JSON.parse(line);
    if (JSON.stringify(value) !== line) throw fail();
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![
        'elapsedMs,operation,sequence,stage',
        'elapsedMs,operation,sequence,stage,threadCpuSystemUs,threadCpuUserUs',
        'elapsedMs,finishedAtUnixMs,operation,sequence,stage,startedAtUnixMs,threadCpuSystemUs,threadCpuUserUs,wallClockRollbackObserved',
      ].includes(
        Object.keys(value)
          .filter((key) => !['ownerProcessId', 'fixtureTag'].includes(key))
          .sort()
          .join(',')
      ) ||
      ((Object.hasOwn(value, 'ownerProcessId') || Object.hasOwn(value, 'fixtureTag')) &&
        (!Number.isSafeInteger(value.ownerProcessId) ||
          value.ownerProcessId <= 0 ||
          value.ownerProcessId >= 0xffffffff ||
          (value.fixtureTag !== null && !validFixtureTag(value.fixtureTag)) ||
          !Object.hasOwn(value, 'fixtureTag'))) ||
      (Object.hasOwn(value, 'threadCpuUserUs') &&
        (!['sqlite_commit', 'sqlite_clock_write'].includes(value.stage) ||
          !Number.isSafeInteger(value.threadCpuUserUs) ||
          value.threadCpuUserUs < 0 ||
          !Number.isSafeInteger(value.threadCpuSystemUs) ||
          value.threadCpuSystemUs < 0)) ||
      (Object.hasOwn(value, 'startedAtUnixMs') &&
        (!['sqlite_commit', 'sqlite_clock_write'].includes(value.stage) ||
          !Number.isSafeInteger(value.startedAtUnixMs) ||
          value.startedAtUnixMs < 0 ||
          !Number.isSafeInteger(value.finishedAtUnixMs) ||
          value.finishedAtUnixMs < 0 ||
          value.wallClockRollbackObserved !== value.finishedAtUnixMs < value.startedAtUnixMs)) ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 ||
      !OPERATIONS.has(value.operation) ||
      !STAGES.has(value.stage) ||
      !Number.isSafeInteger(value.elapsedMs) ||
      value.elapsedMs < 0
    )
      throw fail();
    return Object.freeze(value);
  } catch {
    throw fail();
  }
}

// Allocate before opening each owner. Late stderr events keep their original
// epoch even when a later owner has already opened and reset its sequence.
// The scope only supplies a finite ordinal; it never inspects diagnostic data.
function createOwnerDiagnosticScope(diagnostic) {
  if (typeof diagnostic !== 'function' || types.isProxy(diagnostic)) throw fail();
  let epoch = 0;
  return () => {
    if (epoch >= Number.MAX_SAFE_INTEGER) throw fail();
    const ownerEpoch = ++epoch;
    return (value) => diagnostic(ownerEpoch, value);
  };
}

function createObservedStorageWorker(diagnostic, WorkerType = Worker) {
  if (
    typeof diagnostic !== 'function' ||
    types.isProxy(diagnostic) ||
    typeof WorkerType !== 'function' ||
    types.isProxy(WorkerType)
  )
    throw fail();
  return class ObservedStorageWorker extends WorkerType {
    constructor(file, options) {
      if (file !== path.resolve(__dirname, '../../lib/proxy/context-recovery-storage-worker.js'))
        throw fail();
      const script = [
        'const { installOwnerStageProbe, observedOwnerIdentity } = require(' +
          JSON.stringify(__filename) +
          ');',
        'const { installAnchorStageProbe } = require(' +
          JSON.stringify(path.join(__dirname, 'recovery-anchor-stage-probe.js')) +
          ');',
        "const identity = observedOwnerIdentity(require('node:worker_threads').workerData); installOwnerStageProbe(require, (value) => process.stderr.write('HPM_STAGE ' + JSON.stringify({ ...value, ...identity }) + '\\n'), undefined, undefined, installAnchorStageProbe, Date.now);",
        'require(' + JSON.stringify(file) + ');',
      ].join('\n');
      super(script, { ...options, eval: true, stderr: true });
      let pending = '',
        discarded = false;
      this.stderr.on('data', (chunk) => {
        // Keep at most one prefixed 512-byte JSON line. Process complete lines
        // before bounding the remainder: a large batch of valid short lines
        // must not be discarded just because the OS delivered it together.
        for (let offset = 0; offset < chunk.length; ) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          if (!discarded) {
            if (Buffer.byteLength(pending) + end - offset > 522) {
              pending = '';
              discarded = true;
            } else pending += chunk.subarray(offset, end).toString('utf8');
          }
          offset = end + 1;
          if (newline < 0) break;
          if (!discarded && pending.startsWith('HPM_STAGE ')) {
            try {
              diagnostic({ phase: 'owner-stage', ...parseStageLine(pending.slice(10)) });
            } catch {
              diagnostic({ phase: 'owner-stage-invalid' });
            }
          }
          pending = '';
          discarded = false;
        }
      });
    }
  };
}

function observedOwnerIdentity(workerData) {
  let tag = null;
  if (workerData && typeof workerData === 'object' && !types.isProxy(workerData)) {
    const slot = Object.getOwnPropertyDescriptor(workerData, 'directory');
    if (slot && Object.hasOwn(slot, 'value') && typeof slot.value === 'string')
      tag = fixtureTag(slot.value + '/checkpoint.sqlite');
  }
  return Object.freeze({ ownerProcessId: process.pid, fixtureTag: tag });
}

module.exports = {
  observedOwnerIdentity,
  installOwnerStageProbe,
  parseStageLine,
  createObservedStorageWorker,
  createOwnerDiagnosticScope,
};
