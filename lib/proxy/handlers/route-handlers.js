/** 协议路由处理器：通过 ctx 注入依赖，处理客户端到上游的协议转换与流式响应。 */
'use strict';

const {
  rejectGeminiContextOverflow,
  buildGeminiProxyRequestOptions,
  failGeminiStream,
  finishGeminiClaudeStream,
  normalizeGeminiStreamBufferMax,
  processGeminiStreamChunk,
  sendGeminiLocalCooldown,
} = require('./route-gemini-utils');
const { sendConversionError } = require('./route-error-utils');
const { createMcpInterception } = require('./route-mcp-interception');
const { createRouteImageHandlers } = require('./openai-images');
const { attachGeminiDiagnostics } = require('./client-diagnostics');
const {
  createRouteResponseHelpers,
  summarizeGeminiRequestForDiagnostics,
} = require('./route-response-helpers');
const { createResponsesChatStreamHandler } = require('./responses-chat-stream');
const { createOpenAIResponsesToChatHandler } = require('./responses-to-chat-handler');
const { createOpenAIChatToResponsesHandler } = require('./chat-to-responses-handler');
const { createUpstreamStreamGuard } = require('./upstream-stream-guard');
const { observeUpstreamRequestFailure } = require('./upstream-connection-observer');
const { applyToolLoopGuardToOpenAIChat } = require('../tool-loop-guard');
const { withUpstreamTiming } = require('../request-timing');
const { createChatCompletionCollector } = require('../forced-stream-collector');
const { resolveUpstreamTimeout } = require('./upstream-timeout');
const { setUtf8StreamEncoding } = require('../utf8-stream');
const { createGoogleOfficialAuthRetry } = require('./google-official-auth-retry');
const { createGeminiJsonResponseHandlers } = require('./gemini-json-response-handlers');
const { optimizeContextMessages } = require('../context-optimizer');
const { rejectContextOverflow } = require('../context-budget-manager');
const webFallback = require('./managed-web-search-fallback');
const { upstreamErrorDetail } = require('./upstream-error-detail');
const {
  inputContainsCjk,
  responsesInputNeedsToolPreamble,
  responsesToolPreambleText,
} = require('./responses-tool-preamble');

