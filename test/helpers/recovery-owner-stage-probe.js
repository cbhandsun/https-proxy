'use strict';

// Test-only observation. No product request, worker message or receipt is changed.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
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
  'settle-reader',
  'revoke',
  'revoke-all',
  'revoke-scopes',
  'sweep',
]);
const STAGES = new Set(['engine_execute', 'engine_snapshot', 'anchor_persist']);
const fail = () => new Error('recovery_stage_probe_failed');

function installOwnerStageProbe(load, emit, now = () => performance.now()) {
  if ([load, emit, now].some((value) => typeof value !== 'function' || types.isProxy(value)))
    throw fail();
  let sequence = 0,
    operation = 'startup';
  function measured(stage, action, receiver, args) {
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
    emit({ sequence, operation, stage, elapsedMs: Math.round(elapsed) });
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
  const createAdmission = admissionModule.createRecoveryAnchorAdmission;
  engineModule.createRecoverySqliteStore = function (...args) {
    const engine = Reflect.apply(createEngine, this, args);
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
  admissionModule.createRecoveryAnchorAdmission = function (...args) {
    const admission = Reflect.apply(createAdmission, this, args);
    const persist = admission.persist;
    return {
      ...admission,
      persist(...values) {
        return measured('anchor_persist', persist, admission, values);
      },
    };
  };
}

function parseStageLine(line) {
  try {
    if (typeof line !== 'string' || Buffer.byteLength(line) > 512) throw fail();
    const value = JSON.parse(line);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'elapsedMs,operation,sequence,stage' ||
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
        'const { installOwnerStageProbe } = require(' + JSON.stringify(__filename) + ');',
        "installOwnerStageProbe(require, (value) => process.stderr.write('HPM_STAGE ' + JSON.stringify(value) + '\\n'));",
        'require(' + JSON.stringify(file) + ');',
      ].join('\n');
      super(script, { ...options, eval: true, stderr: true });
      let pending = '';
      this.stderr.on('data', (chunk) => {
        pending += chunk.toString('utf8');
        // Only our short prefixed lines cross into test diagnostics. Native
        // warnings and any unknown/raw stderr are discarded, never printed.
        if (pending.length > 4096) {
          pending = '';
          return;
        }
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('HPM_STAGE ')) continue;
          try {
            diagnostic({ phase: 'owner-stage', ...parseStageLine(line.slice(10)) });
          } catch {
            diagnostic({ phase: 'owner-stage-invalid' });
          }
        }
      });
    }
  };
}

module.exports = { installOwnerStageProbe, parseStageLine, createObservedStorageWorker };
