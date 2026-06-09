/**
 * OpenAI 兼容 API → HTTP 反向代理
 * 把 HTTP 包装成 HTTPS，支持流式补全、CORS
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const net = require('net');
const util = require('util');
const crypto = require('crypto');

const {
  createLogger,
  withRequest,
  newRequestId,
  installReqIdMiddleware,
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
const MANAGEMENT_TOKEN = process.env.MGMT_TOKEN || crypto.randomBytes(16).toString('hex');
let PACKAGE_VERSION = '0.1.0';
try {
  PACKAGE_VERSION = require('./package.json').version || PACKAGE_VERSION;
} catch (err) {}

function shouldVerifyUpstreamTls() {
  if (process.env.PROXY_ALLOW_UNTRUSTED_UPSTREAM === '1') return false;
  try {
    const cfg = loadConfig();
    return cfg.appSettings && cfg.appSettings.verifyUpstreamTls !== false;
  } catch (e) {
    return true;
  }
}

function createHttpsAgent() {
  return new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000,
    rejectUnauthorized: shouldVerifyUpstreamTls(),
  });
}

let globalHttpsAgent = createHttpsAgent();
const globalHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000,
});
https.globalAgent = globalHttpsAgent;
http.globalAgent = globalHttpAgent;

let detectedProxyUrl = null;
let detectedProxyType = 'http'; // 'http' 或 'socks5'
let lastDetectTime = 0;
let proxyDetectCached = false;

function detectLocalProxy(callback) {
  try {
    const { loadConfig } = require('./lib/proxy/config');
    const cfg = loadConfig();
    if (cfg && cfg.appSettings && cfg.appSettings.disableLocalProxy) {
      if (callback) callback(null, 'http');
      return;
    }
  } catch (e) {}

  if (proxyDetectCached && Date.now() - lastDetectTime < 15000) {
    if (callback) callback(detectedProxyUrl, detectedProxyType);
    return;
  }

  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;
  if (envProxy) {
    detectedProxyUrl = envProxy;
    detectedProxyType = envProxy.startsWith('socks') ? 'socks5' : 'http';
    lastDetectTime = Date.now();
    proxyDetectCached = true;
    if (callback) callback(detectedProxyUrl, detectedProxyType);
    return;
  }

  const ports = [7890, 10809, 7893, 10808];
  let finished = 0;
  let found = false;

  for (const port of ports) {
    const socket = new net.Socket();
    socket.setTimeout(250); // 250ms timeout for robustness

    socket.on('connect', () => {
      if (found) {
        socket.destroy();
        return;
      }

      socket.write(Buffer.from([0x05, 0x01, 0x00]));

      const onProxyFound = (type) => {
        if (found) return;
        found = true;
        detectedProxyType = type;
        detectedProxyUrl = `${type}://127.0.0.1:${port}`;
        console.log(
          `[proxy] Auto-detected local ${type} proxy on port ${port}: ${detectedProxyUrl}`
        );
        lastDetectTime = Date.now();
        proxyDetectCached = true;
        socket.destroy();
        if (callback) callback(detectedProxyUrl, detectedProxyType);
      };

      socket.once('data', (chunk) => {
        if (chunk.length >= 2 && chunk[0] === 0x05) {
          onProxyFound('socks5');
        } else {
          onProxyFound('http');
        }
      });

      socket.on('end', () => onProxyFound('http'));
      socket.on('close', () => {
        if (!found) onProxyFound('http');
      });
      socket.on('error', () => {
        if (!found) onProxyFound('http');
      });
    });

    const onFail = () => {
      if (!found && !socket.destroyed) {
        socket.destroy();
        checkFinished();
      }
    };

    socket.on('timeout', onFail);
    socket.on('error', onFail);

    socket.connect(port, '127.0.0.1');
  }

  function checkFinished() {
    finished++;
    if (finished === ports.length && !found) {
      detectedProxyUrl = null;
      lastDetectTime = Date.now();
      proxyDetectCached = true;
      if (callback) callback(null, 'http');
    }
  }
}

// 供连接测试使用的通用请求函数，支持多协议代理检测与无缝自愈隧道
function requestWithProxy(targetUrl, options, callback) {
  const EventEmitter = require('events');
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const emitter = new EventEmitter();
  const requestTimeout = Number(options && options.timeout) || 0;

  function attachRequestTimeout(req) {
    if (requestTimeout > 0 && req && typeof req.setTimeout === 'function') {
      req.setTimeout(requestTimeout, () => {
        req.destroy(new Error(`Request timeout (${requestTimeout}ms)`));
      });
    }
    return req;
  }

  emitter.write = function (chunk) {
    if (emitter.activeReq) emitter.activeReq.write(chunk);
    else emitter.pendingBody = (emitter.pendingBody || '') + chunk;
  };
  emitter.end = function () {
    if (emitter.activeReq) emitter.activeReq.end();
    else emitter.ended = true;
  };
  emitter.destroy = function (err) {
    if (emitter.activeReq && typeof emitter.activeReq.destroy === 'function') {
      emitter.activeReq.destroy(err);
    }
  };

  detectLocalProxy((proxyUrl, proxyType) => {
    const target = url.parse(targetUrl);
    let fallbackTriggered = false;

    function executeDirect() {
      if (fallbackTriggered) return;
      fallbackTriggered = true;

      const transport = target.protocol === 'https:' ? https : http;
      const req = attachRequestTimeout(transport.request(targetUrl, options, callback));
      emitter.activeReq = req;

      req.on('error', (e) => {
        emitter.emit('error', e);
      });

      if (emitter.pendingBody) {
        req.write(emitter.pendingBody);
      }
      req.end();
    }

    if (proxyUrl) {
      const proxy = url.parse(proxyUrl);

      if (target.protocol === 'https:') {
        if (proxyType === 'socks5') {
          // SOCKS5 tunnel via socks-proxy-agent (handles handshake + CONNECT)
          let socksAgent;
          try {
            socksAgent = new SocksProxyAgent(proxyUrl, {
              timeout: requestTimeout || 5000,
            });
          } catch (agentErr) {
            console.warn(
              `[proxy] SOCKS5 agent init failed (${agentErr.message}), falling back to direct connection...`
            );
            executeDirect();
            return;
          }
          const req = attachRequestTimeout(
            https.request(
              {
                agent: socksAgent,
                hostname: target.hostname,
                port: target.port || 443,
                path: target.path,
                method: options.method || 'GET',
                headers: { ...(options.headers || {}), host: target.hostname },
              },
              callback
            )
          );
          emitter.activeReq = req;
          req.on('error', (e) => {
            if (!fallbackTriggered) {
              console.warn(
                `[proxy] SOCKS5 via ${proxyUrl} failed (${e.message}), falling back to direct connection...`
              );
              fallbackTriggered = true;
              executeDirect();
            } else {
              emitter.emit('error', e);
            }
          });
          if (emitter.pendingBody) {
            req.write(emitter.pendingBody);
          }
          req.end();
        } else {
          // HTTP CONNECT tunnel
          const connectReq = attachRequestTimeout(
            http.request({
              hostname: proxy.hostname,
              port: proxy.port,
              method: 'CONNECT',
              path: target.hostname + ':' + (target.port || 443),
              headers: proxy.auth
                ? {
                    'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64'),
                  }
                : {},
            })
          );
          emitter.activeReq = connectReq;

          connectReq.on('connect', (res, socket, head) => {
            socket.on('error', (e) => {
              emitter.emit('error', e);
            });

            if (fallbackTriggered) {
              socket.destroy();
              return;
            }
            fallbackTriggered = true;

            if (res.statusCode !== 200) {
              emitter.emit('error', new Error('Tunnel connection failed: ' + res.statusCode));
              socket.destroy();
              return;
            }

            const tls = require('tls');
            const tlsSocket = tls.connect(
              {
                socket: socket,
                servername: target.hostname,
                rejectUnauthorized: shouldVerifyUpstreamTls(),
              },
              () => {
                const headers = { ...options.headers, host: target.hostname };
                const req = attachRequestTimeout(
                  http.request(
                    {
                      createConnection: () => tlsSocket,
                      method: options.method || 'GET',
                      path: target.path,
                      headers: headers,
                    },
                    callback
                  )
                );

                emitter.activeReq = req;
                req.on('error', (e) => emitter.emit('error', e));

                if (emitter.pendingBody) {
                  req.write(emitter.pendingBody);
                }
                req.end();
              }
            );

            tlsSocket.on('error', (e) => {
              emitter.emit('error', e);
            });
          });

          connectReq.on('error', (e) => {
            if (!fallbackTriggered) {
              console.warn(
                `[proxy] HTTP proxy via ${proxyUrl} failed (${e.message}), falling back to direct connection...`
              );
              executeDirect();
            }
          });

          connectReq.end();
        }
      } else {
        // HTTP target through HTTP proxy
        const headers = { ...options.headers, host: target.hostname };
        if (proxy.auth) {
          headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth).toString('base64');
        }
        const req = attachRequestTimeout(
          http.request(
            {
              hostname: proxy.hostname,
              port: proxy.port,
              path: targetUrl,
              method: options.method || 'GET',
              headers: headers,
            },
            callback
          )
        );

        emitter.activeReq = req;
        req.on('error', (e) => emitter.emit('error', e));

        if (emitter.pendingBody) {
          req.write(emitter.pendingBody);
        }
        req.end();
      }
    } else {
      executeDirect();
    }
  });

  return emitter;
}

const { createAuthResolver } = require('./lib/proxy/auth-resolver');
const { createManagementHandlers } = require('./lib/proxy/handlers/management');

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
  encryptKey,
  decryptKey,
} = require('./lib/proxy/config');

function writeManagementTokenFile(managementPort) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tokenFiles = [path.join(DATA_DIR, '.mgmt-token')];
    const portNumber = Number(managementPort);
    if (Number.isFinite(portNumber) && portNumber > 0) {
      tokenFiles.unshift(path.join(DATA_DIR, `.mgmt-token-${portNumber}`));
    }
    for (const tokenFile of tokenFiles) {
      fs.writeFileSync(tokenFile, MANAGEMENT_TOKEN, { encoding: 'utf8', mode: 0o600 });
    }
  } catch (err) {
    log.warn('[mgmt] Failed to write management token file:', err.message);
  }
}

function maskManagementToken(token) {
  const value = String(token || '');
  if (value.length <= 12) return '[redacted]';
  return value.slice(0, 6) + '...' + value.slice(-4);
}

function setupFileConsoleTee() {
  if (process.env.PROXY_DISABLE_FILE_LOG === '1') return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const maxLogBytes = Math.max(
      256 * 1024,
      Number(process.env.PROXY_LOG_MAX_BYTES || 5 * 1024 * 1024)
    );
    const rotateIfOversized = (filePath) => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size <= maxLogBytes) return;
        const rotated = filePath + '.1';
        try {
          fs.unlinkSync(rotated);
        } catch (_) {}
        try {
          fs.renameSync(filePath, rotated);
        } catch (_) {
          fs.writeFileSync(filePath, '', 'utf8');
        }
      } catch (_) {}
    };
    const logPath = path.join(DATA_DIR, 'proxy.log');
    const errPath = path.join(DATA_DIR, 'proxy.err.log');
    rotateIfOversized(logPath);
    rotateIfOversized(errPath);
    const out = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
    const err = fs.createWriteStream(errPath, { flags: 'a', encoding: 'utf8' });
    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);
    const writeLine = (stream, args) => {
      try {
        stream.write(util.format(...args) + '\n');
      } catch (_) {}
    };
    console.log = (...args) => {
      originalLog(...args);
      writeLine(out, args);
    };
    console.warn = (...args) => {
      originalWarn(...args);
      writeLine(err, args);
    };
    console.error = (...args) => {
      originalError(...args);
      writeLine(err, args);
    };
  } catch (e) {
    try {
      log.error('[log] Failed to initialize file logging:', e.message);
    } catch (_) {}
  }
}

setupFileConsoleTee();

const {
  stableHash,
  stableId,
  fallbackId: fallbackIdWithOptions,
  stableCreated,
} = require('./lib/proxy/ids');
const { CERT_DIR, CERT_FILE, KEY_FILE, ensureCert } = require('./lib/proxy/cert');
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
} = require('./lib/proxy/request-utils');
const {
  appendAuditRecord,
  getAuditRecords,
  getAuditRecordById,
  clearAuditRecords,
} = require('./lib/proxy/audit');
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
  currentTraeDebugSettings,
  startNativeDeepProgress,
} = require('./lib/proxy/trae-debug-center');

let CONFIG = loadConfig();
let PROFILES = getProfiles(CONFIG);
let ACTIVE_PROFILE = getActiveProfile(CONFIG);
let LOCAL_SERVER = getLocalServer(CONFIG);

const PORT = parseInt(process.env.PORT || LOCAL_SERVER.listenPort || '3443', 10);
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

function getClaudeDesktopSelfTestRoute() {
  const routes = getClaudeDesktopRoutes(CONFIG);
  if (!Array.isArray(routes) || routes.length === 0) return null;
  const traeRoute = routes.find((route) => {
    const profile = PROFILES.find((item) => item && item.id === route.profileId) || {};
    return isTraeOfficialProfile(profile) || isTraeOfficialTarget(profile.targetUrl);
  });
  return traeRoute || routes[0];
}

function appendClaudeMessagesPath(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/, '');
  if (!normalized) return '';
  return /\/v1$/i.test(normalized) ? normalized + '/messages' : normalized + '/v1/messages';
}

function getClaudeDesktopSelfTestTarget() {
  const route = getClaudeDesktopSelfTestRoute();
  if (!route || !route.from) return null;

  const gateway = getClaudeDesktopGatewayConfig();
  let baseUrl = '';
  let token = '';
  if (gateway && gateway.isLocalProxy && gateway.baseUrl) {
    baseUrl = gateway.baseUrl;
    token = gateway.token || '';
  } else {
    baseUrl = claudeDesktopBaseUrl(CONFIG) + CLAUDE_DESKTOP_PROXY_PREFIX;
    token =
      CONFIG && CONFIG.claudeDesktop && typeof CONFIG.claudeDesktop.token === 'string'
        ? CONFIG.claudeDesktop.token
        : '';
  }

  const endpoint = appendClaudeMessagesPath(baseUrl);
  if (!endpoint) return null;
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  const profile = PROFILES.find((item) => item && item.id === route.profileId) || {};
  return {
    source:
      gateway && gateway.isLocalProxy
        ? 'claude-desktop-gateway'
        : 'configured-claude-desktop-gateway',
    endpoint,
    headers,
    model: route.from,
    expectedStyle: getClaudeDesktopTraeProcessStyle(CONFIG),
    route: {
      from: route.from,
      profileId: route.profileId,
      profileProtocol: profile.protocol || '',
      targetUrl: profile.targetUrl || '',
      isTraeOfficial: isTraeOfficialProfile(profile) || isTraeOfficialTarget(profile.targetUrl),
    },
  };
}
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
  createCertManagement();
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

// 配置文件热重载：debounce + lock + 重试
let _configWatcher = null;
function reloadProxyConfig() {
  // 兼容旧 API: 立刻调度一次重载
  if (_configWatcher && typeof _configWatcher.scheduleNow === 'function') {
    _configWatcher.scheduleNow();
  } else {
    // 没有装上 watcher 时退化为旧实现
    try {
      const nextConfig = loadConfig();
      CONFIG = nextConfig;
      PROFILES = getProfiles(nextConfig);
      ACTIVE_PROFILE = getActiveProfile(nextConfig);
      LOCAL_SERVER = getLocalServer(nextConfig);
      MODEL_ROUTES = getModelRoutes(nextConfig);
      CLAUDE_DESKTOP_ROUTES = getClaudeDesktopRoutes(nextConfig);

      const nextOptions = {
        ...DEFAULT_CONFIG.protocolOptions,
        ...(nextConfig.protocolOptions || {}),
      };
      for (const key of Object.keys(PROTOCOL_OPTIONS)) {
        delete PROTOCOL_OPTIONS[key];
      }
      Object.assign(PROTOCOL_OPTIONS, nextOptions);

      const newAgent = createHttpsAgent();
      globalHttpsAgent = newAgent;
      https.globalAgent = newAgent;

      log.info('[config] Configuration reloaded (legacy). Active profile:', ACTIVE_PROFILE.id);
    } catch (err) {
      log.error('[config] Failed to reload configuration:', err.message);
    }
  }
}

try {
  const { debounceReload } = require('./lib/proxy/config-watcher');
  _configWatcher = debounceReload(
    CONFIG_FILE,
    (nextConfig) => {
      try {
        CONFIG = nextConfig;
        PROFILES = getProfiles(nextConfig);
        ACTIVE_PROFILE = getActiveProfile(nextConfig);
        LOCAL_SERVER = getLocalServer(nextConfig);
        MODEL_ROUTES = getModelRoutes(nextConfig);
        CLAUDE_DESKTOP_ROUTES = getClaudeDesktopRoutes(nextConfig);

        const nextOptions = {
          ...DEFAULT_CONFIG.protocolOptions,
          ...(nextConfig.protocolOptions || {}),
        };
        for (const key of Object.keys(PROTOCOL_OPTIONS)) {
          delete PROTOCOL_OPTIONS[key];
        }
        Object.assign(PROTOCOL_OPTIONS, nextOptions);

        // Recreate HTTPS agent when TLS verification setting changes
        const newAgent = createHttpsAgent();
        globalHttpsAgent = newAgent;
        https.globalAgent = newAgent;

        log.info(
          '[config] Configuration hot-reloaded successfully. Active profile:',
          ACTIVE_PROFILE.id
        );
        // 指标埋点
        try {
          metricsInstance.counter('proxy_config_reloads_total').inc();
          metricsInstance.gauge('proxy_active_profile_id').set(1, { id: ACTIVE_PROFILE.id });
          if (rebuildProxyRouteIndex(MODEL_ROUTES)) {
            metricsInstance.counter('proxy_route_cache_total').inc(1, { event: 'rebuild' });
          }
        } catch (e) {
          /* never break on metrics */
        }
      } catch (err) {
        log.error('[config] Failed to apply hot-reload configuration:', err.message);
        throw err;
      }
    },
    {
      onError: (err) => log.warn('[config] Hot-reload error:', err && err.message),
    }
  );
} catch (err) {
  log.warn('[config] Failed to watch config file:', err.message);
}

