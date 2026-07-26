/**
 * OpenAI 兼容 API → HTTP 反向代理
 * 把 HTTP 包装成 HTTPS，支持流式补全、CORS
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const crypto = require('crypto');
const { parseBoundedInteger } = require('./lib/proxy/management-utils');

const {
  createLogger,
  withRequest,
  newRequestId,
  getReqId,
  installReqIdMiddleware,
  sanitizeLogArgs,
} = require('./lib/proxy/logger');
const { createMetrics, collectDefaultProcessMetrics } = require('./lib/proxy/metrics');
const log = createLogger('proxy');

// 初始化指标 (process_* 注入 5s 周期)
const metricsInstance = createMetrics();
collectDefaultProcessMetrics(metricsInstance);
// 应用级指标声明
metricsInstance.counter('proxy_requests_total', 'Total number of proxy requests received');
metricsInstance.counter('proxy_errors_total', 'Total number of proxy request errors');
metricsInstance.counter('proxy_config_reloads_total', 'Total number of config hot-reloads');
metricsInstance.counter('proxy_route_cache_total', 'Route resolution cache events');
metricsInstance.histogram('proxy_request_duration_seconds', 'Proxy request duration in seconds', {
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});
metricsInstance.gauge(
  'proxy_active_profile_id',
  'Currently active profile id (set to 1 for whichever is active)'
);

const APP_ID = 'https-proxy-manager';
let MANAGEMENT_TOKEN = process.env.MGMT_TOKEN || '';
let PACKAGE_VERSION = '0.1.0';
try {
  PACKAGE_VERSION = require('./package.json').version || PACKAGE_VERSION;
} catch (err) {}

const { createAuthResolver } = require('./lib/proxy/auth-resolver');
const { createClaudeSelfTestTargetResolver } = require('./lib/proxy/claude-self-test-target');
const { createCoreRequestHandler } = require('./lib/proxy/core-request-handler');
const { createManagementHandlers } = require('./lib/proxy/handlers/management');
const { createProxyTransport } = require('./lib/proxy/proxy-transport');
const { createRequestObservability } = require('./lib/proxy/request-observability');
const { createRuntimeConfigController } = require('./lib/proxy/runtime-config-controller');
const { createRuntimeSupport } = require('./lib/proxy/runtime-support');
const { createRuntimeHttpAgents } = require('./lib/proxy/runtime/http-agents');
const { authorizeManagementRequest } = require('./lib/proxy/management-auth');
const { startProxyServers } = require('./lib/proxy/server-lifecycle');

const {
  DATA_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  loadConfig,
  getActiveProfile,
  getProfiles,
  getLocalServer,
  getEntryServers,
  getModelRoutes,
  resolveProfileProtocolVersion,
  migrateLegacyRuntimeFiles,
  encryptKey,
  decryptKey,
} = require('./lib/proxy/config');

migrateLegacyRuntimeFiles();

const {
  createHttpsAgent,
  httpAgent: globalHttpAgent,
  httpsAgent: initialHttpsAgent,
  shouldVerifyUpstreamTls,
} = createRuntimeHttpAgents({ loadConfig });
let globalHttpsAgent = initialHttpsAgent;
https.globalAgent = globalHttpsAgent;
http.globalAgent = globalHttpAgent;

const { requestWithProxy, resetLocalProxyDetectionCache } = createProxyTransport({
  loadConfig,
  shouldVerifyUpstreamTls,
});

const runtimeSupport = createRuntimeSupport({
  dataDir: DATA_DIR,
  initialToken: MANAGEMENT_TOKEN,
  logger: log,
});
function writeManagementTokenFile(managementPort) {
  MANAGEMENT_TOKEN = runtimeSupport.writeManagementTokenFile(managementPort);
  return MANAGEMENT_TOKEN;
}
runtimeSupport.setupFileConsoleTee();

const {
  stableHash,
  stableId,
  fallbackId: fallbackIdWithOptions,
  stableCreated,
} = require('./lib/proxy/ids');
const { CERT_DIR, CERT_FILE, KEY_FILE, ensureCert } = require('./lib/proxy/cert');
const ACTIVE_HTTPS_SERVERS = [];

function refreshLocalTlsServers() {
  const tlsConfig = ensureCert();
  let refreshed = 0;
  for (const server of ACTIVE_HTTPS_SERVERS) {
    if (!server || typeof server.setSecureContext !== 'function') continue;
    server.setSecureContext(tlsConfig);
    refreshed += 1;
  }
  return { refreshed };
}

const {
  localModelIds,
  buildLocalOpenAIModelObject,
  buildLocalClaudeModelObject,
  buildLocalModelsResponse,
  parseModelsRequestPath,
  handleModelsRequest: handleLocalModelsRequest,
} = require('./lib/proxy/models');
const {
  parseGeminiError,
  normalizeUpstreamError,
  sendJsonError,
  sendUpstreamError,
  geminiErrorToClaude,
  getGeminiCooldown,
  setGeminiCooldown,
} = require('./lib/proxy/errors');
const {
  geminiFunctionCallArgs,
  cleanToolArgs,
  stripEmptyOptionalToolArgs,
  sanitizeGeminiToolCall,
} = require('./lib/proxy/tools');
const {
  parseTargetUrl,
  routeMatchScore,
  resolveRoute: resolveRouteForModel,
  isGeminiProfile,
  isOpenAIProfile,
  isClaudeProfile,
  shouldConvertResponsesToOpenAIChat,
  isClaudeMessagesPath,
  isConversationRequestPath,
  shouldConvertClaudeMessagesToOpenAI,
  isOpenAIChatCompletionsPath,
  isOpenAIResponsesPath,
  prepareRequestBuffer: prepareRequestBufferForRoute,
  logModelMapping: logRouteModelMapping,
  resetRouteIndex: resetProxyRouteIndex,
  rebuildRouteIndex: rebuildProxyRouteIndex,
} = require('./lib/proxy/routing');
const {
  PROXY_PREFIX: CLAUDE_DESKTOP_PROXY_PREFIX,
  claudeDesktopBaseUrl,
  getClaudeDesktopRoutes,
  getClaudeDesktopGatewayConfig,
  getClaudeDesktopTraeProcessStyle,
  isClaudeDesktop3pRequest,
  stripClaudeDesktopPrefix,
  isClaudeDesktopRequest,
  isLocalClaudeDesktopGatewayUrl,
  isAuthorizedClaudeDesktopRequest,
  removeClaudeDesktopGatewayProvider,
  claudeDesktopStatusFromConfig,
  getClaudeDesktopStatus,
  applyClaudeDesktopConfig,
  restoreClaudeDesktopConfig,
} = require('./lib/proxy/claude-desktop');
const {
  createDiagnostics,
  GEMINI_SAMPLE_FILE,
  TOOL_AUDIT_FILE,
  RESPONSE_SAMPLE_FILE,
  DIAGNOSTICS_OUTBOUND_SSE_FILE,
  DIAGNOSTICS_REQUEST_TOOLS_FILE,
  PROXY_EVENTS_FILE,
} = require('./lib/proxy/diagnostics');
const {
  parseClaudeSseEvent,
  resolveSseBlockIndex,
  deltaPartialJson,
  extractSseDataPayloads,
} = require('./lib/proxy/sse');
const { createOpenAIProtocol } = require('./lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('./lib/proxy/protocol-gemini');
const { createClaudeStream } = require('./lib/proxy/stream-claude');
const { createProxyHandlers } = require('./lib/proxy/handlers');
const { createClaudeFilters } = require('./lib/proxy/claude-filters');
const {
  logFilteredToolBody,
  sendGeminiRateLimit: sendGeminiRateLimitResponse,
  handleCountTokens: handleLocalCountTokens,
} = require('./lib/proxy/local-handlers');
const {
  getClientIp,
  decodeBodyBuffer,
  extractJsonField,
  estimateTokens,
  collectLimitedRequestBody,
} = require('./lib/proxy/request-utils');
const {
  appendAuditRecord,
  getAuditRecords,
  getAuditRecordById,
  clearAuditRecords,
} = require('./lib/proxy/audit');
const {
  bufferFromResponseChunk,
  sendRequestTooLarge,
  appendAuditText: appendAuditTextBounded,
  createConversationAuditData,
  installConversationAuditResponseCapture,
  populateAuditDataFromPrepared: populateAuditDataFromPreparedWithDeps,
} = require('./lib/proxy/conversation-audit-utils');
const {
  resolveCliSession,
  applyManagedAuthHeaders,
  applyCliSessionModelOverride,
} = require('./lib/proxy/cli-session-routing');
const { buildOutgoingHeaders } = require('./lib/proxy/upstream-request');
const {
  authorizeEntryRequest,
  profileMatchesEntryKey,
  stripEntryAuthHeaders,
} = require('./lib/proxy/entry-auth');
const { resolveUpstreamRecovery } = require('./lib/proxy/upstream-retry');
const {
  redactHeaders,
  headersForReplay,
  captureRequestBody,
  parseJsonText,
  extractUsageFromJsonPayload,
  usageFromSsePayload,
  mergeUsage,
  estimateUsageForRecord,
  estimateCost,
  buildUsageReport,
} = require('./lib/proxy/usage-report');
const { dispatchLocalManagementRoute } = require('./lib/proxy/management-router');
const {
  ENV_CHECK_TOOLS,
  startToolInstallJob,
  runToolInstall,
  listInstallJobs,
  checkEnvironmentTools,
  clearEnvCaches,
} = require('./lib/proxy/env-tools');
const { createToolConfigHandlers } = require('./lib/proxy/tool-config-handlers');
const {
  fileSignature,
  readLastLinesOfJsonl,
  isQuietLocalPollRequest,
  isLocalManagementPath,
  installManagementCorsGuard,
  parsePortOrDefault,
} = require('./lib/proxy/management-utils');
const {
  formatRateLimits,
  formatCodexLocalRateLimits,
  prioritizeCodexSessionFiles,
  readLatestCodexLocalRateLimits,
} = require('./lib/proxy/rate-limits');
const {
  TRAE_OFFICIAL_TARGET_URL,
  getTraeOfficialBridgeUrl,
  isTraeOfficialProfile,
  isTraeOfficialTarget,
  readTraeStorageSummary,
  queryTraeStateRows,
  traeModelsFromStateRows,
  buildTraeOfficialModelsResponseFromRows,
  buildTraeOfficialModelsResponse,
  normalizeTraeOfficialModelName,
  traeOfficialModelSupport,
  buildTraeBridgePromptFromOpenAIChat,
  buildTraeBridgeOpenAIChatCompletion,
  normalizeTraeBridgeText,
} = require('./lib/proxy/trae-official');
const {
  GOOGLE_OFFICIAL_CODE_ASSIST_USER_AGENT,
  googleOfficialCodeAssistUrl,
  isGoogleOfficialProfile,
  isGoogleOfficialLoginToken,
  buildGoogleOfficialModelsResponse,
  googleOfficialModelsFromAvailableModels,
  buildGoogleOfficialLoadCodeAssistRequest,
  buildGoogleOfficialAvailableModelsRequest,
  buildGoogleOfficialRetrieveUserQuotaRequest,
  formatGoogleOfficialAvailableModels,
  formatGoogleOfficialUserQuota,
  decodeAntigravityOAuthStateValue,
  readAntigravityOfficialCredentialState,
  readGoogleOfficialCredentialFile,
} = require('./lib/proxy/google-official');
const {
  buildProfileAuthProbeRequest,
  evaluateOpenAIProfileAuthResponse,
  evaluateGeminiProfileAuthResponse,
  evaluateClaudeProfileAuthResponse,
} = require('./lib/proxy/profile-auth');
const { createHttpClient } = require('./lib/proxy/http-client');
const { validateConfig } = require('./lib/proxy/validator');
const { createCertManagement } = require('./lib/proxy/cert-management');
const {
  handleLocalPromptsSyncRequest,
  handleLocalPromptsPresetsRequest,
} = require('./lib/proxy/prompts-sync');
const { logUsage, getUsageSummary } = require('./lib/proxy/usage');
const { createGoogleOfficialRuntime } = require('./lib/proxy/google-official-runtime');
const { createMcpHub } = require('./lib/proxy/mcp-hub');
const { getModelsUrl, buildModelListRequest } = require('./lib/proxy/model-list');
const {
  isRedactedSecret,
  isOpenAIOfficialLoginToken,
  shouldUseChatGPTBackendForOfficialLogin,
  officialLoginProvider,
  configuredAuthMode,
  inferOfficialProfileAuthMode,
} = require('./lib/proxy/auth-mode');
const {
  isOpenAIOfficialCodexTarget,
  normalizeOpenAIOfficialCodexModelName,
  codexOfficialModelsFromCache,
  buildOpenAIOfficialCodexModelsResponse,
  openAIOfficialCodexModelSupport,
} = require('./lib/proxy/openai-official');
const { createTraeBridgeRuntime } = require('./lib/proxy/trae-bridge-runtime');
const { createTraeOfficialHandlers } = require('./lib/proxy/trae-official-handlers');
const { createTraeStatusHandlers } = require('./lib/proxy/trae-status-handlers');
const {
  entryLabel,
  modelsFormatForEntry,
  routesForEntry,
  forceClaudeEntry,
  forceChatEntry,
  forceResponsesEntry,
  sendEntryHealth,
  sendUnauthorizedClaudeDesktop,
  isPublicLocalManagementPath,
  isEntryHealthPath,
  isAllowedEntryPath,
  sendEntryPathError,
} = require('./lib/proxy/entry-routing');
const {
  currentTraeDebugSettings,
  startNativeDeepProgress,
} = require('./lib/proxy/trae-debug-center');

let CONFIG = loadConfig({ throwOnError: true });
let PROFILES = getProfiles(CONFIG);
let ACTIVE_PROFILE = getActiveProfile(CONFIG);
let LOCAL_SERVER = getLocalServer(CONFIG);

const PORT = parsePortOrDefault(process.env.PORT || LOCAL_SERVER.listenPort, 3443);
const CLI_SESSIONS = new Map();
let MODEL_ROUTES = getModelRoutes(CONFIG);
let CLAUDE_DESKTOP_ROUTES = getClaudeDesktopRoutes(CONFIG);
const PROTOCOL_OPTIONS = { ...DEFAULT_CONFIG.protocolOptions, ...(CONFIG.protocolOptions || {}) };
const makeRequest = createHttpClient({
  httpAgent: globalHttpAgent,
  httpsAgent: globalHttpsAgent,
});
const makeLocalClaudeSelfTestRequest = createHttpClient({
  httpAgent: globalHttpAgent,
  httpsAgent: new https.Agent({
    keepAlive: false,
    rejectUnauthorized: false,
  }),
});
const mcpHub = createMcpHub({ getConfig: () => CONFIG });

const getClaudeDesktopSelfTestTarget = createClaudeSelfTestTargetResolver({
  claudeDesktopBaseUrl,
  claudeDesktopProxyPrefix: CLAUDE_DESKTOP_PROXY_PREFIX,
  getClaudeDesktopGatewayConfig,
  getClaudeDesktopRoutes,
  getClaudeDesktopTraeProcessStyle,
  getConfig: () => CONFIG,
  getProfiles: () => PROFILES,
  isTraeOfficialProfile,
  isTraeOfficialTarget,
});
const {
  refreshGoogleAccessToken,
  getFreshAntigravityOfficialAccessToken,
  fetchGoogleOfficialAvailableModels,
  resolveGoogleOfficialLoginPrepared,
} = createGoogleOfficialRuntime({
  makeRequest,
  googleOfficialCodeAssistUrl,
  googleOfficialModelsFromAvailableModels,
  readAntigravityOfficialCredentialState,
  isGoogleOfficialLoginToken,
  buildGoogleOfficialLoadCodeAssistRequest,
});
const { handleLocalCertStatusRequest, handleLocalCertTrustRequest, handleLocalCertUntrustRequest } =
  createCertManagement({
    getEntryServersSnapshot: () =>
      Array.isArray(ENTRY_SERVERS) && ENTRY_SERVERS.length ? ENTRY_SERVERS : [LOCAL_SERVER],
    refreshTlsServers: refreshLocalTlsServers,
  });
const {
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
} = createTraeStatusHandlers({
  makeRequest,
  makeClaudeSelfTestRequest: makeLocalClaudeSelfTestRequest,
  getClaudeMessagesBaseUrl: () => {
    const servers =
      Array.isArray(ENTRY_SERVERS) && ENTRY_SERVERS.length ? ENTRY_SERVERS : [LOCAL_SERVER];
    const entry = servers.find((item) => item && item.protocol === 'claude') || servers[0] || {};
    const host = entry.host && entry.host !== '0.0.0.0' ? entry.host : 'localhost';
    const port = entry.listenPort || PORT || 3443;
    const basePath = entry.basePath || '/v1';
    return `https://${host}:${port}${basePath}`;
  },
  getClaudeSelfTestTarget: getClaudeDesktopSelfTestTarget,
});
const {
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
} = createToolConfigHandlers();

const { resolveOfficialCredentials, resolveConfiguredProfile } = createAuthResolver({
  loadConfig,
  getProfiles,
  decryptKey,
  officialLoginProvider,
  inferOfficialProfileAuthMode,
  configuredAuthMode,
  isRedactedSecret,
  readGoogleOfficialCredentialFile,
  refreshGoogleAccessToken,
  getFreshAntigravityOfficialAccessToken,
  resolveGoogleOfficialLoginPrepared,
  shouldUseChatGPTBackendForOfficialLogin,
  TRAE_OFFICIAL_TARGET_URL,
  readTraeStorageSummary,
  isGoogleOfficialLoginToken,
  isOpenAIOfficialLoginToken,
  PROFILES: () => PROFILES, // Use a getter if PROFILES is re-assigned
});

const {
  AUDIT_MAX_CAPTURE_BYTES,
  AUDIT_MAX_TEXT_CHARS,
  MAX_CONVERSION_RESPONSE_BYTES,
  MAX_REQUEST_BODY_BYTES,
  appendAuditText,
  auditClaudeSseToolCalls,
  auditToolCall,
  compactDiagnosticsValue,
  contentLengthForDiagnostics,
  diagnosticsMetaFromResponse,
  extractDiagnosticsSsePayload,
  filterClaudeCompatibleBlocks,
  flushJsonlWrites,
  getDiagnosticsConfig,
  inputKeys,
  installLocalManagementRequestEndLogger,
  isClaudeThinkingBlock,
  logModelMapping,
  logProxyEvent,
  logRequestEnd,
  normalizeClaudeContent,
  populateAuditDataFromPrepared,
  redactDiagnosticsValue,
  sampleDiagnostics,
  sampleGeminiToolEvent,
  sampleOutboundSse,
  sampleRequestToolResults,
  sampleResponseChunk,
  shouldCaptureDiagnostics,
  summarizeClaudeToolHistory,
  truncateDiagnosticsText,
  writeJsonlBounded,
} = createRequestObservability({
  appendAuditTextBounded,
  captureRequestBody,
  createClaudeFilters,
  createDiagnostics,
  estimateTokens,
  getReqId,
  isClaudeProfile,
  isGeminiProfile,
  isQuietLocalPollRequest,
  logRouteModelMapping,
  metricsInstance,
  parseBoundedInteger,
  populateAuditDataFromPreparedWithDeps,
  sanitizeGeminiToolCall,
  getConfig: () => CONFIG,
  protocolOptions: PROTOCOL_OPTIONS,
});

const { reloadProxyConfig } = createRuntimeConfigController({
  configFile: CONFIG_FILE,
  createHttpsAgent,
  defaultProtocolOptions: DEFAULT_CONFIG.protocolOptions,
  getActiveProfile,
  getClaudeDesktopRoutes,
  getLocalServer,
  getModelRoutes,
  getProfiles,
  loadConfig,
  log,
  metricsInstance,
  protocolOptions: PROTOCOL_OPTIONS,
  rebuildProxyRouteIndex,
  resetLocalProxyDetectionCache,
  setHttpsAgent: (agent) => {
    globalHttpsAgent = agent;
    https.globalAgent = agent;
  },
  setRuntimeState: (state) => {
    CONFIG = state.config;
    PROFILES = state.profiles;
    ACTIVE_PROFILE = state.activeProfile;
    LOCAL_SERVER = state.localServer;
    MODEL_ROUTES = state.modelRoutes;
    CLAUDE_DESKTOP_ROUTES = state.claudeDesktopRoutes;
  },
});

const managementHandlers = createManagementHandlers({
  CONFIG: () => CONFIG,
  PROFILES: () => PROFILES,
  ACTIVE_PROFILE: () => ACTIVE_PROFILE,
  LOCAL_SERVER: () => LOCAL_SERVER,
  MODEL_ROUTES: () => MODEL_ROUTES,
  ENTRY_SERVERS: () => ENTRY_SERVERS,
  APP_ID,
  PACKAGE_VERSION,
  PORT,
  CLI_SESSIONS,
  PROTOCOL_OPTIONS,
  metricsInstance,
  reloadProxyConfig,
  makeRequest,
  requestWithProxy,
  logProxyEvent,
  logRequestEnd,
  decryptKey,
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
});

function fallbackId(prefix, value) {
  return fallbackIdWithOptions(prefix, value, PROTOCOL_OPTIONS);
}

/* ========== 代理逻辑 ========== */

