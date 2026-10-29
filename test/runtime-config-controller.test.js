const assert = require('assert');
const { test } = require('node:test');
const { createRuntimeConfigController } = require('../lib/proxy/runtime-config-controller');
const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
const { createContextRecoverySessions } = require('../lib/proxy/context-recovery-sessions');
const { createContextRecoveryRuntime } = require('../lib/proxy/context-recovery-runtime');
const { preservesContextWindow } = require('../lib/proxy/context-recovery-policy');
const { applyContextBudgetToMessages } = require('../lib/proxy/context-budget-manager');
const { createContextRecoveryDiagnostics } = require('../lib/proxy/context-recovery-diagnostics');

assert.throws(() => createRuntimeConfigController(), /requires loadConfig and setRuntimeState/);

let scheduled = 0;
let appliedState = null;
let agent = null;
let watcherOptions = null;
const loadOptions = [];
const protocolOptions = { stale: true };
const config = { profiles: [{ id: 'main' }], protocolOptions: { mode: 'safe' } };
const dependencies = {
  configFile: 'test-config.json',
  createHttpsAgent: () => ({ id: 'agent' }),
  debounceReload: (_configFile, _reloadFn, options) => {
    watcherOptions = options;
    return { scheduleNow: () => (scheduled += 1), close() {} };
  },
  defaultProtocolOptions: { defaulted: true },
  getActiveProfile: () => ({ id: 'main' }),
  getClaudeDesktopRoutes: () => [],
  getLocalServer: () => ({ listenPort: 3443 }),
  getModelRoutes: () => [],
  getProfiles: (value) => value.profiles,
  loadConfig: (options) => {
    loadOptions.push(options);
    return config;
  },
  log: { info() {}, warn() {}, error() {} },
  metricsInstance: { counter: () => ({ inc() {} }), gauge: () => ({ set() {} }) },
  protocolOptions,
  rebuildProxyRouteIndex: () => true,
  resetLocalProxyDetectionCache() {},
  setHttpsAgent: (value) => (agent = value),
  setRuntimeState: (value) => (appliedState = value),
};
const controller = createRuntimeConfigController(dependencies);

controller.reloadProxyConfig();
assert.strictEqual(scheduled, 1);
controller.applyConfig(config);
assert.deepStrictEqual(protocolOptions, { defaulted: true, mode: 'safe' });
assert.deepStrictEqual(agent, { id: 'agent' });
assert.strictEqual(appliedState.activeProfile.id, 'main');
assert.deepStrictEqual(watcherOptions.loadConfigFn(), config);
assert.deepStrictEqual(loadOptions.pop(), { throwOnError: true });
controller.close();

let manualLoadOptions = null;
const manualController = createRuntimeConfigController({
  configFile: 'test-config.json',
  createHttpsAgent: () => ({ id: 'manual-agent' }),
  debounceReload: () => null,
  defaultProtocolOptions: {},
  getActiveProfile: () => ({ id: 'main' }),
  getClaudeDesktopRoutes: () => [],
  getLocalServer: () => ({ listenPort: 3443 }),
  getModelRoutes: () => [],
  getProfiles: (value) => value.profiles,
  loadConfig: (options) => {
    manualLoadOptions = options;
    return config;
  },
  log: { info() {}, warn() {}, error() {} },
  metricsInstance: { counter: () => ({ inc() {} }), gauge: () => ({ set() {} }) },
  protocolOptions: {},
  rebuildProxyRouteIndex: () => false,
  resetLocalProxyDetectionCache() {},
  setHttpsAgent() {},
  setRuntimeState() {},
});
manualController.reloadProxyConfig();
assert.deepStrictEqual(manualLoadOptions, { throwOnError: true });
manualController.close();

test('hot reload applies and clears the actual shared request planning capability atomically on invalid policy', () => {
  const shared = {};
  const recoveryDiagnostics = createContextRecoveryDiagnostics();
  const live = createRuntimeConfigController({
    ...dependencies,
    protocolOptions: shared,
    recoveryDiagnostics,
    debounceReload: () => null,
  });
  const messages = [
    { role: 'user', content: 'old'.repeat(20000) },
    { role: 'assistant', content: 'answer'.repeat(20000) },
    { role: 'user', content: 'current' },
  ];
  const options = { maxContextTokens: 10000, outputReserveTokens: 1, safetyMarginTokens: 1 };
  try {
    for (const enabled of [false, true]) {
      live.applyConfig(
        {
          ...config,
          protocolOptions: options,
          appSettings: { contextPolicyVersion: 2, contextRecoveryEnabled: enabled },
        },
        { hotReload: true }
      );
      const planned = applyContextBudgetToMessages(messages, {}, 'synthetic', shared);
      assert.equal(planned.messages, messages);
      assert.ok(planned.diagnostics.overBudgetTokens > 0);
      assert.equal(planned.diagnostics.policy, 'preserve-window');
      assert.equal(
        recoveryDiagnostics.inspect({
          appSettings: { contextPolicyVersion: 2, contextRecoveryEnabled: enabled },
        }).policy.runtimeApplication,
        'matched'
      );
    }
    const snapshot = { ...shared };
    assert.throws(() => live.applyConfig({ ...config, appSettings: { contextPolicyVersion: 3 } }), {
      code: 'invalid_context_policy',
    });
    assert.deepStrictEqual(shared, snapshot);
    assert.equal(
      recoveryDiagnostics.inspect({
        appSettings: { contextPolicyVersion: 2, contextRecoveryEnabled: true },
      }).policy.runtimeApplication,
      'matched'
    );
    live.applyConfig({ ...config, protocolOptions: options });
    assert.equal(preservesContextWindow(shared), false);
    assert.equal(recoveryDiagnostics.inspect(config).policy.appliedPolicy, 'legacy');
    const legacy = applyContextBudgetToMessages(messages, {}, 'synthetic', shared);
    assert.ok(legacy.diagnostics.droppedCount > 0 || legacy.diagnostics.optimizedCount > 0);
    live.applyConfig({ ...config, protocolOptions: JSON.parse('{"__proto__":{"polluted":true}}') });
    assert.equal(Object.getPrototypeOf(shared), Object.prototype);
    assert.equal(shared.polluted, undefined);
    assert.equal(Object.hasOwn(shared, '__proto__'), true);
  } finally {
    live.close();
  }
});

