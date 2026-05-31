/**
 * OpenAI 兼容 API → HTTP 反向代理
 * 把 HTTP 包装成 HTTPS，支持流式补全、CORS
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  DATA_DIR,
  DEFAULT_CONFIG,
  loadConfig,
  getActiveProfile,
  getProfiles,
  getLocalServer,
  getEntryServers,
  getModelRoutes,
} = require('./lib/proxy/config');
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
} = require('./lib/proxy/claude-desktop');
const { createDiagnostics } = require('./lib/proxy/diagnostics');
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

const CONFIG = loadConfig();
const PROFILES = getProfiles(CONFIG);
const ACTIVE_PROFILE = getActiveProfile(CONFIG);
const LOCAL_SERVER = getLocalServer(CONFIG);

const PORT = parseInt(process.env.PORT || LOCAL_SERVER.listenPort || '3443', 10);
const MODEL_ROUTES = getModelRoutes(CONFIG);
const CLAUDE_DESKTOP_ROUTES = getClaudeDesktopRoutes(CONFIG);
const PROTOCOL_OPTIONS = { ...DEFAULT_CONFIG.protocolOptions, ...(CONFIG.protocolOptions || {}) };

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
  diagnosticsMetaFromResponse,
  sampleDiagnostics,
  extractDiagnosticsSsePayload,
  sampleOutboundSse,
  inputKeys,
  contentLengthForDiagnostics,
  summarizeClaudeToolHistory,
  sampleRequestToolResults,
  sampleGeminiToolEvent,
  logProxyEvent,
  logRequestEnd,
  auditToolCall,
  auditClaudeSseToolCalls,
  sampleResponseChunk,
} = createDiagnostics({ config: CONFIG, normalizeClaudeContent, sanitizeGeminiToolCall });

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

function sendGeminiRateLimit(clientReq, clientRes, upstreamPath, startTime, targetModel, retryAfterSeconds, message, meta) {
  return sendGeminiRateLimitResponse(clientReq, clientRes, upstreamPath, startTime, targetModel, retryAfterSeconds, message, meta, logRequestEnd);
}

function handleCountTokens(clientReq, clientRes, requestBuffer) {
  return handleLocalCountTokens(clientReq, clientRes, requestBuffer, estimateTokens);
}

const {
  handleClaudeMessagesToOpenAIChat,
  handleOpenAIChatToClaudeMessages,
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

function handleRequest(clientReq, clientRes, entry) {
  const startTime = Date.now();
  const clientIp = getClientIp(clientReq);
  const { method, url: urlPath } = clientReq;
  const desktopRequest = isClaudeDesktopRequest(entry, urlPath);
  const effectiveUrlPath = desktopRequest ? stripClaudeDesktopPrefix(urlPath) : urlPath;

  console.log('-> ' + method + ' ' + urlPath + '  [' + clientIp + '] entry=' + entryLabel(entry));
  logProxyEvent('request_start', { method, path: urlPath, clientIp, entryProtocol: entryLabel(entry), entryPort: entry && entry.listenPort, claudeDesktop: desktopRequest });

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

  // Forward request - pass path as-is (SDK already includes /v1 from base_url)
  // Normalize path: tools may or may not include /v1 prefix
  if ((method === 'GET' || method === 'HEAD') && (effectiveUrlPath === '/favicon.ico' || effectiveUrlPath === '/v1/favicon.ico')) {
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
    logRequestEnd(method, urlPath, startTime, 200, { type: 'entry_health', entryProtocol: entryLabel(entry) });
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
  clientReq.on('data', function(chunk) {
    requestChunks.push(chunk);
    requestBytes += chunk.length;
  });

  clientReq.on('end', function() {
    const requestBuffer = Buffer.concat(requestChunks, requestBytes);
    if (method === 'POST' && clientPath.indexOf('/v1/messages/count_tokens') === 0) {
      handleCountTokens(clientReq, clientRes, requestBuffer);
      return;
    }

    const prepared = prepareRequestBufferWithResolver(requestBuffer, clientReq.headers['content-encoding'], desktopRequest ? resolveClaudeDesktopRoute : resolveRoute);
    const target = parseTargetUrl(prepared.profile.targetUrl);
    const upstreamPath = target.path + clientPath.replace(/^\/v1/, '');
    const apiKey = process.env.API_KEY || prepared.profile.apiKey || null;
    const requestProtocol = isGeminiProfile(prepared.profile) ? 'gemini' : (isClaudeProfile(prepared.profile) ? 'claude' : 'openai');
    const isClaudeEntryRequest = forceClaudeEntry(entry) && isClaudeMessagesPath(clientPath);
    const isChatEntryRequest = forceChatEntry(entry) && isOpenAIChatCompletionsPath(clientPath);
    const isResponsesEntryRequest = forceResponsesEntry(entry) && isOpenAIResponsesPath(clientPath);

    if ((shouldConvertClaudeMessagesToOpenAI(clientReq, prepared.profile, clientPath) || (isClaudeEntryRequest && isOpenAIProfile(prepared.profile))) && method === 'POST') {
      if (clientReq.headers['content-encoding']) {
        clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Claude to OpenAI conversion does not support compressed request bodies' } }));
        return;
      }
      logModelMapping('claude->openai', method, upstreamPath, prepared);
      handleClaudeMessagesToOpenAIChat(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime);
      return;
    }
    if (method === 'POST' && isClaudeMessagesPath(clientPath)) sampleRequestToolResults(prepared, requestProtocol, upstreamPath);
    if (isChatEntryRequest && isGeminiProfile(prepared.profile) && method === 'POST') {
      if (clientReq.headers['content-encoding']) {
        clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'OpenAI to Gemini conversion does not support compressed request bodies' } }));
        return;
      }
      logModelMapping('openai->gemini', method, upstreamPath, prepared);
      handleOpenAIChatToGeminiMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime);
      return;
    }
    if (isClaudeProfile(prepared.profile) && method === 'POST' && isOpenAIChatCompletionsPath(clientPath)) {
      if (clientReq.headers['content-encoding']) {
        clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'OpenAI to Claude conversion does not support compressed request bodies' } }));
        return;
      }
      logModelMapping('openai->claude', method, upstreamPath, prepared);
      handleOpenAIChatToClaudeMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime);
      return;
    }
    if (isResponsesEntryRequest && method === 'POST' && !isOpenAIProfile(prepared.profile)) {
      if (clientReq.headers['content-encoding']) {
        clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'OpenAI Responses conversion does not support compressed request bodies' } }));
        return;
      }
      if (isClaudeProfile(prepared.profile)) {
        logModelMapping('responses->claude', method, upstreamPath, prepared);
        handleOpenAIResponsesToClaudeMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime);
        return;
      }
      if (isGeminiProfile(prepared.profile)) {
        logModelMapping('responses->gemini', method, upstreamPath, prepared);
        handleOpenAIResponsesToGeminiMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime);
        return;
      }
    }
    if (isResponsesEntryRequest && method === 'POST' && isOpenAIProfile(prepared.profile) && shouldConvertResponsesToOpenAIChat(prepared.profile)) {
      logModelMapping('responses->chat', method, upstreamPath, prepared);
      handleOpenAIResponsesToOpenAIChat(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime);
      return;
    }
    if (isGeminiProfile(prepared.profile) && method === 'POST' && isClaudeMessagesPath(clientPath)) {
      if (clientReq.headers['content-encoding']) {
        clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
        clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Gemini conversion does not support compressed request bodies' } }));
        return;
      }
      logModelMapping('claude->gemini', method, upstreamPath, prepared);
      handleGeminiMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime);
      return;
    }
    const outgoingHeaders = { ...fwdHeaders };
    if (apiKey) {
      delete outgoingHeaders['authorization'];
      delete outgoingHeaders['api-key'];
      delete outgoingHeaders['x-api-key'];
      delete outgoingHeaders['x-goog-api-key'];
      outgoingHeaders['authorization'] = 'Bearer ' + apiKey;
      outgoingHeaders['api-key'] = apiKey;
    }
    if (prepared.routed) {
      outgoingHeaders['content-length'] = Buffer.byteLength(prepared.buffer);
      logModelMapping('route', method, upstreamPath, prepared);
    }

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request({
      hostname: process.env.TARGET || target.hostname,
      port: parseInt(process.env.TARGET_PORT || target.port, 10),
      path: upstreamPath,
      method: method,
      headers: outgoingHeaders,
      timeout: 600000,
    }, (proxyRes) => {
      const code = proxyRes.statusCode;
      const headers = {
        ...proxyRes.headers,
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': '*',
      };

      const isStream = (proxyRes.headers['content-type'] || '').indexOf('text/event-stream') >= 0;
      const shouldSanitizeOpenAIStream = code >= 200 && code < 300 && isStream && isClaudeMessagesPath(clientPath) && isOpenAIProfile(prepared.profile);
      const shouldProtectStream = code >= 200 && code < 300 && isStream && isClaudeMessagesPath(clientPath) && !isOpenAIProfile(prepared.profile);
      if (shouldProtectStream || shouldSanitizeOpenAIStream) delete headers['content-length'];
      clientRes.writeHead(code, headers);
      const errorChunks = [];
      let errorBytes = 0;
      let logged = false;

      if (shouldSanitizeOpenAIStream) {
        clientRes.__diagnostics = { protocol: 'openai', route: prepared.model, target: prepared.rewriteTo, upstreamPath, profile: prepared.profile && prepared.profile.id };
        const sseState = { buffer: '', pendingClaudeTool: null, mode: 'strip-empty-optionals' };
        proxyRes.on('data', function(chunk) {
          const chunkText = chunk.toString('utf8');
          if (!logged) logged = true;
          sampleResponseChunk('openai-upstream', chunkText, { route: prepared.model, target: prepared.rewriteTo, upstreamPath });
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
        clientRes.__diagnostics = { protocol: 'openai', route: prepared.model, target: prepared.rewriteTo, upstreamPath, profile: prepared.profile && prepared.profile.id };
        const sseState = { buffer: '', pendingClaudeTool: null };
        proxyRes.on('data', function(chunk) {
          const chunkText = chunk.toString('utf8');
          if (!logged) logged = true;
          sampleResponseChunk('openai-upstream', chunkText, { route: prepared.model, target: prepared.rewriteTo, upstreamPath });
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
          const bodyBuffer = Buffer.concat(errorChunks);
          const body = decodeBodyBuffer(bodyBuffer, proxyRes.headers['content-encoding']).replace(/\s+/g, ' ').trim();
          const requestBody = decodeBodyBuffer(prepared.buffer, clientReq.headers['content-encoding']);
          const requestedModel = extractJsonField(requestBody, 'model');
          console.warn('!! upstream error ' + method + ' ' + upstreamPath + ' -> ' + code + ' model=' + requestedModel + ' request-id=' + requestId + ' retry-after=' + retryAfter + ' body=' + body);
          logProxyEvent('upstream_error', { method, path: upstreamPath, code, model: requestedModel, body });
        }
      });

      proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', function(err) {
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

    proxyReq.end(prepared.buffer);
  });

  clientReq.on('aborted', function() { clientRes.destroy(); });
}

/* ========== 启动 ========== */