function resolveRoute(model) {
  return resolveRouteForModel(model, MODEL_ROUTES, PROFILES, ACTIVE_PROFILE);
}

function resolveClaudeDesktopRoute(model) {
  return resolveRouteForModel(model, CLAUDE_DESKTOP_ROUTES, PROFILES, ACTIVE_PROFILE);
}

function handleModelsRequest(clientReq, clientRes, requestInfo, forcedFormat) {
  return handleLocalModelsRequest(clientReq, clientRes, requestInfo, MODEL_ROUTES, forcedFormat);
}

function prepareRequestBuffer(buffer, encoding) {
  return prepareRequestBufferForRoute(buffer, encoding, ACTIVE_PROFILE, resolveRoute);
}

function prepareRequestBufferWithResolver(buffer, encoding, resolver) {
  return prepareRequestBufferForRoute(buffer, encoding, ACTIVE_PROFILE, resolver || resolveRoute);
}

// 全局异常处理，避免进程意外崩溃
const exceptionHandlers = require('./lib/proxy/exception-handlers');
exceptionHandlers.install({
  onEvent: (kind, payload) => {
    if (typeof logProxyEvent === 'function') {
      try {
        logProxyEvent(kind, payload);
      } catch (e) {
        /* ignore */
      }
    }
  },
});

