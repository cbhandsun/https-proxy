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

const APP_ID = 'https-proxy-manager';
let PACKAGE_VERSION = '0.1.0';
try {
  PACKAGE_VERSION = require('./package.json').version || PACKAGE_VERSION;
} catch (err) {}

const globalHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000,
  rejectUnauthorized: false
});
const globalHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000
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

  if (proxyDetectCached && (Date.now() - lastDetectTime < 15000)) {
    if (callback) callback(detectedProxyUrl, detectedProxyType);
    return;
  }

  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
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
        console.log(`[proxy] Auto-detected local ${type} proxy on port ${port}: ${detectedProxyUrl}`);
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

  emitter.write = function(chunk) {
    if (emitter.activeReq) emitter.activeReq.write(chunk);
    else emitter.pendingBody = (emitter.pendingBody || '') + chunk;
  };
  emitter.end = function() {
    if (emitter.activeReq) emitter.activeReq.end();
    else emitter.ended = true;
  };
  emitter.destroy = function(err) {
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
          // SOCKS5 Connect tunnel
          const socket = new net.Socket();
          socket.setTimeout(requestTimeout || 5000);

          socket.connect(proxy.port, proxy.hostname, () => {
            socket.write(Buffer.from([0x05, 0x01, 0x00]));
          });

          let step = 0;
          socket.on('data', (chunk) => {
            if (fallbackTriggered) {
              socket.destroy();
              return;
            }

            if (step === 0) {
              if (chunk.length >= 2 && chunk[0] === 0x05 && chunk[1] === 0x00) {
                step = 1;
                const domain = target.hostname;
                const domainBuf = Buffer.from(domain, 'utf8');
                const port = target.port || 443;
                const portBuf = Buffer.alloc(2);
                portBuf.writeUInt16BE(port, 0);

                const reqBuf = Buffer.concat([
                  Buffer.from([0x05, 0x01, 0x00, 0x03, domainBuf.length]),
                  domainBuf,
                  portBuf
                ]);
                socket.write(reqBuf);
              } else {
                socket.destroy(new Error('SOCKS5 handshake failed'));
              }
            } else if (step === 1) {
              if (chunk.length >= 2 && chunk[0] === 0x05 && chunk[1] === 0x00) {
                fallbackTriggered = true;

                const tls = require('tls');
                const tlsSocket = tls.connect({
                  socket: socket,
                  servername: target.hostname,
                  rejectUnauthorized: false
                }, () => {
                  const headers = { ...options.headers, host: target.hostname };
                  const req = attachRequestTimeout(http.request({
                    createConnection: () => tlsSocket,
                    method: options.method || 'GET',
                    path: target.path,
                    headers: headers
                  }, callback));

                  emitter.activeReq = req;
                  req.on('error', (e) => emitter.emit('error', e));

                  if (emitter.pendingBody) {
                    req.write(emitter.pendingBody);
                  }
                  req.end();
                });

                tlsSocket.on('error', (e) => {
                  emitter.emit('error', e);
                });
              } else {
                socket.destroy(new Error('SOCKS5 connection request failed'));
              }
            }
          });

          socket.on('error', (e) => {
            if (!fallbackTriggered) {
              console.warn(`[proxy] SOCKS5 via ${proxyUrl} failed (${e.message}), falling back to direct connection...`);
              executeDirect();
            }
          });
          socket.on('timeout', () => {
            socket.destroy(new Error(`Proxy tunnel timeout (${requestTimeout || 5000}ms)`));
          });
        } else {
          // HTTP CONNECT tunnel
          const connectReq = attachRequestTimeout(http.request({
            hostname: proxy.hostname,
            port: proxy.port,
            method: 'CONNECT',
            path: target.hostname + ':' + (target.port || 443),
            headers: proxy.auth ? {
              'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64')
            } : {}
          }));
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
              const tlsSocket = tls.connect({
                socket: socket,
                servername: target.hostname,
                rejectUnauthorized: false
              }, () => {
                const headers = { ...options.headers, host: target.hostname };
                const req = attachRequestTimeout(http.request({
                  createConnection: () => tlsSocket,
                  method: options.method || 'GET',
                  path: target.path,
                  headers: headers
                }, callback));

                emitter.activeReq = req;
                req.on('error', (e) => emitter.emit('error', e));

                if (emitter.pendingBody) {
                  req.write(emitter.pendingBody);
              }
              req.end();
            });

            tlsSocket.on('error', (e) => {
              emitter.emit('error', e);
            });
          });

          connectReq.on('error', (e) => {
            if (!fallbackTriggered) {
              console.warn(`[proxy] HTTP proxy via ${proxyUrl} failed (${e.message}), falling back to direct connection...`);
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
        const req = attachRequestTimeout(http.request({
          hostname: proxy.hostname,
          port: proxy.port,
          path: targetUrl,
          method: options.method || 'GET',
          headers: headers
        }, callback));

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
  encryptKey,
  decryptKey,
} = require('./lib/proxy/config');

function setupFileConsoleTee() {
  if (process.env.PROXY_DISABLE_FILE_LOG === '1') return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const maxLogBytes = Math.max(256 * 1024, Number(process.env.PROXY_LOG_MAX_BYTES || 5 * 1024 * 1024));
    const rotateIfOversized = (filePath) => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size <= maxLogBytes) return;
        const rotated = filePath + '.1';
        try { fs.unlinkSync(rotated); } catch (_) {}
        try { fs.renameSync(filePath, rotated); } catch (_) { fs.writeFileSync(filePath, '', 'utf8'); }
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
      try { stream.write(util.format(...args) + '\n'); } catch (_) {}
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
    try { console.error('[log] Failed to initialize file logging:', e.message); } catch (_) {}
  }
}

setupFileConsoleTee();

const {
  stableHash,
  stableId,
  fallbackId: fallbackIdWithOptions,
  stableCreated,
} = require('./lib/proxy/ids');
const {
  CERT_DIR,
  CERT_FILE,
  KEY_FILE,
  ensureCert,
} = require('./lib/proxy/cert');
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
} = require('./lib/proxy/routing');
const {
  getClaudeDesktopRoutes,
  stripClaudeDesktopPrefix,
  isClaudeDesktopRequest,
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
  PROXY_EVENTS_FILE
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
  clearAuditRecords
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
const { createCertManagement } = require('./lib/proxy/cert-management');
const { handleLocalPromptsSyncRequest, handleLocalPromptsPresetsRequest } = require('./lib/proxy/prompts-sync');
const { createGoogleOfficialRuntime } = require('./lib/proxy/google-official-runtime');
const { createMcpHub } = require('./lib/proxy/mcp-hub');
const {
  getModelsUrl,
  buildModelListRequest,
} = require('./lib/proxy/model-list');
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
const mcpHub = createMcpHub({ getConfig: () => CONFIG });
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
const {
  handleLocalCertStatusRequest,
  handleLocalCertTrustRequest,
  handleLocalCertUntrustRequest,
} = createCertManagement();
const {
  handleLocalTraeStatusRequest,
  handleLocalTraeBridgeStatusRequest,
} = createTraeStatusHandlers({ makeRequest });
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
  handleLocalGeminiCliStatusRequest,
  handleLocalGeminiCliApplyRequest,
  handleLocalGeminiCliRestoreRequest,
} = createToolConfigHandlers();

let watchTimeout;
try {
  fs.watch(CONFIG_FILE, (event) => {
    if (event === 'change') {
      clearTimeout(watchTimeout);
      watchTimeout = setTimeout(reloadProxyConfig, 100);
    }
  });
} catch (err) {
  console.warn('[config] Failed to watch config file:', err.message);
}

function reloadProxyConfig() {
  try {
    const nextConfig = loadConfig();
    CONFIG = nextConfig;
    PROFILES = getProfiles(nextConfig);
    ACTIVE_PROFILE = getActiveProfile(nextConfig);
    LOCAL_SERVER = getLocalServer(nextConfig);
    MODEL_ROUTES = getModelRoutes(nextConfig);
    CLAUDE_DESKTOP_ROUTES = getClaudeDesktopRoutes(nextConfig);

    const nextOptions = { ...DEFAULT_CONFIG.protocolOptions, ...(nextConfig.protocolOptions || {}) };
    for (const key of Object.keys(PROTOCOL_OPTIONS)) {
      delete PROTOCOL_OPTIONS[key];
    }
    Object.assign(PROTOCOL_OPTIONS, nextOptions);

    console.log('[config] Configuration hot-reloaded successfully. Active profile:', ACTIVE_PROFILE.id);
  } catch (err) {
    console.error('[config] Failed to hot-reload configuration:', err.message);
  }
}

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

function logModelMapping(kind, method, upstreamPath, prepared) {
  return logRouteModelMapping(kind, method, upstreamPath, prepared, logProxyEvent);
}

const {
  normalizeClaudeContent,
  isClaudeThinkingBlock,
  filterClaudeCompatibleBlocks,
} = createClaudeFilters({
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
    ...(extra || {})
  });
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

const AUDIT_MAX_CAPTURE_BYTES = Math.max(16 * 1024, Number(process.env.PROXY_AUDIT_MAX_CAPTURE_BYTES || 256 * 1024));
const AUDIT_MAX_TEXT_CHARS = Math.max(1024, Number(process.env.PROXY_AUDIT_MAX_TEXT_CHARS || 120000));
const MAX_REQUEST_BODY_BYTES = Math.max(1024 * 1024, Number(process.env.PROXY_MAX_REQUEST_BODY_BYTES || 32 * 1024 * 1024));
const MAX_CONVERSION_RESPONSE_BYTES = Math.max(1024 * 1024, Number(process.env.PROXY_MAX_CONVERSION_RESPONSE_BYTES || 16 * 1024 * 1024));

// 全局异常处理，避免进程意外崩溃
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
  if (typeof logProxyEvent === 'function') {
    try {
      logProxyEvent('uncaught_exception', { error: err.message, stack: err.stack });
    } catch (e) {}
  }
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection]', reason);
  if (typeof logProxyEvent === 'function') {
    try {
      logProxyEvent('unhandled_rejection', { reason: String(reason) });
    } catch (e) {}
  }
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
});

({ filterClaudeToolUseBlocks, filterClaudeJsonBody } = createClaudeFilters({
  protocolOptions: PROTOCOL_OPTIONS,
  makeSafeClaudeToolUseContentBlock,
}));

const {
  callTraeOfficialBridge,
  writeTraeBridgeOpenAIStream,
  buildTraeBridgeOpenAIResponsesResponse,
  writeTraeBridgeOpenAIResponsesStream,
  buildTraeBridgeClaudeMessageResponse,
  writeTraeBridgeClaudeStream,
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
  writeTraeBridgeOpenAIStream,
  buildTraeBridgeOpenAIChatCompletion,
  buildTraeBridgeOpenAIResponsesResponse,
  writeTraeBridgeOpenAIResponsesStream,
  buildTraeBridgeClaudeMessageResponse,
  writeTraeBridgeClaudeStream,
});

function sendGeminiRateLimit(clientReq, clientRes, upstreamPath, startTime, targetModel, retryAfterSeconds, message, meta) {
  return sendGeminiRateLimitResponse(clientReq, clientRes, upstreamPath, startTime, targetModel, retryAfterSeconds, message, meta, logRequestEnd);
}