function fallbackId(prefix, value) {
  return fallbackIdWithOptions(prefix, value, PROTOCOL_OPTIONS);
}

/* ========== 代理逻辑 ========== */

function resolveRoute(model) {
  return resolveRouteForModel(model, MODEL_ROUTES, PROFILES, ACTIVE_PROFILE);
}

function resolveClaudeDesktopRoute(model) {
  const resolved = resolveRouteForModel(model, CLAUDE_DESKTOP_ROUTES, PROFILES, ACTIVE_PROFILE);
  if (resolved.route) return resolved;
  if (String(model || '').trim() === 'claude-opus-4-8') {
    return resolveRouteForModel('claude-opus-4-1', CLAUDE_DESKTOP_ROUTES, PROFILES, ACTIVE_PROFILE);
  }
  return resolved;
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

function logModelMapping(kind, method, upstreamPath, prepared, requestBuffer) {
  const estimatedContextTokens = estimateTokens(
    captureRequestBody(prepared.buffer || requestBuffer).body
  );
  return logRouteModelMapping(
    kind,
    method,
    upstreamPath,
    { ...prepared, estimatedContextTokens },
    logProxyEvent
  );
}

const { normalizeClaudeContent, isClaudeThinkingBlock, filterClaudeCompatibleBlocks } =
  createClaudeFilters({
    protocolOptions: PROTOCOL_OPTIONS,
    makeSafeClaudeToolUseContentBlock: () => ({ type: 'text', text: '' }),
  });

const {
  getDiagnosticsConfig,
  shouldCaptureDiagnostics,
  redactDiagnosticsValue,
  truncateDiagnosticsText,
  compactDiagnosticsValue,
  writeJsonlBounded,
  flushJsonlWrites,
  diagnosticsMetaFromResponse,
  sampleDiagnostics,
  extractDiagnosticsSsePayload,
  sampleOutboundSse,
  inputKeys,
  contentLengthForDiagnostics,
  summarizeClaudeToolHistory,
  sampleRequestToolResults,
  sampleGeminiToolEvent,
  logProxyEvent: writeProxyEvent,
  auditToolCall,
  auditClaudeSseToolCalls,
  sampleResponseChunk,
} = createDiagnostics({ getConfig: () => CONFIG, normalizeClaudeContent, sanitizeGeminiToolCall });

function shouldLogProxyEvent(kind, payload) {
  if (!payload) return true;
  if (kind !== 'request_start' && kind !== 'request_end') return true;
  const statusCode = Number(payload.statusCode || 0);
  if (statusCode >= 400) return true;
  return !isQuietLocalPollRequest(payload.method, payload.path);
}

function logProxyEvent(kind, payload) {
  if (!shouldLogProxyEvent(kind, payload)) return false;
  writeProxyEvent(kind, payload);
  return true;
}

function logRequestEnd(method, path, startTime, statusCode, extra) {
  const elapsed = Date.now() - startTime;
  logProxyEvent('request_end', {
    method,
    path,
    elapsed,
    statusCode,
    ...(extra || {}),
  });
  // 指标埋点:观察直方图 + 错误计数
  try {
    metricsInstance.histogram('proxy_request_duration_seconds').observe(elapsed / 1000);
    if (statusCode && statusCode >= 500) {
      metricsInstance
        .counter('proxy_errors_total')
        .inc(1, { type: (extra && extra.type) || 'unknown' });
    }
  } catch (e) {
    /* never break on metrics */
  }
}

function installLocalManagementRequestEndLogger(clientRes, method, path, startTime) {
  if (!clientRes || clientRes.__localManagementRequestEndLogger) return;
  clientRes.__localManagementRequestEndLogger = true;
  clientRes.once('finish', () => {
    logRequestEnd(method, path, startTime, clientRes.statusCode || 200, {
      type: 'local_management',
    });
  });
}

const AUDIT_MAX_CAPTURE_BYTES = Math.max(
  16 * 1024,
  Number(process.env.PROXY_AUDIT_MAX_CAPTURE_BYTES || 256 * 1024)
);
const AUDIT_MAX_TEXT_CHARS = Math.max(
  1024,
  Number(process.env.PROXY_AUDIT_MAX_TEXT_CHARS || 120000)
);
const MAX_REQUEST_BODY_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.PROXY_MAX_REQUEST_BODY_BYTES || 32 * 1024 * 1024)
);
const MAX_CONVERSION_RESPONSE_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.PROXY_MAX_CONVERSION_RESPONSE_BYTES || 16 * 1024 * 1024)
);

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