const {
  geminiClaudeToolId,
  rememberGeminiToolCall,
  geminiToolResponseText,
  normalizeClaudeSystem,
  claudeMessagesToGemini,
  claudeStopReasonFromGemini,
  geminiUsageToClaude,
  geminiResponseToClaude,
  geminiGeneratePath,
} = createGeminiProtocol({
  stableHash,
  fallbackId,
  cleanToolArgs,
  geminiFunctionCallArgs,
  sanitizeGeminiToolCall,
  filterClaudeCompatibleBlocks,
  normalizeClaudeContent,
  isClaudeThinkingBlock,
  sampleGeminiToolEvent,
  protocolOptions: PROTOCOL_OPTIONS,
});

const {
  openAIChatToClaudeMessages,
  claudeResponseToOpenAIChat,
  processClaudeSseChunkToOpenAI,
  flushClaudeSseToOpenAI,
  claudeMessagesToOpenAIChat,
  openAIResponseToClaudeMessage,
  openAIResponsesToChat,
  openAIChatToResponses,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  openAIChatToResponsesRequest,
  openAIResponsesToChatResponse,
  processOpenAIResponsesSseChunkToChat,
  flushOpenAIResponsesSseToChat,
} = createOpenAIProtocol({
  cleanToolArgs,
  fallbackId,
  stableCreated,
  isClaudeThinkingBlock,
  filterClaudeCompatibleBlocks,
  normalizeClaudeContent,
  normalizeClaudeSystem,
  geminiToolResponseText,
  parseClaudeSseEvent,
  deltaPartialJson,
  protocolOptions: PROTOCOL_OPTIONS,
});