function handleCountTokens(clientReq, clientRes, requestBuffer, requestEndLogger, startTime) {
  return handleLocalCountTokens(clientReq, clientRes, requestBuffer, estimateTokens, requestEndLogger, startTime);
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
  sampleResponseChunk,
  logProxyEvent,
  logRequestEnd,
  fallbackId,
  stableCreated,
  extractSseDataPayloads,
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
  return desktopRequest || (entry && entry.protocol === 'claude-desktop') ? CLAUDE_DESKTOP_ROUTES : MODEL_ROUTES;
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

function sendEntryPathError(clientRes, entry, method, clientPath) {
  clientRes.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(JSON.stringify({
    error: {
      type: 'invalid_request_error',
      message: 'Path ' + method + ' ' + clientPath + ' is not supported by ' + entryLabel(entry) + ' entry',
    },
  }));
}

function handleLocalLatencyRequest(clientReq, clientRes) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let { protocol, targetUrl, apiKey, id, profileId } = body;
      if (!targetUrl || !protocol) {
        throw new Error('targetUrl and protocol are required');
      }

      const lookupId = id || profileId;
      let finalProfile = resolveConfiguredProfile({ id: lookupId, protocol, targetUrl, apiKey }, lookupId);

      const resolved = await resolveOfficialCredentials({ profile: finalProfile });
      protocol = resolved.profile.protocol || protocol;
      targetUrl = resolved.profile.targetUrl || targetUrl;
      apiKey = resolved.profile.apiKey;

      const url = getModelsUrl(targetUrl, protocol);
      const urlObj = new URL(url);
      const transport = urlObj.protocol === 'https:' ? https : http;
      const headers = { 'accept': 'application/json' };
      if (apiKey) {
        if (protocol === 'claude') headers['x-api-key'] = apiKey;
        else if (protocol === 'gemini') {
          if (isGoogleOfficialLoginToken(apiKey)) headers['authorization'] = 'Bearer ' + apiKey;
          else headers['x-goog-api-key'] = apiKey;
        }
        else headers['authorization'] = 'Bearer ' + apiKey;
      }

      const startTime = Date.now();
      const targetFullUrl = urlObj.protocol + '//' + urlObj.host + urlObj.pathname + urlObj.search;
      const req = requestWithProxy(targetFullUrl, { method: 'GET', headers }, (res) => {
        const latency = Date.now() - startTime;
        res.resume();
        clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ ok: true, latency }));
      });

      req.on('error', (err) => {
        clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ ok: false, error: err.message }));
      });

    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleLocalClaudeDesktopStatusRequest(clientReq, clientRes) {
  try {
    const status = getClaudeDesktopStatus();
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: true, ...status }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalClaudeDesktopApplyRequest(clientReq, clientRes) {
  try {
    const result = applyClaudeDesktopConfig(CONFIG, CONFIG_FILE, decryptKey);
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: true, ...result }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalClaudeDesktopRestoreRequest(clientReq, clientRes) {
  try {
    restoreClaudeDesktopConfig(CONFIG, CONFIG_FILE);
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: true }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalCliCredentialsRequest(clientReq, clientRes) {
  try {
    const parsedUrl = new URL(clientReq.url, 'http://localhost');
    const type = parsedUrl.searchParams.get('type') || '';

    if (type === 'google') {
      const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
      if (fs.existsSync(credsPath)) {
        const content = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({
          ok: true,
          token: content.access_token || '',
          expiry: content.expiry_date || 0,
          hasRefreshToken: !!content.refresh_token
        }));
        return;
      }
    } else if (type === 'antigravity' || type === 'agy') {
      const agyCreds = readAntigravityOfficialCredentialState();
      if (agyCreds && agyCreds.content) {
        const sendAgyCreds = (token) => {
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({
            ok: true,
            token: token || agyCreds.content.access_token || '',
            expiry: agyCreds.content.expiry_date || 0,
            hasRefreshToken: !!agyCreds.content.refresh_token,
            source: agyCreds.source
          }));
        };
        if (agyCreds.content.refresh_token) {
          refreshGoogleAccessToken(null, agyCreds.content)
            .then(sendAgyCreds)
            .catch(() => sendAgyCreds(agyCreds.content.access_token || ''));
        } else {
          sendAgyCreds(agyCreds.content.access_token || '');
        }
        return;
      }
    } else if (type === 'codex' || type === 'openai') {
      const authPath = path.join(os.homedir(), '.codex', 'auth.json');
      if (fs.existsSync(authPath)) {
        const content = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        const token = (content.tokens && content.tokens.access_token) || content.OPENAI_API_KEY || '';
        clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({
          ok: true,
          token: token,
          hasRefreshToken: !!(content.tokens && content.tokens.refresh_token)
        }));
        return;
      }
    }

    clientRes.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: false, error: '未找到本地凭据文件' }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

async function handleLocalRateLimitsRequest(clientReq, clientRes) {
  try {
    const urlObj = new URL(clientReq.url, 'http://localhost');
    const profileId = urlObj.searchParams.get('profileId') || 'openai-official';

    const profile = PROFILES.find(p => p.id === profileId);
    if (!profile) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ ok: false, error: '找不到 Profile' }));
      return;
    }

    let finalProfile = { ...profile };
    let foundApiKey = finalProfile.apiKey;
    if (foundApiKey && foundApiKey.startsWith('hpm-enc:')) {
      foundApiKey = decryptKey(foundApiKey);
    }
    finalProfile.apiKey = foundApiKey;

    const resolved = await resolveOfficialCredentials({ profile: finalProfile });
    let apiKey = resolved.profile.apiKey;

    if (!apiKey) {
      if (profileId === 'openai-official' || officialLoginProvider(resolved.profile) === 'openai') {
        sendCodexLocalRateLimitsOrError(clientRes, '未检测到 OpenAI 官方登录凭证，已尝试读取 Codex 本地限额。');
      } else {
        clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ ok: false, limits: [], error: '未检测到官方登录凭证，无法同步真实限额。' }));
      }
      return;
    }

    if (profileId === 'google-official') {
      let projectId = resolved.profile.projectId || resolved.profile.managedProjectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || '';
      if (!projectId) {
        const loadProbe = buildGoogleOfficialLoadCodeAssistRequest(apiKey);
        const loadRes = await makeRequest(loadProbe.fullUrl, { method: loadProbe.method, headers: loadProbe.headers }, loadProbe.requestBody);
        if (loadRes.statusCode >= 200 && loadRes.statusCode < 300) {
          try {
            const loaded = JSON.parse(loadRes.body);
            projectId = loaded.cloudaicompanionProject || (loaded.currentTier && loaded.currentTier.cloudaicompanionProject) || '';
          } catch (e) {}
        }
      }

      const availableReq = buildGoogleOfficialAvailableModelsRequest(apiKey, projectId);
      const availableRes = await makeRequest(availableReq.fullUrl, { method: availableReq.method, headers: availableReq.headers }, availableReq.requestBody);
      if (availableRes.statusCode >= 200 && availableRes.statusCode < 300) {
        let parsed = {};
        try { parsed = JSON.parse(availableRes.body); } catch (e) {}
        const limits = formatGoogleOfficialAvailableModels(parsed);
        clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ ok: true, limits, source: 'fetchAvailableModels', projectId: projectId || undefined }));
        return;
      }

      const quotaReq = buildGoogleOfficialRetrieveUserQuotaRequest(apiKey, projectId);
      const quotaRes = await makeRequest(quotaReq.fullUrl, { method: quotaReq.method, headers: quotaReq.headers }, quotaReq.requestBody);
      if (quotaRes.statusCode >= 200 && quotaRes.statusCode < 300) {
        let parsed = {};
        try { parsed = JSON.parse(quotaRes.body); } catch (e) {}
        const limits = formatGoogleOfficialUserQuota(parsed);
        clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ ok: true, limits, source: 'retrieveUserQuota', projectId: projectId || undefined }));
        return;
      }

      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({
        ok: false,
        limits: [],
        source: 'fetchAvailableModels',
        error: `Google 官方限额同步失败 HTTP ${availableRes.statusCode}: ${availableRes.body || quotaRes.body || '无响应'}`
      }));
      return;
    }

    const targetUrl = 'https://chatgpt.com/backend-api/rate_limits';
    const targetUrlObj = new URL(targetUrl);

    const headers = {
      'authorization': 'Bearer ' + apiKey,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept': 'application/json',
    };

    const req = https.request({
      hostname: targetUrlObj.hostname,
      port: 443,
      path: targetUrlObj.pathname + targetUrlObj.search,
      method: 'GET',
      headers,
      timeout: 5000,
      agent: globalHttpsAgent,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const dataStr = Buffer.concat(chunks).toString('utf8');
        try {
          if (res.statusCode !== 200) {
            console.warn(`[RateLimits] Fetch official rate limits failed with status ${res.statusCode}.`);
            sendCodexLocalRateLimitsOrError(clientRes, `OpenAI 后端限额接口 HTTP ${res.statusCode}: ${dataStr || '无法获取真实限额'}`);
            return;
          }
          const data = JSON.parse(dataStr);
          const formatted = formatRateLimits(data);
          if (!formatted.length) {
            sendCodexLocalRateLimitsOrError(clientRes, 'OpenAI 后端限额接口未返回可用窗口数据。');
            return;
          }
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({ ok: true, limits: formatted, source: 'chatgpt-rate-limits' }));
        } catch (err) {
          console.warn(`[RateLimits] Parse limits data failed: ${err.message}.`);
          sendCodexLocalRateLimitsOrError(clientRes, '解析 OpenAI 后端限额失败: ' + err.message);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
    });

    req.on('error', (err) => {
      console.warn(`[RateLimits] Request failed: ${err.message}.`);
      sendCodexLocalRateLimitsOrError(clientRes, '同步 OpenAI 后端限额失败: ' + err.message);
    });

    req.end();
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

function sendCodexLocalRateLimitsOrError(clientRes, error) {
  const local = readLatestCodexLocalRateLimits();
  clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  if (local.ok) {
    clientRes.end(JSON.stringify({ ...local, warning: error || undefined }));
  } else {
    clientRes.end(JSON.stringify({ ok: false, limits: [], error: error || local.error }));
  }
}

function decryptProfileApiKey(profile) {
  let apiKey = profile && profile.apiKey;
  if (apiKey && apiKey.startsWith('hpm-enc:')) {
    apiKey = decryptKey(apiKey);
  } else if (apiKey === '***' || apiKey === '[redacted]') {
    apiKey = '';
  }
  return apiKey;
}

function resolveConfiguredProfile(inputProfile, lookupId) {
  const id = lookupId || (inputProfile && (inputProfile.profileId || inputProfile.id));
  let finalProfile = {
    ...(inputProfile || {}),
    id: id || (inputProfile && inputProfile.id),
    apiKey: decryptProfileApiKey(inputProfile || {})
  };

  if (id) {
    const config = loadConfig();
    const profiles = getProfiles(config) || [];
    const found = profiles.find(p => p && p.id === id);
    if (found) {
      finalProfile = {
        ...found,
        apiKey: decryptProfileApiKey(found)
      };
    }
  }

  return finalProfile;
}

function resolveOfficialCredentials(prepared, clientHeaders) {
  return new Promise((resolve) => {
    const profile = prepared.profile;
    if (!profile) return resolve(prepared);

    const provider = officialLoginProvider(profile);
    const isOfficialProfile = Boolean(provider);
    const requestedAuthMode = isOfficialProfile ? inferOfficialProfileAuthMode(profile, provider) : configuredAuthMode(profile);

    if (!isOfficialProfile) {
      const clientAuth = clientHeaders && (clientHeaders['authorization'] || clientHeaders['x-api-key'] || clientHeaders['x-goog-api-key'] || clientHeaders['api-key']);
      if (clientAuth && clientAuth !== 'Bearer PROXY_MANAGED' && clientAuth !== 'PROXY_MANAGED' && !clientAuth.includes('***') && !clientAuth.includes('[redacted]')) {
        return resolve(prepared);
      }

      const hasValidKey = !isRedactedSecret(profile.apiKey);
      if (hasValidKey) {
        prepared.authMode = 'api-key';
        return resolve(prepared);
      }
    } else {
      // 官方特权路由，忽略并擦除任何客户端传入的自定义 API key，解耦原有密钥，仅允许从本地官方凭据或配置加载
      const profileId = profile.id ? String(profile.id).toLowerCase() : '';
      const globalProfile = profileId
        ? PROFILES.find(p => p.id && String(p.id).toLowerCase() === profileId)
        : null;
      let allowedConfigKey = null;
      if (globalProfile && globalProfile.apiKey) {
        let key = globalProfile.apiKey;
        if (key.startsWith('hpm-enc:')) {
          key = decryptKey(key);
        }
        if (!isRedactedSecret(key)) {
          allowedConfigKey = key;
        }
      }

      if (profile.apiKey !== allowedConfigKey) {
        profile.apiKey = null;
      }
    }

    if (provider === 'google') {
      if (requestedAuthMode === 'api-key') {
        prepared.authMode = 'api-key';
        prepared.authProvider = 'google';
        return resolve(prepared);
      }

      const localCreds = readGoogleOfficialCredentialFile();
      if (localCreds) {
        const { credsPath, content } = localCreds;
        const hasExpired = content.expiry_date && Date.now() > content.expiry_date - 300000;

        if (hasExpired && content.refresh_token) {
          const refreshPromise = content.__readOnly && content.__source === 'antigravity-state'
            ? getFreshAntigravityOfficialAccessToken()
            : refreshGoogleAccessToken(credsPath, content);
          if (!(content.__readOnly && content.__source === 'antigravity-state')) {
            console.log('[auth] Google OAuth token expired or expiring soon, refreshing...');
          }
          refreshPromise
            .then((newToken) => {
              resolveGoogleOfficialLoginPrepared(prepared, profile, newToken, resolve);
            })
            .catch((err) => {
              console.error('[auth] Failed to refresh Google token:', err.message);
              if (!isRedactedSecret(profile.apiKey) && isGoogleOfficialLoginToken(profile.apiKey)) {
                resolveGoogleOfficialLoginPrepared(prepared, profile, profile.apiKey, resolve);
                return;
              } else if (content.access_token) {
                resolveGoogleOfficialLoginPrepared(prepared, profile, content.access_token, resolve);
                return;
              }
              resolve(prepared);
            });
          return;
        } else if (content.access_token) {
          resolveGoogleOfficialLoginPrepared(prepared, profile, content.access_token, resolve);
          return;
        }
      } else if (!isRedactedSecret(profile.apiKey) && isGoogleOfficialLoginToken(profile.apiKey)) {
        resolveGoogleOfficialLoginPrepared(prepared, profile, profile.apiKey, resolve);
        return;
      }
    }

    if (provider === 'openai') {
      if (requestedAuthMode === 'api-key') {
        prepared.authMode = 'api-key';
        prepared.authProvider = 'openai';
        return resolve(prepared);
      }
      if (!isRedactedSecret(profile.apiKey)) {
        prepared.authMode = 'official-login';
        prepared.authProvider = 'openai';
        if (prepared.authMode === 'official-login' && shouldUseChatGPTBackendForOfficialLogin(profile.targetUrl)) {
          prepared.profile = { ...profile, targetUrl: 'https://chatgpt.com/backend-api/codex' };
        }
        return resolve(prepared);
      }

      const authPath = path.join(os.homedir(), '.codex', 'auth.json');
      if (fs.existsSync(authPath)) {
        try {
          const content = JSON.parse(fs.readFileSync(authPath, 'utf8'));
          const token = (content.tokens && content.tokens.access_token) || content.OPENAI_API_KEY || null;
          if (token && token !== 'PROXY_MANAGED') {
            prepared.profile = { ...profile, apiKey: token };
            if (token.startsWith('eyJ')) {
              if (shouldUseChatGPTBackendForOfficialLogin(profile.targetUrl)) {
                prepared.profile.targetUrl = 'https://chatgpt.com/backend-api/codex';
              }
              prepared.authMode = 'official-login';
            } else {
              prepared.authMode = 'api-key';
            }
            prepared.authProvider = 'openai';
          }
        } catch (e) {
          console.error('[auth] Error loading Codex OAuth credentials:', e.message);
        }
      }
    }

    if (provider === 'trae') {
      prepared.authMode = 'official-login';
      prepared.authProvider = 'trae';
      prepared.profile = {
        ...profile,
        protocol: 'trae',
        targetUrl: profile.targetUrl || TRAE_OFFICIAL_TARGET_URL,
        apiKey: null
      };
      prepared.traeOfficialStorage = readTraeStorageSummary();
      return resolve(prepared);
    }

    resolve(prepared);
  });
}