function entryLabel(entry) {
  if (!entry) return 'claude';
  return entry.protocol || 'claude';
}

function modelsFormatForEntry(entry) {
  return entry && entry.protocol === 'claude' ? 'claude' : 'openai';
}

function routesForEntry(entry, desktopRequest) {
  return desktopRequest || (entry && entry.protocol === 'claude-desktop')
    ? CLAUDE_DESKTOP_ROUTES
    : MODEL_ROUTES;
}

function forceClaudeEntry(entry) {
  return entry && (entry.protocol === 'claude' || entry.protocol === 'claude-desktop');
}

function forceChatEntry(entry) {
  return entry && entry.protocol === 'openai-chat';
}

function forceResponsesEntry(entry) {
  return entry && entry.protocol === 'openai-responses';
}

function sendEntryHealth(clientRes, entry, method, clientPath) {
  const body = JSON.stringify({
    ok: true,
    object: 'local.entry',
    protocol: entryLabel(entry),
    path: clientPath,
  });
  clientRes.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': method === 'HEAD' ? 0 : Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(method === 'HEAD' ? undefined : body);
}

function sendUnauthorizedClaudeDesktop(clientRes) {
  clientRes.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(
    JSON.stringify({
      error: {
        type: 'authentication_error',
        message: 'Claude Desktop gateway request is missing or using an invalid token.',
      },
    })
  );
}

function isPublicLocalManagementPath(pathname) {
  const normalized = String(pathname || '').split('?')[0];
  return normalized === '/v1/local/health' || normalized === '/local/health';
}

function isEntryHealthPath(entry, method, clientPath) {
  if (!entry || (method !== 'GET' && method !== 'HEAD')) return false;
  if (forceClaudeEntry(entry)) return isClaudeMessagesPath(clientPath);
  if (forceChatEntry(entry)) return isOpenAIChatCompletionsPath(clientPath);
  if (forceResponsesEntry(entry)) return isOpenAIResponsesPath(clientPath);
  return false;
}

function isAllowedEntryPath(entry, method, clientPath) {
  if (!entry) return true;
  if (method !== 'POST') return false;
  if (forceClaudeEntry(entry)) {
    return (
      isClaudeMessagesPath(clientPath) || clientPath.indexOf('/v1/messages/count_tokens') === 0
    );
  }
  if (forceChatEntry(entry)) return isOpenAIChatCompletionsPath(clientPath);
  if (forceResponsesEntry(entry)) return isOpenAIResponsesPath(clientPath);
  return true;
}

function sendEntryPathError(clientRes, entry, method, clientPath) {
  clientRes.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(
    JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message:
          'Path ' +
          method +
          ' ' +
          clientPath +
          ' is not supported by ' +
          entryLabel(entry) +
          ' entry',
      },
    })
  );
}
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