test('configuration changes immediately apply to the shared actual recovery owner without another request', async () => {
  const sessions = createContextRecoverySessions();
  const originalConfigure = sessions.configure;
  const changes = [];
  sessions.configure = (value) => {
    changes.push(value);
    originalConfigure(value);
  };
  const owner = createContextRecoveryLifecycle({ sessions });
  owner.configure(false);
  let state;
  const live = createRuntimeConfigController({
    ...dependencies,
    contextRecoveryLifecycle: owner,
    debounceReload: () => null,
    protocolOptions: {},
    setRuntimeState(value) {
      state = value;
    },
  });
  try {
    for (const value of [true, true, false, 'true', null, undefined]) {
      const next = { ...config, appSettings: { contextRecoveryEnabled: value } };
      live.applyConfig(next, { hotReload: true });
      assert.equal(state.config, next);
      assert.equal(sessions.inspect().enabled, value === true);
    }
    assert.deepStrictEqual(changes, [false, true, false]);
    assert.deepStrictEqual(await owner.ready(), { ok: true });
    await owner.shutdownAsync();
    live.applyConfig({ ...config, appSettings: { contextRecoveryEnabled: true } });
    assert.equal(sessions.inspect().closed, true);
    assert.equal(sessions.inspect().enabled, false);
  } finally {
    live.close();
    await owner.shutdownAsync();
  }
});

test('configuration controller rejects executable or missing lifecycle configuration methods before watching', () => {
  let executed = 0;
  for (const lifecycle of [
    null,
    {},
    { configure: true },
    {
      get configure() {
        executed++;
        return () => {};
      },
    },
  ]) {
    assert.throws(
      () =>
        createRuntimeConfigController({
          ...dependencies,
          contextRecoveryLifecycle: lifecycle,
          debounceReload() {
            executed++;
            return null;
          },
        }),
      TypeError
    );
  }
  assert.equal(executed, 0);
});

test('configuration events apply storage mode changes to the actual runtime without another inference request', async () => {
  const options = [];
  const runtime = createContextRecoveryRuntime({
    dataDirectory: require('node:os').tmpdir(),
    createLifecycle(value) {
      options.push(value);
      return createContextRecoveryLifecycle();
    },
  });
  const live = createRuntimeConfigController({
    ...dependencies,
    contextRecoveryLifecycle: runtime,
    debounceReload: () => null,
  });
  try {
    live.applyConfig({
      ...config,
      appSettings: { contextRecoveryEnabled: false, contextRecoveryPersistenceEnabled: true },
    });
    assert.deepStrictEqual(await runtime.ready(), { ok: true });
    assert.equal(options.length, 1);
    assert.equal(runtime.inspect().requestedPersistence, true);
    assert.equal(runtime.inspect().appliedPersistence, false);
    live.applyConfig({
      ...config,
      appSettings: { contextRecoveryEnabled: true, contextRecoveryPersistenceEnabled: true },
    });
    assert.deepStrictEqual(await runtime.ready(), { ok: true });
    assert.equal(options.length, 2);
    assert.equal(require('node:path').basename(options[1].directory), 'context-recovery-v1');
    const prior = runtime.sessions;
    live.applyConfig({
      ...config,
      appSettings: { contextRecoveryEnabled: false, contextRecoveryPersistenceEnabled: false },
    });
    assert.equal(prior.inspect().enabled, false);
    assert.deepStrictEqual(await runtime.ready(), { ok: true });
    assert.equal(options.length, 3);
    assert.equal(prior.inspect().closed, true);
    assert.equal(runtime.sessions.inspect().enabled, false);
  } finally {
    live.close();
    await runtime.shutdownAsync();
  }
});

console.log('[runtime-config-controller.test] ok');