let localEventsResponseCache = { key: '', body: '' };
let localLogResponseCache = { key: '', body: '' };
let localDiagnosticsResponseCache = { key: '', body: '' };

function handleLocalEventsRequest(clientReq, clientRes) {
  try {
    const eventsFile = path.join(DATA_DIR, 'proxy-events.jsonl');
    const parsedUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
    const limit = Math.min(1000, Math.max(1, Number(parsedUrl.searchParams.get('limit') || 200)));
    const after = parsedUrl.searchParams.get('after');
    const afterTime = after ? Date.parse(after) : NaN;
    const readLimit = Number.isFinite(afterTime) ? Math.min(5000, limit * 5) : limit;
    const cacheKey = [eventsFile, fileSignature(eventsFile), limit, after || '', readLimit].join('|');
    if (cacheKey === localEventsResponseCache.key) {
      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(localEventsResponseCache.body);
      return;
    }
    let events = readLastLinesOfJsonl(eventsFile, readLimit, 512 * 1024);
    if (Number.isFinite(afterTime)) {
      events = events.filter((event) => Date.parse(event.time || '') > afterTime).slice(-limit);
    } else {
      events = events.slice(-limit);
    }
    const body = JSON.stringify(events);
    localEventsResponseCache = { key: cacheKey, body };
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(body);
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalEventsClearRequest(clientReq, clientRes) {
  try {
    const eventsFile = path.join(DATA_DIR, 'proxy-events.jsonl');
    if (fs.existsSync(eventsFile)) {
      fs.writeFileSync(eventsFile, '', 'utf8');
    }
    localEventsResponseCache = { key: '', body: '' };
    localDiagnosticsResponseCache = { key: '', body: '' };
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: true }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalGetConfigRequest(clientReq, clientRes) {
  try {
    const rawConfig = loadConfig();
    const cloned = JSON.parse(JSON.stringify(rawConfig));
    if (cloned && Array.isArray(cloned.profiles)) {
      for (const profile of cloned.profiles) {
        if (profile && profile.apiKey) {
          profile.apiKey = '[redacted]';
        }
      }
    }
    if (cloned && cloned.claudeDesktop && cloned.claudeDesktop.directApiKey) {
      cloned.claudeDesktop.directApiKey = '[redacted]';
    }
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify(cloned));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalSaveConfigRequest(clientReq, clientRes) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', () => {
    try {
      const newConfig = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      let currentRaw = {};
      try {
        if (fs.existsSync(CONFIG_FILE)) {
          currentRaw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
      } catch (e) {}

      if (newConfig && Array.isArray(newConfig.profiles)) {
        for (const profile of newConfig.profiles) {
          if (!profile) continue;
          const currentProfile = (currentRaw.profiles || []).find(p => p && p.id === profile.id);
          if (profile.apiKey === '[redacted]' || profile.apiKey === '***') {
            profile.apiKey = currentProfile ? currentProfile.apiKey : '';
          }
          if (profile.apiKey && !profile.apiKey.startsWith('hpm-enc:')) {
            profile.apiKey = encryptKey(profile.apiKey);
          }
        }
      }

      if (newConfig && newConfig.claudeDesktop) {
        if (newConfig.claudeDesktop.directApiKey === '[redacted]' || newConfig.claudeDesktop.directApiKey === '***') {
          newConfig.claudeDesktop.directApiKey = (currentRaw.claudeDesktop && currentRaw.claudeDesktop.directApiKey) || '';
        }
        if (newConfig.claudeDesktop.directApiKey && !newConfig.claudeDesktop.directApiKey.startsWith('hpm-enc:')) {
          newConfig.claudeDesktop.directApiKey = encryptKey(newConfig.claudeDesktop.directApiKey);
        }
      }

      fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
      reloadProxyConfig();
      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ ok: true }));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleLocalSetActiveRequest(clientReq, clientRes) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { profileId } = body;
      if (!profileId) throw new Error('profileId is required');

      let rawConfig = {};
      if (fs.existsSync(CONFIG_FILE)) {
        rawConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      } else {
        rawConfig = loadConfig();
      }

      rawConfig.activeProfile = profileId;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(rawConfig, null, 2), 'utf8');
      reloadProxyConfig();
      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ ok: true }));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: err.message }));
    }
  });
}

function readTailText(filePath, maxLines = 300, maxBytes = 256 * 1024) {
  if (!fs.existsSync(filePath)) return '暂无日志记录';
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return '暂无日志记录';

  const safeBytes = Math.min(stat.size, Math.max(8 * 1024, Number(maxBytes || 256 * 1024)));
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(safeBytes);
    fs.readSync(fd, buffer, 0, safeBytes, stat.size - safeBytes);
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    const safeLines = Math.min(2000, Math.max(1, Number(maxLines || 300)));
    return lines.slice(-safeLines).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function handleLocalLogRequest(clientReq, clientRes) {
  clientRes.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  const logFile = path.join(DATA_DIR, 'proxy.log');
  const parsedUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
  const full = parsedUrl.searchParams.get('full') === '1';
  if (full && fs.existsSync(logFile)) {
    clientRes.end(fs.readFileSync(logFile, 'utf8'));
    return;
  }
  const maxLines = Number(parsedUrl.searchParams.get('lines') || 300);
  const maxBytes = Number(parsedUrl.searchParams.get('maxBytes') || 256 * 1024);
  const cacheKey = [logFile, fileSignature(logFile), fileSignature(PROXY_EVENTS_FILE), maxLines, maxBytes].join('|');
  if (cacheKey === localLogResponseCache.key) {
    clientRes.end(localLogResponseCache.body);
    return;
  }
  let body = readTailText(logFile, maxLines, maxBytes);
  const recentEvents = formatRecentProxyEventsForLog(30);
  if (recentEvents) {
    body += (body && !body.endsWith('\n') ? '\n' : '') + '\n--- recent proxy events ---\n' + recentEvents;
  }
  localLogResponseCache = { key: cacheKey, body };
  clientRes.end(body);
}

function formatRecentProxyEventsForLog(limit) {
  const events = readLastLinesOfJsonl(PROXY_EVENTS_FILE, limit, 256 * 1024);
  if (!events.length) return '';
  return events.map((event) => {
    const time = event.time || '-';
    if (event.kind === 'request_start') {
      return `${time} request_start ${event.method || ''} ${event.path || ''} entry=${event.entryProtocol || '-'}`;
    }
    if (event.kind === 'route') {
      return `${time} route ${event.method || ''} ${event.path || ''} ${event.sourceModel || '-'} -> ${event.profileId || '-'}:${event.targetModel || '-'} protocol=${event.protocol || '-'}`;
    }
    if (event.kind === 'request_end') {
      const endpoint = event.upstreamEndpoint ? ` upstream=${event.upstreamEndpoint}` : '';
      return `${time} request_end ${event.method || ''} ${event.path || ''} -> ${event.statusCode || '-'} elapsed=${event.elapsed || 0}ms type=${event.type || '-'}${endpoint}`;
    }
    if (event.kind === 'upstream_error') {
      return `${time} upstream_error ${event.method || ''} ${event.path || ''} -> ${event.code || '-'} model=${event.model || '-'} body=${event.body || ''}`;
    }
    if (event.kind === 'proxy_error') {
      return `${time} proxy_error ${event.method || ''} ${event.path || ''} ${event.code || ''} ${event.error || ''}`;
    }
    return `${time} ${event.kind || 'event'} ${JSON.stringify(event)}`;
  }).join('\n');
}

function getFormattedDiagnosticsOutput() {
  const allEvents = [];

  // 1. proxy-events.jsonl (max 100)
  const proxyEvents = readLastLinesOfJsonl(PROXY_EVENTS_FILE, 100);
  for (const item of proxyEvents) {
    const time = item.time || new Date().toISOString();
    let text = '';
    if (item.kind === 'request_start') {
      text = `[Proxy-Request] ${item.method} ${item.path} (clientIp: ${item.clientIp || 'unknown'}, protocol: ${item.entryProtocol || 'unknown'})`;
    } else if (item.kind === 'request_end') {
      text = `[Proxy-Response] ${item.method} ${item.path} -> ${item.statusCode} (elapsed: ${item.elapsed || 0}ms, type: ${(item.extra && item.extra.type) || 'unknown'})`;
    } else if (item.kind === 'upstream_error') {
      text = `[Upstream-Error] ${item.method} ${item.path} -> ${item.code} (model: ${item.model || 'N/A'}, errorBody: ${item.body || ''})`;
    } else if (item.kind === 'proxy_error') {
      text = `[Proxy-Error] ${item.method} ${item.path} (error: ${item.error || 'N/A'})`;
    } else {
      text = `[Event] kind=${item.kind} ${JSON.stringify(item)}`;
    }
    allEvents.push({ time, text });
  }

  // 2. tool-call-audit.jsonl (max 20)
  const toolAudits = readLastLinesOfJsonl(TOOL_AUDIT_FILE, 20);
  for (const item of toolAudits) {
    const time = item.time || new Date().toISOString();
    const text = `[Tool-Audit] tool: ${item.toolName} (source: ${item.source}) - Status: INVALID, Error: ${item.error}`;
    allEvents.push({ time, text });
  }

  // 3. gemini-tool-samples.jsonl (max 20)
  const geminiTools = readLastLinesOfJsonl(GEMINI_SAMPLE_FILE, 20);
  for (const item of geminiTools) {
    const time = item.time || new Date().toISOString();
    const text = `[Gemini-Tool] reason: ${item.reason} - payload: ${JSON.stringify(item.payload)}`;
    allEvents.push({ time, text });
  }

  // 4. diagnostics-outbound-sse.jsonl (max 20)
  const sseSamples = readLastLinesOfJsonl(DIAGNOSTICS_OUTBOUND_SSE_FILE, 20);
  for (const item of sseSamples) {
    const time = item.time || new Date().toISOString();
    const p = item.payload || {};
    const text = `[Outbound-SSE] event: ${p.event} (index: ${p.index}, toolName: ${p.toolName || 'N/A'})`;
    allEvents.push({ time, text });
  }

  // 5. diagnostics-request-tools.jsonl (max 20)
  const requestTools = readLastLinesOfJsonl(DIAGNOSTICS_REQUEST_TOOLS_FILE, 20);
  for (const item of requestTools) {
    const time = item.time || new Date().toISOString();
    const p = item.payload || {};
    const text = `[Request-Tools] model: ${p.model} (messageCount: ${p.messageCount || 0}, uses: ${p.toolUses ? p.toolUses.length : 0}, results: ${p.toolResults ? p.toolResults.length : 0})`;
    allEvents.push({ time, text });
  }

  // 6. Sort chronologically
  allEvents.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  if (allEvents.length === 0) {
    return '暂无诊断事件。请确保 diagnostics.enabled 在配置文件中开启，并进行了一些代理请求。';
  }

  return allEvents.map(ev => {
    const localTime = new Date(ev.time).toLocaleString();
    return `[${localTime}] ${ev.text}`;
  }).join('\n');
}

async function handleLocalEnvCheckRequest(clientReq, clientRes) {
  try {
    const result = await checkEnvironmentTools();

    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({
      ok: true,
      ...result
    }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

async function handleLocalEnvUpgradeRequest(clientReq, clientRes) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', async () => {
    try {
      let body = {};
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {}
      }
      const { toolId } = body;
      const toolIds = Array.isArray(body.toolIds) ? body.toolIds.filter(Boolean) : null;
      let targetTools = [];
      if (toolIds && toolIds.length > 0) {
        const allowedIds = new Set(toolIds);
        targetTools = ENV_CHECK_TOOLS.filter(t => allowedIds.has(t.id));
      } else if (toolId) {
        const found = ENV_CHECK_TOOLS.find(t => t.id === toolId);
        if (found) targetTools.push(found);
      } else {
        targetTools = [...ENV_CHECK_TOOLS];
      }

      if (targetTools.length === 0) {
        throw new Error('未找到指定的工具包');
      }

      const results = [];
      for (const tool of targetTools) {
        const job = startToolInstallJob(tool);
        results.push({
          id: tool.id,
          name: tool.name,
          ok: job.status !== 'failed',
          jobId: job.jobId,
          status: job.status,
          error: job.error || null,
          startedAt: job.startedAt,
          endedAt: job.endedAt || null,
          installCommand: job.installCommand,
          usesIrm: job.usesIrm,
          lastLine: job.lastLine || '',
          outputTail: (job.output || '').slice(-2000)
        });
      }

      clearEnvCaches();

      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ ok: true, results }));
    } catch (err) {
      clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleLocalEnvInstallJobsRequest(clientReq, clientRes) {
  try {
    const reqUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
    const ids = (reqUrl.searchParams.get('ids') || '').split(',').map(id => id.trim()).filter(Boolean);
    const jobs = listInstallJobs(ids);
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: true, jobs }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalSelectDirectoryRequest(clientReq, clientRes) {
  try {
    const cp = require('child_process');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$code = { Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择工作目录'; $dialog.ShowNewFolderButton = $true; if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath } }; $thread = [PowerShell]::Create().AddScript($code); $thread.Runspace.ApartmentState = 'STA'; $result = $thread.BeginInvoke(); while (-not $result.IsCompleted) { Start-Sleep -Milliseconds 100 }; $thread.EndInvoke($result)"`;

    cp.exec(cmd, (err, stdout, stderr) => {
      if (err) {
        clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ error: err.message }));
        return;
      }
      const selectedPath = stdout.trim();
      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ ok: true, path: selectedPath }));
    });
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