function handleRequestInner(clientReq, clientRes, entry) {
  const startTime = Date.now();
  const clientIp = getClientIp(clientReq);
  const urlPath = clientReq.url;
  const method = clientReq.method;
  const desktopRequest = isClaudeDesktopRequest(entry, urlPath);
  const effectiveUrlPath = desktopRequest ? stripClaudeDesktopPrefix(urlPath) : urlPath;
  const effectiveUrlPathname = effectiveUrlPath.split('?')[0];
  const localManagementRequest = isLocalManagementPath(effectiveUrlPathname);
  // 指标埋点:每个非本地管理请求递增
  const isApiRequest =
    urlPath.indexOf('/chat/completions') >= 0 ||
    urlPath.indexOf('/messages') >= 0 ||
    urlPath.indexOf('/v1/chat/completions') >= 0 ||
    urlPath.indexOf('/v1/messages') >= 0;
  if (!localManagementRequest) {
    metricsInstance.counter('proxy_requests_total').inc();
  }
  const auditEnabled =
    isApiRequest &&
    process.env.PROXY_DISABLE_CONVERSATION_AUDIT !== '1' &&
    !(CONFIG.appSettings && CONFIG.appSettings.conversationAuditEnabled === false);
  const responseBuffer = [];
  let responseBytes = 0;
  let responseTruncated = false;
  let sseContent = '';
  let auditTextTruncated = false;
  let auditProviderUsage = null;
  const sseToolCallsMap = new Map();
  let isStream = false;

  if (auditEnabled) {
    const requestId = 'req-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    clientRes.__auditId = requestId;
    clientRes.__auditData = {
      id: requestId,
      startTime: Date.now(),
      method: method,
      path: urlPath,
      clientIp: clientIp,
      entryPort: entry && entry.listenPort,
      entryProtocol: entryLabel(entry),
      originalModel: '',
      rewriteModel: '',
      profileId: '',
      profileName: '',
      protocol: '',
      system: '',
      messages: [],
      request: {
        headers: redactHeaders(clientReq.headers),
        body: '',
        truncated: false,
      },
      upstream: {},
      responseHeaders: {},
      usage: null,
      cost: null,
      response: { role: 'assistant', content: '', tool_calls: [] },
    };

    const originalWrite = clientRes.write;
    const originalEnd = clientRes.end;
    const originalWriteHead = clientRes.writeHead;

    clientRes.writeHead = function (statusCode, reasonPhrase, headers) {
      const headerObj =
        headers || (reasonPhrase && typeof reasonPhrase === 'object' ? reasonPhrase : {});
      if (headerObj) {
        const contentType = headerObj['content-type'] || headerObj['Content-Type'] || '';
        if (contentType.indexOf('text/event-stream') >= 0) {
          isStream = true;
        }
        if (clientRes.__auditData) {
          clientRes.__auditData.responseHeaders = redactHeaders(headerObj);
        }
      }
      return originalWriteHead.apply(this, arguments);
    };

    const captureAuditResponseChunk = function (chunk, encoding) {
      if (chunk) {
        if (!isStream) {
          const chunkBuffer = bufferFromResponseChunk(chunk, encoding);
          let capturedLength = 0;
          if (responseBytes < AUDIT_MAX_CAPTURE_BYTES) {
            const remaining = AUDIT_MAX_CAPTURE_BYTES - responseBytes;
            const captured =
              chunkBuffer.length > remaining ? chunkBuffer.subarray(0, remaining) : chunkBuffer;
            responseBuffer.push(captured);
            responseBytes += captured.length;
            capturedLength = captured.length;
          }
          if (chunkBuffer.length > capturedLength) responseTruncated = true;
        } else {
          const text = chunk.toString('utf8');
          const lines = text.split('\n');
          lines.forEach((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) {
              const dataStr = trimmed.substring(5).trim();
              if (dataStr === '[DONE]') return;
              try {
                const data = JSON.parse(dataStr);
                auditProviderUsage = mergeUsage(auditProviderUsage, usageFromSsePayload(data));

                // 1. Claude style SSE
                if (data.type === 'content_block_delta' && data.delta) {
                  if (data.delta.text) {
                    const appended = appendAuditText(sseContent, data.delta.text);
                    sseContent = appended.value;
                    if (appended.truncated) auditTextTruncated = true;
                  }
                  if (data.delta.partial_json) {
                    const index = data.index;
                    const existing = sseToolCallsMap.get(index) || { args: '' };
                    const appended = appendAuditText(existing.args, data.delta.partial_json);
                    existing.args = appended.value;
                    if (appended.truncated) {
                      existing.truncated = true;
                      auditTextTruncated = true;
                    }
                    sseToolCallsMap.set(index, existing);
                  }
                } else if (data.type === 'content_block_start' && data.content_block) {
                  const block = data.content_block;
                  if (block.type === 'tool_use') {
                    const index = data.index;
                    sseToolCallsMap.set(index, {
                      id: block.id,
                      name: block.name,
                      args: '',
                    });
                  }
                }

                // 2. OpenAI style SSE
                if (Array.isArray(data.choices) && data.choices[0] && data.choices[0].delta) {
                  const delta = data.choices[0].delta;
                  if (delta.content) {
                    const appended = appendAuditText(sseContent, delta.content);
                    sseContent = appended.value;
                    if (appended.truncated) auditTextTruncated = true;
                  }
                  if (Array.isArray(delta.tool_calls)) {
                    delta.tool_calls.forEach((tc) => {
                      const idx = tc.index;
                      const existing = sseToolCallsMap.get(idx) || { args: '' };
                      if (tc.id) existing.id = tc.id;
                      if (tc.function && tc.function.name) existing.name = tc.function.name;
                      if (tc.function && tc.function.arguments) {
                        const appended = appendAuditText(existing.args, tc.function.arguments);
                        existing.args = appended.value;
                        if (appended.truncated) {
                          existing.truncated = true;
                          auditTextTruncated = true;
                        }
                      }
                      sseToolCallsMap.set(idx, existing);
                    });
                  }
                }
              } catch (e) {}
            }
          });
        }
      }
    };

    clientRes.write = function (chunk, encoding, callback) {
      captureAuditResponseChunk(chunk, encoding);
      return originalWrite.apply(this, arguments);
    };

    clientRes.end = function (chunk, encoding, callback) {
      if (chunk) {
        captureAuditResponseChunk(chunk, encoding);
      }
      const result = originalEnd.apply(this, arguments);

      try {
        const auditData = clientRes.__auditData;
        if (auditData) {
          auditData.elapsed = Date.now() - auditData.startTime;
          auditData.statusCode = clientRes.statusCode || 200;

          if (isStream) {
            auditData.response.content = sseContent;
            auditData.response.truncated = auditTextTruncated;
            const toolCalls = [];
            for (const [idx, tc] of sseToolCallsMap.entries()) {
              let parsedArgs = tc.args;
              try {
                parsedArgs = JSON.parse(tc.args);
              } catch (e) {}
              toolCalls.push({
                id: tc.id || `tc-${idx}`,
                name: tc.name || '',
                args: parsedArgs,
                truncated: tc.truncated === true,
              });
            }
            auditData.response.tool_calls = toolCalls;
          } else {
            auditData.response.truncated = responseTruncated;
            try {
              const resBodyStr = Buffer.concat(responseBuffer).toString('utf8');
              auditData.response.body = resBodyStr;
              auditData.response.bodyTruncated = responseTruncated;
              const resJson = JSON.parse(resBodyStr);
              auditProviderUsage = mergeUsage(
                auditProviderUsage,
                extractUsageFromJsonPayload(resJson)
              );

              if (resJson.choices && resJson.choices[0] && resJson.choices[0].message) {
                const msg = resJson.choices[0].message;
                const appended = appendAuditText('', msg.content || '');
                auditData.response.content = appended.value;
                if (appended.truncated) auditData.response.truncated = true;
                if (Array.isArray(msg.tool_calls)) {
                  auditData.response.tool_calls = msg.tool_calls.map((tc) => {
                    let args = tc.function && tc.function.arguments;
                    try {
                      if (typeof args === 'string') args = JSON.parse(args);
                    } catch (e) {}
                    return { id: tc.id, name: tc.function && tc.function.name, args };
                  });
                }
              } else if (Array.isArray(resJson.content)) {
                resJson.content.forEach((block) => {
                  if (block.type === 'text') {
                    const appended = appendAuditText(auditData.response.content, block.text || '');
                    auditData.response.content = appended.value;
                    if (appended.truncated) auditData.response.truncated = true;
                  } else if (block.type === 'tool_use') {
                    auditData.response.tool_calls.push({
                      id: block.id,
                      name: block.name,
                      args: block.input,
                    });
                  }
                });
              }
            } catch (e) {}
          }

          auditData.usage = auditProviderUsage || estimateUsageForRecord(auditData);
          logUsage({
            profileId: auditData.profileId,
            model: auditData.rewriteModel || auditData.originalModel,
            inputTokens: auditData.usage.input_tokens || 0,
            outputTokens: auditData.usage.output_tokens || 0,
          });
          const costModel = auditData.rewriteModel || auditData.originalModel || '';
          auditData.cost = estimateCost(auditData.usage, costModel, CONFIG);
          appendAuditRecord(auditData);
        }
      } catch (e) {
        log.error('!! failed to write conversation audit logs:', e);
      }

      return result;
    };
  }

  // 拦截并提取会话 Token
  const clientAuth =
    clientReq.headers['authorization'] ||
    clientReq.headers['x-api-key'] ||
    clientReq.headers['x-goog-api-key'] ||
    clientReq.headers['api-key'];
  let sessionToken = '';
  let cliSession = null;
  if (clientAuth) {
    const match = String(clientAuth).match(/^(?:Bearer\s+)?(hpm-session-\w+)/i);
    if (match) {
      sessionToken = match[1];
      cliSession = CLI_SESSIONS.get(sessionToken);
    }
  }

  // 如果找到了对应的 CLI 快速启动会话，重写认证头为代理托管
  if (cliSession) {
    cliSession.lastUsedAt = Date.now();
    cliSession.requestCount = (cliSession.requestCount || 0) + 1;
    if (clientReq.headers['authorization'])
      clientReq.headers['authorization'] = 'Bearer PROXY_MANAGED';
    if (clientReq.headers['x-api-key']) clientReq.headers['x-api-key'] = 'PROXY_MANAGED';
    if (clientReq.headers['x-goog-api-key']) clientReq.headers['x-goog-api-key'] = 'PROXY_MANAGED';
    if (clientReq.headers['api-key']) clientReq.headers['api-key'] = 'PROXY_MANAGED';
  }

  const localPollRequest = isQuietLocalPollRequest(method, effectiveUrlPathname);
  if (!localPollRequest) {
    log.info('-> ' + method + ' ' + urlPath + '  [' + clientIp + '] entry=' + entryLabel(entry));
    logProxyEvent('request_start', {
      method,
      path: urlPath,
      clientIp,
      entryProtocol: entryLabel(entry),
      entryPort: entry && entry.listenPort,
      claudeDesktop: desktopRequest,
    });
  }

  if (localManagementRequest && !installManagementCorsGuard(clientReq, clientRes)) {
    logRequestEnd(method, urlPath, startTime, 403, { type: 'management_origin' });
    return;
  }

  // CORS preflight
  if (method === 'OPTIONS') {
    clientRes.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    clientRes.end();
    return;
  }

  // Local Admin APIs
  if (localManagementRequest && !isPublicLocalManagementPath(effectiveUrlPathname)) {
    installLocalManagementRequestEndLogger(clientRes, method, urlPath, startTime);

    const clientToken =
      clientReq.headers['x-mgmt-token'] ||
      new URL(clientReq.url, 'http://localhost').searchParams.get('token');
    if (clientToken !== MANAGEMENT_TOKEN) {
      console.warn(`[mgmt] Unauthorized management request from ${clientIp}: ${method} ${urlPath}`);
      clientRes.writeHead(401, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Unauthorized management access' }));
      logRequestEnd(method, urlPath, startTime, 401, { type: 'management_unauthorized' });
      return;
    }
  }
  if (
    dispatchLocalManagementRoute({
      method,
      pathname: effectiveUrlPathname,
      req: clientReq,
      res: clientRes,
      handlers: managementHandlers,
    })
  ) {
    return;
  }

  // Forward request - pass path as-is (SDK already includes /v1 from base_url)
  // Normalize path: tools may or may not include /v1 prefix
  if (
    (method === 'GET' || method === 'HEAD') &&
    (effectiveUrlPathname === '/favicon.ico' || effectiveUrlPathname === '/v1/favicon.ico')
  ) {
    clientRes.writeHead(204, {
      'Cache-Control': 'public, max-age=86400',
      'access-control-allow-origin': '*',
    });
    clientRes.end();
    return;
  }

  if (desktopRequest && !isAuthorizedClaudeDesktopRequest(CONFIG, clientReq.headers, decryptKey)) {
    sendUnauthorizedClaudeDesktop(clientRes);
    logRequestEnd(method, urlPath, startTime, 401, { type: 'claude_desktop_auth' });
    return;
  }

  const modelRequest = parseModelsRequestPath(effectiveUrlPath);
  if ((method === 'GET' || method === 'HEAD') && modelRequest) {
    handleLocalModelsRequest(
      clientReq,
      clientRes,
      modelRequest,
      routesForEntry(entry, desktopRequest),
      desktopRequest ? 'claude' : modelsFormatForEntry(entry)
    );
    return;
  }
  const clientPath =
    effectiveUrlPath.indexOf('/v1') === 0 ? effectiveUrlPath : '/v1' + effectiveUrlPath;
  if (isEntryHealthPath(entry, method, clientPath)) {
    sendEntryHealth(clientRes, entry, method, clientPath);
    return;
  }
  if (!isAllowedEntryPath(entry, method, clientPath)) {
    sendEntryPathError(clientRes, entry, method, clientPath);
    logRequestEnd(method, urlPath, startTime, 404, {
      type: 'entry_path_mismatch',
      entryProtocol: entryLabel(entry),
    });
    return;
  }
  const fwdHeaders = { ...clientReq.headers };
  delete fwdHeaders['host'];

  const requestChunks = [];
  let requestBytes = 0;
  let requestTooLarge = false;
  clientReq.on('data', function (chunk) {
    if (requestTooLarge) return;
    requestChunks.push(chunk);
    requestBytes += chunk.length;
    if (requestBytes > MAX_REQUEST_BODY_BYTES) {
      requestTooLarge = true;
      requestChunks.length = 0;
      logProxyEvent('request_too_large', {
        method,
        path: urlPath,
        bytes: requestBytes,
        limit: MAX_REQUEST_BODY_BYTES,
      });
    }
  });

  clientReq.on('end', function () {
    if (requestTooLarge) {
      sendRequestTooLarge(clientReq, clientRes, MAX_REQUEST_BODY_BYTES);
      logRequestEnd(method, urlPath, startTime, 413, {
        type: 'request_too_large',
        bytes: requestBytes,
        limit: MAX_REQUEST_BODY_BYTES,
      });
      return;
    }
    const requestBuffer = Buffer.concat(requestChunks, requestBytes);
    if (clientRes.__auditData) {
      const captured = captureRequestBody(requestBuffer, clientReq.headers['content-encoding']);
      clientRes.__auditData.request = {
        ...clientRes.__auditData.request,
        body: captured.body,
        truncated: captured.truncated,
        originalLength: captured.originalLength,
      };
    }
    const desktop3pRequest = isClaudeDesktop3pRequest(clientReq.headers);
    const shouldUseDesktopRoutes = desktopRequest || desktop3pRequest;
    const initialPrepared = prepareRequestBufferWithResolver(
      requestBuffer,
      clientReq.headers['content-encoding'],
      shouldUseDesktopRoutes ? resolveClaudeDesktopRoute : resolveRoute
    );
    if (method === 'POST' && clientPath.indexOf('/v1/messages/count_tokens') === 0) {
      populateAuditDataFromPrepared(clientRes, initialPrepared, requestBuffer);
      handleCountTokens(clientReq, clientRes, requestBuffer, logRequestEnd, startTime);
      return;
    }

    function doForward(currentPrepared, attempt = 1) {
      const MAX_RETRIES = 2; // Up to 3 total attempts
      const requestProtocol = isGeminiProfile(currentPrepared.profile)
        ? 'gemini'
        : isClaudeProfile(currentPrepared.profile)
          ? 'claude'
          : 'openai';
      // 协议版本透传:Claude 走 anthropic-version header
      const protocolVersion = resolveProfileProtocolVersion(currentPrepared.profile);
      if (protocolVersion) {
        // 通过 out-of-band 变量携带,稍后在 outgoingHeaders 合并
        currentPrepared._protocolVersion = protocolVersion;
      }

      if (clientRes.__auditData) {
        populateAuditDataFromPrepared(clientRes, currentPrepared, requestBuffer);
      }

      if (
        currentPrepared.authMode === 'official-login' &&
        currentPrepared.authProvider === 'trae'
      ) {
        if (method === 'POST' && isOpenAIChatCompletionsPath(clientPath)) {
          handleTraeOfficialChatCompletion(
            clientReq,
            clientRes,
            requestBuffer,
            currentPrepared,
            startTime,
            urlPath
          );
          return;
        }
        if (method === 'POST' && isOpenAIResponsesPath(clientPath)) {
          handleTraeOfficialResponses(
            clientReq,
            clientRes,
            requestBuffer,
            currentPrepared,
            startTime,
            urlPath
          );
          return;
        }
        if (method === 'POST' && isClaudeMessagesPath(clientPath)) {
          handleTraeOfficialClaudeMessages(
            clientReq,
            clientRes,
            requestBuffer,
            currentPrepared,
            startTime,
            urlPath,
            {
              claudeProcessStyle: shouldUseDesktopRoutes
                ? getClaudeDesktopTraeProcessStyle(CONFIG, {
                    claudeDesktop3p: desktop3pRequest,
                  })
                : '',
            }
          );
          return;
        }
        sendJsonError(clientRes, 501, {
          error: {
            type: 'not_implemented',
            message:
              'Trae 官方登录桥接目前支持 OpenAI /v1/chat/completions、OpenAI /v1/responses 和 Claude /v1/messages。',
          },
        });
        logRequestEnd(method, urlPath, startTime, 501, { type: 'trae_official_unsupported_path' });
        return;
      }

      const target = parseTargetUrl(currentPrepared.profile.targetUrl);
      const upstreamPath = target.path + clientPath.replace(/^\/v1/, '');
      const apiKey =
        currentPrepared.authMode === 'official-login'
          ? currentPrepared.profile.apiKey || null
          : process.env.API_KEY || currentPrepared.profile.apiKey || null;
      const isClaudeEntryRequest = forceClaudeEntry(entry) && isClaudeMessagesPath(clientPath);
      const isChatEntryRequest = forceChatEntry(entry) && isOpenAIChatCompletionsPath(clientPath);
      const isResponsesEntryRequest =
        forceResponsesEntry(entry) && isOpenAIResponsesPath(clientPath);

      if (
        currentPrepared.authMode === 'official-login' &&
        currentPrepared.authProvider === 'google' &&
        isGeminiProfile(currentPrepared.profile) &&
        !(typeof apiKey === 'string' && apiKey.startsWith('ya29.'))
      ) {
        sendJsonError(clientRes, 401, {
          error: {
            type: 'authentication_error',
            message:
              'Google official-login credentials are unavailable or expired. Please sign in again before using this route.',
          },
        });
        logRequestEnd(method, urlPath, startTime, 401, { type: 'google_official_auth_missing' });
        return;
      }

      const isResponsesUpstream =
        currentPrepared.profile &&
        (currentPrepared.profile.api === 'openai-codex-responses' ||
          (currentPrepared.profile.targetUrl &&
            (currentPrepared.profile.targetUrl.includes('/backend-api/codex') ||
              currentPrepared.profile.targetUrl.includes('/backend-api'))));

      // 协议转换路由表:把 8 个 if 块(原 270 行)合并成数据驱动的调度。
      // 每条路由包含:匹配谓词、logModelMapping 标签、压缩请求体拒绝消息、目标 handler。
      // 第一个匹配的路由会处理并 return,后续路由不再评估(与原代码语义一致)。
      const conversionRoutes = [
        {
          label: 'chat->responses',
          match:
            isResponsesUpstream && isOpenAIChatCompletionsPath(clientPath) && method === 'POST',
          rejectMessage: 'Chat to Responses conversion does not support compressed request bodies',
          handler: handleOpenAIChatToOpenAIResponses,
        },
        {
          label: 'claude->responses',
          match: isResponsesUpstream && isClaudeEntryRequest && method === 'POST',
          rejectMessage:
            'Claude to Responses conversion does not support compressed request bodies',
          handler: handleClaudeMessagesToOpenAIResponses,
        },
        {
          label: 'claude->openai',
          match:
            method === 'POST' &&
            (shouldConvertClaudeMessagesToOpenAI(clientReq, currentPrepared.profile, clientPath) ||
              (isClaudeEntryRequest && isOpenAIProfile(currentPrepared.profile))),
          rejectMessage: 'Claude to OpenAI conversion does not support compressed request bodies',
          handler: handleClaudeMessagesToOpenAIChat,
        },
        {
          label: 'openai->gemini',
          match:
            isChatEntryRequest && isGeminiProfile(currentPrepared.profile) && method === 'POST',
          rejectMessage: 'OpenAI to Gemini conversion does not support compressed request bodies',
          handler: handleOpenAIChatToGeminiMessages,
        },
        {
          label: 'openai->claude',
          match:
            isClaudeProfile(currentPrepared.profile) &&
            method === 'POST' &&
            isOpenAIChatCompletionsPath(clientPath),
          rejectMessage: 'OpenAI to Claude conversion does not support compressed request bodies',
          handler: handleOpenAIChatToClaudeMessages,
        },
        {
          label: 'responses->claude',
          match:
            isResponsesEntryRequest &&
            method === 'POST' &&
            isClaudeProfile(currentPrepared.profile),
          rejectMessage: 'OpenAI Responses conversion does not support compressed request bodies',
          handler: handleOpenAIResponsesToClaudeMessages,
        },
        {
          label: 'responses->gemini',
          match:
            isResponsesEntryRequest &&
            method === 'POST' &&
            isGeminiProfile(currentPrepared.profile),
          rejectMessage: 'OpenAI Responses conversion does not support compressed request bodies',
          handler: handleOpenAIResponsesToGeminiMessages,
        },
        {
          label: 'responses->chat',
          match:
            isResponsesEntryRequest &&
            method === 'POST' &&
            isOpenAIProfile(currentPrepared.profile) &&
            shouldConvertResponsesToOpenAIChat(currentPrepared.profile),
          rejectMessage: null,
          handler: handleOpenAIResponsesToOpenAIChat,
        },
        {
          label: 'claude->gemini',
          match:
            isGeminiProfile(currentPrepared.profile) &&
            method === 'POST' &&
            isClaudeMessagesPath(clientPath),
          rejectMessage: 'Gemini conversion does not support compressed request bodies',
          handler: handleGeminiMessages,
        },
      ];

      function tryConversionRoute(route) {
        if (!route.match) return false;
        if (route.rejectMessage && clientReq.headers['content-encoding']) {
          clientRes.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
          });
          clientRes.end(
            JSON.stringify({
              error: { type: 'invalid_request_error', message: route.rejectMessage },
            })
          );
          return true;
        }
        logModelMapping(route.label, method, upstreamPath, currentPrepared, requestBuffer);
        route.handler(
          clientReq,
          clientRes,
          currentPrepared,
          target,
          apiKey,
          upstreamPath,
          startTime
        );
        return true;
      }

      for (const route of conversionRoutes) {
        if (tryConversionRoute(route)) return;
      }

      if (method === 'POST' && isClaudeMessagesPath(clientPath))
        sampleRequestToolResults(currentPrepared, requestProtocol, upstreamPath);

      const outgoingHeaders = { ...fwdHeaders };
      // 协议版本透传:Claude 走 anthropic-version header,其它协议作为额外元数据记录
      if (requestProtocol === 'claude' && currentPrepared._protocolVersion) {
        outgoingHeaders['anthropic-version'] = String(currentPrepared._protocolVersion);
      }
      const managesAuth = Boolean(apiKey) || currentPrepared.authMode === 'official-login';
      if (managesAuth) {
        delete outgoingHeaders['authorization'];
        delete outgoingHeaders['api-key'];
        delete outgoingHeaders['x-api-key'];
        delete outgoingHeaders['x-goog-api-key'];
        if (apiKey) {
          if (requestProtocol === 'claude') {
            outgoingHeaders['x-api-key'] = apiKey;
          } else if (requestProtocol === 'gemini') {
            if (String(apiKey).startsWith('ya29.')) {
              outgoingHeaders['authorization'] = 'Bearer ' + apiKey;
            } else {
              outgoingHeaders['x-goog-api-key'] = apiKey;
            }
          } else {
            outgoingHeaders['authorization'] = 'Bearer ' + apiKey;
            outgoingHeaders['api-key'] = apiKey;
          }
        }
      }
      if (currentPrepared.routed) {
        outgoingHeaders['content-length'] = Buffer.byteLength(currentPrepared.buffer);
        logModelMapping('route', method, upstreamPath, currentPrepared, requestBuffer);
      }

      if (clientRes.__auditData) {
        clientRes.__auditData.upstream = {
          method,
          path: upstreamPath,
          targetHost: target.hostname,
          targetProtocol: target.protocol,
          headers: redactHeaders(outgoingHeaders),
          body: captureRequestBody(currentPrepared.buffer, outgoingHeaders['content-encoding'])
            .body,
        };
      }

      const transport = target.protocol === 'https:' ? https : http;
      const proxyReq = transport.request(
        {
          hostname: process.env.TARGET || target.hostname,
          port: parseInt(process.env.TARGET_PORT || target.port, 10),
          path: upstreamPath,
          method: method,
          headers: outgoingHeaders,
          timeout: 45000,
          agent: target.protocol === 'https:' ? globalHttpsAgent : globalHttpAgent,
        },
        (proxyRes) => {
          const code = proxyRes.statusCode;

          if ((code === 429 || code >= 500) && attempt <= MAX_RETRIES) {
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
            console.warn(
              `[Retry] Upstream returned ${code}, retrying in ${Math.round(delay)}ms... (Attempt ${attempt}/${MAX_RETRIES})`
            );
            proxyRes.destroy();
            setTimeout(() => doForward(currentPrepared, attempt + 1), delay);
            return;
          }

          if (
            attempt === 1 &&
            (code >= 500 || code === 429) &&
            currentPrepared.profile.backupProfileId
          ) {
            const backupProfile = (getProfiles(loadConfig()) || []).find(
              (p) => p.id === currentPrepared.profile.backupProfileId
            );
            if (backupProfile) {
              console.warn(
                `[Failover] Upstream returned status ${code}, falling back to backup profile: ${backupProfile.id}`
              );
              const backupPrepared = { ...currentPrepared, profile: backupProfile };
              proxyRes.destroy();
              doForward(backupPrepared, 2);
              return;
            }
          }

          const headers = {
            ...proxyRes.headers,
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'access-control-allow-headers': '*',
          };

          const isStream =
            (proxyRes.headers['content-type'] || '').indexOf('text/event-stream') >= 0;
          const shouldSanitizeOpenAIStream =
            code >= 200 &&
            code < 300 &&
            isStream &&
            isClaudeMessagesPath(clientPath) &&
            isOpenAIProfile(currentPrepared.profile);
          const shouldProtectStream =
            code >= 200 &&
            code < 300 &&
            isStream &&
            isClaudeMessagesPath(clientPath) &&
            !isOpenAIProfile(currentPrepared.profile);
          if (shouldProtectStream || shouldSanitizeOpenAIStream) delete headers['content-length'];
          clientRes.writeHead(code, headers);
          const errorChunks = [];
          let errorBytes = 0;
          let logged = false;

          if (shouldSanitizeOpenAIStream) {
            clientRes.__diagnostics = {
              protocol: 'openai',
              route: currentPrepared.model,
              target: currentPrepared.rewriteTo,
              upstreamPath,
              profile: currentPrepared.profile && currentPrepared.profile.id,
            };
            const sseState = { buffer: '', pendingClaudeTool: null, mode: 'strip-empty-optionals' };
            proxyRes.on('data', function (chunk) {
              const chunkText = chunk.toString('utf8');
              if (!logged) logged = true;
              sampleResponseChunk('openai-upstream', chunkText, {
                route: currentPrepared.model,
                target: currentPrepared.rewriteTo,
                upstreamPath,
              });
              processClaudeSseChunk(clientRes, chunkText, sseState);
            });
            proxyRes.on('end', function () {
              flushClaudeSseFilter(clientRes, sseState);
              log.info(
                'ok ' +
                  method +
                  ' ' +
                  urlPath +
                  '  -> ' +
                  code +
                  ' (streaming sanitized, ' +
                  (Date.now() - startTime) +
                  'ms)'
              );
              clientRes.end();
              logRequestEnd(method, urlPath, startTime, code, { type: 'openai_stream_sanitized' });
            });
            return;
          }

          if (shouldProtectStream) {
            clientRes.__diagnostics = {
              protocol: 'openai',
              route: currentPrepared.model,
              target: currentPrepared.rewriteTo,
              upstreamPath,
              profile: currentPrepared.profile && currentPrepared.profile.id,
            };
            const sseState = { buffer: '', pendingClaudeTool: null };
            proxyRes.on('data', function (chunk) {
              const chunkText = chunk.toString('utf8');
              if (!logged) logged = true;
              sampleResponseChunk('openai-upstream', chunkText, {
                route: currentPrepared.model,
                target: currentPrepared.rewriteTo,
                upstreamPath,
              });
              processClaudeSseChunk(clientRes, chunkText, sseState);
            });
            proxyRes.on('end', function () {
              flushClaudeSseFilter(clientRes, sseState);
              log.info(
                'ok ' +
                  method +
                  ' ' +
                  urlPath +
                  '  -> ' +
                  code +
                  ' (protected streaming, ' +
                  (Date.now() - startTime) +
                  'ms)'
              );
              clientRes.end();
              logRequestEnd(method, urlPath, startTime, code, { type: 'openai_stream_protected' });
            });
            return;
          }

          proxyRes.on('data', function (chunk) {
            if (!logged) {
              const elapsed = Date.now() - startTime;
              if (!isStream)
                log.info('ok ' + method + ' ' + urlPath + '  -> ' + code + ' (' + elapsed + 'ms)');
              logged = true;
            }

            if (code >= 400 && !isStream && errorBytes < 4096) {
              const remaining = 4096 - errorBytes;
              const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
              errorChunks.push(part);
              errorBytes += part.length;
            }
          });

          proxyRes.on('end', function () {
            if (isStream)
              log.info(
                'ok ' +
                  method +
                  ' ' +
                  urlPath +
                  '  -> ' +
                  code +
                  ' (streaming, ' +
                  (Date.now() - startTime) +
                  'ms)'
              );
            logRequestEnd(method, urlPath, startTime, code, {
              type: isStream ? 'openai_stream' : 'openai',
            });

            if (code >= 400 && errorChunks.length > 0) {
              const requestId =
                proxyRes.headers['x-request-id'] ||
                proxyRes.headers['request-id'] ||
                proxyRes.headers['anthropic-request-id'] ||
                '-';
              const retryAfter = proxyRes.headers['retry-after'] || '-';
              const body = Buffer.concat(errorChunks).toString('utf8').replace(/\s+/g, ' ').trim();
              const requestedModel = currentPrepared.model || '';
              log.warn(
                '!! upstream error ' +
                  method +
                  ' ' +
                  upstreamPath +
                  ' -> ' +
                  code +
                  ' model=' +
                  requestedModel +
                  ' request-id=' +
                  requestId +
                  ' retry-after=' +
                  retryAfter +
                  ' body=' +
                  body
              );
              logProxyEvent('upstream_error', {
                method,
                path: upstreamPath,
                code,
                model: requestedModel,
                body,
              });
            }
          });

          proxyRes.pipe(clientRes);
        }
      );

      proxyReq.on('timeout', function () {
        if (attempt <= MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          console.warn(
            `[Retry] Upstream timeout, retrying in ${Math.round(delay)}ms... (Attempt ${attempt}/${MAX_RETRIES})`
          );
          proxyReq.destroy();
          setTimeout(() => doForward(currentPrepared, attempt + 1), delay);
          return;
        }
        proxyReq.destroy(new Error('Gateway Timeout (Upstream request timed out)'));
      });

      proxyReq.on('error', function (err) {
        if (attempt <= MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          console.warn(
            `[Retry] Upstream error (${err.message}), retrying in ${Math.round(delay)}ms... (Attempt ${attempt}/${MAX_RETRIES})`
          );
          proxyReq.destroy();
          setTimeout(() => doForward(currentPrepared, attempt + 1), delay);
          return;
        }
        if (attempt === 1 && currentPrepared.profile.backupProfileId) {
          const backupProfile = (getProfiles(loadConfig()) || []).find(
            (p) => p.id === currentPrepared.profile.backupProfileId
          );
          if (backupProfile) {
            console.warn(
              `[Failover] Upstream request failed (${err.message}), falling back to backup profile: ${backupProfile.id}`
            );
            const backupPrepared = { ...currentPrepared, profile: backupProfile };
            doForward(backupPrepared, 2);
            return;
          }
        }

        log.error('xx ' + method + ' ' + urlPath + '  ' + (err.code || err.message));
        logProxyEvent('proxy_error', { method, path: urlPath, error: err.message, code: err.code });
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, {
            'Content-Type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
          });
          clientRes.end(
            JSON.stringify({
              error: { message: 'Proxy error: ' + err.message, type: 'proxy_error' },
            })
          );
        }
      });

      proxyReq.end(currentPrepared.buffer);
    }

    if (cliSession && cliSession.modelOverride) {
      const targetModel = cliSession.modelOverride;
      const resolved = resolveRoute(targetModel, MODEL_ROUTES, PROFILES, ACTIVE_PROFILE);

      initialPrepared.profile = resolved.profile;
      initialPrepared.route = resolved.route;
      initialPrepared.model = targetModel;
      initialPrepared.routed = true;
      initialPrepared.rewriteTo =
        resolved.route && resolved.route.to && resolved.route.to !== '*'
          ? resolved.route.to
          : targetModel;

      if (!clientReq.headers['content-encoding'] && requestBuffer && requestBuffer.length > 0) {
        try {
          const parsed = JSON.parse(requestBuffer.toString('utf8'));
          if (parsed) {
            parsed.model = initialPrepared.rewriteTo;
            initialPrepared.buffer = Buffer.from(JSON.stringify(parsed));
          }
        } catch (e) {}
      }
    }

    resolveOfficialCredentials(initialPrepared, clientReq.headers)
      .then(async function (prepared) {
        if (
          isClaudeMessagesPath(clientPath) &&
          prepared.buffer &&
          !clientReq.headers['content-encoding']
        ) {
          try {
            const parsed = JSON.parse(prepared.buffer.toString('utf8'));
            const augmented = await mcpHub.augmentRequestTools(parsed);
            prepared.buffer = Buffer.from(JSON.stringify(augmented));
          } catch (e) {}
        }
        doForward(prepared, 1);
      })
      .catch(function (err) {
        log.error('[auth] Failed to resolve credentials:', err.message);
        doForward(initialPrepared, 1);
      });
  });

  clientReq.on('aborted', function () {
    clientRes.destroy();
  });
}