let filterClaudeToolUseBlocks;
let filterClaudeJsonBody;

const {
  makeSafeClaudeToolUseContentBlock,
  writeClaudeSseEvent,
  flushPendingGeminiToolCall,
  geminiClaudeStopReason,
  processGeminiSseEvent,
  processClaudeSseChunk,
  flushClaudeSseFilter,
  processOpenAISseChunkToClaude,
  flushOpenAISseToClaude,
} = createClaudeStream({
  cleanToolArgs,
  stripEmptyOptionalToolArgs,
  sanitizeGeminiToolCall,
  sampleGeminiToolEvent,
  auditToolCall,
  sampleOutboundSse,
  parseClaudeSseEvent,
  resolveSseBlockIndex,
  deltaPartialJson,
  geminiFunctionCallArgs,
  geminiClaudeToolId,
  rememberGeminiToolCall,
  claudeStopReasonFromGemini,
  geminiUsageToClaude,
  fallbackId,
  protocolOptions: PROTOCOL_OPTIONS,
});

({ filterClaudeToolUseBlocks, filterClaudeJsonBody } = createClaudeFilters({
  protocolOptions: PROTOCOL_OPTIONS,
  makeSafeClaudeToolUseContentBlock,
}));

const {
  callTraeOfficialBridge,
  streamTraeOfficialBridge,
  writeTraeBridgeOpenAIStream,
  writeTraeBridgeOpenAILiveStream,
  buildTraeBridgeOpenAIResponsesResponse,
  writeTraeBridgeOpenAIResponsesStream,
  writeTraeBridgeOpenAIResponsesLiveStream,
  buildTraeBridgeClaudeMessageResponse,
  writeTraeBridgeClaudeStream,
  writeTraeBridgeClaudeLiveStream,
} = createTraeBridgeRuntime({
  makeRequest,
  getTraeOfficialBridgeUrl,
  normalizeTraeBridgeText,
  buildTraeBridgeOpenAIChatCompletion,
  openAIChatToResponses,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  writeClaudeSseEvent,
  fallbackId,
  stableCreated,
  getTraeDebugSettings: currentTraeDebugSettings,
  startNativeDeepProgress,
});