async function handleLocalCliLaunchRequest(clientReq, clientRes) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { toolId, model, cwd, envs, terminal, upgrade, customArgs } = body;

      if (!toolId) throw new Error('toolId is required');

      const foundTool = ENV_CHECK_TOOLS.find(t => t.id === toolId);
      if (!foundTool) throw new Error('Unknown tool: ' + toolId);

      if (upgrade) {
        await new Promise((resolve) => {
          runToolInstall(foundTool).then((res) => {
            if (!res.ok) {
              console.error(`[cli-launch] Failed to upgrade ${foundTool.name}:`, res.error);
            }
            resolve();
          }).catch((err) => {
            console.error(`[cli-launch] Failed to upgrade ${foundTool.name}:`, err.message);
            resolve();
          });
        });
      }

      const sessionToken = 'hpm-session-' + Math.random().toString(36).substring(2, 10);
      CLI_SESSIONS.set(sessionToken, {
        toolId,
        toolName: foundTool.name,
        modelOverride: model,
        customArgs: customArgs || '',
        createdAt: Date.now(),
        lastUsedAt: 0,
        requestCount: 0
      });

      let proxyUrl = 'https://localhost:3443';
      const entries = ENTRY_SERVERS || [];
      const httpsEntry = entries.find(e => e.protocol === 'claude' || e.protocol === 'openai');
      if (httpsEntry) {
        proxyUrl = `${httpsEntry.tls === false ? 'http' : 'https'}://localhost:${httpsEntry.listenPort}`;
      } else if (LOCAL_SERVER) {
        proxyUrl = `${LOCAL_SERVER.tls === false ? 'http' : 'https'}://localhost:${PORT}`;
      }

      const customEnvs = {};
      if (envs && typeof envs === 'string') {
        const lines = envs.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx > 0) {
            const k = trimmed.substring(0, idx).trim();
            const v = trimmed.substring(idx + 1).trim();
            if (k) customEnvs[k] = v;
          }
        }
      }

      const injectedEnvs = {
        'ANTHROPIC_BASE_URL': proxyUrl,
        'ANTHROPIC_API_KEY': sessionToken,
        'ANTHROPIC_AUTH_TOKEN': sessionToken,
        'OPENAI_BASE_URL': proxyUrl + '/v1',
        'OPENAI_API_KEY': sessionToken,
        'GEMINI_API_BASE': proxyUrl + '/v1',
        'GEMINI_API_KEY': sessionToken,
        'GOOGLE_GEMINI_BASE_URL': proxyUrl + '/v1',
        'DEEPSEEK_API_KEY': sessionToken,
        ...customEnvs
      };
      if (toolId === 'claude-code') {
        delete injectedEnvs['ANTHROPIC_AUTH_TOKEN'];
      }

      const workDir = cwd ? path.resolve(cwd) : process.cwd();
      let cliCommand = foundTool.command;
      if (customArgs && typeof customArgs === 'string' && customArgs.trim()) {
        cliCommand += ' ' + customArgs.trim();
      }

      let launchCmd = '';
      if (terminal === 'PowerShell' || terminal === 'powershell') {
        const envSetStatements = Object.keys(injectedEnvs)
          .map(k => {
            const val = injectedEnvs[k] || '';
            return `$env:${k}='${val.replace(/'/g, "''")}'`;
          })
          .join('; ');
        launchCmd = `start powershell -NoExit -Command "Set-Location -Path '${workDir.replace(/'/g, "''")}'; $Host.UI.RawUI.WindowTitle='Claude Code (${model || 'default'})'; ${envSetStatements}; ${cliCommand}"`;
      } else {
        const envSetStatements = Object.keys(injectedEnvs)
          .map(k => `set ${k}=${injectedEnvs[k] || ''}`)
          .join(' && ');
        launchCmd = `cmd /c start cmd /k "title Claude Code (${model || 'default'}) && cd /d ${workDir} && ${envSetStatements} && ${cliCommand}"`;
      }

      console.log(`[cli-launch] Launching ${foundTool.name} via ${terminal} in ${workDir} with args: ${customArgs || 'none'}`);
      cp.exec(launchCmd, { cwd: workDir }, (err) => {
        if (err) {
          console.error(`[cli-launch] Exec error:`, err.message);
        }
      });

      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ ok: true, sessionToken }));
    } catch (err) {
      clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleLocalCliSessionsRequest(clientReq, clientRes) {
  try {
    const list = [];
    for (const [token, session] of CLI_SESSIONS.entries()) {
      list.push({
        sessionToken: token,
        toolId: session.toolId,
        toolName: session.toolName || session.toolId,
        modelOverride: session.modelOverride,
        customArgs: session.customArgs || '',
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt || 0,
        requestCount: session.requestCount || 0
      });
    }
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: true, sessions: list }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalCliSessionDeleteRequest(clientReq, clientRes) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { sessionToken } = body;
      if (!sessionToken) throw new Error('sessionToken is required');

      const deleted = CLI_SESSIONS.delete(sessionToken);
      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ ok: true, deleted }));
    } catch (err) {
      clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: err.message }));
    }
  });
}

function handleLocalHealthRequest(clientReq, clientRes) {
  clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  clientRes.end(JSON.stringify({
    ok: true,
    appId: APP_ID,
    version: PACKAGE_VERSION,
    status: 'running',
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    ports: {
      management: parseInt(process.env.MGMT_PORT || CONFIG.localServer?.managementPort || (PORT + 100), 10),
      entries: ENTRY_SERVERS.map((entry) => ({
        protocol: entry.protocol,
        host: entry.host,
        listenPort: entry.listenPort,
        basePath: entry.basePath,
        tls: entry.tls !== false,
      })),
    },
  }));
}

function handleLocalDiagnosticsGetRequest(clientReq, clientRes) {
  try {
    const config = getDiagnosticsConfig();

    const filesMeta = [
      { label: 'Gemini采样', path: GEMINI_SAMPLE_FILE },
      { label: '工具审计', path: TOOL_AUDIT_FILE },
      { label: '响应采样', path: RESPONSE_SAMPLE_FILE },
      { label: '出站SSE', path: DIAGNOSTICS_OUTBOUND_SSE_FILE },
      { label: '请求工具', path: DIAGNOSTICS_REQUEST_TOOLS_FILE },
      { label: '代理事件', path: PROXY_EVENTS_FILE }
    ];

    const cacheKey = [
      JSON.stringify(config),
      ...filesMeta.map((item) => `${item.path}:${fileSignature(item.path)}`)
    ].join('|');
    if (cacheKey === localDiagnosticsResponseCache.key) {
      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(localDiagnosticsResponseCache.body);
      return;
    }

    const files = filesMeta.map(item => {
      const exists = fs.existsSync(item.path);
      const bytes = exists ? fs.statSync(item.path).size : 0;
      return { label: item.label, exists, bytes };
    });

    const output = getFormattedDiagnosticsOutput();

    const body = JSON.stringify({
      ok: true,
      status: {
        config,
        files
      },
      output
    });
    localDiagnosticsResponseCache = { key: cacheKey, body };

    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(body);
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalDiagnosticsClearRequest(clientReq, clientRes) {
  try {
    const filesToClear = [
      GEMINI_SAMPLE_FILE,
      TOOL_AUDIT_FILE,
      RESPONSE_SAMPLE_FILE,
      DIAGNOSTICS_OUTBOUND_SSE_FILE,
      DIAGNOSTICS_REQUEST_TOOLS_FILE,
      PROXY_EVENTS_FILE
    ];

    for (const file of filesToClear) {
      if (fs.existsSync(file)) {
        fs.writeFileSync(file, '', 'utf8');
      }
    }
    localEventsResponseCache = { key: '', body: '' };
    localDiagnosticsResponseCache = { key: '', body: '' };

    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: true }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalModelsListRequest(clientReq, clientRes) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', async () => {
    let responded = false;
    let activeReq = null;
    const sendJson = (payload) => {
      if (responded || clientRes.writableEnded) return;
      responded = true;
      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify(payload));
    };
    const hardTimeout = setTimeout(() => {
      if (activeReq && typeof activeReq.destroy === 'function') {
        activeReq.destroy(new Error('获取上游模型超时'));
      }
      sendJson({ ok: false, error: '获取上游模型超时，请检查上游地址、代理网络或官方登录凭证。' });
    }, 12000);

    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let { id, protocol, targetUrl, apiKey } = body;
      if (!targetUrl || !protocol) throw new Error('targetUrl and protocol are required');

      let finalProfile = resolveConfiguredProfile({ id, protocol, targetUrl, apiKey }, id);

      const resolved = await resolveOfficialCredentials({ profile: finalProfile });
      protocol = resolved.profile.protocol || protocol;
      targetUrl = resolved.profile.targetUrl || targetUrl;
      apiKey = resolved.profile.apiKey;

      if (resolved.authProvider === 'google' && resolved.authMode === 'official-login') {
        clearTimeout(hardTimeout);
        try {
          const upstreamModels = await fetchGoogleOfficialAvailableModels(apiKey, resolved.googleOfficialProjectId);
          if (upstreamModels.ok) {
            sendJson(upstreamModels);
          } else {
            sendJson({
              ...buildGoogleOfficialModelsResponse(),
              warning: upstreamModels.error,
              source: 'official-model-config-fallback'
            });
          }
        } catch (err) {
          sendJson({
            ...buildGoogleOfficialModelsResponse(),
            warning: err.message,
            source: 'official-model-config-fallback'
          });
        }
        return;
      }

      if (resolved.authProvider === 'openai' && resolved.authMode === 'official-login' && isOpenAIOfficialCodexTarget(targetUrl)) {
        clearTimeout(hardTimeout);
        sendJson(buildOpenAIOfficialCodexModelsResponse());
        return;
      }

      if (resolved.authProvider === 'trae' && resolved.authMode === 'official-login') {
        clearTimeout(hardTimeout);
        sendJson(await buildTraeOfficialModelsResponse());
        return;
      }

      const listRequest = buildModelListRequest(targetUrl, protocol, apiKey);

      const req = requestWithProxy(listRequest.requestUrl, {
        method: listRequest.method,
        headers: listRequest.headers,
        timeout: 8000
      }, (res) => {
        const resChunks = [];
        res.on('data', c => resChunks.push(c));
        res.on('end', () => {
          clearTimeout(hardTimeout);
          const dataStr = Buffer.concat(resChunks).toString('utf8');
          try {
            const resData = JSON.parse(dataStr);
            if (res.statusCode !== 200) {
              const errMsg = resData.error && typeof resData.error === 'object'
                ? (resData.error.message || JSON.stringify(resData.error))
                : (resData.error || dataStr || `HTTP ${res.statusCode}`);
              sendJson({ ok: false, error: errMsg, requestUrl: listRequest.requestUrl.replace(/([?&]key=)[^&]+/, '$1[redacted]') });
              return;
            }
            let models = [];
            if (Array.isArray(resData.models)) {
              models = resData.models.map(m => {
                if (typeof m === 'string') return m;
                return m.slug || m.name || m.id || JSON.stringify(m);
              }).map(name => name.replace(/^models\//, ''));
            } else if (Array.isArray(resData.data)) {
              models = resData.data.map(m => {
                if (typeof m === 'string') return m;
                return m.id || m.slug || m.name || JSON.stringify(m);
              });
            } else if (resData.models && typeof resData.models === 'object') {
              models = Object.keys(resData.models);
            }
            sendJson({ ok: true, models, authMode: resolved.authMode || (isGoogleOfficialLoginToken(apiKey) ? 'official-login' : 'api-key'), source: 'upstream-api' });
          } catch (err) {
            if (res.statusCode !== 200) {
              sendJson({ ok: false, error: `HTTP ${res.statusCode}: ${dataStr || '无法解析的错误响应'}` });
            } else {
              sendJson({ ok: false, error: '解析模型响应失败: ' + err.message });
            }
          }
        });
      });
      activeReq = req;
      req.on('error', (err) => {
        clearTimeout(hardTimeout);
        sendJson({ ok: false, error: err.message });
      });
      req.end();
    } catch (err) {
      clearTimeout(hardTimeout);
      sendJson({ ok: false, error: err.message });
    }
  });
}

