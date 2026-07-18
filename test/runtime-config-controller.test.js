const assert = require('assert');
const { createRuntimeConfigController } = require('../lib/proxy/runtime-config-controller');

assert.throws(() => createRuntimeConfigController(), /requires loadConfig and setRuntimeState/);

let scheduled = 0;
let appliedState = null;
let agent = null;
const protocolOptions = { stale: true };
const config = { profiles: [{ id: 'main' }], protocolOptions: { mode: 'safe' } };
const controller = createRuntimeConfigController({
  configFile: 'test-config.json',
  createHttpsAgent: () => ({ id: 'agent' }),
  debounceReload: () => ({ scheduleNow: () => (scheduled += 1), close() {} }),
  defaultProtocolOptions: { defaulted: true },
  getActiveProfile: () => ({ id: 'main' }),
  getClaudeDesktopRoutes: () => [],
  getLocalServer: () => ({ listenPort: 3443 }),
  getModelRoutes: () => [],
  getProfiles: (value) => value.profiles,
  loadConfig: () => config,
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
controller.close();

console.log('[runtime-config-controller.test] ok');
