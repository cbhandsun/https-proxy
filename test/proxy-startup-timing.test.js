'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  STARTUP_IMPORTS,
  STARTUP_CALLS,
  STARTUP_NESTED_IMPORTS,
} = require('./helpers/proxy-startup-imports.cjs');

test('startup call probes preserve exact returns, thrown errors and receivers without exposing arguments', () => {
  const helper = path.resolve(__dirname, 'helpers/proxy-startup-timing.cjs');
  const source = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    const value = {};
    const failure = new Error('PRIVATE_FAILURE');
    let calls = 0;
    let getters = 0;
    const config = {
      loadConfig(input) { assert.equal(this, config); assert.equal(input, value); calls++; return value; },
      migrateLegacyRuntimeFiles() { throw failure; },
    };
    const support = Object.defineProperty({}, 'createRuntimeSupport', {
      configurable: true, get() { getters++; throw Error('PRIVATE_GETTER'); },
    });
    Module._load = function(request) {
      if (request === './lib/proxy/config') return config;
      if (request === './lib/proxy/runtime-support') return support;
      return original.apply(this, arguments);
    };
    require(${JSON.stringify(helper)});
    require('./lib/proxy/runtime-support');
    assert.equal(getters, 0);
    const loaded = require('./lib/proxy/config');
    assert.equal(loaded.loadConfig(value), value);
    assert.equal(loaded.loadConfig(value), value);
    assert.equal(calls, 2);
    assert.throws(() => loaded.migrateLegacyRuntimeFiles('PRIVATE_ARGUMENT'), error => error === failure);
    process.stdout.write('preserved');
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 16384,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'preserved');
  assert.match(
    child.stderr,
    /fixture_call_started_connection_config_load\nfixture_call_connection_config_load=\d+\n/
  );
  assert.match(
    child.stderr,
    /fixture_call_started_legacy_runtime_migration\nfixture_call_legacy_runtime_migration=\d+\n/
  );
  assert.equal(
    (child.stderr.match(/fixture_call_started_connection_config_load\n/g) || []).length,
    1
  );
  assert.doesNotMatch(child.stderr, /PRIVATE|[A-Z]:\\|https?:/);
});

test('startup probe uses a fixed unique vocabulary for both writer and reader', () => {
  assert.ok(Object.isFrozen(STARTUP_IMPORTS));
  const labels = Object.values(STARTUP_IMPORTS);
  assert.equal(new Set(labels).size, labels.length);
  for (const [request, label] of Object.entries(STARTUP_IMPORTS)) {
    assert.match(request, /^\.\/lib\/proxy\/[a-z/-]+$/);
    assert.match(label, /^[a-z_]+$/);
  }
  assert.ok(Object.isFrozen(STARTUP_CALLS));
  const callLabels = Object.values(STARTUP_CALLS).flatMap((value) => Object.values(value));
  assert.equal(new Set(callLabels).size, callLabels.length);
  for (const [request, calls] of Object.entries(STARTUP_CALLS)) {
    assert.ok(Object.hasOwn(STARTUP_IMPORTS, request));
    assert.ok(Object.isFrozen(calls));
    for (const [name, label] of Object.entries(calls)) {
      assert.match(name, /^[A-Za-z]+$/);
      assert.match(label, /^[a-z_]+$/);
    }
  }
  assert.ok(Object.isFrozen(STARTUP_NESTED_IMPORTS));
  const allLabels = [...labels];
  for (const [parent, imports] of Object.entries(STARTUP_NESTED_IMPORTS)) {
    assert.ok(['core', 'handlers', 'lazyCore'].includes(parent));
    assert.ok(Object.isFrozen(imports));
    for (const [request, label] of Object.entries(imports)) {
      assert.match(request, /^\.\/[a-z0-9/-]+$/);
      assert.match(label, /^[a-z_]+$/);
      allLabels.push(label);
    }
  }
  assert.equal(new Set(allLabels).size, allLabels.length);
});

test('nested startup imports require an exact owned parent and never disclose paths or thrown content', () => {
  const helper = path.resolve(__dirname, 'helpers/proxy-startup-timing.cjs');
  const core = path.resolve(__dirname, '../lib/proxy/core-request-handler.js');
  const handlers = path.resolve(__dirname, '../lib/proxy/handlers.js');
  const source = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    const value = {};
    const failure = Error('PRIVATE_FAILURE');
    Module._load = function(request) {
      if (request === './entry-routing' || request === './PRIVATE_PATH') return value;
      if (request === './handlers/responses-state') throw failure;
      return Reflect.apply(original, this, arguments);
    };
    require(${JSON.stringify(helper)});
    const load = (request, filename) => Module._load(request, { filename });
    assert.equal(load('./entry-routing', 'PRIVATE_PARENT'), value);
    assert.equal(load('./entry-routing', ${JSON.stringify(core)} + '.backup'), value);
    assert.equal(load('./entry-routing', ${JSON.stringify(core)}), value);
    assert.equal(load('./entry-routing', ${JSON.stringify(core)}), value);
    assert.equal(load('./PRIVATE_PATH', ${JSON.stringify(core)}), value);
    assert.throws(() => load('./handlers/responses-state', ${JSON.stringify(handlers)}), error => error === failure);
    process.stdout.write('nested_imports_verified');
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 16384,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'nested_imports_verified');
  assert.equal(
    (child.stderr.match(/fixture_import_started_core_entry_routing\n/g) || []).length,
    1
  );
  assert.match(child.stderr, /fixture_import_core_entry_routing=\d+\n/);
  assert.match(
    child.stderr,
    /fixture_import_started_handlers_handlers_responses_state\nfixture_import_handlers_handlers_responses_state=\d+\n/
  );
  assert.doesNotMatch(child.stderr, /PRIVATE|[A-Z]:\\|https?:/);
});

test('startup probe reports begun/finished imports including failure without leaking arguments and restores its loader', () => {
  const helper = path.resolve(__dirname, 'helpers/proxy-startup-timing.cjs');
  const timing = path.resolve(__dirname, '../lib/proxy/startup-timing.js');
  const source = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const timing = require(${JSON.stringify(timing)});
    const original = Module._load;
    let calls = 0;
    Module._load = function(request) {
      if (request === './lib/proxy/core-request-handler') { calls++; return {}; }
      if (request === './lib/proxy/claude-desktop') throw Error('PRIVATE_ERROR_CONTENT');
      if (request === 'PRIVATE_MODULE_PATH') return {};
      return original.apply(this, arguments);
    };
    const base = Module._load;
    require(${JSON.stringify(helper)});
    require('./lib/proxy/core-request-handler');
    require('./lib/proxy/core-request-handler');
    assert.throws(() => require('./lib/proxy/claude-desktop'), /PRIVATE_ERROR_CONTENT/);
    require('PRIVATE_MODULE_PATH');
    assert.equal(calls, 2);
    const clock = timing.createStartupTiming();
    clock.mark('module_graph_ready');
    clock.mark('ports_listening');
    assert.equal(Module._load, base);
    require('./lib/proxy/core-request-handler');
    assert.equal(calls, 3);
    Module._load = original;
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 16384,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /fixture_import_started_core\nfixture_import_core=\d+\n/);
  assert.match(
    child.stderr,
    /fixture_import_started_claude_desktop\nfixture_import_claude_desktop=\d+\n/
  );
  assert.equal((child.stderr.match(/fixture_import_started_core\n/g) || []).length, 1);
  assert.match(child.stderr, /fixture_phase_module_graph_ready\n/);
  assert.doesNotMatch(child.stderr, /PRIVATE|[A-Z]:\\|https?:/);
});