function handleLocalRouteTestRequest(clientReq, clientRes) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let { profileId, protocol, targetUrl, apiKey, to } = body;
      if (!targetUrl || !protocol || !to) {
        throw new Error('targetUrl, protocol and upstreamModel (to) are required');
      }

      let finalProfile = resolveConfiguredProfile({ id: profileId, protocol, targetUrl, apiKey }, profileId);

      // 动态解析官方托管凭据（如自适应从本地 ~/.codex/auth.json 读取最新的 Codex 凭证）
      const resolved = await resolveOfficialCredentials({ profile: finalProfile });
      protocol = resolved.profile.protocol || protocol;
      targetUrl = resolved.profile.targetUrl || targetUrl;
      apiKey = resolved.profile.apiKey;

      const target = parseTargetUrl(targetUrl);
      const urlObj = new URL(targetUrl);
      const transport = urlObj.protocol === 'https:' ? https : http;

      let testPath = '';
      let testHeaders = {
        'content-type': 'application/json',
        'accept': 'application/json'
      };
      let testBody = '';

      if (resolved.authMode === 'official-login' && resolved.authProvider === 'trae') {
        const state = await queryTraeStateRows();
        const support = state.ok ? traeOfficialModelSupport(to, state.rows) : { known: false, supported: false, model: normalizeTraeOfficialModelName(to) };
        clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        if (support.known && support.supported) {
          clientRes.end(JSON.stringify({
            ok: true,
            message: `Trae 国际版官方登录缓存已加载；${to} 映射到 Trae 后端模型 ${support.model}。`,
            authMode: 'official-login',
            source: 'trae-state-cache',
            model: support.model,
            displayName: support.displayName
          }));
        } else {
          clientRes.end(JSON.stringify({
            ok: false,
            authMode: 'official-login',
            source: 'trae-state-cache',
            error: state.ok
              ? `Trae 国际版模型缓存未返回 ${normalizeTraeOfficialModelName(to)}。`
              : `无法读取 Trae 国际版模型缓存: ${state.error}`
          }));
        }
        return;
      }

      if (protocol === 'gemini') {
        if (resolved.authMode === 'official-login' && resolved.authProvider === 'google' && apiKey && isGoogleOfficialLoginToken(apiKey)) {
          const check = await testProfileAuthUpstream(protocol, targetUrl, apiKey, to, 'official-login');
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify(check.ok ? {
            ok: true,
            message: `Google 官方登录链路可达；${to} 将按 Antigravity/Code Assist 官方后端路由校验。`,
            authMode: 'official-login',
            source: check.source || 'code-assist'
          } : check));
          return;
        }
        const geminiApiKey = apiKey || '';
        testPath = `/v1beta/models/${encodeURIComponent(to)}:generateContent`;
        if (geminiApiKey && isGoogleOfficialLoginToken(geminiApiKey)) {
          testHeaders['authorization'] = 'Bearer ' + geminiApiKey;
        } else if (geminiApiKey) {
          testPath += `?key=${encodeURIComponent(geminiApiKey)}`;
        }
        testBody = JSON.stringify({
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 }
        });
      } else if (protocol === 'claude') {
        const hasV1 = target.path.endsWith('/v1') || target.path.includes('/v1/');
        testPath = hasV1 ? target.path + '/messages' : '/v1/messages';
        testBody = JSON.stringify({
          model: to,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1
        });
        if (apiKey) {
          testHeaders['x-api-key'] = apiKey;
        }
        testHeaders['anthropic-version'] = '2023-06-01';
      } else {
        if (resolved.authMode === 'official-login' && resolved.authProvider === 'openai' && apiKey && isOpenAIOfficialLoginToken(apiKey)) {
          const check = await testProfileAuthUpstream(protocol, targetUrl, apiKey, to, 'official-login');
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify(check.ok ? {
            ok: true,
            message: check.message || `OpenAI 官方登录链路可用；${to} 将按 Codex 官方模型缓存校验。`,
            authMode: 'official-login',
            source: check.source || 'codex'
          } : check));
          return;
        }

        const hasV1 = target.path.endsWith('/v1') || target.path.includes('/v1/');
        testPath = hasV1 ? target.path + '/chat/completions' : '/v1/chat/completions';
        testBody = JSON.stringify({
          model: to,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1
        });
        if (apiKey) {
          testHeaders['authorization'] = 'Bearer ' + apiKey;
        }
      }

      const targetFullUrl = urlObj.protocol + '//' + urlObj.host + testPath;
      const options = {
        method: 'POST',
        headers: testHeaders,
        body: testBody,
        timeout: 10000
      };

      const req = requestWithProxy(targetFullUrl, options, (res) => {
        const resChunks = [];
        res.on('data', c => resChunks.push(c));
        res.on('end', () => {
          const dataStr = Buffer.concat(resChunks).toString('utf8');
          try {
            const resData = JSON.parse(dataStr);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
              clientRes.end(JSON.stringify({ ok: true, message: '连接成功，模型响应正常。' }));
            } else {
              let errMsg = '';
              if (protocol === 'gemini') {
                errMsg = resData.error && resData.error.message ? resData.error.message : JSON.stringify(resData);
              } else if (protocol === 'claude') {
                errMsg = resData.error && resData.error.message ? resData.error.message : JSON.stringify(resData);
              } else {
                errMsg = resData.error && resData.error.message ? resData.error.message : (resData.error || dataStr || `HTTP ${res.statusCode}`);
              }
              clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
              clientRes.end(JSON.stringify({ ok: false, error: `${errMsg}` }));
            }
          } catch (err) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
              clientRes.end(JSON.stringify({ ok: true, message: '连接成功，但上游返回了非 JSON 响应。' }));
            } else {
              clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
              clientRes.end(JSON.stringify({ ok: false, error: `HTTP ${res.statusCode}: ${dataStr || '无法解析的错误响应'}` }));
            }
          }
        });
      });

      req.on('error', (err) => {
        if (!clientRes.writableEnded) {
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });

      req.on('timeout', () => {
        if (!clientRes.writableEnded) {
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({ ok: false, error: '请求超时 (10秒)，可能是网络不通或被防火墙拦截' }));
        }
        req.destroy();
      });

      req.write(testBody);
      req.end();
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: err.message }));
    }
  });
}

function sendUnauthorizedClaudeDesktop(clientRes) {
  clientRes.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'www-authenticate': 'Bearer',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Claude Desktop gateway token is invalid or missing' } }));
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
    return isClaudeMessagesPath(clientPath) || clientPath.indexOf('/v1/messages/count_tokens') === 0;
  }
  if (forceChatEntry(entry)) return isOpenAIChatCompletionsPath(clientPath);
  if (forceResponsesEntry(entry)) return isOpenAIResponsesPath(clientPath);
  return true;
}

const LOCAL_MANAGEMENT_HANDLERS = {
  selectDirectory: handleLocalSelectDirectoryRequest,
  cliLaunch: handleLocalCliLaunchRequest,
  cliSessions: handleLocalCliSessionsRequest,
  cliSessionDelete: handleLocalCliSessionDeleteRequest,
  auditConversations: handleLocalAuditConversationsRequest,
  auditConversationsClear: handleLocalAuditConversationsClearRequest,
  auditRetry: handleLocalAuditRetryRequest,
  usageReport: handleLocalUsageReportRequest,
  profileTestAuth: handleLocalProfileTestAuthRequest,
  health: handleLocalHealthRequest,
  getConfig: handleLocalGetConfigRequest,
  saveConfig: handleLocalSaveConfigRequest,
  setActive: handleLocalSetActiveRequest,
  log: handleLocalLogRequest,
  envCheck: handleLocalEnvCheckRequest,
  envInstallJobs: handleLocalEnvInstallJobsRequest,
  envUpgrade: handleLocalEnvUpgradeRequest,
  diagnosticsGet: handleLocalDiagnosticsGetRequest,
  diagnosticsClear: handleLocalDiagnosticsClearRequest,
  certStatus: handleLocalCertStatusRequest,
  certTrust: handleLocalCertTrustRequest,
  certUntrust: handleLocalCertUntrustRequest,
  modelsList: handleLocalModelsListRequest,
  routeTest: handleLocalRouteTestRequest,
  latency: handleLocalLatencyRequest,
  promptsSync: handleLocalPromptsSyncRequest,
  promptsPresetsGet: (req, res) => handleLocalPromptsPresetsRequest(req, res, CONFIG, (newConfig) => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
    reloadProxyConfig();
  }),
  promptsPresetsSave: (req, res) => handleLocalPromptsPresetsRequest(req, res, CONFIG, (newConfig) => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
    reloadProxyConfig();
  }),
  mcpHubGet: (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, mcpHub: CONFIG.mcpHub || { servers: [], routing: [] } }));
  },
  mcpHubSave: (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const mcpHubConfig = body.mcpHub;
        if (!mcpHubConfig || !Array.isArray(mcpHubConfig.servers) || !Array.isArray(mcpHubConfig.routing)) {
          throw new Error('mcpHub.servers and mcpHub.routing are required arrays');
        }
        CONFIG.mcpHub = {
          servers: mcpHubConfig.servers,
          routing: mcpHubConfig.routing,
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2), 'utf8');
        reloadProxyConfig();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  },
  claudeCodeStatus: handleLocalClaudeCodeStatusRequest,
  claudeCodeApply: handleLocalClaudeCodeApplyRequest,
  claudeCodeRestore: handleLocalClaudeCodeRestoreRequest,
  antigravityCliStatus: handleLocalAntigravityCliStatusRequest,
  traeStatus: handleLocalTraeStatusRequest,
  traeBridgeStatus: handleLocalTraeBridgeStatusRequest,
  antigravityCliApply: handleLocalAntigravityCliApplyRequest,
  antigravityCliRestore: handleLocalAntigravityCliRestoreRequest,
  claudeDesktopStatus: handleLocalClaudeDesktopStatusRequest,
  claudeDesktopApply: handleLocalClaudeDesktopApplyRequest,
  claudeDesktopRestore: handleLocalClaudeDesktopRestoreRequest,
  codexStatus: handleLocalCodexStatusRequest,
  codexApply: handleLocalCodexApplyRequest,
  codexRestore: handleLocalCodexRestoreRequest,
  geminiCliStatus: handleLocalGeminiCliStatusRequest,
  geminiCliApply: handleLocalGeminiCliApplyRequest,
  geminiCliRestore: handleLocalGeminiCliRestoreRequest,
  cliCredentials: handleLocalCliCredentialsRequest,
  rateLimits: handleLocalRateLimitsRequest,
  events: handleLocalEventsRequest,
  eventsClear: handleLocalEventsClearRequest,
};

