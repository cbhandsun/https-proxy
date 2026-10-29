'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { composeContextProtocolOptions } = require('../lib/proxy/context-recovery-policy');
const { createContextRecoveryDiagnostics } = require('../lib/proxy/context-recovery-diagnostics');

test('runtime selection observes the actual shared options without implying route or client acceptance', () => {
  const diagnostics = createContextRecoveryDiagnostics();
  const shared = {};
  assert.equal(diagnostics.attachPlannerOptions(shared), true);
  const next = { appSettings: { contextPolicyVersion: 2, contextRecoveryEnabled: false } };
  assert.equal(diagnostics.inspect(next).policy.runtimeApplication, 'unavailable');
  for (const config of [
    {},
    next,
    { appSettings: { contextPolicyVersion: 2, contextRecoveryEnabled: true } },
  ]) {
    for (const key of Reflect.ownKeys(shared)) delete shared[key];
    Object.defineProperties(
      shared,
      Object.getOwnPropertyDescriptors(composeContextProtocolOptions({}, config))
    );
    const policy = diagnostics.inspect(config).policy;
    assert.equal(policy.runtimeApplication, 'matched');
    assert.equal(policy.appliedVersion, policy.version);
    assert.equal(policy.appliedPolicy, policy.requestedPolicy);
    assert.equal(policy.plannerApplication, 'unverified');
    assert.equal(diagnostics.inspect(config).clientAcceptance, 'not_verified');
  }
  const mismatch = diagnostics.inspect({}).policy;
  assert.equal(mismatch.runtimeApplication, 'mismatch');
  assert.equal(mismatch.appliedPolicy, 'enhanced');
  assert.equal(mismatch.appliedVersion, 2);
  for (const input of [
    null,
    [],
    false,
    'PRIVATE',
    Object.create({}),
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw Error('PRIVATE');
        },
      }
    ),
  ])
    assert.equal(diagnostics.attachPlannerOptions(input), false);
  assert.equal(diagnostics.inspect({}).policy.runtimeApplication, 'mismatch');
  assert.doesNotMatch(JSON.stringify(diagnostics.inspect({})), /PRIVATE/);
});

test('diagnostic retention reports admission policy without accepting configuration overrides', () => {
  const runtime = createContextRecoveryDiagnostics();
  const retention = runtime.inspect({}).retention;
  assert.deepEqual(retention, {
    policyVersion: 2,
    absoluteTtlMs: 86400000,
    maxActiveRoots: 4,
  });
  retention.absoluteTtlMs = Number.MAX_SAFE_INTEGER;
  retention.maxActiveRoots = 1000;
  let getters = 0;
  const status = runtime.inspect({
    appSettings: {
      get retention() {
        getters++;
        throw Error('PRIVATE_DATA');
      },
    },
  });
  assert.equal(getters, 0);
  assert.equal(status.retention.absoluteTtlMs, 86400000);
  assert.equal(status.retention.maxActiveRoots, 4);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_DATA/);
});

test('recovery diagnostics separate requested and applied state without claiming client acceptance', () => {
  const runtime = createContextRecoveryDiagnostics();
  const config = { appSettings: { contextRecoveryEnabled: true } };
  assert.equal(runtime.record('responses', 'reportingFailed'), true);
  assert.equal(runtime.inspect(config).counters.responses.reportingFailed, 1);
  assert.equal(runtime.inspect(config).state, 'pending_application');
  assert.equal(runtime.configure('true'), false);
  assert.equal(runtime.inspect(config).appliedEnabled, null);
  runtime.configure(true);
  assert.equal(runtime.inspect(config).state, 'enabled_restricted');
  assert.equal(runtime.inspect({}).state, 'pending_application');
  runtime.configure(false);
  const status = runtime.inspect({});
  assert.equal(status.state, 'disabled');
  assert.equal(status.storage, 'memory');
  assert.equal(status.restartRetention, false);
  assert.equal(status.webSocket, 'restricted_unverified');
  assert.equal(status.plugin, 'not_verified');
  assert.equal(status.clientAcceptance, 'not_verified');
});

