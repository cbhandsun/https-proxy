const { decryptKey } = require('../config');

const {
  queryTraeStateRows,
  traeOfficialModelSupport,
  getTraeOfficialBridgeUrl,
} = require('../trae-official');

const { parseBoundedInteger, readJsonBodyFromRequest } = require('../management-utils');

const { createManagementConfigHandlers, redactConfigSecrets } = require('./management-config');
const { createManagementAuditHandlers } = require('./management-audit');
const { createManagementDiagnosticsHandlers } = require('./management-diagnostics');
const { createManagementMcpHandlers } = require('./management-mcp');
const { createManagementProfileHandlers } = require('./management-profile');
const { createManagementModelsHandlers } = require('./management-models');
const { createManagementLatencyHandlers } = require('./management-latency');
const { createManagementCredentialsHandlers } = require('./management-credentials');
const { createManagementRateLimitHandlers } = require('./management-rate-limits');
const { createManagementClaudeDesktopHandlers } = require('./management-claude-desktop');
const { createManagementCoreHandlers } = require('./management-core');

const {
  createManagementCliEnvHandlers,
  buildCliLaunchCommand,
  buildCliLaunchSpec,
  encodePowerShellCommand,
  normalizeCliTerminal,
  parseCliArgs,
  resolveCliWorkDir,
} = require('./management-cli-env');