function handleRequest(clientReq, clientRes, entry) {
  const startTime = Date.now();
  const clientIp = getClientIp(clientReq);
  const urlPath = clientReq.url;
  const method = clientReq.method;
  const desktopRequest = isClaudeDesktopRequest(entry, urlPath);
  const effectiveUrlPath = desktopRequest ? stripClaudeDesktopPrefix(urlPath) : urlPath;
  const effectiveUrlPathname = effectiveUrlPath.split('?')[0];
  const localManagementRequest = isLocalManagementPath(effectiveUrlPathname);

  const isApiRequest = urlPath.indexOf('/chat/completions') >= 0 || urlPath.indexOf('/messages') >= 0 || urlPath.indexOf('/v1/chat/completions') >= 0 || urlPath.indexOf('/v1/messages') >= 0;
  const auditEnabled = isApiRequest
    && process.env.PROXY_DISABLE_CONVERSATION_AUDIT !== '1'
    && !(CONFIG.appSettings && CONFIG.appSettings.conversationAuditEnabled === false);
  let responseBuffer = [];
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
      response: { role: 'assistant', content: '', tool_calls: [] }
    };

    const originalWrite = clientRes.write;
    const originalEnd = clientRes.end;
    const originalWriteHead = clientRes.writeHead;

    clientRes.writeHead = function(statusCode, reasonPhrase, headers) {
      const headerObj = headers || (reasonPhrase && typeof reasonPhrase === 'object' ? reasonPhrase : {});
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

    function captureAuditResponseChunk(chunk, encoding) {
      if (chunk) {
        if (!isStream) {
          const chunkBuffer = bufferFromResponseChunk(chunk, encoding);
          let capturedLength = 0;
          if (responseBytes < AUDIT_MAX_CAPTURE_BYTES) {
            const remaining = AUDIT_MAX_CAPTURE_BYTES - responseBytes;
            const captured = chunkBuffer.length > remaining ? chunkBuffer.subarray(0, remaining) : chunkBuffer;
            responseBuffer.push(captured);
            responseBytes += captured.length;
            capturedLength = captured.length;
          }
          if (chunkBuffer.length > capturedLength) responseTruncated = true;
        } else {
          const text = chunk.toString('utf8');
          const lines = text.split('\n');
          lines.forEach(line => {
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
                      args: ''
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
                    delta.tool_calls.forEach(tc => {
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
              } catch(e) {}
            }
          });
        }
      }
    }

    clientRes.write = function(chunk, encoding, callback) {
      captureAuditResponseChunk(chunk, encoding);
      return originalWrite.apply(this, arguments);
    };

    clientRes.end = function(chunk, encoding, callback) {
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
              try { parsedArgs = JSON.parse(tc.args); } catch(e){}
              toolCalls.push({
                id: tc.id || `tc-${idx}`,
                name: tc.name || '',
                args: parsedArgs,
                truncated: tc.truncated === true
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
              auditProviderUsage = mergeUsage(auditProviderUsage, extractUsageFromJsonPayload(resJson));

              if (resJson.choices && resJson.choices[0] && resJson.choices[0].message) {
                const msg = resJson.choices[0].message;
                const appended = appendAuditText('', msg.content || '');
                auditData.response.content = appended.value;
                if (appended.truncated) auditData.response.truncated = true;
                if (Array.isArray(msg.tool_calls)) {
                  auditData.response.tool_calls = msg.tool_calls.map(tc => {
                    let args = tc.function && tc.function.arguments;
                    try { if (typeof args === 'string') args = JSON.parse(args); } catch(e){}
                    return { id: tc.id, name: tc.function && tc.function.name, args };
                  });
                }
              } else if (Array.isArray(resJson.content)) {
                resJson.content.forEach(block => {
                  if (block.type === 'text') {
                    const appended = appendAuditText(auditData.response.content, block.text || '');
                    auditData.response.content = appended.value;
                    if (appended.truncated) auditData.response.truncated = true;
                  } else if (block.type === 'tool_use') {
                    auditData.response.tool_calls.push({
                      id: block.id,
                      name: block.name,
                      args: block.input
                    });
                  }
                });
              }
            } catch(e){}
          }

          auditData.usage = auditProviderUsage || estimateUsageForRecord(auditData);
          const costModel = auditData.rewriteModel || auditData.originalModel || '';
          auditData.cost = estimateCost(auditData.usage, costModel, CONFIG);
          appendAuditRecord(auditData);
        }
      } catch(e) {
        console.error('!! failed to write conversation audit logs:', e);
      }

      return result;
    };
  }

  // 拦截并提取会话 Token
  const clientAuth = clientReq.headers['authorization'] || clientReq.headers['x-api-key'] || clientReq.headers['x-goog-api-key'] || clientReq.headers['api-key'];
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
    if (clientReq.headers['authorization']) clientReq.headers['authorization'] = 'Bearer PROXY_MANAGED';
    if (clientReq.headers['x-api-key']) clientReq.headers['x-api-key'] = 'PROXY_MANAGED';
    if (clientReq.headers['x-goog-api-key']) clientReq.headers['x-goog-api-key'] = 'PROXY_MANAGED';
    if (clientReq.headers['api-key']) clientReq.headers['api-key'] = 'PROXY_MANAGED';
  }

  const localPollRequest = isQuietLocalPollRequest(method, effectiveUrlPathname);
  if (!localPollRequest) {
    console.log('-> ' + method + ' ' + urlPath + '  [' + clientIp + '] entry=' + entryLabel(entry));
    logProxyEvent('request_start', { method, path: urlPath, clientIp, entryProtocol: entryLabel(entry), entryPort: entry && entry.listenPort, claudeDesktop: desktopRequest });
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
  if (localManagementRequest) {
    installLocalManagementRequestEndLogger(clientRes, method, urlPath, startTime);
  }
  if (dispatchLocalManagementRoute({
    method,
    pathname: effectiveUrlPathname,
    req: clientReq,
    res: clientRes,
    handlers: LOCAL_MANAGEMENT_HANDLERS,
  })) {
    return;
  }

  // Forward request - pass path as-is (SDK already includes /v1 from base_url)
  // Normalize path: tools may or may not include /v1 prefix
  if ((method === 'GET' || method === 'HEAD') && (effectiveUrlPathname === '/favicon.ico' || effectiveUrlPathname === '/v1/favicon.ico')) {
    clientRes.writeHead(204, {
      'Cache-Control': 'public, max-age=86400',
      'access-control-allow-origin': '*',
    });
    clientRes.end();
    return;
  }

  if (desktopRequest && !isAuthorizedClaudeDesktopRequest(CONFIG, clientReq.headers)) {
    sendUnauthorizedClaudeDesktop(clientRes);
    logRequestEnd(method, urlPath, startTime, 401, { type: 'claude_desktop_auth' });
    return;
  }

  const modelRequest = parseModelsRequestPath(effectiveUrlPath);
  if ((method === 'GET' || method === 'HEAD') && modelRequest) {
    handleLocalModelsRequest(clientReq, clientRes, modelRequest, routesForEntry(entry, desktopRequest), desktopRequest ? 'claude' : modelsFormatForEntry(entry));
    return;
  }
  const clientPath = effectiveUrlPath.indexOf('/v1') === 0 ? effectiveUrlPath : '/v1' + effectiveUrlPath;
  if (isEntryHealthPath(entry, method, clientPath)) {
    sendEntryHealth(clientRes, entry, method, clientPath);
    return;
  }
  if (!isAllowedEntryPath(entry, method, clientPath)) {
    sendEntryPathError(clientRes, entry, method, clientPath);
    logRequestEnd(method, urlPath, startTime, 404, { type: 'entry_path_mismatch', entryProtocol: entryLabel(entry) });
    return;
  }
  const fwdHeaders = { ...clientReq.headers };
  delete fwdHeaders['host'];

  const requestChunks = [];
  let requestBytes = 0;
  let requestTooLarge = false;
  clientReq.on('data', function(chunk) {
    if (requestTooLarge) return;
    requestChunks.push(chunk);
    requestBytes += chunk.length;
    if (requestBytes > MAX_REQUEST_BODY_BYTES) {
      requestTooLarge = true;
      requestChunks.length = 0;
      logProxyEvent('request_too_large', { method, path: urlPath, bytes: requestBytes, limit: MAX_REQUEST_BODY_BYTES });
    }
  });

  clientReq.on('end', function() {
    if (requestTooLarge) {
      sendRequestTooLarge(clientReq, clientRes, MAX_REQUEST_BODY_BYTES);
      logRequestEnd(method, urlPath, startTime, 413, { type: 'request_too_large', bytes: requestBytes, limit: MAX_REQUEST_BODY_BYTES });
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
    if (method === 'POST' && clientPath.indexOf('/v1/messages/count_tokens') === 0) {
      handleCountTokens(clientReq, clientRes, requestBuffer, logRequestEnd, startTime);
      return;
    }

    function doForward(currentPrepared, attempt = 1) {
      const requestProtocol = isGeminiProfile(currentPrepared.profile) ? 'gemini' : (isClaudeProfile(currentPrepared.profile) ? 'claude' : 'openai');

      if (clientRes.__auditData) {
        clientRes.__auditData.originalModel = currentPrepared.model || '';
        clientRes.__auditData.rewriteModel = currentPrepared.rewriteTo || '';
        clientRes.__auditData.profileId = currentPrepared.profile ? currentPrepared.profile.id : '';
        clientRes.__auditData.profileName = currentPrepared.profile ? (currentPrepared.profile.name || currentPrepared.profile.id) : '';
        clientRes.__auditData.protocol = requestProtocol;

        const extracted = extractPromptFromBuffer(currentPrepared.buffer || requestBuffer, requestProtocol);
        clientRes.__auditData.system = extracted.system;
        clientRes.__auditData.messages = extracted.messages;
      }

      if (currentPrepared.authMode === 'official-login' && currentPrepared.authProvider === 'trae') {
        if (method === 'POST' && isOpenAIChatCompletionsPath(clientPath)) {
          handleTraeOfficialChatCompletion(clientReq, clientRes, requestBuffer, currentPrepared, startTime, urlPath);
          return;
        }
        if (method === 'POST' && isOpenAIResponsesPath(clientPath)) {
          handleTraeOfficialResponses(clientReq, clientRes, requestBuffer, currentPrepared, startTime, urlPath);
          return;
        }
        if (method === 'POST' && isClaudeMessagesPath(clientPath)) {
          handleTraeOfficialClaudeMessages(clientReq, clientRes, requestBuffer, currentPrepared, startTime, urlPath);
          return;
        }
        sendJsonError(clientRes, 501, {
          error: {
            type: 'not_implemented',
            message: 'Trae 官方登录桥接目前支持 OpenAI /v1/chat/completions、OpenAI /v1/responses 和 Claude /v1/messages。'
          }
        });
        logRequestEnd(method, urlPath, startTime, 501, { type: 'trae_official_unsupported_path' });
        return;
      }

      const target = parseTargetUrl(currentPrepared.profile.targetUrl);
      const upstreamPath = target.path + clientPath.replace(/^\/v1/, '');
      const apiKey = process.env.API_KEY || currentPrepared.profile.apiKey || null;
      const isClaudeEntryRequest = forceClaudeEntry(entry) && isClaudeMessagesPath(clientPath);
      const isChatEntryRequest = forceChatEntry(entry) && isOpenAIChatCompletionsPath(clientPath);
      const isResponsesEntryRequest = forceResponsesEntry(entry) && isOpenAIResponsesPath(clientPath);

      const isResponsesUpstream = currentPrepared.profile && (
        currentPrepared.profile.api === 'openai-codex-responses' ||
        (currentPrepared.profile.targetUrl && (
          currentPrepared.profile.targetUrl.includes('/backend-api/codex') ||
          currentPrepared.profile.targetUrl.includes('/backend-api')
        ))
      );

      if (isResponsesUpstream && isOpenAIChatCompletionsPath(clientPath) && method === 'POST') {
        if (clientReq.headers['content-encoding']) {
          clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Chat to Responses conversion does not support compressed request bodies' } }));
          return;
        }
        logModelMapping('chat->responses', method, upstreamPath, currentPrepared);
        handleOpenAIChatToOpenAIResponses(clientReq, clientRes, currentPrepared, target, apiKey, upstreamPath, startTime);
        return;
      }

      if (isResponsesUpstream && isClaudeEntryRequest && method === 'POST') {
        if (clientReq.headers['content-encoding']) {
          clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Claude to Responses conversion does not support compressed request bodies' } }));
          return;
        }
        logModelMapping('claude->responses', method, upstreamPath, currentPrepared);
        handleClaudeMessagesToOpenAIResponses(clientReq, clientRes, currentPrepared, target, apiKey, upstreamPath, startTime);
        return;
      }

      if ((shouldConvertClaudeMessagesToOpenAI(clientReq, currentPrepared.profile, clientPath) || (isClaudeEntryRequest && isOpenAIProfile(currentPrepared.profile))) && method === 'POST') {
        if (clientReq.headers['content-encoding']) {
          clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Claude to OpenAI conversion does not support compressed request bodies' } }));
          return;
        }
        logModelMapping('claude->openai', method, upstreamPath, currentPrepared);
        handleClaudeMessagesToOpenAIChat(clientReq, clientRes, currentPrepared, target, apiKey, upstreamPath, startTime);
        return;
      }
      if (method === 'POST' && isClaudeMessagesPath(clientPath)) sampleRequestToolResults(currentPrepared, requestProtocol, upstreamPath);
      if (isChatEntryRequest && isGeminiProfile(currentPrepared.profile) && method === 'POST') {
        if (clientReq.headers['content-encoding']) {
          clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'OpenAI to Gemini conversion does not support compressed request bodies' } }));
          return;
        }
        logModelMapping('openai->gemini', method, upstreamPath, currentPrepared);
        handleOpenAIChatToGeminiMessages(clientReq, clientRes, currentPrepared, target, apiKey, upstreamPath, startTime);
        return;
      }
      if (isClaudeProfile(currentPrepared.profile) && method === 'POST' && isOpenAIChatCompletionsPath(clientPath)) {
        if (clientReq.headers['content-encoding']) {
          clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'OpenAI to Claude conversion does not support compressed request bodies' } }));
          return;
        }
        logModelMapping('openai->claude', method, upstreamPath, currentPrepared);
        handleOpenAIChatToClaudeMessages(clientReq, clientRes, currentPrepared, target, apiKey, upstreamPath, startTime);
        return;
      }
      if (isResponsesEntryRequest && method === 'POST' && !isOpenAIProfile(currentPrepared.profile)) {
        if (clientReq.headers['content-encoding']) {
          clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'OpenAI Responses conversion does not support compressed request bodies' } }));
          return;
        }
        if (isClaudeProfile(currentPrepared.profile)) {
          logModelMapping('responses->claude', method, upstreamPath, currentPrepared);
          handleOpenAIResponsesToClaudeMessages(clientReq, clientRes, currentPrepared, target, apiKey, upstreamPath, startTime);
          return;
        }
        if (isGeminiProfile(currentPrepared.profile)) {
          logModelMapping('responses->gemini', method, upstreamPath, currentPrepared);
          handleOpenAIResponsesToGeminiMessages(clientReq, clientRes, currentPrepared, target, apiKey, upstreamPath, startTime);
          return;
        }
      }
      if (isResponsesEntryRequest && method === 'POST' && isOpenAIProfile(currentPrepared.profile) && shouldConvertResponsesToOpenAIChat(currentPrepared.profile)) {
        logModelMapping('responses->chat', method, upstreamPath, currentPrepared);
        handleOpenAIResponsesToOpenAIChat(clientReq, clientRes, currentPrepared, target, apiKey, upstreamPath, startTime);
        return;
      }
      if (isGeminiProfile(currentPrepared.profile) && method === 'POST' && isClaudeMessagesPath(clientPath)) {
        if (clientReq.headers['content-encoding']) {
          clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Gemini conversion does not support compressed request bodies' } }));
          return;
        }
        logModelMapping('claude->gemini', method, upstreamPath, currentPrepared);
        handleGeminiMessages(clientReq, clientRes, currentPrepared, target, apiKey, upstreamPath, startTime);
        return;
      }
      const outgoingHeaders = { ...fwdHeaders };
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
        logModelMapping('route', method, upstreamPath, currentPrepared);
      }

      if (clientRes.__auditData) {
        clientRes.__auditData.upstream = {
          method,
          path: upstreamPath,
          targetHost: target.hostname,
          targetProtocol: target.protocol,
          headers: redactHeaders(outgoingHeaders),
          body: captureRequestBody(currentPrepared.buffer, outgoingHeaders['content-encoding']).body,
        };
      }

      const transport = target.protocol === 'https:' ? https : http;
      const proxyReq = transport.request({
        hostname: process.env.TARGET || target.hostname,
        port: parseInt(process.env.TARGET_PORT || target.port, 10),
        path: upstreamPath,
        method: method,
        headers: outgoingHeaders,
        timeout: 45000,
        agent: target.protocol === 'https:' ? globalHttpsAgent : globalHttpAgent,
      }, (proxyRes) => {
        const code = proxyRes.statusCode;

        if (attempt === 1 && (code >= 500 || code === 429) && currentPrepared.profile.backupProfileId) {
          const backupProfile = (getProfiles(loadConfig()) || []).find(p => p.id === currentPrepared.profile.backupProfileId);
          if (backupProfile) {
            console.warn(`[Failover] Upstream returned status ${code}, falling back to backup profile: ${backupProfile.id}`);
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

        const isStream = (proxyRes.headers['content-type'] || '').indexOf('text/event-stream') >= 0;
        const shouldSanitizeOpenAIStream = code >= 200 && code < 300 && isStream && isClaudeMessagesPath(clientPath) && isOpenAIProfile(currentPrepared.profile);
        const shouldProtectStream = code >= 200 && code < 300 && isStream && isClaudeMessagesPath(clientPath) && !isOpenAIProfile(currentPrepared.profile);
        if (shouldProtectStream || shouldSanitizeOpenAIStream) delete headers['content-length'];
        clientRes.writeHead(code, headers);
        const errorChunks = [];
        let errorBytes = 0;
        let logged = false;

        if (shouldSanitizeOpenAIStream) {
          clientRes.__diagnostics = { protocol: 'openai', route: currentPrepared.model, target: currentPrepared.rewriteTo, upstreamPath, profile: currentPrepared.profile && currentPrepared.profile.id };
          const sseState = { buffer: '', pendingClaudeTool: null, mode: 'strip-empty-optionals' };
          proxyRes.on('data', function(chunk) {
            const chunkText = chunk.toString('utf8');
            if (!logged) logged = true;
            sampleResponseChunk('openai-upstream', chunkText, { route: currentPrepared.model, target: currentPrepared.rewriteTo, upstreamPath });
            processClaudeSseChunk(clientRes, chunkText, sseState);
          });
          proxyRes.on('end', function() {
            flushClaudeSseFilter(clientRes, sseState);
            console.log('ok ' + method + ' ' + urlPath + '  -> ' + code + ' (streaming sanitized, ' + (Date.now()-startTime) + 'ms)');
            clientRes.end();
            logRequestEnd(method, urlPath, startTime, code, { type: 'openai_stream_sanitized' });
          });
          return;
        }

        if (shouldProtectStream) {
          clientRes.__diagnostics = { protocol: 'openai', route: currentPrepared.model, target: currentPrepared.rewriteTo, upstreamPath, profile: currentPrepared.profile && currentPrepared.profile.id };
          const sseState = { buffer: '', pendingClaudeTool: null };
          proxyRes.on('data', function(chunk) {
            const chunkText = chunk.toString('utf8');
            if (!logged) logged = true;
            sampleResponseChunk('openai-upstream', chunkText, { route: currentPrepared.model, target: currentPrepared.rewriteTo, upstreamPath });
            processClaudeSseChunk(clientRes, chunkText, sseState);
          });
          proxyRes.on('end', function() {
            flushClaudeSseFilter(clientRes, sseState);
            console.log('ok ' + method + ' ' + urlPath + '  -> ' + code + ' (protected streaming, ' + (Date.now()-startTime) + 'ms)');
            clientRes.end();
            logRequestEnd(method, urlPath, startTime, code, { type: 'openai_stream_protected' });
          });
          return;
        }

        proxyRes.on('data', function(chunk) {
          if (!logged) {
            const elapsed = Date.now() - startTime;
            if (!isStream) console.log('ok ' + method + ' ' + urlPath + '  -> ' + code + ' (' + elapsed + 'ms)');
            logged = true;
          }

          if (code >= 400 && !isStream && errorBytes < 4096) {
            const remaining = 4096 - errorBytes;
            const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            errorChunks.push(part);
            errorBytes += part.length;
          }
        });

        proxyRes.on('end', function() {
          if (isStream) console.log('ok ' + method + ' ' + urlPath + '  -> ' + code + ' (streaming, ' + (Date.now()-startTime) + 'ms)');
          logRequestEnd(method, urlPath, startTime, code, { type: isStream ? 'openai_stream' : 'openai' });

          if (code >= 400 && errorChunks.length > 0) {
            const requestId = proxyRes.headers['x-request-id'] || proxyRes.headers['request-id'] || proxyRes.headers['anthropic-request-id'] || '-';
            const retryAfter = proxyRes.headers['retry-after'] || '-';
            const body = Buffer.concat(errorChunks).toString('utf8').replace(/\s+/g, ' ').trim();
            const requestedModel = currentPrepared.model || '';
            console.warn('!! upstream error ' + method + ' ' + upstreamPath + ' -> ' + code + ' model=' + requestedModel + ' request-id=' + requestId + ' retry-after=' + retryAfter + ' body=' + body);
            logProxyEvent('upstream_error', { method, path: upstreamPath, code, model: requestedModel, body });
          }
        });

        proxyRes.pipe(clientRes);
      });

      proxyReq.on('timeout', function() {
        proxyReq.destroy(new Error('Gateway Timeout (Upstream request timed out)'));
      });

      proxyReq.on('error', function(err) {
        if (attempt === 1 && currentPrepared.profile.backupProfileId) {
          const backupProfile = (getProfiles(loadConfig()) || []).find(p => p.id === currentPrepared.profile.backupProfileId);
          if (backupProfile) {
            console.warn(`[Failover] Upstream request failed (${err.message}), falling back to backup profile: ${backupProfile.id}`);
            const backupPrepared = { ...currentPrepared, profile: backupProfile };
            doForward(backupPrepared, 2);
            return;
          }
        }

        console.error('xx ' + method + ' ' + urlPath + '  ' + (err.code || err.message));
        logProxyEvent('proxy_error', { method, path: urlPath, error: err.message, code: err.code });
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, {
            'Content-Type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
          });
          clientRes.end(JSON.stringify({ error: { message: 'Proxy error: ' + err.message, type: 'proxy_error' } }));
        }
      });


      proxyReq.end(currentPrepared.buffer);
    }

    const initialPrepared = prepareRequestBufferWithResolver(requestBuffer, clientReq.headers['content-encoding'], desktopRequest ? resolveClaudeDesktopRoute : resolveRoute);

    if (cliSession && cliSession.modelOverride) {
      const targetModel = cliSession.modelOverride;
      const resolved = resolveRoute(targetModel, MODEL_ROUTES, PROFILES, ACTIVE_PROFILE);

      initialPrepared.profile = resolved.profile;
      initialPrepared.route = resolved.route;
      initialPrepared.model = targetModel;
      initialPrepared.routed = true;
      initialPrepared.rewriteTo = resolved.route && resolved.route.to && resolved.route.to !== '*' ? resolved.route.to : targetModel;

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

    resolveOfficialCredentials(initialPrepared, clientReq.headers).then(async function(prepared) {
      if (isClaudeMessagesPath(clientPath) && prepared.buffer && !clientReq.headers['content-encoding']) {
        try {
          const parsed = JSON.parse(prepared.buffer.toString('utf8'));
          const augmented = await mcpHub.augmentRequestTools(parsed);
          prepared.buffer = Buffer.from(JSON.stringify(augmented));
        } catch (e) {}
      }
      doForward(prepared, 1);
    }).catch(function(err) {
      console.error('[auth] Failed to resolve credentials:', err.message);
      doForward(initialPrepared, 1);
    });
  });

  clientReq.on('aborted', function() { clientRes.destroy(); });
}

