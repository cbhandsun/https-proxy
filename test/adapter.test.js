const assert = require('assert');
const { ROUTES } = require('../lib/proxy/management-router');
const managementModule = require('../lib/proxy/handlers/management');
const { createManagementHandlers } = managementModule;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('management handler aggregate exposes tool integration routes', () => {
  const noop = () => {};
  const handlers = createManagementHandlers({
    CONFIG: () => ({}),
    PROFILES: () => [],
    ACTIVE_PROFILE: () => ({}),
    LOCAL_SERVER: () => ({}),
    MODEL_ROUTES: () => [],
    ENTRY_SERVERS: () => [],
    APP_ID: 'test',
    PACKAGE_VERSION: '0.0.0',
    PORT: 3443,
    CLI_SESSIONS: new Map(),
    PROTOCOL_OPTIONS: {},
    reloadProxyConfig: noop,
    makeRequest: noop,
    requestWithProxy: noop,
    logProxyEvent: noop,
    logRequestEnd: noop,
    resolveOfficialCredentials: noop,
    resolveConfiguredProfile: noop,
    handleLocalCertStatusRequest: noop,
    handleLocalCertTrustRequest: noop,
    handleLocalCertUntrustRequest: noop,
    handleLocalTraeStatusRequest: noop,
    handleLocalTraeBridgeStatusRequest: noop,
    handleLocalTraeDebugEventsRequest: noop,
    handleLocalTraeDebugSettingsRequest: noop,
    handleLocalTraeDebugSettingsSaveRequest: noop,
    handleLocalTraeDebugClaudeProcessSelfTestRequest: noop,
    handleLocalTraeDebugNativeStatusRequest: noop,
    handleLocalTraeDebugNativeScanRequest: noop,
    handleLocalTraeDebugNativeDeepEventsRequest: noop,
    handleLocalTraeDebugNativeDeepStartRequest: noop,
    handleLocalTraeDebugNativeDeepStopRequest: noop,
    handleLocalAntigravityCliStatusRequest: noop,
    handleLocalAntigravityCliApplyRequest: noop,
    handleLocalAntigravityCliRestoreRequest: noop,
    handleLocalClaudeCodeStatusRequest: noop,
    handleLocalClaudeCodeApplyRequest: noop,
    handleLocalClaudeCodeRestoreRequest: noop,
    handleLocalCodexStatusRequest: noop,
    handleLocalCodexApplyRequest: noop,
    handleLocalCodexRestoreRequest: noop,
    handleLocalCodexSwitchRequest: noop,
    handleLocalCodexApiLoginRequest: noop,
    handleLocalCodexOfficialLoginRequest: noop,
    handleLocalCodexAuthBackupRequest: noop,
    handleLocalCodexDesktopStatusRequest: noop,
    handleLocalCodexDesktopApplyRequest: noop,
    handleLocalCodexDesktopRestoreRequest: noop,
    handleLocalCodexDesktopSwitchRequest: noop,
    handleLocalCodexDesktopApiLoginRequest: noop,
    handleLocalCodexDesktopOfficialLoginRequest: noop,
    handleLocalCodexDesktopAuthBackupRequest: noop,
    handleLocalGeminiCliStatusRequest: noop,
    handleLocalGeminiCliApplyRequest: noop,
    handleLocalGeminiCliRestoreRequest: noop,
  });

  const toolRoutes = ROUTES.filter((route) =>
    /codex|claudeCode|antigravityCli|geminiCli|trae/.test(route.handlerName)
  );
  assert.ok(toolRoutes.length > 0);
  for (const route of toolRoutes) {
    const legacyHandlerName =
      'handleLocal' +
      route.handlerName.charAt(0).toUpperCase() +
      route.handlerName.slice(1) +
      'Request';
    assert.strictEqual(typeof handlers[legacyHandlerName], 'function', legacyHandlerName);
  }
});

(async () => {
  for (const item of tests) {
    try {
      await item.fn();
      console.log('ok - ' + item.name);
    } catch (err) {
      console.error('not ok - ' + item.name);
      console.error(err.stack || err.message);
      process.exitCode = 1;
    }
  }
  if (process.exitCode) process.exit(process.exitCode);
  console.log('all tests passed');
  process.exit(0);
})();