/* ========== 启动 ========== */

if (require.main === module) {
  const MGMT_PORT = parseInt(
    process.env.MGMT_PORT || CONFIG.localServer?.managementPort || PORT + 100,
    10
  );

  const checkExistingManagementServer = function (callback) {
    let settled = false;
    function finish(isProxy) {
      if (settled) return;
      settled = true;
      callback(isProxy);
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: MGMT_PORT,
        path: '/v1/local/health',
        method: 'GET',
        timeout: 500,
      },
      function (res) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
          body += chunk;
          if (body.length > 4096) req.destroy();
        });
        res.on('end', function () {
          try {
            const parsed = JSON.parse(body || '{}');
            finish(res.statusCode >= 200 && res.statusCode < 300 && parsed.appId === APP_ID);
          } catch (err) {
            finish(false);
          }
        });
      }
    );
    req.on('timeout', function () {
      req.destroy();
      finish(false);
    });
    req.on('error', function () {
      finish(false);
    });
    req.end();
  };

  const startServers = function () {
    const tlsConfig = ensureCert();
    const servers = [];

    // Wire safety-module shutdown hook to our local shutdown
    try {
      exceptionHandlers.setShutdownHook(function (reason) {
        shutdown();
      });
    } catch (e) {}

    function shutdown() {
      let remaining = servers.length;
      if (!remaining) process.exit(0);
      for (const server of servers) {
        try {
          server.close(function () {
            remaining -= 1;
            if (remaining === 0) process.exit(0);
          });
        } catch (err) {
          remaining -= 1;
          if (remaining === 0) process.exit(0);
        }
      }
    }

    function handleListenError(serverName, err) {
      if (err && err.code === 'EADDRINUSE') {
        log.error(
          '[startup] ' +
            serverName +
            ' is already in use. Stop the owning process or change the configured port.'
        );
        process.exit(1);
        return;
      }
      log.error('[startup] ' + serverName + ' failed: ' + (err && err.message ? err.message : err));
      process.exit(1);
    }

    function listenEntry(entry) {
      const factory = entry.tls === false ? http : https;
      const server =
        entry.tls === false
          ? factory.createServer(function (req, res) {
              handleRequest(req, res, entry);
            })
          : factory.createServer(tlsConfig, function (req, res) {
              handleRequest(req, res, entry);
            });
      servers.push(server);
      const listenHost = entry.host === 'localhost' ? '127.0.0.1' : entry.host;
      server.on('error', function (err) {
        handleListenError('port ' + listenHost + ':' + entry.listenPort, err);
      });
      server.listen(entry.listenPort, listenHost, function () {
        log.info(
          '  Listen:  ' +
            (entry.tls === false ? 'http' : 'https') +
            '://' +
            entry.host +
            ':' +
            entry.listenPort +
            entry.basePath +
            '  [' +
            entry.protocol +
            ']'
        );
      });
      return server;
    }

    log.info('');
    log.info('+-----------------------------------------------+');
    log.info('|        OpenAI HTTPS Proxy                      |');
    log.info('+-----------------------------------------------+');
    log.info('');

    const envEntry = process.env.PORT ? [{ ...LOCAL_SERVER, listenPort: PORT }] : ENTRY_SERVERS;
    for (const entry of envEntry) listenEntry(entry);

    // ── HTTP 管理端口 ──────────────────────────────────
    // 纯 HTTP 服务器，仅处理 /v1/local/* 管理 API，不转发代理请求。
    // 解决 Tauri 生产模式下 webview 无法访问自签名 HTTPS 的问题。
    const mgmtServer = http.createServer(function (req, res) {
      const urlPath = req.url || '';
      if (!installManagementCorsGuard(req, res)) return;
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      // 只允许 /v1/local/* 管理端点
      if (urlPath.startsWith('/v1/local/') || urlPath.startsWith('/local/')) {
        handleRequest(req, res, envEntry[0] || LOCAL_SERVER);
        return;
      }
      // 拒绝其他所有请求（不允许通过 HTTP 管理端口做代理转发）
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Management port only accepts /v1/local/* requests' }));
    });
    servers.push(mgmtServer);
    mgmtServer.on('error', function (err) {
      handleListenError('management port 127.0.0.1:' + MGMT_PORT, err);
    });
    // Write the management token to disk BEFORE starting to listen so
    // dev-static-server.js (and any other reader) sees the new token the
    // moment the port is reachable. Without this, there's a small window
    // where the server is accepting connections but the token file still
    // holds the previous process's token, and any forwarded management
    // request gets 401 Unauthorized until the new token is written.
    writeManagementTokenFile(MGMT_PORT);
    mgmtServer.listen(MGMT_PORT, '127.0.0.1', function () {
      writeManagementTokenFile(MGMT_PORT);
      log.info('  Mgmt:    http://127.0.0.1:' + MGMT_PORT + '/v1/local/*  [management-http]');
    });

    process.nextTick(function () {
      log.info('');
      log.info('  Profile: ' + (ACTIVE_PROFILE.name || ACTIVE_PROFILE.id || 'default'));
      log.info('  Target:  ' + ACTIVE_PROFILE.targetUrl);
      log.info('  Routes:  ' + MODEL_ROUTES.length);
      log.info('');
      log.info('  SDK Config:');
      for (const entry of envEntry) {
        log.info(
          '    ' +
            entry.protocol +
            ': ' +
            (entry.tls === false ? 'http' : 'https') +
            '://' +
            entry.host +
            ':' +
            entry.listenPort +
            entry.basePath
        );
      }
      log.info('    management: http://127.0.0.1:' + MGMT_PORT + '/v1/local/*');
      log.info('    mgmt_token_file: ' + path.join(DATA_DIR, `.mgmt-token-${MGMT_PORT}`));
      log.info('    mgmt_token_hint: ' + maskManagementToken(MANAGEMENT_TOKEN));
      log.info('    openai.api_key  = "your key"');
      log.info('');
      log.info('  Ctrl+C to stop');
      log.info('');
    });

    process.on('SIGINT', function () {
      log.info('\nStopping...');
      shutdown();
    });
    process.on('SIGTERM', shutdown);
  };

  checkExistingManagementServer(function (isRunning) {
    if (isRunning) {
      log.info(
        '[single-instance] Existing proxy management endpoint detected on 127.0.0.1:' +
          MGMT_PORT +
          '; exiting duplicate process.'
      );
      process.exit(0);
      return;
    }
    startServers();
  });
}

function bufferFromResponseChunk(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

function sendRequestTooLarge(clientReq, clientRes, limit) {
  if (clientRes.headersSent) return;
  const body = JSON.stringify({
    error: {
      type: 'request_too_large',
      message: 'Request body exceeds proxy limit of ' + limit + ' bytes',
    },
  });
  clientRes.writeHead(413, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  clientRes.end(body);
}

function appendAuditText(current, addition) {
  const text = String(addition || '');
  if (!text) return { value: current || '', truncated: false };
  const base = current || '';
  if (base.length >= AUDIT_MAX_TEXT_CHARS) return { value: base, truncated: true };
  const remaining = AUDIT_MAX_TEXT_CHARS - base.length;
  if (text.length > remaining) return { value: base + text.slice(0, remaining), truncated: true };
  return { value: base + text, truncated: false };
}

function populateAuditDataFromPrepared(clientRes, prepared, requestBuffer) {
  const auditData = clientRes && clientRes.__auditData;
  if (!auditData || !prepared) return;
  const profile = prepared.profile || {};
  const requestProtocol = isGeminiProfile(profile)
    ? 'gemini'
    : isClaudeProfile(profile)
      ? 'claude'
      : 'openai';
  auditData.originalModel = prepared.model || '';
  auditData.rewriteModel = prepared.rewriteTo || '';
  auditData.profileId = profile.id || '';
  auditData.profileName = profile.name || profile.id || '';
  auditData.protocol = requestProtocol;

  try {
    const sourceBuffer = prepared.buffer || requestBuffer || Buffer.alloc(0);
    const extracted = extractPromptFromBuffer(sourceBuffer, requestProtocol);
    auditData.system = extracted.system;
    auditData.messages = extracted.messages;
  } catch (err) {
    auditData.system = auditData.system || '';
    auditData.messages = auditData.messages || [];
  }
}

function extractPromptFromBuffer(buffer, protocol) {
  let system = '';
  const messages = [];
  try {
    const raw = JSON.parse(buffer.toString('utf8'));

    if (protocol === 'gemini') {
      if (raw.systemInstruction && Array.isArray(raw.systemInstruction.parts)) {
        system = raw.systemInstruction.parts.map((p) => p.text || '').join('\n');
      }
      if (Array.isArray(raw.contents)) {
        raw.contents.forEach((item) => {
          const role = item.role === 'model' ? 'assistant' : 'user';
          let content = '';
          const toolUses = [];
          const toolResults = [];
          if (Array.isArray(item.parts)) {
            item.parts.forEach((p) => {
              if (p.text) content += p.text;
              if (p.functionCall) {
                toolUses.push({
                  id: p.functionCall.name,
                  name: p.functionCall.name,
                  args: p.functionCall.args,
                });
              }
              if (p.functionResponse) {
                toolResults.push({
                  name: p.functionResponse.name,
                  content: p.functionResponse.response,
                });
              }
            });
          }
          messages.push({ role, content, toolUses, toolResults });
        });
      }
    } else {
      if (raw.system) {
        if (typeof raw.system === 'string') system = raw.system;
        else if (Array.isArray(raw.system)) {
          system = raw.system.map((x) => x.text || JSON.stringify(x)).join('\n');
        }
      }

      const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
      rawMessages.forEach((msg) => {
        const role = msg.role;
        let content = '';
        const toolUses = [];
        const toolResults = [];

        if (role === 'system') {
          system = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          return;
        }

        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          msg.content.forEach((block) => {
            if (block.type === 'text') {
              content += block.text || '';
            } else if (block.type === 'image_url') {
              content += '[图片]';
            } else if (block.type === 'tool_use' || block.type === 'tool_call') {
              const id = block.id || (block.function && block.function.name);
              const name = block.name || (block.function && block.function.name);
              const args = block.input || (block.function && block.function.arguments);
              toolUses.push({ id, name, args });
            } else if (block.type === 'tool_result') {
              toolResults.push({
                id: block.tool_use_id,
                content: block.content,
              });
            }
          });
        }

        if (Array.isArray(msg.tool_calls)) {
          msg.tool_calls.forEach((tc) => {
            const id = tc.id;
            const name = tc.function && tc.function.name;
            let args = tc.function && tc.function.arguments;
            try {
              if (typeof args === 'string') args = JSON.parse(args);
            } catch (e) {}
            toolUses.push({ id, name, args });
          });
        }

        if (role === 'tool') {
          toolResults.push({
            id: msg.tool_call_id,
            content: msg.content,
          });
        }

        messages.push({ role, content, toolUses, toolResults });
      });
    }
  } catch (err) {}

  return { system, messages };
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