/* ========== 启动 ========== */

if (require.main === module) {
  const MGMT_PORT = parseInt(process.env.MGMT_PORT || CONFIG.localServer?.managementPort || (PORT + 100), 10);

  function checkExistingManagementServer(callback) {
    let settled = false;
    function finish(isProxy) {
      if (settled) return;
      settled = true;
      callback(isProxy);
    }
    const req = http.request({
      host: '127.0.0.1',
      port: MGMT_PORT,
      path: '/v1/local/health',
      method: 'GET',
      timeout: 500,
    }, function(res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function(chunk) {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      res.on('end', function() {
        try {
          const parsed = JSON.parse(body || '{}');
          finish(res.statusCode >= 200 && res.statusCode < 300 && parsed.appId === APP_ID);
        } catch (err) {
          finish(false);
        }
      });
    });
    req.on('timeout', function() {
      req.destroy();
      finish(false);
    });
    req.on('error', function() {
      finish(false);
    });
    req.end();
  }

  function startServers() {
    var tlsConfig = ensureCert();
    var servers = [];

    function shutdown() {
      let remaining = servers.length;
      if (!remaining) process.exit(0);
      for (const server of servers) {
        try {
          server.close(function() {
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
        console.error('[startup] ' + serverName + ' is already in use. Stop the owning process or change the configured port.');
        process.exit(1);
        return;
      }
      console.error('[startup] ' + serverName + ' failed: ' + (err && err.message ? err.message : err));
      process.exit(1);
    }

    function listenEntry(entry) {
      var factory = entry.tls === false ? http : https;
      var server = entry.tls === false ? factory.createServer(function(req, res) {
        handleRequest(req, res, entry);
      }) : factory.createServer(tlsConfig, function(req, res) {
        handleRequest(req, res, entry);
      });
      servers.push(server);
      var listenHost = entry.host === 'localhost' ? '127.0.0.1' : entry.host;
      server.on('error', function(err) {
        handleListenError('port ' + listenHost + ':' + entry.listenPort, err);
      });
      server.listen(entry.listenPort, listenHost, function() {
        console.log('  Listen:  ' + (entry.tls === false ? 'http' : 'https') + '://' + entry.host + ':' + entry.listenPort + entry.basePath + '  [' + entry.protocol + ']');
      });
      return server;
    }

    console.log('');
    console.log('+-----------------------------------------------+');
    console.log('|        OpenAI HTTPS Proxy                      |');
    console.log('+-----------------------------------------------+');
    console.log('');

    const envEntry = process.env.PORT ? [{ ...LOCAL_SERVER, listenPort: PORT }] : ENTRY_SERVERS;
    for (const entry of envEntry) listenEntry(entry);

    // ── HTTP 管理端口 ──────────────────────────────────
    // 纯 HTTP 服务器，仅处理 /v1/local/* 管理 API，不转发代理请求。
    // 解决 Tauri 生产模式下 webview 无法访问自签名 HTTPS 的问题。
    const mgmtServer = http.createServer(function(req, res) {
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
    mgmtServer.on('error', function(err) {
      handleListenError('management port 127.0.0.1:' + MGMT_PORT, err);
    });
    mgmtServer.listen(MGMT_PORT, '127.0.0.1', function() {
      console.log('  Mgmt:    http://127.0.0.1:' + MGMT_PORT + '/v1/local/*  [management-http]');
    });

    process.nextTick(function() {
      console.log('');
      console.log('  Profile: ' + (ACTIVE_PROFILE.name || ACTIVE_PROFILE.id || 'default'));
      console.log('  Target:  ' + ACTIVE_PROFILE.targetUrl);
      console.log('  Routes:  ' + MODEL_ROUTES.length);
      console.log('');
      console.log('  SDK Config:');
      for (const entry of envEntry) {
        console.log('    ' + entry.protocol + ': ' + (entry.tls === false ? 'http' : 'https') + '://' + entry.host + ':' + entry.listenPort + entry.basePath);
      }
      console.log('    management: http://127.0.0.1:' + MGMT_PORT + '/v1/local/*');
      console.log('    openai.api_key  = "your key"');
      console.log('');
      console.log('  Ctrl+C to stop');
      console.log('');
    });

    process.on('SIGINT', function() {
      console.log('\nStopping...');
      shutdown();
    });
    process.on('SIGTERM', shutdown);
  }

  checkExistingManagementServer(function(isRunning) {
    if (isRunning) {
      console.log('[single-instance] Existing proxy management endpoint detected on 127.0.0.1:' + MGMT_PORT + '; exiting duplicate process.');
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
      message: 'Request body exceeds proxy limit of ' + limit + ' bytes'
    }
  });
  clientRes.writeHead(413, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'access-control-allow-origin': '*'
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

function extractPromptFromBuffer(buffer, protocol) {
  let system = '';
  const messages = [];
  try {
    const raw = JSON.parse(buffer.toString('utf8'));

    if (protocol === 'gemini') {
      if (raw.systemInstruction && Array.isArray(raw.systemInstruction.parts)) {
        system = raw.systemInstruction.parts.map(p => p.text || '').join('\n');
      }
      if (Array.isArray(raw.contents)) {
        raw.contents.forEach(item => {
          const role = item.role === 'model' ? 'assistant' : 'user';
          let content = '';
          const toolUses = [];
          const toolResults = [];
          if (Array.isArray(item.parts)) {
            item.parts.forEach(p => {
              if (p.text) content += p.text;
              if (p.functionCall) {
                toolUses.push({
                  id: p.functionCall.name,
                  name: p.functionCall.name,
                  args: p.functionCall.args
                });
              }
              if (p.functionResponse) {
                toolResults.push({
                  name: p.functionResponse.name,
                  content: p.functionResponse.response
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
          system = raw.system.map(x => x.text || JSON.stringify(x)).join('\n');
        }
      }

      const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
      rawMessages.forEach(msg => {
        let role = msg.role;
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
          msg.content.forEach(block => {
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
                content: block.content
              });
            }
          });
        }

        if (Array.isArray(msg.tool_calls)) {
          msg.tool_calls.forEach(tc => {
            const id = tc.id;
            const name = tc.function && tc.function.name;
            let args = tc.function && tc.function.arguments;
            try {
              if (typeof args === 'string') args = JSON.parse(args);
            } catch(e){}
            toolUses.push({ id, name, args });
          });
        }

        if (role === 'tool') {
          toolResults.push({
            id: msg.tool_call_id,
            content: msg.content
          });
        }

        messages.push({ role, content, toolUses, toolResults });
      });
    }
  } catch (err) {}

  return { system, messages };
}

function handleLocalAuditConversationsRequest(clientReq, clientRes) {
  try {
    const url = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
    const limit = Number(url.searchParams.get('limit') || 50);
    const records = getAuditRecords(limit);
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: true, conversations: records }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function handleLocalAuditConversationsClearRequest(clientReq, clientRes) {
  try {
    const ok = clearAuditRecords();
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok }));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ error: err.message }));
  }
}

function readJsonBodyFromRequest(clientReq, callback) {
  const chunks = [];
  let bytes = 0;
  clientReq.on('data', (chunk) => {
    chunks.push(chunk);
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      chunks.length = 0;
      clientReq.destroy(new Error('Request body too large'));
    }
  });
  clientReq.on('end', () => {
    try {
      const text = Buffer.concat(chunks, bytes).toString('utf8');
      callback(null, text ? JSON.parse(text) : {});
    } catch (err) {
      callback(err);
    }
  });
  clientReq.on('error', (err) => callback(err));
}

function localReplayBaseUrl(record) {
  const tls = LOCAL_SERVER && LOCAL_SERVER.tls === false ? false : true;
  const port = Number(record && record.entryPort) || PORT;
  return `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
}

function handleLocalAuditRetryRequest(clientReq, clientRes) {
  readJsonBodyFromRequest(clientReq, async (bodyErr, payload) => {
    if (bodyErr) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ ok: false, error: bodyErr.message }));
      return;
    }
    try {
      const record = getAuditRecordById(payload && payload.id);
      if (!record) {
        clientRes.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ ok: false, error: '未找到对应审计记录' }));
        return;
      }
      if (!record.request || !record.request.body || record.request.truncated) {
        clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ ok: false, error: '该请求体为空或已截断，无法安全重试' }));
        return;
      }

      const replayHeaders = headersForReplay(record.request.headers);
      replayHeaders['content-type'] = replayHeaders['content-type'] || replayHeaders['Content-Type'] || 'application/json';
      replayHeaders['x-hpm-retry-of'] = record.id;
      const replayBody = record.request.body;
      replayHeaders['content-length'] = Buffer.byteLength(replayBody);
      const replayUrl = localReplayBaseUrl(record) + record.path;
      const response = await makeRequest(replayUrl, {
        method: record.method || 'POST',
        headers: replayHeaders,
        timeout: Number(payload && payload.timeout) || 60000,
      }, replayBody);
      const parsed = parseJsonText(response.body);
      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        statusCode: response.statusCode,
        headers: redactHeaders(response.headers || {}),
        body: parsed || response.body,
        bodyText: parsed ? '' : response.body,
      }));
    } catch (err) {
      clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
}

function handleLocalUsageReportRequest(clientReq, clientRes) {
  try {
    const url = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
    const limit = Number(url.searchParams.get('limit') || 300);
    const after = url.searchParams.get('after') || '';
    let records = getAuditRecords(limit);
    if (after) {
      const afterTime = Date.parse(after);
      if (Number.isFinite(afterTime)) {
        records = records.filter((record) => Date.parse(record.time || '') >= afterTime);
      }
    }
    const report = buildUsageReport(records, CONFIG);
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify(report));
  } catch (err) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    clientRes.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

async function testProfileAuthUpstream(protocol, targetUrl, apiKey, testModel = null, authMode = 'api-key') {
  try {
    if (protocol === 'openai' && authMode === 'official-login' && isOpenAIOfficialCodexTarget(targetUrl) && testModel) {
      const support = openAIOfficialCodexModelSupport(testModel);
      if (support.known && support.supported) {
        return {
          ok: true,
          authMode,
          source: 'codex-model-cache',
          message: `OpenAI 官方登录凭证已加载；Codex 模型缓存确认 ${support.model} 可用于 API。`
        };
      }
      if (support.known) {
        return {
          ok: false,
          authMode,
          source: 'codex-model-cache',
          error: `Codex 模型 ${support.model} 当前不支持 API 路由。`
        };
      }
      return {
        ok: false,
        authMode,
        source: 'codex-model-cache',
        error: `Codex 官方模型缓存未返回 ${normalizeOpenAIOfficialCodexModelName(testModel)}，不要按 ChatGPT Web 模型列表路由。`
      };
    }

    const probe = buildProfileAuthProbeRequest(protocol, targetUrl, apiKey, testModel, authMode);
    if (probe.unsupported) {
      return { ok: false, error: `Unsupported protocol: ${protocol}` };
    }

    if (protocol === 'openai') {
      const res = await makeRequest(probe.fullUrl, { method: probe.method, headers: probe.headers }, probe.requestBody);
      return evaluateOpenAIProfileAuthResponse(res, { testModel, authMode });
    } else if (protocol === 'gemini') {
      const res = await makeRequest(probe.fullUrl, { method: probe.method, headers: probe.headers }, probe.requestBody);
      return evaluateGeminiProfileAuthResponse(res, { testModel, authMode, probeFullUrl: probe.fullUrl });
    } else if (protocol === 'claude') {
      const res = await makeRequest(probe.fullUrl, { method: probe.method, headers: probe.headers }, probe.requestBody);
      return evaluateClaudeProfileAuthResponse(res, { testModel });
    } else {
      return { ok: false, error: `Unsupported protocol: ${protocol}` };
    }
  } catch (err) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

function handleLocalProfileTestAuthRequest(clientReq, clientRes) {
  const chunks = [];
  clientReq.on('data', chunk => chunks.push(chunk));
  clientReq.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let { protocol, targetUrl, profileId, testModel } = body;
      profileId = profileId || body.id;
      let { apiKey } = body;

      if (!protocol || !targetUrl) {
        throw new Error('protocol and targetUrl are required');
      }

      let finalProfile = resolveConfiguredProfile({ id: profileId, protocol, targetUrl, apiKey }, profileId);

      const resolved = await resolveOfficialCredentials({ profile: finalProfile });
      protocol = resolved.profile.protocol || protocol;
      apiKey = resolved.profile.apiKey;
      const finalTargetUrl = resolved.profile.targetUrl || targetUrl;

      const result = await testProfileAuthUpstream(protocol, finalTargetUrl, apiKey, testModel, resolved.authMode || 'api-key');

      clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify(result));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ ok: false, error: err.message }));
    }
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
  stripClaudeDesktopPrefix,
  isClaudeDesktopRequest,
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
  KEY_FILE,
};