if (require.main === module) {
  var tlsConfig = ensureCert();
  var servers = [];

  function listenEntry(entry) {
    var factory = entry.tls === false ? http : https;
    var server = entry.tls === false ? factory.createServer(function(req, res) {
      handleRequest(req, res, entry);
    }) : factory.createServer(tlsConfig, function(req, res) {
      handleRequest(req, res, entry);
    });
    servers.push(server);
    var listenHost = entry.host === 'localhost' ? undefined : entry.host;
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
    console.log('    openai.api_key  = "your key"');
    console.log('');
    console.log('  Ctrl+C to stop');
    console.log('');
  });

  process.on('SIGINT', function() {
    console.log('\nStopping...');
    let remaining = servers.length;
    if (!remaining) process.exit(0);
    for (const server of servers) {
      server.close(function() {
        remaining -= 1;
        if (remaining === 0) process.exit(0);
      });
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
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  processOpenAISseChunkToClaude,
  flushOpenAISseToClaude,
  flushPendingGeminiToolCall,
  getLocalServer,
  getEntryServers,
  getClaudeDesktopRoutes,
  stripClaudeDesktopPrefix,
  isClaudeDesktopRequest,
  shouldConvertResponsesToOpenAIChat,
  prepareRequestBuffer,
  buildLocalModelsResponse,
  buildLocalOpenAIModelObject,
  buildLocalClaudeModelObject,
  parseModelsRequestPath,
  localModelIds,
  redactDiagnosticsValue,
  summarizeClaudeToolHistory,
  extractDiagnosticsSsePayload,
  writeJsonlBounded,
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
  setGeminiCooldown,
  getGeminiCooldown,
  ensureCert,
  CERT_DIR,
  CERT_FILE,
  KEY_FILE,
};