const {
  handleTraeOfficialChatCompletion,
  handleTraeOfficialResponses,
  handleTraeOfficialClaudeMessages,
} = createTraeOfficialHandlers({
  sendJsonError,
  logRequestEnd,
  normalizeTraeOfficialModelName,
  buildTraeBridgePromptFromOpenAIChat,
  openAIResponsesToChat,
  claudeMessagesToOpenAIChat,
  getTraeOfficialBridgeUrl,
  callTraeOfficialBridge,
  streamTraeOfficialBridge,
  writeTraeBridgeOpenAIStream,
  writeTraeBridgeOpenAILiveStream,
  buildTraeBridgeOpenAIChatCompletion,
  buildTraeBridgeOpenAIResponsesResponse,
  writeTraeBridgeOpenAIResponsesStream,
  writeTraeBridgeOpenAIResponsesLiveStream,
  buildTraeBridgeClaudeMessageResponse,
  writeTraeBridgeClaudeStream,
  writeTraeBridgeClaudeLiveStream,
});

function sendGeminiRateLimit(
  clientReq,
  clientRes,
  upstreamPath,
  startTime,
  targetModel,
  retryAfterSeconds,
  message,
  meta
) {
  return sendGeminiRateLimitResponse(
    clientReq,
    clientRes,
    upstreamPath,
    startTime,
    targetModel,
    retryAfterSeconds,
    message,
    meta,
    logRequestEnd
  );
}

