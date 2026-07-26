const http = require('http');
const https = require('https');
const { createLogger } = require('./logger');

const safeLog = createLogger('core-request-handler');
function createCoreRequestHandler(dependencies = {}) {
  const {
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
    getRuntimeState,
  } = dependencies;
  if (typeof getRuntimeState !== 'function') {
    throw new TypeError('createCoreRequestHandler requires getRuntimeState');
  }

  function handleRequestInner(clientReq, clientRes, entry) {
    const {
      ACTIVE_PROFILE,
      CLAUDE_DESKTOP_ROUTES,
      CLI_SESSIONS,
      CONFIG,
      MANAGEMENT_TOKEN,
      MODEL_ROUTES,
      PROFILES,
      globalHttpAgent,
      globalHttpsAgent,
    } = getRuntimeState();
    const startTime = Date.now();
    const clientIp = getClientIp(clientReq);
    const urlPath = clientReq.url;
    const method = clientReq.method;
    const desktopRequest = isClaudeDesktopRequest(entry, urlPath);
    const effectiveUrlPath = desktopRequest ? stripClaudeDesktopPrefix(urlPath) : urlPath;
    const effectiveUrlPathname = effectiveUrlPath.split('?')[0];
    const localManagementRequest = isLocalManagementPath(effectiveUrlPathname);
    // 指标埋点:每个非本地管理请求递增
    const isApiRequest = isConversationRequestPath(method, effectiveUrlPath);
    if (!localManagementRequest) {
      metricsInstance.counter('proxy_requests_total').inc();
    }
    const auditEnabled =
      isApiRequest &&
      process.env.PROXY_DISABLE_CONVERSATION_AUDIT !== '1' &&
      !(CONFIG.appSettings && CONFIG.appSettings.conversationAuditEnabled === false);

    if (auditEnabled) {
      const auditCaptureContent =
        CONFIG.appSettings && CONFIG.appSettings.conversationAuditCaptureContent === true;
      const requestId = 'req-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
      clientRes.__auditId = requestId;
      clientRes.__auditData = createConversationAuditData({
        id: requestId,
        startTime: Date.now(),
        method,
        path: urlPath,
        clientIp,
        entryPort: entry && entry.listenPort,
        entryProtocol: entryLabel(entry),
        requestHeaders: clientReq.headers,
        redactHeaders,
        captureContent: auditCaptureContent,
      });

      installConversationAuditResponseCapture(clientRes, {
        maxCaptureBytes: AUDIT_MAX_CAPTURE_BYTES,
        maxTextChars: AUDIT_MAX_TEXT_CHARS,
        redactHeaders,
        mergeUsage,
        usageFromSsePayload,
        extractUsageFromJsonPayload,
        estimateUsageForRecord,
        logUsage,
        estimateCost,
        appendAuditRecord,
        config: CONFIG,
        log,
        captureContent: auditCaptureContent,
      });
    }

    const { cliSession } = resolveCliSession(clientReq.headers, CLI_SESSIONS);
    if (cliSession) applyManagedAuthHeaders(clientReq.headers);

    const localPollRequest = isQuietLocalPollRequest(method, effectiveUrlPathname);
    if (!localPollRequest) {
      log.info('-> ' + method + ' ' + urlPath + '  [' + clientIp + '] entry=' + entryLabel(entry));
      logProxyEvent('request_start', {
        reqId: clientReq.reqId,
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

      if (!authorizeManagementRequest(clientReq, MANAGEMENT_TOKEN)) {
        safeLog.warn(
          `[mgmt] Unauthorized management request from ${clientIp}: ${method} ${urlPath}`
        );
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

    const clientPath =
      effectiveUrlPath.indexOf('/v1') === 0 ? effectiveUrlPath : '/v1' + effectiveUrlPath;
    const entryAuth = authorizeEntryRequest(clientReq, entry, CONFIG);
    if (!entryAuth.ok) {
      sendJsonError(clientRes, 401, {
        error: {
          type: 'authentication_error',
          message: 'Invalid or missing proxy entry API key.',
        },
      });
      logRequestEnd(method, urlPath, startTime, 401, { type: 'entry_auth' });
      return;
    }
    clientReq.entryAuth = entryAuth;
    if (isEntryHealthPath(entry, method, clientPath)) {
      sendEntryHealth(clientRes, entry, method, clientPath);
      logRequestEnd(method, urlPath, startTime, 200, {
        type: 'entry_health',
        entryProtocol: entryLabel(entry),
      });
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

    if (
      desktopRequest &&
      !isAuthorizedClaudeDesktopRequest(CONFIG, clientReq.headers, decryptKey)
    ) {
      sendUnauthorizedClaudeDesktop(clientRes);
      logRequestEnd(method, urlPath, startTime, 401, { type: 'claude_desktop_auth' });
      return;
    }

    const modelRequest = parseModelsRequestPath(effectiveUrlPath);
    if ((method === 'GET' || method === 'HEAD') && modelRequest) {
      const entryRoutes = routesForEntry(entry, desktopRequest, {
        modelRoutes: MODEL_ROUTES,
        claudeDesktopRoutes: CLAUDE_DESKTOP_ROUTES,
      }).filter(
        (route) =>
          !entryAuth.enabled || profileMatchesEntryKey(entryAuth, { id: route && route.profileId })
      );
      const modelsResult = handleLocalModelsRequest(
        clientReq,
        clientRes,
        modelRequest,
        entryRoutes,
        desktopRequest ? 'claude' : modelsFormatForEntry(entry),
        desktopRequest ? 'claude' : entry && entry.protocol
      );
      logRequestEnd(method, urlPath, startTime, modelsResult && modelsResult.status, {
        type: 'local_models',
        format: modelsResult && modelsResult.format,
        modelCount: modelsResult && modelsResult.modelCount,
      });
      return;
    }
    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders['host'];
    if (entryAuth.enabled) stripEntryAuthHeaders(fwdHeaders);

    collectLimitedRequestBody(clientReq, {
      limit: MAX_REQUEST_BODY_BYTES,
      onTooLarge({ bytes, limit }) {
        logProxyEvent('request_too_large', {
          method,
          path: urlPath,
          bytes,
          limit,
        });
      },
      onComplete({ tooLarge, bytes, buffer: requestBuffer }) {
        if (tooLarge) {
          sendRequestTooLarge(clientReq, clientRes, MAX_REQUEST_BODY_BYTES);
          logRequestEnd(method, urlPath, startTime, 413, {
            type: 'request_too_large',
            bytes,
            limit: MAX_REQUEST_BODY_BYTES,
          });
          return;
        }
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
            clientReq.entryAuth &&
            clientReq.entryAuth.enabled &&
            !profileMatchesEntryKey(clientReq.entryAuth, currentPrepared.profile)
          ) {
            sendJsonError(clientRes, 403, {
              error: {
                type: 'permission_denied',
                message: 'Proxy entry API key is not allowed to use this route.',
              },
            });
            logRequestEnd(method, urlPath, startTime, 403, { type: 'entry_auth_profile' });
            return;
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
            logRequestEnd(method, urlPath, startTime, 501, {
              type: 'trae_official_unsupported_path',
            });
            return;
          }

          const target = parseTargetUrl(currentPrepared.profile.targetUrl);
          const upstreamPath = target.path + clientPath.replace(/^\/v1/, '');
          const apiKey =
            currentPrepared.authMode === 'official-login'
              ? currentPrepared.profile.apiKey || null
              : process.env.API_KEY || currentPrepared.profile.apiKey || null;
          const isClaudeEntryRequest = forceClaudeEntry(entry) && isClaudeMessagesPath(clientPath);
          const isChatEntryRequest =
            forceChatEntry(entry) && isOpenAIChatCompletionsPath(clientPath);
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
            logRequestEnd(method, urlPath, startTime, 401, {
              type: 'google_official_auth_missing',
            });
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
              rejectMessage:
                'Chat to Responses conversion does not support compressed request bodies',
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
                (shouldConvertClaudeMessagesToOpenAI(
                  clientReq,
                  currentPrepared.profile,
                  clientPath
                ) ||
                  (isClaudeEntryRequest && isOpenAIProfile(currentPrepared.profile))),
              rejectMessage:
                'Claude to OpenAI conversion does not support compressed request bodies',
              handler: handleClaudeMessagesToOpenAIChat,
            },
            {
              label: 'openai->gemini',
              match:
                isChatEntryRequest && isGeminiProfile(currentPrepared.profile) && method === 'POST',
              rejectMessage:
                'OpenAI to Gemini conversion does not support compressed request bodies',
              handler: handleOpenAIChatToGeminiMessages,
            },
            {
              label: 'openai->claude',
              match:
                isClaudeProfile(currentPrepared.profile) &&
                method === 'POST' &&
                isOpenAIChatCompletionsPath(clientPath),
              rejectMessage:
                'OpenAI to Claude conversion does not support compressed request bodies',
              handler: handleOpenAIChatToClaudeMessages,
            },
            {
              label: 'responses->claude',
              match:
                isResponsesEntryRequest &&
                method === 'POST' &&
                isClaudeProfile(currentPrepared.profile),
              rejectMessage:
                'OpenAI Responses conversion does not support compressed request bodies',
              handler: handleOpenAIResponsesToClaudeMessages,
            },
            {
              label: 'responses->gemini',
              match:
                isResponsesEntryRequest &&
                method === 'POST' &&
                isGeminiProfile(currentPrepared.profile),
              rejectMessage:
                'OpenAI Responses conversion does not support compressed request bodies',
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

          const outgoingHeaders = buildOutgoingHeaders(fwdHeaders, {
            requestProtocol,
            protocolVersion: currentPrepared._protocolVersion,
            authMode: currentPrepared.authMode,
            apiKey,
            routed: currentPrepared.routed,
            bodyBuffer: currentPrepared.buffer,
          });
          if (currentPrepared.routed) {
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
              port: parsePortOrDefault(
                process.env.TARGET_PORT || target.port,
                target.protocol === 'https:' ? 443 : 80
              ),
              path: upstreamPath,
              method: method,
              headers: outgoingHeaders,
              timeout: 45000,
              agent: target.protocol === 'https:' ? globalHttpsAgent : globalHttpAgent,
            },
            (proxyRes) => {
              const code = proxyRes.statusCode;
              const recovery = resolveUpstreamRecovery({
                kind: 'status',
                statusCode: code,
                attempt,
                maxRetries: MAX_RETRIES,
                prepared: currentPrepared,
                profiles: getProfiles(loadConfig()) || [],
                retryAfter: proxyRes.headers['retry-after'],
              });

              if (recovery.type === 'failover') {
                safeLog.warn(
                  `[Failover] Upstream returned status ${code}, falling back to backup profile: ${recovery.profile.id}`
                );
                const backupPrepared = { ...currentPrepared, profile: recovery.profile };
                proxyRes.destroy();
                doForward(backupPrepared, 2);
                return;
              }

              if (recovery.type === 'retry') {
                safeLog.warn(
                  `[Retry] Upstream returned ${code}, retrying in ${Math.round(recovery.delayMs)}ms... (Attempt ${attempt}/${MAX_RETRIES})`
                );
                proxyRes.destroy();
                setTimeout(() => doForward(currentPrepared, attempt + 1), recovery.delayMs);
                return;
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
              if (shouldProtectStream || shouldSanitizeOpenAIStream)
                delete headers['content-length'];
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
                const sseState = {
                  buffer: '',
                  pendingClaudeTool: null,
                  mode: 'strip-empty-optionals',
                };
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
                  logRequestEnd(method, urlPath, startTime, code, {
                    type: 'openai_stream_sanitized',
                  });
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
                  logRequestEnd(method, urlPath, startTime, code, {
                    type: 'openai_stream_protected',
                  });
                });
                return;
              }

              proxyRes.on('data', function (chunk) {
                if (!logged) {
                  const elapsed = Date.now() - startTime;
                  if (!isStream)
                    log.info(
                      'ok ' + method + ' ' + urlPath + '  -> ' + code + ' (' + elapsed + 'ms)'
                    );
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
                  const body = Buffer.concat(errorChunks)
                    .toString('utf8')
                    .replace(/\s+/g, ' ')
                    .trim();
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
            const recovery = resolveUpstreamRecovery({
              kind: 'error',
              attempt,
              maxRetries: MAX_RETRIES,
              prepared: currentPrepared,
              profiles: getProfiles(loadConfig()) || [],
            });
            if (recovery.type === 'failover') {
              safeLog.warn(
                `[Failover] Upstream timed out, falling back to backup profile: ${recovery.profile.id}`
              );
              proxyReq.destroy();
              doForward({ ...currentPrepared, profile: recovery.profile }, 2);
              return;
            }
            if (recovery.type === 'retry') {
              safeLog.warn(
                `[Retry] Upstream timeout, retrying in ${Math.round(recovery.delayMs)}ms... (Attempt ${attempt}/${MAX_RETRIES})`
              );
              proxyReq.destroy();
              setTimeout(() => doForward(currentPrepared, attempt + 1), recovery.delayMs);
              return;
            }
            proxyReq.destroy(new Error('Gateway Timeout (Upstream request timed out)'));
          });

          proxyReq.on('error', function (err) {
            const recovery = resolveUpstreamRecovery({
              kind: 'error',
              attempt,
              maxRetries: MAX_RETRIES,
              prepared: currentPrepared,
              profiles: getProfiles(loadConfig()) || [],
            });
            if (recovery.type === 'failover') {
              safeLog.warn(
                `[Failover] Upstream request failed (${err.message}), falling back to backup profile: ${recovery.profile.id}`
              );
              doForward({ ...currentPrepared, profile: recovery.profile }, 2);
              return;
            }
            if (recovery.type === 'retry') {
              safeLog.warn(
                `[Retry] Upstream error (${err.message}), retrying in ${Math.round(recovery.delayMs)}ms... (Attempt ${attempt}/${MAX_RETRIES})`
              );
              setTimeout(() => doForward(currentPrepared, attempt + 1), recovery.delayMs);
              return;
            }

            log.error('xx ' + method + ' ' + urlPath + '  ' + (err.code || err.message));
            logProxyEvent('proxy_error', {
              method,
              path: urlPath,
              error: err.message,
              code: err.code,
            });
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

        applyCliSessionModelOverride(initialPrepared, {
          cliSession,
          requestBuffer,
          requestEncoding: clientReq.headers['content-encoding'],
          resolveRoute,
          modelRoutes: MODEL_ROUTES,
          profiles: PROFILES,
          activeProfile: ACTIVE_PROFILE,
        });

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
      },
      onAborted() {
        clientRes.destroy();
      },
    });
  }

  return handleRequestInner;
}

module.exports = { createCoreRequestHandler };