function createRouteHandlers(ctx) {
  const {
    https,
    http,
    log,
    CORS_HEADERS,
    sendJsonError,
    sendUpstreamError,
    logRequestEnd,
    logProxyEvent,
    fallbackId,
    stableCreated,
    sendGeminiRateLimit,
    writeClaudeSseEvent,
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
    geminiInlineImageToClaudeBlock,
    geminiGeneratePath,
    geminiResponseToClaude,
    parseGeminiError,
    getGeminiCooldown,
    setGeminiCooldown,
    writeJsonResponse,
    parseProxyBody,
    upstreamRequestOptions,
    onProxyTimeout,
    onProxyError,
    parseJsonOrSseJson,
    shouldUseCodeAssistUpstream,
    codeAssistUserAgent,
    codeAssistGenerateRequest,
    unwrapCodeAssistResponse,
    unwrapCodeAssistSseEvent,
    collectBoundedResponse,
    createChatToResponsesBridge,
    responsesToChatWithHistory,
    rememberResponsesFromChatResponse,
    rememberResponsesFromBridge,
    rejectUnsupportedResponsesNonOpenAIConversion,
    rejectUnsupportedOpenAIChatNonOpenAIConversion,
    refreshAntigravityOfficialAccessToken,
    maxConversionResponseBytes = 16 * 1024 * 1024,
    protocolOptions = {},
  } = ctx;
  const geminiStreamBufferMaxChars = normalizeGeminiStreamBufferMax(
    protocolOptions.maxSseBufferChars
  );
  const {
    boundedResponseContext,
    handleConvertedJsonResponse,
    handleGeminiUpstreamError,
    proxyErrorContext,
  } = createRouteResponseHelpers({
    log,
    logProxyEvent,
    logRequestEnd,
    parseGeminiError,
    sendJsonError,
    sendUpstreamError,
    setGeminiCooldown,
    writeJsonResponse,
  });
  const handleMcpInterception = createMcpInterception(ctx);
  const handleResponsesChatStream = createResponsesChatStreamHandler(ctx);
  const handleOpenAIChatToOpenAIResponses = createOpenAIChatToResponsesHandler(ctx, {
    boundedResponseContext,
    handleConvertedJsonResponse,
    handleResponsesChatStream,
    proxyErrorContext,
  });
  // Upstream streams that die after the response headers went out would otherwise
  // leave the client waiting forever for a terminal event that never arrives.
  const guardUpstreamStream = createUpstreamStreamGuard({ logProxyEvent, logRequestEnd });
  // Seven conversion branches guard an upstream stream the same way. One positional
  // helper keeps each branch short enough to hold this module inside its size budget.
  const guardConversionStream = (proxyRes, ctx2, label, logType, onFailure) =>
    guardUpstreamStream(proxyRes, {
      clientRes: ctx2.clientRes,
      label,
      logType,
      method: ctx2.clientReq.method,
      upstreamPath: ctx2.upstreamPath,
      startTime: ctx2.startTime,
      onFailure,
    });
  const handleOpenAIResponsesToOpenAIChat = createOpenAIResponsesToChatHandler(ctx, {
    boundedResponseContext,
    handleConvertedJsonResponse,
    proxyErrorContext,
  });
  const retryGoogleOfficialAuthOnce = createGoogleOfficialAuthRetry({
    logProxyEvent,
    refreshAntigravityOfficialAccessToken,
  });
  const { handleOpenAIChatToGeminiJson, handleResponsesToGeminiJson } =
    createGeminiJsonResponseHandlers({
      ...ctx,
      handleConvertedJsonResponse,
      handleGeminiUpstreamError,
    });
  const {
    handleOpenAIImagesToGemini,
    handleOpenAIImagesToOpenAIOfficialResponses,
    handleOpenAIImageJobControl,
    handleOpenAIImageJobCreate,
    _imageJobStore,
  } = createRouteImageHandlers(ctx, {
    boundedResponseContext,
    handleGeminiUpstreamError,
    proxyErrorContext,
    geminiInlineImageToClaudeBlock,
  });
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
      upstreamRequestOptions(target, target.path + '/chat/completions', headers, {
        profile: prepared.profile,
        fallbackTimeoutMs: 600000,
      }),
      withUpstreamTiming(clientRes, (proxyRes) => {
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
          const streamGuard = guardConversionStream(
            proxyRes,
            { clientReq, clientRes, upstreamPath, startTime },
            'Claude',
            'claude_to_openai_stream_aborted'
          );
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
          setUtf8StreamEncoding(proxyRes);
          proxyRes.on('data', (chunk) =>
            streamGuard.hasFailed()
              ? undefined
              : processOpenAISseChunkToClaude(clientRes, chunk.toString('utf8'), state)
          );
          proxyRes.on('end', () => {
            streamGuard.markComplete();
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
      })
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
    if (rejectContextOverflow(clientRes, responsesBody, sendJsonError)) return;
    const requestBody = Buffer.from(JSON.stringify(responsesBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/responses', headers, {
        profile: prepared.profile,
        fallbackTimeoutMs: 600000,
      }),
      withUpstreamTiming(clientRes, (proxyRes) => {
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
          const streamGuard = guardConversionStream(
            proxyRes,
            { clientReq, clientRes, upstreamPath, startTime },
            'OpenAI Responses',
            'claude_to_responses_stream_aborted'
          );
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

          setUtf8StreamEncoding(proxyRes);
          proxyRes.on('data', (chunk) =>
            streamGuard.hasFailed()
              ? undefined
              : processOpenAIResponsesSseChunkToChat(chatRes, chunk.toString('utf8'), chatState)
          );
          proxyRes.on('end', () => {
            streamGuard.markComplete();
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
      })
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
    if (rejectContextOverflow(clientRes, claudeBody, sendJsonError)) return;
    const requestBody = Buffer.from(JSON.stringify(claudeBody));
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
      'anthropic-version': clientReq.headers['anthropic-version'] || '2023-06-01',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/messages', headers, {
        profile: prepared.profile,
        fallbackTimeoutMs: 600000,
      }),
      withUpstreamTiming(clientRes, (proxyRes) => {
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
          const streamGuard = guardConversionStream(
            proxyRes,
            { clientReq, clientRes, upstreamPath, startTime },
            'Claude',
            'openai_to_claude_stream_aborted'
          );
          setUtf8StreamEncoding(proxyRes);
          proxyRes.on('data', (chunk) =>
            streamGuard.hasFailed()
              ? undefined
              : processClaudeSseChunkToOpenAI(clientRes, chunk.toString('utf8'), state)
          );
          proxyRes.on('end', () => {
            streamGuard.markComplete();
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
      })
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
    if (rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed, 'Claude')) return;
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;
    if (Array.isArray(chatBody.messages)) {
      const { messages } = optimizeContextMessages(chatBody.messages);
      chatBody.messages = messages;
    }
    const claudeBody = openAIChatToClaudeMessages(chatBody, targetModel);
    if (rejectContextOverflow(clientRes, claudeBody, sendJsonError)) return;
    const requestBody = Buffer.from(JSON.stringify(claudeBody));
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
      'anthropic-version': clientReq.headers['anthropic-version'] || '2023-06-01',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      upstreamRequestOptions(target, target.path + '/messages', headers, {
        profile: prepared.profile,
        fallbackTimeoutMs: 600000,
      }),
      withUpstreamTiming(clientRes, (proxyRes) => {
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
            thinkingPolicy: 'passthrough',
          };
          const streamGuard = guardConversionStream(
            proxyRes,
            { clientReq, clientRes, upstreamPath, startTime },
            'Claude',
            'responses_to_claude_stream_aborted'
          );
          const chatRes = {
            write: (chunk) =>
              processOpenAIChatSseChunkToResponses(clientRes, String(chunk), bridge.responseState),
          };
          setUtf8StreamEncoding(proxyRes);
          proxyRes.on('data', (chunk) =>
            streamGuard.hasFailed()
              ? undefined
              : processClaudeSseChunkToOpenAI(chatRes, chunk.toString('utf8'), chatState)
          );
          proxyRes.on('end', () => {
            streamGuard.markComplete();
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
                const response = openAIChatToResponses(
                  chatResponse,
                  parsed.model || targetModel,
                  parsed
                );
                rememberResponsesFromChatResponse(response, chatBody, chatResponse);
                return response;
              },
            });
          },
          boundedResponseContext(clientReq, startTime, 'responses_to_claude')
        );
      })
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
    if (rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed, 'Gemini')) return;
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;
    const claudeBody = openAIChatToClaudeMessages(chatBody, targetModel);
    claudeBody.reasoning_effort = chatBody.reasoning_effort;
    const shouldUseToolPreamble = responsesInputNeedsToolPreamble(parsed.input);
    if (shouldUseToolPreamble) claudeBody.__responsesToolPreamble = true;
    const toolPreambleText = shouldUseToolPreamble ? responsesToolPreambleText(parsed) : '';
    const geminiBody = claudeMessagesToGemini(claudeBody, targetModel);
    if (rejectGeminiContextOverflow(clientRes, geminiBody, sendJsonError)) return;
    Object.defineProperty(geminiBody, '__hpmDiagnostics', {
      value: {
        ...(geminiBody.__hpmDiagnostics && typeof geminiBody.__hpmDiagnostics === 'object'
          ? geminiBody.__hpmDiagnostics
          : {}),
        managedWebSearchFallback: parsed.__disableManagedWebSearchPromotion === true,
        managedWebSearchFallbackMode:
          typeof parsed.__managedWebSearchFallbackMode === 'string'
            ? parsed.__managedWebSearchFallbackMode
            : undefined,
        nativeWebSearch: chatBody.__nativeWebSearch === 'gemini-google-search',
        managedWebSearchHistoryAsText: claudeBody.__managedWebSearchHistoryAsText === true,
      },
      enumerable: false,
      configurable: true,
    });
    const stream = chatBody.stream === true;
    const useCodeAssist = shouldUseCodeAssistUpstream(prepared, apiKey);
    const codeAssist = useCodeAssist
      ? codeAssistGenerateRequest(prepared, geminiBody, targetModel, stream)
      : null;
    const requestBody = Buffer.from(JSON.stringify(useCodeAssist ? codeAssist.body : geminiBody));
    const managedWebSearchFallback = webFallback.context(
      chatBody,
      parsed,
      prepared,
      handleOpenAIResponsesToGeminiMessages,
      arguments,
      {
        onFallback: ({ statusCode, responseBody, fallbackMode }) => {
          logProxyEvent('managed_web_search_fallback', {
            method: clientReq.method,
            path: upstreamPath,
            statusCode,
            fallbackMode,
            sourceModel: parsed.model,
            targetModel,
            routeType: 'responses_to_gemini',
            ...upstreamErrorDetail(responseBody || ''),
            requestBodyDiagnostic: summarizeGeminiRequestForDiagnostics(geminiBody),
          });
        },
      }
    );
    const pathWithMethod = useCodeAssist
      ? codeAssist.target.pathname + codeAssist.target.search
      : geminiGeneratePath(target.path, targetModel, stream) + (stream ? '?alt=sse' : '');
    const headers = webFallback.headers(
      apiKey,
      requestBody.length,
      useCodeAssist && codeAssistUserAgent()
    );

    const transport = target.protocol === 'https:' ? https : http;
    let upstreamResponseSeen = false;
    let upstreamResponseStatusCode = null;
    const proxyReq = transport.request(
      buildGeminiProxyRequestOptions({
        target,
        useCodeAssist,
        codeAssist,
        path: pathWithMethod,
        headers,
        timeout: resolveUpstreamTimeout(prepared.profile, { fallbackMs: 600000 }),
      }),
      withUpstreamTiming(clientRes, (proxyRes) => {
        upstreamResponseSeen = true;
        upstreamResponseStatusCode = proxyRes.statusCode;
        if (webFallback.retry(proxyRes, managedWebSearchFallback, clientRes)) return;
        if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS_HEADERS,
          });
          attachGeminiDiagnostics(
            clientRes,
            prepared,
            targetModel,
            upstreamPath,
            geminiBody,
            'openai-responses'
          );
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
            thinkingPolicy: 'passthrough',
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
            responsesToolPreambleText: toolPreambleText,
          };
          const streamGuard = guardConversionStream(
            proxyRes,
            { clientReq, clientRes, upstreamPath, startTime },
            'Gemini',
            'responses_to_gemini_stream_aborted',
            () => {
              geminiState.streamFailed = true;
            }
          );
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
          setUtf8StreamEncoding(proxyRes);
          proxyRes.on('data', (chunk) => {
            const chunkText = chunk.toString('utf8');
            sampleResponseChunk('gemini-upstream', chunkText, {
              upstreamPath,
              targetModel,
              entryProtocol: 'openai-responses',
            });
            try {
              if (streamGuard.hasFailed()) return;
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
            streamGuard.markComplete();
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
              requestBodyDiagnostic: summarizeGeminiRequestForDiagnostics(geminiBody),
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
            if (
              retryGoogleOfficialAuthOnce({
                clientReq,
                clientRes,
                prepared,
                apiKey,
                useCodeAssist,
                proxyRes,
                routeType: 'responses_to_gemini',
                upstreamPath,
                startTime,
                sendJsonError,
                logRequestEnd,
                target,
                handler: handleOpenAIResponsesToGeminiMessages,
              })
            ) {
              return;
            }
            handleResponsesToGeminiJson({
              proxyRes,
              clientReq,
              clientRes,
              prepared,
              upstreamPath,
              startTime,
              responseBody,
              targetModel,
              claudeBody,
              parsed,
              chatBody,
              toolPreambleText,
              geminiBody,
            });
          },
          boundedResponseContext(clientReq, startTime, 'responses_to_gemini')
        );
      })
    );
    const getFailureDiagnostics = observeUpstreamRequestFailure(proxyReq, () => ({
      clientRes,
      upstreamResponseSeen,
      upstreamResponseStatusCode,
      requestBodyByteLength: requestBody.length,
      contentLength: headers['content-length'] ?? headers['Content-Length'],
    }));

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Gemini'));
    proxyReq.on(
      'error',
      onProxyError(clientRes, 'Gemini', {
        ...proxyErrorContext(
          clientReq,
          upstreamPath,
          startTime,
          'gemini',
          'responses_to_gemini_proxy_error'
        ),
        getFailureDiagnostics,
      })
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

    const clientStream = parsed.stream === true;
    const collapseUpstreamStream = !clientStream && prepared.forceUpstreamChatStreaming === true;
    const stream = clientStream || collapseUpstreamStream;
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
    claudeBody.reasoning_effort =
      parsed.reasoning_effort || (parsed.reasoning && parsed.reasoning.effort);
    const geminiBody = claudeMessagesToGemini(claudeBody, targetModel);
    if (rejectGeminiContextOverflow(clientRes, geminiBody, sendJsonError)) return;
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
        timeout: resolveUpstreamTimeout(prepared.profile, { fallbackMs: 600000 }),
      }),
      withUpstreamTiming(clientRes, (proxyRes) => {
        if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          if (!collapseUpstreamStream) {
            clientRes.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              ...CORS_HEADERS,
            });
          }
          attachGeminiDiagnostics(
            clientRes,
            prepared,
            targetModel,
            upstreamPath,
            geminiBody,
            'openai-chat'
          );
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
          const collector = collapseUpstreamStream
            ? createChatCompletionCollector(maxConversionResponseBytes)
            : null;
          const openAIStreamSink = collector
            ? { write: (chunk) => collector.push(Buffer.from(String(chunk))) }
            : clientRes;
          const bridge = {
            write: (chunk) =>
              processClaudeSseChunkToOpenAI(openAIStreamSink, String(chunk), chatState),
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
          const streamGuard = guardConversionStream(
            proxyRes,
            { clientReq, clientRes, upstreamPath, startTime },
            'Gemini',
            'openai_chat_to_gemini_stream_aborted',
            () => {
              geminiState.streamFailed = true;
            }
          );
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
          setUtf8StreamEncoding(proxyRes);
          proxyRes.on('data', (chunk) => {
            const chunkText = chunk.toString('utf8');
            sampleResponseChunk('gemini-upstream', chunkText, {
              upstreamPath,
              targetModel,
              entryProtocol: 'openai-chat',
            });
            try {
              if (streamGuard.hasFailed()) return;
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
            streamGuard.markComplete();
            try {
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
              flushClaudeSseToOpenAI(openAIStreamSink, chatState);
              if (collector) {
                const openAIResponse = collector.finish();
                if (!openAIResponse.usage) {
                  const pt = geminiState.usage.input_tokens || 0;
                  const ct = geminiState.usage.output_tokens || 0;
                  openAIResponse.usage = {
                    prompt_tokens: pt,
                    completion_tokens: ct,
                    total_tokens: pt + ct,
                  };
                }
                writeJsonResponse(clientRes, 200, openAIResponse);
              } else {
                clientRes.end();
              }
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
            logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
              type: collapseUpstreamStream
                ? 'openai_to_gemini_stream_collapsed'
                : 'openai_to_gemini_stream',
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
            if (
              retryGoogleOfficialAuthOnce({
                clientReq,
                clientRes,
                prepared,
                apiKey,
                useCodeAssist,
                proxyRes,
                routeType: 'openai_to_gemini',
                upstreamPath,
                startTime,
                sendJsonError,
                logRequestEnd,
                target,
                handler: handleOpenAIChatToGeminiMessages,
              })
            ) {
              return;
            }
            handleOpenAIChatToGeminiJson({
              proxyRes,
              clientReq,
              clientRes,
              prepared,
              upstreamPath,
              startTime,
              responseBody,
              targetModel,
              claudeBody,
              parsed,
              geminiBody,
            });
          },
          boundedResponseContext(clientReq, startTime, 'openai_to_gemini')
        );
      })
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
    if (rejectGeminiContextOverflow(clientRes, geminiBody, sendJsonError)) return;
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
        timeout: resolveUpstreamTimeout(prepared.profile, { fallbackMs: 600000 }),
      }),
      withUpstreamTiming(clientRes, (proxyRes) => {
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
          attachGeminiDiagnostics(clientRes, prepared, targetModel, upstreamPath, geminiBody);
          const state = {
            textIndex: -1,
            textOpen: false,
            stopReason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
            buffer: '',
            tools: parsed.tools,
            pendingToolCall: null,
          };
          const streamGuard = guardConversionStream(
            proxyRes,
            { clientReq, clientRes, upstreamPath, startTime },
            'Gemini',
            'gemini_stream_aborted',
            () => {
              state.streamFailed = true;
            }
          );
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
          setUtf8StreamEncoding(proxyRes);
          proxyRes.on('data', (chunk) => {
            const chunkText = chunk.toString('utf8');
            sampleResponseChunk('gemini-upstream', chunkText, { upstreamPath, targetModel });
            try {
              if (streamGuard.hasFailed()) return;
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
            streamGuard.markComplete();
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
                requestBodyForDiagnostics: geminiBody,
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
      })
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
    handleOpenAIImageJobControl,
    handleOpenAIImageJobCreate,
    handleOpenAIImagesToGemini,
    handleOpenAIImagesToOpenAIOfficialResponses,
    handleGeminiMessages,
    _imageJobStore,
  };
}

module.exports = {
  createRouteHandlers,
  _internal: {
    inputContainsCjk,
    responsesInputNeedsToolPreamble,
    responsesToolPreambleText,
  },
};
