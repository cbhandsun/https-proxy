const assert = require('assert');
const { createRuntimeConfigController } = require('../lib/proxy/runtime-config-controller');

assert.throws(() => createRuntimeConfigController(), /requires loadConfig and setRuntimeState/);

let scheduled = 0;
let appliedState = null;
let agent = null;
let watcherOptions = null;
const loadOptions = [];
const protocolOptions = { stale: true };
const config = { profiles: [{ id: 'main' }], protocolOptions: { mode: 'safe' } };
const controller = createRuntimeConfigController({
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
});

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

console.log('[runtime-config-controller.test] ok');