test('recovery counters use fixed protocol/event vocabulary and detached snapshots', () => {
  const runtime = createContextRecoveryDiagnostics();
  assert.equal(runtime.record('chat', 'bound'), false);
  runtime.configure(true);
  for (const kind of ['chat', 'responses', 'claude'])
    for (const event of ['bound', 'bindingUnavailable', 'completed', 'failed'])
      assert.equal(runtime.record(kind, event), true);
  for (const kind of ['', null, {}, '__proto__', 'private-user-text', 'websocket'])
    assert.equal(runtime.record(kind, 'bound'), false);
  for (const event of [null, {}, 'constructor', 'token-secret'])
    assert.equal(runtime.record('chat', event), false);
  const status = runtime.inspect({});
  assert.equal(status.counterWindow, 'process_lifetime');
  status.counters.chat.completed = Number.MAX_SAFE_INTEGER;
  assert.equal(runtime.inspect({}).counters.chat.completed, 1);
  runtime.configure(false);
  // A request may finish after another request applies a disable/permission change.
  assert.equal(runtime.record('chat', 'failed'), true);
  assert.equal(runtime.record('chat', 'bound'), false);
  assert.equal(runtime.inspect({}).counters.chat.failed, 2);
  assert.equal(runtime.inspect({}).counters.chat.completed, 1);
  assert.doesNotMatch(JSON.stringify(status), /private-user-text|token-secret/);
});

test('diagnostic configuration rejects null, malformed flags, accessors and hostile descriptors without leakage', () => {
  const runtime = createContextRecoveryDiagnostics();
  let getters = 0;
  const accessor = {
    get contextRecoveryEnabled() {
      getters++;
      return true;
    },
  };
  const outer = {
    get appSettings() {
      getters++;
      return {};
    },
  };
  for (const config of [
    null,
    undefined,
    outer,
    { appSettings: accessor },
    { appSettings: [] },
    { appSettings: null },
    { appSettings: { contextRecoveryEnabled: 'secret-value' } },
    { appSettings: { contextRecoveryPersistenceEnabled: 'secret-value' } },
    {
      appSettings: {
        get contextRecoveryPersistenceEnabled() {
          getters++;
          return true;
        },
      },
    },
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('secret-value');
        },
      }
    ),
  ]) {
    const status = runtime.inspect(config);
    assert.equal(status.configValid, false);
    assert.equal(status.state, 'invalid_config');
    assert.doesNotMatch(JSON.stringify(status), /secret-value/);
  }
  assert.equal(getters, 0);
  assert.equal(
    runtime.inspect(Object.create({ appSettings: { contextRecoveryEnabled: true } }))
      .requestedEnabled,
    false
  );
});

test('diagnostics project actual lifecycle storage and admission while protecting getters and failures', () => {
  const diagnostics = createContextRecoveryDiagnostics();
  let state = { appliedEnabled: false, storage: 'persistent', state: 'initializing' };
  assert.equal(diagnostics.attachLifecycle({ inspect: () => state }), true);
  const config = { appSettings: { contextRecoveryEnabled: true } };
  diagnostics.configure(true);
  assert.equal(diagnostics.inspect(config).appliedEnabled, false);
  assert.equal(diagnostics.inspect(config).state, 'pending_application');
  state = { ...state, appliedEnabled: true, state: 'enabled' };
  assert.equal(diagnostics.inspect(config).storage, 'persistent');
  assert.equal(diagnostics.inspect(config).state, 'enabled_restricted');
  assert.equal(diagnostics.inspect(config).restartRetention, false);
  let executed = 0;
  assert.equal(
    diagnostics.attachLifecycle({
      get inspect() {
        executed++;
        return () => state;
      },
    }),
    false
  );
  assert.equal(diagnostics.attachLifecycle(null), false);
  state = {
    get storage() {
      executed++;
      throw new Error('PRIVATE_DATA');
    },
    appliedEnabled: true,
    state: 'enabled',
  };
  assert.equal(diagnostics.inspect(config).state, 'unavailable');
  assert.equal(executed, 0);
  assert.doesNotMatch(JSON.stringify(diagnostics.inspect(config)), /PRIVATE_DATA/);
});
