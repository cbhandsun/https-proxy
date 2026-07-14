/**
 * 协议路由处理器(9 个 handleXxx)
 *
 * 每个 handler 处理"客户端→上游"的协议转换:
 *   - 输入:HTTP 请求 + 已解析的 prepared/target/apiKey
 *   - 输出:HTTP 响应(可能是流式 SSE)
 *
 * 所有依赖通过 ctx 单次注入(避免长参数列表),包括:
 *   - stdlib (https/http) + log + CORS_HEADERS
 *   - http-utils 工厂产物
 *   - code-assist / responses-state / request-validators 工厂产物
 *   - 协议转换函数与 SSE 工具(从 createProxyHandlers 的 deps 透传)
 */
'use strict';

const {
  applyGeminiCooldown,
  buildGeminiProxyRequestOptions,
  failGeminiStream,
  finishGeminiClaudeStream,
  geminiRetryHeaders,
  geminiUpstreamErrorEvent,
  logGeminiDirectError,
  normalizeGeminiStreamBufferMax,
  processGeminiStreamChunk,
  sendGeminiLocalCooldown,
} = require('./route-gemini-utils');
const { sendConversionError } = require('./route-error-utils');
const { applyToolLoopGuardToOpenAIChat } = require('../tool-loop-guard');

function createRouteHandlers(ctx) {
  const {
    // stdlib / 模块级
    https,
    http,
    log,
    CORS_HEADERS,
    mcpHub,
    // 通用工具(deps 透传)
    sendJsonError,
    sendUpstreamError,
    logRequestEnd,
    logProxyEvent,
    fallbackId,
    stableCreated,
    sendGeminiRateLimit,
    writeClaudeSseEvent,
    // OpenAI / Claude 协议转换(deps 透传)
    processOpenAISseChunkToClaude,
    flushOpenAISseToClaude,
    processClaudeSseChunkToOpenAI,
    flushClaudeSseToOpenAI,
    processOpenAIResponsesSseChunkToChat,
    flushOpenAIResponsesSseToChat,
    processOpenAIChatSseChunkToResponses,
    processGeminiSseEvent,
    flushPendingGeminiToolCall,
    geminiClaudeStopReason = (state) => {
      const stopReason = state && state.stopReason ? state.stopReason : 'end_turn';
      return state && state.hasToolUse && stopReason === 'end_turn' ? 'tool_use' : stopReason;
    },
    sampleResponseChunk,
    claudeMessagesToOpenAIChat,
    openAIResponseToClaudeMessage,
    openAIChatToClaudeMessages,
    claudeResponseToOpenAIChat,
    openAIChatToResponsesRequest,
    openAIResponsesToChatResponse,
    openAIChatToResponses,
    claudeMessagesToGemini,
    geminiGeneratePath,
    geminiResponseToClaude,
    parseGeminiError,
    getGeminiCooldown,
    setGeminiCooldown,
    // http-utils 工厂产物
    writeJsonResponse,
    parseProxyBody,
    upstreamRequestOptions,
    onProxyTimeout,
    onProxyError,
    parseJsonOrSseJson,
    // code-assist 工厂产物
    shouldUseCodeAssistUpstream,
    codeAssistUserAgent,
    codeAssistGenerateRequest,
    unwrapCodeAssistResponse,
    unwrapCodeAssistSseEvent,
    // responses-state 工厂产物
    collectBoundedResponse,
    createChatToResponsesBridge,
    responsesToChatWithHistory,
    rememberResponsesFromChatResponse,
    rememberResponsesFromBridge,
    // request-validators 工厂产物
    rejectUnsupportedResponsesConversion,
    rejectUnsupportedResponsesNonOpenAIConversion,
    rejectUnsupportedOpenAIChatNonOpenAIConversion,
    protocolOptions = {},
  } = ctx;
  const geminiStreamBufferMaxChars = normalizeGeminiStreamBufferMax(
    protocolOptions.maxSseBufferChars
  );

  function proxyErrorContext(clientReq, upstreamPath, startTime, type, logType, extra) {
    return {
      method: clientReq.method,
      path: clientReq.url,
      upstreamPath,
      startTime,
      type,
      logType,
      logProxyEvent,
      logRequestEnd,
      extra,
    };
  }

  function boundedResponseContext(clientReq, startTime, type) {
    return {
      method: clientReq.method,
      startTime,
      tooLargeLogType: type + '_response_too_large',
      errorLogType: type + '_response_error',
    };
  }

  function handleConvertedJsonResponse(options) {
    const {
      proxyRes,
      clientReq,
      clientRes,
      upstreamPath,
      startTime,
      responseBody,
      upstreamProvider,
      upstreamErrorType,
      successType,
      successMeta,
      conversionLabel,
      conversionLogType,
      convert,
    } = options;
    const statusCode = proxyRes.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      sendUpstreamError(clientRes, statusCode, proxyRes.headers, responseBody, upstreamProvider);
      logRequestEnd(clientReq.method, upstreamPath, startTime, statusCode, {
        type: upstreamErrorType,
      });
      return;
    }
    try {
      const response = convert(responseBody);
      writeJsonResponse(clientRes, 200, response);
      const extraSuccessMeta =
        typeof successMeta === 'function' ? successMeta(response) : successMeta;
      logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
        type: successType,
        ...(extraSuccessMeta || {}),
      });
    } catch (err) {
      sendConversionError({
        clientReq,
        clientRes,
        upstreamPath,
        startTime,
        err,
        label: conversionLabel,
        logType: conversionLogType,
        sendJsonError,
        logRequestEnd,
      });
    }
  }

  function handleGeminiUpstreamError(options) {
    const {
      proxyRes,
      clientReq,
      clientRes,
      prepared,
      upstreamPath,
      startTime,
      responseBody,
      targetModel,
      requestEndType,
      logDirectError = false,
      eventExtra,
    } = options;
    const statusCode = proxyRes.statusCode;
    const geminiError = parseGeminiError(statusCode, responseBody);
    const retryAfter = geminiError.retryAfterSeconds;
    sendUpstreamError(
      clientRes,
      statusCode,
      geminiRetryHeaders(proxyRes.headers, statusCode, retryAfter),
      responseBody,
      'gemini'
    );
    const cooldownSeconds = applyGeminiCooldown({
      statusCode,
      retryAfterSeconds: retryAfter,
      profileId: prepared.profile && prepared.profile.id,
      targetModel,
      setGeminiCooldown,
    });
    if (logDirectError) {
      logGeminiDirectError({
        clientReq,
        upstreamPath,
        statusCode,
        targetModel,
        geminiError,
        cooldownSeconds,
        log,
      });
    }
    const extraEventFields =
      typeof eventExtra === 'function' ? eventExtra(geminiError) : eventExtra;
    logProxyEvent(
      'upstream_error',
      geminiUpstreamErrorEvent(clientReq, upstreamPath, statusCode, geminiError, extraEventFields)
    );
    logRequestEnd(clientReq.method, upstreamPath, startTime, statusCode, {
      type: requestEndType,
      errorType: geminiError.type,
      retryAfterSeconds: retryAfter,
    });
  }

  // MCP 拦截(仅被 handleClaudeMessagesToOpenAIChat 使用,放在本文件)
  async function handleMcpInterception(
    responseBody,
    protocol,
    clientRes,
    upstreamPath,
    startTime,
    method
  ) {
    if (!mcpHub) return false;
    try {
      const parsed = parseJsonOrSseJson(responseBody);
      const toolCalls = mcpHub.extractToolCalls(parsed, protocol);
      if (toolCalls && toolCalls.length > 0) {
        const mcpResults = await mcpHub.interceptAndExecute(toolCalls, protocol);
        if (mcpResults) {
          log.info(
            `[MCP Hub] Intercepted and executed ${mcpResults.length} tool(s):`,
            mcpResults.map((r) => r.toolCallId).join(', ')
          );
          const finalResponse = {
            mcp_intercepted: true,
            results: mcpResults,
          };
          clientRes.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
          });
          clientRes.end(JSON.stringify(finalResponse));
          logRequestEnd(method, upstreamPath, startTime, 200, {
            type: 'mcp_interception',
            tools: toolCalls.length,
          });
          return true;
        }
      }
    } catch (e) {
      log.warn('[MCP Hub] Interception check failed:', e.message);
    }
    return false;
  }

  // ========== Claude 源 → 各类上游 ==========

  function handleClaudeMessagesToOpenAIChat(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    const openAIBody = claudeMessagesToOpenAIChat(parsed, targetModel);
    const requestBody = Buffer.from(JSON.stringify(openAIBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/chat/completions', headers),
      (proxyRes) => {
        if (openAIBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          const state = {
            buffer: '',
            textIndex: -1,
            textOpen: false,
            toolCalls: [],
            finishReason: 'stop',
            usage: { input_tokens: 0, output_tokens: 0 },
            done: false,
          };
          const messageId = fallbackId('msg_openai', {
            model: parsed.model || targetModel,
            messages: parsed.messages,
            route: targetModel,
          });
          writeClaudeSseEvent(clientRes, 'message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: parsed.model || targetModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: state.usage,
            },
          });
          proxyRes.on('data', (chunk) =>
            processOpenAISseChunkToClaude(clientRes, chunk.toString('utf8'), state)
          );
          proxyRes.on('end', () => {
            flushOpenAISseToClaude(clientRes, state);
            clientRes.end();
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: 'claude_to_openai_stream',
            });
          });
          return;
        }

        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'claude_to_openai',
          async (responseBody) => {
            if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
              sendUpstreamError(
                clientRes,
                proxyRes.statusCode,
                proxyRes.headers,
                responseBody,
                'openai'
              );
              logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, {
                type: 'claude_to_openai_error',
              });
              return;
            }
            if (
              await handleMcpInterception(
                responseBody,
                'openai',
                clientRes,
                upstreamPath,
                startTime,
                clientReq.method
              )
            )
              return;
            try {
              const claudeResponse = openAIResponseToClaudeMessage(
                parseJsonOrSseJson(responseBody),
                parsed.model || targetModel
              );
              writeJsonResponse(clientRes, 200, claudeResponse);
              logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
                type: 'claude_to_openai',
              });
            } catch (err) {
              sendConversionError({
                clientReq,
                clientRes,
                upstreamPath,
                startTime,
                err,
                label: 'OpenAI response',
                logType: 'claude_to_openai_conversion_error',
                sendJsonError,
                logRequestEnd,
              });
            }
          },
          boundedResponseContext(clientReq, startTime, 'claude_to_openai')
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'OpenAI'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'OpenAI',
        proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'openai',
          'claude_to_openai_proxy_error'
        )
      )
    );
    proxyReq.end(requestBody);
  }

  function handleClaudeMessagesToOpenAIResponses(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    const chatBody = claudeMessagesToOpenAIChat(parsed, targetModel);
    const responsesBody = openAIChatToResponsesRequest({ ...chatBody, model: targetModel });
    const requestBody = Buffer.from(JSON.stringify(responsesBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/responses', headers),
      (proxyRes) => {
        const code = proxyRes.statusCode;
        if (parsed.stream && code >= 200 && code < 300) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });

          const chatSeed = {
            model: parsed.model || targetModel,
            messages: parsed.messages,
            route: targetModel,
          };
          const messageId = fallbackId('msg_openai_responses', chatSeed);
          const chatState = {
            id: fallbackId('chatcmpl', chatSeed),
            created: stableCreated(chatSeed),
            model: parsed.model || targetModel,
            buffer: '',
            started: false,
            toolCalls: [],
            usage: null,
            done: false,
          };
          const claudeState = {
            buffer: '',
            textIndex: -1,
            textOpen: false,
            toolCalls: [],
            finishReason: 'stop',
            usage: { input_tokens: 0, output_tokens: 0 },
            done: false,
          };
          const chatRes = {
            write: (chunk) => processOpenAISseChunkToClaude(clientRes, String(chunk), claudeState),
          };
          writeClaudeSseEvent(clientRes, 'message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: parsed.model || targetModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: claudeState.usage,
            },
          });

          proxyRes.on('data', (chunk) =>
            processOpenAIResponsesSseChunkToChat(chatRes, chunk.toString('utf8'), chatState)
          );
          proxyRes.on('end', () => {
            flushOpenAIResponsesSseToChat(chatRes, chatState);
            flushOpenAISseToClaude(clientRes, claudeState);
            clientRes.end();
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: 'claude_to_responses_stream',
              upstreamEndpoint: target.path + '/responses',
            });
          });
          return;
        }

        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'claude_to_responses',
          (responseBody) => {
            handleConvertedJsonResponse({
              proxyRes,
              clientReq,
              clientRes,
              upstreamPath,
              startTime,
              responseBody,
              upstreamProvider: 'openai',
              upstreamErrorType: 'claude_to_responses_error',
              successType: 'claude_to_responses',
              successMeta: { upstreamEndpoint: target.path + '/responses' },
              conversionLabel: 'Claude from Responses',
              conversionLogType: 'claude_to_openai_responses_conversion_error',
              convert: (body) => {
                const payload = parseJsonOrSseJson(body);
                const chatResponse =
                  payload && Array.isArray(payload.choices) && !payload.output
                    ? payload
                    : openAIResponsesToChatResponse(payload, parsed.model || targetModel);
                return openAIResponseToClaudeMessage(chatResponse, parsed.model || targetModel);
              },
            });
          },
          boundedResponseContext(clientReq, startTime, 'claude_to_responses')
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'OpenAI'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'OpenAI',
        proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'openai',
          'claude_to_openai_responses_proxy_error'
        )
      )
    );
    proxyReq.end(requestBody);
  }

  // ========== OpenAI Chat 源 → 各类上游 ==========

  function handleOpenAIChatToClaudeMessages(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel =
      prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model || 'claude-sonnet-4-6';
    if (rejectUnsupportedOpenAIChatNonOpenAIConversion(clientRes, parsed, 'Claude')) return;
    const claudeBody = openAIChatToClaudeMessages(parsed, targetModel);
    const requestBody = Buffer.from(JSON.stringify(claudeBody));
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
      'anthropic-version': clientReq.headers['anthropic-version'] || '2023-06-01',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/messages', headers),
      (proxyRes) => {
        if (claudeBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          const streamSeed = {
            model: parsed.model || targetModel,
            messages: parsed.messages,
            route: targetModel,
          };
          const state = {
            id: fallbackId('chatcmpl', streamSeed),
            created: stableCreated(streamSeed),
            model: parsed.model || targetModel,
            buffer: '',
            pendingToolCall: null,
            toolCallIndex: 0,
            hasToolCalls: false,
            stopReason: 'end_turn',
            done: false,
          };
          proxyRes.on('data', (chunk) =>
            processClaudeSseChunkToOpenAI(clientRes, chunk.toString('utf8'), state)
          );
          proxyRes.on('end', () => {
            flushClaudeSseToOpenAI(clientRes, state);
            clientRes.end();
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: 'openai_to_claude_stream',
            });
          });
          return;
        }

        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'openai_to_claude',
          (responseBody) => {
            handleConvertedJsonResponse({
              proxyRes,
              clientReq,
              clientRes,
              upstreamPath,
              startTime,
              responseBody,
              upstreamProvider: 'claude',
              upstreamErrorType: 'openai_to_claude_error',
              successType: 'openai_to_claude',
              conversionLabel: 'Claude response',
              conversionLogType: 'openai_to_claude_conversion_error',
              convert: (body) =>
                claudeResponseToOpenAIChat(parseJsonOrSseJson(body), parsed.model || targetModel),
            });
          },
          boundedResponseContext(clientReq, startTime, 'openai_to_claude')
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Claude'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'Claude',
        proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'claude',
          'openai_to_claude_proxy_error'
        )
      )
    );
    proxyReq.end(requestBody);
  }

  function handleOpenAIChatToOpenAIResponses(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    const responsesBody = openAIChatToResponsesRequest({ ...parsed, model: targetModel });
    const requestBody = Buffer.from(JSON.stringify(responsesBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/responses', headers),
      (proxyRes) => {
        const code = proxyRes.statusCode;
        if (parsed.stream && code >= 200 && code < 300) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          const streamSeed = {
            model: parsed.model || targetModel,
            messages: parsed.messages,
            route: targetModel,
          };
          const state = {
            id: fallbackId('chatcmpl', streamSeed),
            created: stableCreated(streamSeed),
            model: parsed.model || targetModel,
            buffer: '',
            started: false,
            toolCalls: [],
            usage: null,
            done: false,
          };
          proxyRes.on('data', (chunk) =>
            processOpenAIResponsesSseChunkToChat(clientRes, chunk.toString('utf8'), state)
          );
          proxyRes.on('end', () => {
            flushOpenAIResponsesSseToChat(clientRes, state);
            clientRes.end();
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: 'chat_to_responses_stream',
            });
          });
          return;
        }

        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'chat_to_responses',
          (responseBody) => {
            handleConvertedJsonResponse({
              proxyRes,
              clientReq,
              clientRes,
              upstreamPath,
              startTime,
              responseBody,
              upstreamProvider: 'openai',
              upstreamErrorType: 'chat_to_responses_error',
              successType: 'chat_to_responses',
              conversionLabel: 'OpenAI Chat from Responses',
              conversionLogType: 'openai_responses_to_chat_conversion_error',
              convert: (body) => {
                const payload = parseJsonOrSseJson(body);
                return payload && Array.isArray(payload.choices) && !payload.output
                  ? payload
                  : openAIResponsesToChatResponse(payload, parsed.model || targetModel);
              },
            });
          },
          boundedResponseContext(clientReq, startTime, 'chat_to_responses')
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'OpenAI'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'OpenAI',
        proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'openai',
          'openai_responses_to_chat_proxy_error'
        )
      )
    );
    proxyReq.end(requestBody);
  }

  // ========== OpenAI Responses 源 → 各类上游 ==========

  function handleOpenAIResponsesToOpenAIChat(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    if (rejectUnsupportedResponsesConversion(clientRes, parsed)) return;
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;

    const requestBody = Buffer.from(JSON.stringify(chatBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/chat/completions', headers),
      (proxyRes) => {
        if (chatBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          const bridge = createChatToResponsesBridge(clientRes, parsed, targetModel);
          proxyRes.on('data', (chunk) =>
            processOpenAIChatSseChunkToResponses(
              clientRes,
              chunk.toString('utf8'),
              bridge.responseState
            )
          );
          proxyRes.on('end', () => {
            bridge.flush();
            rememberResponsesFromBridge(bridge, chatBody);
            clientRes.end();
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: 'responses_to_chat_stream',
            });
          });
          return;
        }
        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'responses_to_chat',
          (responseBody) => {
            handleConvertedJsonResponse({
              proxyRes,
              clientReq,
              clientRes,
              upstreamPath,
              startTime,
              responseBody,
              upstreamProvider: 'openai',
              upstreamErrorType: 'responses_to_chat_error',
              successType: 'responses_to_chat',
              conversionLabel: 'OpenAI Responses',
              conversionLogType: 'openai_chat_to_responses_conversion_error',
              convert: (body) => {
                const chatPayload = parseJsonOrSseJson(body);
                const response = openAIChatToResponses(chatPayload, parsed.model || targetModel);
                rememberResponsesFromChatResponse(response, chatBody, chatPayload);
                return response;
              },
            });
          },
          boundedResponseContext(clientReq, startTime, 'responses_to_chat')
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'OpenAI'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'OpenAI',
        proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'openai',
          'openai_chat_to_responses_proxy_error'
        )
      )
    );
    proxyReq.end(requestBody);
  }

  function handleOpenAIResponsesToClaudeMessages(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel =
      prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model || 'claude-sonnet-4-6';
    if (rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed)) return;
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;
    const claudeBody = openAIChatToClaudeMessages(chatBody, targetModel);
    const requestBody = Buffer.from(JSON.stringify(claudeBody));
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
      'anthropic-version': clientReq.headers['anthropic-version'] || '2023-06-01',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/messages', headers),
      (proxyRes) => {
        if (claudeBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          const bridge = createChatToResponsesBridge(clientRes, parsed, targetModel);
          const chatSeed = {
            model: parsed.model || targetModel,
            input: parsed.input,
            route: targetModel,
          };
          const chatState = {
            id: fallbackId('chatcmpl', chatSeed),
            created: stableCreated(chatSeed),
            model: parsed.model || targetModel,
            buffer: '',
            pendingToolCall: null,
            toolCallIndex: 0,
            hasToolCalls: false,
            stopReason: 'end_turn',
            done: false,
          };
          const chatRes = {
            write: (chunk) =>
              processOpenAIChatSseChunkToResponses(clientRes, String(chunk), bridge.responseState),
          };
          proxyRes.on('data', (chunk) =>
            processClaudeSseChunkToOpenAI(chatRes, chunk.toString('utf8'), chatState)
          );
          proxyRes.on('end', () => {
            flushClaudeSseToOpenAI(chatRes, chatState);
            bridge.flush();
            rememberResponsesFromBridge(bridge, chatBody);
            clientRes.end();
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: 'responses_to_claude_stream',
            });
          });
          return;
        }
        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'responses_to_claude',
          (responseBody) => {
            handleConvertedJsonResponse({
              proxyRes,
              clientReq,
              clientRes,
              upstreamPath,
              startTime,
              responseBody,
              upstreamProvider: 'claude',
              upstreamErrorType: 'responses_to_claude_error',
              successType: 'responses_to_claude',
              conversionLabel: 'OpenAI Responses',
              conversionLogType: 'claude_to_openai_responses_response_conversion_error',
              convert: (body) => {
                const chatResponse = claudeResponseToOpenAIChat(
                  parseJsonOrSseJson(body),
                  parsed.model || targetModel
                );
                const response = openAIChatToResponses(chatResponse, parsed.model || targetModel);
                rememberResponsesFromChatResponse(response, chatBody, chatResponse);
                return response;
              },
            });
          },
          boundedResponseContext(clientReq, startTime, 'responses_to_claude')
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Claude'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'Claude',
        proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'claude',
          'openai_responses_to_claude_proxy_error'
        )
      )
    );
    proxyReq.end(requestBody);
  }

  function handleOpenAIResponsesToGeminiMessages(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel =
      prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model || 'gemini-pro';
    if (rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed)) return;
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;
    const claudeBody = openAIChatToClaudeMessages(chatBody, targetModel);
    const geminiBody = claudeMessagesToGemini(claudeBody, targetModel);
    const stream = chatBody.stream === true;
    const useCodeAssist = shouldUseCodeAssistUpstream(prepared, apiKey);
    const codeAssist = useCodeAssist
      ? codeAssistGenerateRequest(prepared, geminiBody, targetModel, stream)
      : null;
    const requestBody = Buffer.from(JSON.stringify(useCodeAssist ? codeAssist.body : geminiBody));
    const pathWithMethod = useCodeAssist
      ? codeAssist.target.pathname + codeAssist.target.search
      : geminiGeneratePath(target.path, targetModel, stream) + (stream ? '?alt=sse' : '');
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (useCodeAssist) headers['user-agent'] = codeAssistUserAgent();
    if (apiKey) {
      if (String(apiKey).startsWith('ya29.')) {
        headers['authorization'] = 'Bearer ' + apiKey;
      } else {
        headers['x-goog-api-key'] = apiKey;
      }
    }

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      buildGeminiProxyRequestOptions({
        target,
        useCodeAssist,
        codeAssist,
        path: pathWithMethod,
        headers,
      }),
      (proxyRes) => {
        if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          clientRes.__diagnostics = {
            protocol: 'gemini',
            route: prepared.model,
            target: targetModel,
            upstreamPath,
            profile: prepared.profile && prepared.profile.id,
            entryProtocol: 'openai-responses',
          };
          const bridge = createChatToResponsesBridge(clientRes, parsed, targetModel);
          const chatSeed = {
            model: parsed.model || targetModel,
            input: parsed.input,
            route: targetModel,
          };
          const chatState = {
            id: fallbackId('chatcmpl', chatSeed),
            created: stableCreated(chatSeed),
            model: parsed.model || targetModel,
            buffer: '',
            pendingToolCall: null,
            toolCallIndex: 0,
            hasToolCalls: false,
            stopReason: 'end_turn',
            done: false,
          };
          const chatRes = {
            write: (chunk) =>
              processOpenAIChatSseChunkToResponses(clientRes, String(chunk), bridge.responseState),
          };
          const claudeBridge = {
            write: (chunk) => processClaudeSseChunkToOpenAI(chatRes, String(chunk), chatState),
          };
          const geminiState = {
            textIndex: -1,
            textOpen: false,
            stopReason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
            buffer: '',
            tools: claudeBody.tools,
            pendingToolCall: null,
          };
          const messageId = fallbackId('msg_gemini', {
            model: targetModel,
            messages: claudeBody.messages,
            route: targetModel,
          });
          writeClaudeSseEvent(claudeBridge, 'message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: targetModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: geminiState.usage,
            },
          });
          proxyRes.on('data', (chunk) => {
            const chunkText = chunk.toString('utf8');
            sampleResponseChunk('gemini-upstream', chunkText, {
              upstreamPath,
              targetModel,
              entryProtocol: 'openai-responses',
            });
            try {
              processGeminiStreamChunk({
                sink: claudeBridge,
                state: geminiState,
                chunkText,
                maxChars: geminiStreamBufferMaxChars,
                processGeminiSseEvent,
                targetModel,
                unwrapEvent: useCodeAssist ? unwrapCodeAssistSseEvent : undefined,
              });
            } catch (err) {
              geminiState.streamFailed = true;
              failGeminiStream({
                clientReq,
                clientRes,
                proxyRes,
                upstreamPath,
                startTime,
                err,
                sendJsonError,
                logRequestEnd,
              });
              return;
            }
          });
          proxyRes.on('end', () => {
            if (geminiState.streamFailed) return;
            finishGeminiClaudeStream({
              sink: claudeBridge,
              state: geminiState,
              targetModel,
              unwrapEvent: useCodeAssist ? unwrapCodeAssistSseEvent : undefined,
              processGeminiSseEvent,
              flushPendingGeminiToolCall,
              writeClaudeSseEvent,
              geminiClaudeStopReason,
            });
            flushClaudeSseToOpenAI(chatRes, chatState);
            bridge.flush();
            rememberResponsesFromBridge(bridge, chatBody);
            clientRes.end();
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: 'responses_to_gemini_stream',
              usage: geminiState.usage,
            });
          });
          return;
        }
        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'responses_to_gemini',
          (responseBody) => {
            handleConvertedJsonResponse({
              proxyRes,
              clientReq,
              clientRes,
              upstreamPath,
              startTime,
              responseBody,
              upstreamProvider: 'gemini',
              upstreamErrorType: 'responses_to_gemini_error',
              successType: 'responses_to_gemini',
              conversionLabel: 'OpenAI Responses to Gemini',
              conversionLogType: 'responses_to_gemini_conversion_error',
              convert: (body) => {
                const claudeResponse = geminiResponseToClaude(
                  unwrapCodeAssistResponse(parseJsonOrSseJson(body)),
                  targetModel,
                  claudeBody.tools
                );
                const chatResponse = claudeResponseToOpenAIChat(
                  claudeResponse,
                  parsed.model || targetModel
                );
                const response = openAIChatToResponses(chatResponse, parsed.model || targetModel);
                rememberResponsesFromChatResponse(response, chatBody, chatResponse);
                return response;
              },
            });
          },
          boundedResponseContext(clientReq, startTime, 'responses_to_gemini')
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Gemini'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'Gemini',
        proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'gemini',
          'responses_to_gemini_proxy_error'
        )
      )
    );
    proxyReq.end(requestBody);
  }

  function handleOpenAIChatToGeminiMessages(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    let parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const stream = parsed.stream === true;
    const targetModel =
      prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model || 'gemini-pro';
    if (rejectUnsupportedOpenAIChatNonOpenAIConversion(clientRes, parsed, 'Gemini')) return;
    const cooldown = getGeminiCooldown(prepared.profile && prepared.profile.id, targetModel);
    if (
      sendGeminiLocalCooldown({
        clientReq,
        clientRes,
        upstreamPath,
        startTime,
        targetModel,
        cooldown,
        log,
        sendGeminiRateLimit,
      })
    ) {
      return;
    }

    parsed = applyToolLoopGuardToOpenAIChat(parsed, {
      maxToolResults: protocolOptions.openaiToGeminiMaxToolResults,
    }).body;
    const claudeBody = openAIChatToClaudeMessages(parsed, targetModel);
    const geminiBody = claudeMessagesToGemini(claudeBody, targetModel);
    const useCodeAssist = shouldUseCodeAssistUpstream(prepared, apiKey);
    const codeAssist = useCodeAssist
      ? codeAssistGenerateRequest(prepared, geminiBody, targetModel, stream)
      : null;
    const requestBody = Buffer.from(JSON.stringify(useCodeAssist ? codeAssist.body : geminiBody));
    const pathWithMethod = useCodeAssist
      ? codeAssist.target.pathname + codeAssist.target.search
      : geminiGeneratePath(target.path, targetModel, stream) + (stream ? '?alt=sse' : '');
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
    };
    if (useCodeAssist) headers['user-agent'] = codeAssistUserAgent();
    if (apiKey) {
      if (String(apiKey).startsWith('ya29.')) {
        headers['authorization'] = 'Bearer ' + apiKey;
      } else {
        headers['x-goog-api-key'] = apiKey;
      }
    }

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      buildGeminiProxyRequestOptions({
        target,
        useCodeAssist,
        codeAssist,
        path: pathWithMethod,
        headers,
      }),
      (proxyRes) => {
        if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          clientRes.__diagnostics = {
            protocol: 'gemini',
            route: prepared.model,
            target: targetModel,
            upstreamPath,
            profile: prepared.profile && prepared.profile.id,
            entryProtocol: 'openai-chat',
          };
          const chatSeed = {
            model: parsed.model || targetModel,
            messages: parsed.messages,
            route: targetModel,
          };
          const chatState = {
            id: fallbackId('chatcmpl', chatSeed),
            created: stableCreated(chatSeed),
            model: parsed.model || targetModel,
            buffer: '',
            pendingToolCall: null,
            toolCallIndex: 0,
            hasToolCalls: false,
            stopReason: 'end_turn',
            done: false,
          };
          const bridge = {
            write: (chunk) => processClaudeSseChunkToOpenAI(clientRes, String(chunk), chatState),
          };
          const geminiState = {
            textIndex: -1,
            textOpen: false,
            stopReason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
            buffer: '',
            tools: claudeBody.tools,
            pendingToolCall: null,
          };
          const messageId = fallbackId('msg_gemini', {
            model: targetModel,
            messages: claudeBody.messages,
            route: targetModel,
          });
          writeClaudeSseEvent(bridge, 'message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: targetModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: geminiState.usage,
            },
          });
          proxyRes.on('data', (chunk) => {
            const chunkText = chunk.toString('utf8');
            sampleResponseChunk('gemini-upstream', chunkText, {
              upstreamPath,
              targetModel,
              entryProtocol: 'openai-chat',
            });
            try {
              processGeminiStreamChunk({
                sink: bridge,
                state: geminiState,
                chunkText,
                maxChars: geminiStreamBufferMaxChars,
                processGeminiSseEvent,
                targetModel,
                unwrapEvent: useCodeAssist ? unwrapCodeAssistSseEvent : undefined,
              });
            } catch (err) {
              geminiState.streamFailed = true;
              failGeminiStream({
                clientReq,
                clientRes,
                proxyRes,
                upstreamPath,
                startTime,
                err,
                sendJsonError,
                logRequestEnd,
              });
              return;
            }
          });
          proxyRes.on('end', () => {
            if (geminiState.streamFailed) return;
            finishGeminiClaudeStream({
              sink: bridge,
              state: geminiState,
              targetModel,
              unwrapEvent: useCodeAssist ? unwrapCodeAssistSseEvent : undefined,
              processGeminiSseEvent,
              flushPendingGeminiToolCall,
              writeClaudeSseEvent,
              geminiClaudeStopReason,
            });
            flushClaudeSseToOpenAI(clientRes, chatState);
            clientRes.end();
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: 'openai_to_gemini_stream',
              usage: geminiState.usage,
            });
          });
          return;
        }

        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'openai_to_gemini',
          (responseBody) => {
            if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
              handleGeminiUpstreamError({
                proxyRes,
                clientReq,
                clientRes,
                prepared,
                upstreamPath,
                startTime,
                responseBody,
                targetModel,
                requestEndType: 'openai_to_gemini_error',
              });
              return;
            }
            try {
              const claudeResponse = geminiResponseToClaude(
                unwrapCodeAssistResponse(parseJsonOrSseJson(responseBody)),
                targetModel,
                claudeBody.tools
              );
              const openAIResponse = claudeResponseToOpenAIChat(
                claudeResponse,
                parsed.model || targetModel
              );
              writeJsonResponse(clientRes, 200, openAIResponse);
              logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
                type: 'openai_to_gemini',
                usage: claudeResponse.usage,
              });
            } catch (err) {
              sendConversionError({
                clientReq,
                clientRes,
                upstreamPath,
                startTime,
                err,
                label: 'Gemini response',
                logType: 'openai_to_gemini_conversion_error',
                sendJsonError,
                logRequestEnd,
              });
            }
          },
          boundedResponseContext(clientReq, startTime, 'openai_to_gemini')
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Gemini'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'Gemini',
        proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'gemini',
          'openai_to_gemini_proxy_error',
          { entryProtocol: 'openai-chat' }
        )
      )
    );
    proxyReq.end(requestBody);
  }

  // ========== Gemini 源 / 直接 ==========

  function handleGeminiMessages(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const stream = parsed.stream === true;
    const targetModel =
      prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model || 'gemini-pro';
    const cooldown = getGeminiCooldown(prepared.profile && prepared.profile.id, targetModel);
    if (
      sendGeminiLocalCooldown({
        clientReq,
        clientRes,
        upstreamPath,
        startTime,
        targetModel,
        cooldown,
        log,
        sendGeminiRateLimit,
      })
    ) {
      return;
    }
    parsed.__diagnosticsMeta = {
      protocol: 'gemini',
      route: prepared.model,
      target: targetModel,
      upstreamPath,
      profile: prepared.profile && prepared.profile.id,
    };
    const geminiBody = claudeMessagesToGemini(parsed, targetModel);
    const useCodeAssist = shouldUseCodeAssistUpstream(prepared, apiKey);
    const codeAssist = useCodeAssist
      ? codeAssistGenerateRequest(prepared, geminiBody, targetModel, stream)
      : null;
    const requestBody = Buffer.from(JSON.stringify(useCodeAssist ? codeAssist.body : geminiBody));
    const pathWithMethod = useCodeAssist
      ? codeAssist.target.pathname + codeAssist.target.search
      : geminiGeneratePath(target.path, targetModel, stream) + (stream ? '?alt=sse' : '');
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
    };
    if (useCodeAssist) headers['user-agent'] = codeAssistUserAgent();
    if (apiKey) {
      if (String(apiKey).startsWith('ya29.')) {
        headers['authorization'] = 'Bearer ' + apiKey;
      } else {
        headers['x-goog-api-key'] = apiKey;
      }
    }

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      buildGeminiProxyRequestOptions({
        target,
        useCodeAssist,
        codeAssist,
        path: pathWithMethod,
        headers,
      }),
      (proxyRes) => {
        log.info(
          'gemini upstream response ' +
            clientReq.method +
            ' ' +
            upstreamPath +
            ' -> ' +
            proxyRes.statusCode +
            ' stream=' +
            stream
        );
        if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          clientRes.__diagnostics = {
            protocol: 'gemini',
            route: prepared.model,
            target: targetModel,
            upstreamPath,
            profile: prepared.profile && prepared.profile.id,
          };
          const state = {
            textIndex: -1,
            textOpen: false,
            stopReason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
            buffer: '',
            tools: parsed.tools,
            pendingToolCall: null,
          };
          const messageId = fallbackId('msg_gemini', {
            model: targetModel,
            messages: parsed.messages,
            route: targetModel,
          });
          writeClaudeSseEvent(clientRes, 'message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: targetModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: state.usage,
            },
          });
          proxyRes.on('data', (chunk) => {
            const chunkText = chunk.toString('utf8');
            sampleResponseChunk('gemini-upstream', chunkText, { upstreamPath, targetModel });
            try {
              processGeminiStreamChunk({
                sink: clientRes,
                state,
                chunkText,
                maxChars: geminiStreamBufferMaxChars,
                processGeminiSseEvent,
                targetModel,
                unwrapEvent: useCodeAssist ? unwrapCodeAssistSseEvent : undefined,
              });
            } catch (err) {
              state.streamFailed = true;
              failGeminiStream({
                clientReq,
                clientRes,
                proxyRes,
                upstreamPath,
                startTime,
                err,
                sendJsonError,
                logRequestEnd,
              });
              return;
            }
          });
          proxyRes.on('end', () => {
            if (state.streamFailed) return;
            finishGeminiClaudeStream({
              sink: clientRes,
              state,
              targetModel,
              unwrapEvent: useCodeAssist ? unwrapCodeAssistSseEvent : undefined,
              processGeminiSseEvent,
              flushPendingGeminiToolCall,
              writeClaudeSseEvent,
              geminiClaudeStopReason,
            });
            clientRes.end();
            log.info(
              'ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (gemini streaming)'
            );
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: 'gemini_stream',
              usage: state.usage,
            });
          });
          return;
        }

        collectBoundedResponse(
          proxyRes,
          clientRes,
          upstreamPath,
          'gemini',
          (responseBody) => {
            if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
              handleGeminiUpstreamError({
                proxyRes,
                clientReq,
                clientRes,
                prepared,
                upstreamPath,
                startTime,
                responseBody,
                targetModel,
                requestEndType: 'gemini_error',
                logDirectError: true,
                eventExtra: (geminiError) => ({
                  quotaMetric: geminiError.quotaMetric,
                  quotaId: geminiError.quotaId,
                }),
              });
              return;
            }
            try {
              const claudeResponse = geminiResponseToClaude(
                unwrapCodeAssistResponse(parseJsonOrSseJson(responseBody)),
                targetModel,
                parsed.tools
              );
              writeJsonResponse(clientRes, 200, claudeResponse);
              log.info('ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (gemini)');
              logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
                type: 'gemini',
                usage: claudeResponse.usage,
              });
            } catch (err) {
              sendConversionError({
                clientReq,
                clientRes,
                upstreamPath,
                startTime,
                err,
                label: 'Gemini response',
                logType: 'gemini_conversion_error',
                sendJsonError,
                logRequestEnd,
              });
            }
          },
          boundedResponseContext(clientReq, startTime, 'gemini')
        );
      }
    );

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Gemini'));
    proxyReq.on(
      'error',
      onProxyError(
        clientRes,
        'Gemini',
        proxyErrorContext(clientReq, upstreamPath, startTime, 'gemini', 'gemini_proxy_error')
      )
    );

    proxyReq.end(requestBody);
  }

  return {
    handleClaudeMessagesToOpenAIChat,
    handleClaudeMessagesToOpenAIResponses,
    handleOpenAIChatToClaudeMessages,
    handleOpenAIChatToOpenAIResponses,
    handleOpenAIResponsesToOpenAIChat,
    handleOpenAIResponsesToClaudeMessages,
    handleOpenAIResponsesToGeminiMessages,
    handleOpenAIChatToGeminiMessages,
    handleGeminiMessages,
  };
}

module.exports = { createRouteHandlers };