function createManagementHandlers(deps) {
  const {
    CONFIG,
    PROFILES,
    LOCAL_SERVER,
    ENTRY_SERVERS,
    APP_ID,
    PACKAGE_VERSION,
    PORT,
    CLI_SESSIONS,
    metricsInstance,
    reloadProxyConfig,
    makeRequest,
    requestWithProxy,
    resolveOfficialCredentials,
    resolveConfiguredProfile,
    handleLocalCertStatusRequest,
    handleLocalCertTrustRequest,
    handleLocalCertUntrustRequest,
    handleLocalTraeStatusRequest,
    handleLocalTraeBridgeStatusRequest,
    handleLocalTraeDebugEventsRequest,
    handleLocalTraeDebugSettingsRequest,
    handleLocalTraeDebugSettingsSaveRequest,
    handleLocalTraeDebugClaudeProcessSelfTestRequest,
    handleLocalTraeDebugNativeStatusRequest,
    handleLocalTraeDebugNativeScanRequest,
    handleLocalTraeDebugNativeDeepEventsRequest,
    handleLocalTraeDebugNativeDeepStartRequest,
    handleLocalTraeDebugNativeDeepStopRequest,
    handleLocalAntigravityCliStatusRequest,
    handleLocalAntigravityCliApplyRequest,
    handleLocalAntigravityCliRestoreRequest,
    handleLocalClaudeCodeStatusRequest,
    handleLocalClaudeCodeApplyRequest,
    handleLocalClaudeCodeRestoreRequest,
    handleLocalCodexStatusRequest,
    handleLocalCodexApplyRequest,
    handleLocalCodexRestoreRequest,
    handleLocalCodexSwitchRequest,
    handleLocalCodexApiLoginRequest,
    handleLocalCodexOfficialLoginRequest,
    handleLocalCodexAuthBackupRequest,
    handleLocalCodexDesktopStatusRequest,
    handleLocalCodexDesktopApplyRequest,
    handleLocalCodexDesktopRestoreRequest,
    handleLocalCodexDesktopSwitchRequest,
    handleLocalCodexDesktopApiLoginRequest,
    handleLocalCodexDesktopOfficialLoginRequest,
    handleLocalCodexDesktopAuthBackupRequest,
    handleLocalGeminiCliStatusRequest,
    handleLocalGeminiCliApplyRequest,
    handleLocalGeminiCliRestoreRequest,
    globalHttpsAgent,
    queryTraeStateRows: queryTraeStateRowsForTest = queryTraeStateRows,
    traeOfficialModelSupport: traeOfficialModelSupportForTest = traeOfficialModelSupport,
    getTraeOfficialBridgeUrl: getTraeOfficialBridgeUrlForTest = getTraeOfficialBridgeUrl,
  } = deps;

  // Helper to send JSON responses
  function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(data));
  }

  const {
    handleLocalEventsRequest,
    handleLocalEventsClearRequest,
    handleLocalDiagnosticsGetRequest,
    handleLocalDiagnosticsClearRequest,
    handleLocalLogRequest,
  } = createManagementDiagnosticsHandlers({
    sendJson,
  });

  const {
    handleLocalGetConfigRequest,
    handleLocalSaveConfigRequest,
    handleLocalSetActiveRequest,
    writeConfigFileAtomically,
  } = createManagementConfigHandlers({
    sendJson,
    reloadProxyConfig,
  });

  const {
    handleLocalClaudeDesktopStatusRequest,
    handleLocalClaudeDesktopApplyRequest,
    handleLocalClaudeDesktopRestoreRequest,
  } = createManagementClaudeDesktopHandlers({
    sendJson,
    currentConfigSnapshot,
  });

  function currentConfigSnapshot() {
    return typeof CONFIG === 'function' ? CONFIG() : CONFIG;
  }

  function currentProfilesSnapshot() {
    return typeof PROFILES === 'function' ? PROFILES() : PROFILES;
  }

  function currentLocalServerSnapshot() {
    return typeof LOCAL_SERVER === 'function' ? LOCAL_SERVER() : LOCAL_SERVER;
  }

  function currentEntryServersSnapshot() {
    const entries = typeof ENTRY_SERVERS === 'function' ? ENTRY_SERVERS() : ENTRY_SERVERS;
    return Array.isArray(entries) ? entries : [];
  }

  const {
    handleLocalEnvCheckRequest,
    handleLocalEnvUpgradeRequest,
    handleLocalEnvInstallJobsRequest,
    handleLocalSelectDirectoryRequest,
    handleLocalCliLaunchRequest,
    handleLocalCliSessionsRequest,
    handleLocalCliSessionDeleteRequest,
  } = createManagementCliEnvHandlers({
    sendJson,
    cliSessions: CLI_SESSIONS,
    getEntryServersSnapshot: currentEntryServersSnapshot,
    getLocalServerSnapshot: currentLocalServerSnapshot,
    defaultPort: PORT,
  });

  const {
    handleLocalAuditConversationsRequest,
    handleLocalAuditConversationsClearRequest,
    handleLocalAuditRetryRequest,
    handleLocalUsageReportRequest,
  } = createManagementAuditHandlers({
    sendJson,
    makeRequest,
    currentConfigSnapshot,
    getLocalServerSnapshot: currentLocalServerSnapshot,
    defaultPort: PORT,
  });

  const {
    handleLocalMetricsRequest,
    handleLocalHealthRequest,
    handleLocalUsageSummaryRequest,
    handleLocalPromptsSyncRequest,
    handleLocalPromptsPresetsGetRequest,
    handleLocalPromptsPresetsSaveRequest,
    handleLocalPromptsPresetsApplyRequest,
    readRawConfigSnapshot,
    writeRawConfigSnapshot,
  } = createManagementCoreHandlers({
    sendJson,
    metricsInstance,
    appId: APP_ID,
    packageVersion: PACKAGE_VERSION,
    defaultPort: PORT,
    currentConfigSnapshot,
    currentEntryServersSnapshot,
    writeConfigFileAtomically,
    reloadProxyConfig,
  });

  const {
    handleLocalMcpHubGetRequest,
    handleLocalMcpHubSaveRequest,
    handleLocalMcpHubLogsRequest,
  } = createManagementMcpHandlers({
    sendJson,
    currentConfigSnapshot,
    readRawConfigSnapshot,
    writeRawConfigSnapshot,
  });

  const { handleLocalProfileTestAuthRequest, handleLocalRouteTestRequest } =
    createManagementProfileHandlers({
      sendJson,
      makeRequest,
      resolveOfficialCredentials,
      resolveConfiguredProfile,
      getProfilesSnapshot: currentProfilesSnapshot,
      queryTraeStateRows: queryTraeStateRowsForTest,
      traeOfficialModelSupport: traeOfficialModelSupportForTest,
      getTraeOfficialBridgeUrl: getTraeOfficialBridgeUrlForTest,
    });

  const { handleLocalModelsListRequest } = createManagementModelsHandlers({
    sendJson,
    requestWithProxy,
    resolveOfficialCredentials,
    resolveConfiguredProfile,
  });

  const { handleLocalLatencyRequest } = createManagementLatencyHandlers({
    sendJson,
    requestWithProxy,
    resolveOfficialCredentials,
    resolveConfiguredProfile,
  });

  const { handleLocalCliCredentialsRequest } = createManagementCredentialsHandlers({
    sendJson,
  });

  const { handleLocalRateLimitsRequest, sendCodexLocalRateLimitsOrError } =
    createManagementRateLimitHandlers({
      sendJson,
      makeRequest,
      resolveOfficialCredentials,
      getProfilesSnapshot: currentProfilesSnapshot,
      decryptKey,
      globalHttpsAgent,
    });

  return {
    handleLocalLatencyRequest,
    handleLocalClaudeDesktopStatusRequest,
    handleLocalClaudeDesktopApplyRequest,
    handleLocalClaudeDesktopRestoreRequest,
    handleLocalCliCredentialsRequest,
    handleLocalRateLimitsRequest,
    handleLocalEventsRequest,
    handleLocalEventsClearRequest,
    handleLocalMetricsRequest,
    handleLocalGetConfigRequest,
    handleLocalSaveConfigRequest,
    handleLocalSetActiveRequest,
    handleLocalLogRequest,
    handleLocalEnvCheckRequest,
    handleLocalEnvUpgradeRequest,
    handleLocalEnvInstallJobsRequest,
    handleLocalSelectDirectoryRequest,
    handleLocalCliLaunchRequest,
    handleLocalCliSessionsRequest,
    handleLocalCliSessionDeleteRequest,
    handleLocalHealthRequest,
    handleLocalDiagnosticsGetRequest,
    handleLocalDiagnosticsClearRequest,
    handleLocalCertStatusRequest,
    handleLocalCertTrustRequest,
    handleLocalCertUntrustRequest,
    handleLocalTraeStatusRequest,
    handleLocalTraeBridgeStatusRequest,
    handleLocalTraeDebugEventsRequest,
    handleLocalTraeDebugSettingsRequest,
    handleLocalTraeDebugSettingsSaveRequest,
    handleLocalTraeDebugClaudeProcessSelfTestRequest,
    handleLocalTraeDebugNativeStatusRequest,
    handleLocalTraeDebugNativeScanRequest,
    handleLocalTraeDebugNativeDeepEventsRequest,
    handleLocalTraeDebugNativeDeepStartRequest,
    handleLocalTraeDebugNativeDeepStopRequest,
    handleLocalAntigravityCliStatusRequest,
    handleLocalAntigravityCliApplyRequest,
    handleLocalAntigravityCliRestoreRequest,
    handleLocalClaudeCodeStatusRequest,
    handleLocalClaudeCodeApplyRequest,
    handleLocalClaudeCodeRestoreRequest,
    handleLocalCodexStatusRequest,
    handleLocalCodexApplyRequest,
    handleLocalCodexRestoreRequest,
    handleLocalCodexSwitchRequest,
    handleLocalCodexApiLoginRequest,
    handleLocalCodexOfficialLoginRequest,
    handleLocalCodexAuthBackupRequest,
    handleLocalCodexDesktopStatusRequest,
    handleLocalCodexDesktopApplyRequest,
    handleLocalCodexDesktopRestoreRequest,
    handleLocalCodexDesktopSwitchRequest,
    handleLocalCodexDesktopApiLoginRequest,
    handleLocalCodexDesktopOfficialLoginRequest,
    handleLocalCodexDesktopAuthBackupRequest,
    handleLocalGeminiCliStatusRequest,
    handleLocalGeminiCliApplyRequest,
    handleLocalGeminiCliRestoreRequest,
    handleLocalModelsListRequest,
    handleLocalRouteTestRequest,
    handleLocalAuditConversationsRequest,
    handleLocalAuditConversationsClearRequest,
    handleLocalAuditRetryRequest,
    handleLocalUsageReportRequest,
    handleLocalProfileTestAuthRequest,
    handleLocalUsageSummaryRequest,
    handleLocalPromptsSyncRequest,
    handleLocalPromptsPresetsGetRequest,
    handleLocalPromptsPresetsSaveRequest,
    handleLocalPromptsPresetsApplyRequest,
    handleLocalMcpHubGetRequest,
    handleLocalMcpHubSaveRequest,
    handleLocalMcpHubLogsRequest,
    sendCodexLocalRateLimitsOrError,
  };
}

module.exports = {
  createManagementHandlers,
  _test: {
    buildCliLaunchCommand,
    buildCliLaunchSpec,
    encodePowerShellCommand,
    normalizeCliTerminal,
    parseBoundedInteger,
    parseCliArgs,
    readJsonBodyFromRequest,
    redactConfigSecrets,
    resolveCliWorkDir,
  },
};