function handleCountTokens(clientReq, clientRes, requestBuffer, requestEndLogger, startTime) {
  return handleLocalCountTokens(
    clientReq,
    clientRes,
    requestBuffer,
    estimateTokens,
    requestEndLogger,
    startTime
  );
}

const {
  handleClaudeMessagesToOpenAIChat,
  handleClaudeMessagesToOpenAIResponses,
  handleOpenAIChatToClaudeMessages,
  handleOpenAIChatToOpenAIResponses,
  handleOpenAIResponsesToOpenAIChat,
  handleOpenAIResponsesToClaudeMessages,
  handleOpenAIResponsesToGeminiMessages,
  handleOpenAIChatToGeminiMessages,
  handleGeminiMessages,
} = createProxyHandlers({
  claudeMessagesToOpenAIChat,
  openAIResponseToClaudeMessage,
  openAIChatToClaudeMessages,
  claudeResponseToOpenAIChat,
  openAIResponsesToChat,
  openAIChatToResponses,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  openAIChatToResponsesRequest,
  openAIResponsesToChatResponse,
  processOpenAIResponsesSseChunkToChat,
  flushOpenAIResponsesSseToChat,
  claudeMessagesToGemini,
  geminiGeneratePath,
  geminiResponseToClaude,
  parseGeminiError,
  getGeminiCooldown,
  setGeminiCooldown,
  sendGeminiRateLimit,
  sendUpstreamError,
  sendJsonError,
  writeClaudeSseEvent,
  processOpenAISseChunkToClaude,
  flushOpenAISseToClaude,
  processClaudeSseChunkToOpenAI,
  flushClaudeSseToOpenAI,
  processGeminiSseEvent,
  flushPendingGeminiToolCall,
  geminiClaudeStopReason,
  sampleResponseChunk,
  logProxyEvent,
  logRequestEnd,
  fallbackId,
  stableCreated,
  extractSseDataPayloads,
  mcpHub,
  maxConversionResponseBytes: MAX_CONVERSION_RESPONSE_BYTES,
});

