'use strict';

// Explicit synthetic-test mode only. Never forward native diagnostics verbatim.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const fail = () => new Error('recovery_anchor_probe_failed');
const phases = ['acquire', 'read', 'write', 'flush', 'readback'];
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw fail();
}
function parseNativeAnchorStages(text) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024) throw fail();
    const value = JSON.parse(text);
    if (JSON.stringify(value) !== text) throw fail();
    exact(value, ['schemaVersion', 'elapsedMs', 'stages']);
    if (
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > 10000 ||
      !Array.isArray(value.stages) ||
      ![2, 5].includes(value.stages.length)
    )
      throw fail();
    let total = 0;
    value.stages.forEach((row, index) => {
      exact(row, ['stage', 'elapsedMs']);
      if (row.stage !== phases[index] || !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0)
        throw fail();
      total += row.elapsedMs;
    });
    if (total > value.elapsedMs) throw fail();
    return value;
  } catch {
    throw fail();
  }
}
function installAnchorStageProbe(load, emit, now = () => performance.now(), start = spawnSync) {
  if ([load, emit, now, start].some((value) => typeof value !== 'function' || types.isProxy(value)))
    throw fail();
  const module = load(path.resolve(__dirname, '../../lib/proxy/context-recovery-anchor.js'));
  const create = module.createRecoveryAnchorRepository;
  module.createRecoveryAnchorRepository = function (input, dependencies = {}) {
    if (Object.hasOwn(dependencies, 'execute')) throw fail();
    return Reflect.apply(create, this, [
      input,
      {
        ...dependencies,
        execute(file, args, options) {
          try {
            if (!Array.isArray(args) || args.length !== 1 || args[0] !== '--hpm-context-anchor-v1')
              throw fail();
            const started = now();
            const result = start(file, ['--hpm-context-anchor-diagnostic-v1'], options);
            const elapsed = now() - started;
            if (
              !Number.isFinite(elapsed) ||
              elapsed < 0 ||
              result.error ||
              result.signal ||
              result.status !== 0
            )
              throw fail();
            const report = parseNativeAnchorStages(result.stderr);
            if (report.elapsedMs > Math.ceil(elapsed)) throw fail();
            const request = JSON.parse(options.input);
            if (
              !['read', 'compare'].includes(request.operation) ||
              report.stages.length !== (request.operation === 'read' ? 2 : 5)
            )
              throw fail();
            // Preserve the original stdout for the repository's identity/CAS checks.
            for (const row of report.stages) emit('anchor_native_' + row.stage, row.elapsedMs);
            emit('anchor_native_total', report.elapsedMs);
            emit('anchor_native_dispatch', Math.round(elapsed));
            return result.stdout;
          } catch {
            throw fail();
          }
        },
      },
    ]);
  };
}
module.exports = { parseNativeAnchorStages, installAnchorStageProbe };
