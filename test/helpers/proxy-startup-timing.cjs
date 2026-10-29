'use strict';

// Test-only preload. Only fixed module labels, fixed startup phases and elapsed
// milliseconds may leave the child; no arguments, paths or errors are emitted.
const Module = require('node:module');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const timing = require('../../lib/proxy/startup-timing');
const createTiming = timing.createStartupTiming;
const load = Module._load;
const {
  STARTUP_IMPORTS,
  STARTUP_CALLS,
  STARTUP_NESTED_IMPORTS,
} = require('./proxy-startup-imports.cjs');
const labels = new Map(Object.entries(STARTUP_IMPORTS));
const nestedLabels = new Map([
  [
    path.resolve(__dirname, '../../lib/proxy/lazy-core-request-handler.js'),
    STARTUP_NESTED_IMPORTS.lazyCore,
  ],
  [path.resolve(__dirname, '../../lib/proxy/core-request-handler.js'), STARTUP_NESTED_IMPORTS.core],
  [path.resolve(__dirname, '../../lib/proxy/handlers.js'), STARTUP_NESTED_IMPORTS.handlers],
]);
const phases = new Set([
  'module_graph_ready',
  'config_load_started',
  'config_loaded',
  'composition_ready',
]);
const seen = new Set();
const seenCalls = new Set();
let portsListening = false;
function instrumentCalls(request, exported) {
  const calls = STARTUP_CALLS[request];
  if (!calls || !exported) return exported;
  for (const [name, label] of Object.entries(calls)) {
    const slot = Object.getOwnPropertyDescriptor(exported, name);
    if (!slot || typeof slot.value !== 'function' || !slot.configurable) continue;
    const original = slot.value;
    Object.defineProperty(exported, name, {
      ...slot,
      value: function (...args) {
        if (seenCalls.has(label)) return Reflect.apply(original, this, args);
        seenCalls.add(label);
        const started = performance.now();
        process.stderr.write('fixture_call_started_' + label + '\n');
        try {
          return Reflect.apply(original, this, args);
        } finally {
          process.stderr.write(
            'fixture_call_' + label + '=' + Math.floor(performance.now() - started) + '\n'
          );
        }
      },
    });
  }
  return exported;
}
function measuredLoad(request, parent) {
  const nested = nestedLabels.get(parent?.filename);
  const label =
    labels.get(request) || (nested && Object.hasOwn(nested, request) ? nested[request] : undefined);
  if (!label || seen.has(label)) return load.apply(this, arguments);
  seen.add(label);
  const started = performance.now();
  process.stderr.write('fixture_import_started_' + label + '\n');
  try {
    return instrumentCalls(request, load.apply(this, arguments));
  } finally {
    process.stderr.write(
      'fixture_import_' + label + '=' + Math.floor(performance.now() - started) + '\n'
    );
    if (
      ['core', 'core_lazy_implementation'].includes(label) &&
      portsListening &&
      Module._load === measuredLoad
    )
      Module._load = load;
  }
}
Module._load = measuredLoad;
timing.createStartupTiming = (...args) => {
  const result = createTiming(...args);
  return {
    ...result,
    mark(phase) {
      const value = result.mark(phase);
      if (phases.has(phase)) process.stderr.write('fixture_phase_' + phase + '\n');
      if (phase === 'ports_listening') {
        portsListening = true;
        if (
          (seen.has('core') || seen.has('core_lazy_implementation')) &&
          Module._load === measuredLoad
        )
          Module._load = load;
      }
      return value;
    },
  };
};