const ENTRY_SERVERS = getEntryServers(CONFIG);

function handleRequest(clientReq, clientRes, entry) {
  // 绑定 reqId 到本请求的异步作用域，日志自动附加
  const reqId = clientReq.reqId || clientReq.headers['x-request-id'] || newRequestId();
  clientReq.reqId = reqId;
  if (!clientRes.headersSent)
    try {
      clientRes.setHeader('x-request-id', reqId);
    } catch (e) {}
  return withRequest({ reqId }, () => handleRequestInner(clientReq, clientRes, entry));
}

const handleRequestInner = createCoreRequestHandler({
  AUDIT_MAX_CAPTURE_BYTES,
  AUDIT_MAX_TEXT_CHARS,
  MAX_REQUEST_BODY_BYTES,
  appendAuditRecord,
  applyCliSessionModelOverride,
  applyManagedAuthHeaders,
  authorizeManagementRequest,
  authorizeEntryRequest,
  buildOutgoingHeaders,
  captureRequestBody,
  collectLimitedRequestBody,
  createConversationAuditData,
  decryptKey,
  dispatchLocalManagementRoute,
  entryLabel,
  estimateCost,
  estimateUsageForRecord,
  extractUsageFromJsonPayload,
  flushClaudeSseFilter,
  forceChatEntry,
  forceClaudeEntry,
  forceResponsesEntry,
  getClaudeDesktopTraeProcessStyle,
  getClientIp,
  getProfiles,
  handleClaudeMessagesToOpenAIChat,
  handleClaudeMessagesToOpenAIResponses,
  handleCountTokens,
  handleGeminiMessages,
  handleLocalModelsRequest,
  handleOpenAIChatToClaudeMessages,
  handleOpenAIChatToGeminiMessages,
  handleOpenAIChatToOpenAIResponses,
  handleOpenAIResponsesToClaudeMessages,
  handleOpenAIResponsesToGeminiMessages,
  handleOpenAIResponsesToOpenAIChat,
  handleTraeOfficialChatCompletion,
  handleTraeOfficialClaudeMessages,
  handleTraeOfficialResponses,
  installConversationAuditResponseCapture,
  installLocalManagementRequestEndLogger,
  installManagementCorsGuard,
  isAllowedEntryPath,
  isAuthorizedClaudeDesktopRequest,
  isClaudeDesktop3pRequest,
  isClaudeDesktopRequest,
  isClaudeMessagesPath,
  isClaudeProfile,
  isConversationRequestPath,
  isEntryHealthPath,
  isGeminiProfile,
  isLocalManagementPath,
  isOpenAIChatCompletionsPath,
  isOpenAIProfile,
  isOpenAIResponsesPath,
  isPublicLocalManagementPath,
  isQuietLocalPollRequest,
  loadConfig,
  log,
  logModelMapping,
  logProxyEvent,
  logRequestEnd,
  logUsage,
  managementHandlers,
  mcpHub,
  mergeUsage,
  metricsInstance,
  modelsFormatForEntry,
  parseModelsRequestPath,
  parsePortOrDefault,
  parseTargetUrl,
  populateAuditDataFromPrepared,
  prepareRequestBufferWithResolver,
  processClaudeSseChunk,
  profileMatchesEntryKey,
  redactHeaders,
  resolveClaudeDesktopRoute,
  resolveCliSession,
  resolveOfficialCredentials,
  resolveProfileProtocolVersion,
  resolveRoute,
  resolveUpstreamRecovery,
  routesForEntry,
  sampleRequestToolResults,
  sampleResponseChunk,
  sendEntryHealth,
  sendEntryPathError,
  sendJsonError,
  sendRequestTooLarge,
  sendUnauthorizedClaudeDesktop,
  shouldConvertClaudeMessagesToOpenAI,
  shouldConvertResponsesToOpenAIChat,
  stripClaudeDesktopPrefix,
  stripEntryAuthHeaders,
  usageFromSsePayload,
  getRuntimeState: () => ({
    ACTIVE_PROFILE,
    CLAUDE_DESKTOP_ROUTES,
    CLI_SESSIONS,
    CONFIG,
    MANAGEMENT_TOKEN,
    MODEL_ROUTES,
    PROFILES,
    globalHttpAgent,
    globalHttpsAgent,
  }),
});

/* ========== 启动 ========== */

if (require.main === module) {
  startProxyServers({
    ACTIVE_HTTPS_SERVERS,
    APP_ID,
    DATA_DIR,
    ensureCert,
    exceptionHandlers,
    handleRequest,
    installManagementCorsGuard,
    log,
    parsePortOrDefault,
    writeManagementTokenFile,
    getRuntimeState: () => ({
      ACTIVE_PROFILE,
      CONFIG,
      ENTRY_SERVERS,
      LOCAL_SERVER,
      MANAGEMENT_TOKEN,
      MODEL_ROUTES,
      PORT,
    }),
  });
}

module.exports = {
  claudeMessagesToGemini,
  geminiResponseToClaude,
  geminiUsageToClaude,
  claudeStopReasonFromGemini,
  parseTargetUrl,
  geminiGeneratePath,
  processGeminiSseEvent,
  processClaudeSseChunk,
  flushClaudeSseFilter,
  geminiClaudeStopReason,
  filterClaudeToolUseBlocks,
  filterClaudeJsonBody,
  openAIChatToClaudeMessages,
  claudeResponseToOpenAIChat,
  processClaudeSseChunkToOpenAI,
  flushClaudeSseToOpenAI,
  claudeMessagesToOpenAIChat,
  openAIResponseToClaudeMessage,
  openAIResponsesToChat,
  openAIChatToResponses,
  openAIChatToResponsesRequest,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  processOpenAIResponsesSseChunkToChat,
  flushOpenAIResponsesSseToChat,
  processOpenAISseChunkToClaude,
  flushOpenAISseToClaude,
  flushPendingGeminiToolCall,
  getLocalServer,
  getEntryServers,
  getClaudeDesktopRoutes,
  getClaudeDesktopTraeProcessStyle,
  isClaudeDesktop3pRequest,
  stripClaudeDesktopPrefix,
  isClaudeDesktopRequest,
  isLocalClaudeDesktopGatewayUrl,
  isAuthorizedClaudeDesktopRequest,
  removeClaudeDesktopGatewayProvider,
  claudeDesktopStatusFromConfig,
  shouldConvertResponsesToOpenAIChat,
  prepareRequestBuffer,
  prepareRequestBufferWithResolver,
  buildLocalModelsResponse,
  buildLocalOpenAIModelObject,
  buildLocalClaudeModelObject,
  parseModelsRequestPath,
  localModelIds,
  redactDiagnosticsValue,
  summarizeClaudeToolHistory,
  extractDiagnosticsSsePayload,
  writeJsonlBounded,
  flushJsonlWrites,
  parseGeminiError,
  geminiErrorToClaude,
  routeMatchScore,
  cleanToolArgs,
  stripEmptyOptionalToolArgs,
  stableHash,
  stableId,
  fallbackId,
  filterClaudeCompatibleBlocks,
  normalizeUpstreamError,
  sendUpstreamError,
  isOpenAIOfficialLoginToken,
  isGoogleOfficialLoginToken,
  shouldUseChatGPTBackendForOfficialLogin,
  officialLoginProvider,
  configuredAuthMode,
  inferOfficialProfileAuthMode,
  getModelsUrl,
  isOpenAIOfficialCodexTarget,
  codexOfficialModelsFromCache,
  buildOpenAIOfficialCodexModelsResponse,
  openAIOfficialCodexModelSupport,
  isTraeOfficialTarget,
  isTraeOfficialProfile,
  normalizeTraeOfficialModelName,
  queryTraeStateRows,
  traeModelsFromStateRows,
  buildTraeOfficialModelsResponseFromRows,
  buildTraeOfficialModelsResponse,
  traeOfficialModelSupport,
  getTraeOfficialBridgeUrl,
  buildTraeBridgePromptFromOpenAIChat,
  buildTraeBridgeOpenAIChatCompletion,
  normalizeTraeBridgeText,
  googleOfficialCodeAssistUrl,
  buildGoogleOfficialModelsResponse,
  googleOfficialModelsFromAvailableModels,
  decodeAntigravityOAuthStateValue,
  buildGoogleOfficialLoadCodeAssistRequest,
  buildGoogleOfficialAvailableModelsRequest,
  buildGoogleOfficialRetrieveUserQuotaRequest,
  formatGoogleOfficialAvailableModels,
  formatGoogleOfficialUserQuota,
  formatCodexLocalRateLimits,
  prioritizeCodexSessionFiles,
  buildModelListRequest,
  buildProfileAuthProbeRequest,
  evaluateOpenAIProfileAuthResponse,
  evaluateGeminiProfileAuthResponse,
  evaluateClaudeProfileAuthResponse,
  setGeminiCooldown,
  getGeminiCooldown,
  ensureCert,
  CERT_DIR,
  CERT_FILE,
  MANAGEMENT_TOKEN,
  managementHandlers,
};
