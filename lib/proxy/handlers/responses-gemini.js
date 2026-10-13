'use strict';
const { resolveResponsesGeminiContext } = require('../responses-gemini-request');
const { attachGeminiResponsesStream } = require('./gemini-responses-stream');
const { CLAUDE_STREAM_EVENT, CHAT_STREAM_CHUNK } = require('../internal-stream-events');
const { createConversionStreamOutput } = require('../conversion-stream-output');
const {
  rejectGeminiContextOverflow,
  buildGeminiProxyRequestOptions,
  failGeminiStream,
  finishGeminiClaudeStream,
  processGeminiStreamChunk,
} = require('./route-gemini-utils');
const { attachGeminiDiagnostics } = require('./client-diagnostics');
const { summarizeGeminiRequestForDiagnostics } = require('./route-response-helpers');
const { withUpstreamTiming } = require('../request-timing');
const { observeUpstreamRequestFailure } = require('./upstream-connection-observer');
const { resolveUpstreamTimeout } = require('./upstream-timeout');
const { setUtf8StreamEncoding } = require('../utf8-stream');
const {
  responsesInputNeedsToolPreamble,
  responsesToolPreambleText,
} = require('./responses-tool-preamble');
const { upstreamErrorDetail } = require('./upstream-error-detail');
const webFallback = require('./managed-web-search-fallback');
const {
  geminiResponsesConversionErrorDiagnostics,
  geminiResponsesOptionDiagnostics,
  normalizeGeminiResponsesRequest,
} = require('../gemini-responses-compat');
const {
  createDeferredGeminiOutput,
  createGeminiOutputRecovery,
  isEmptyGeminiBudgetResponse,
  observeGeminiRecoveryEvent,
} = require('./gemini-output-recovery');
function createResponsesGeminiHandler(ctx, helpers) {
  const {
    https,
    http,
    CORS_HEADERS,
    sendJsonError,
    logRequestEnd,
    logProxyEvent,
    fallbackId,
    stableCreated,
    writeClaudeSseEvent,
    processClaudeEventToOpenAI,
    processClaudeSseChunkToOpenAI,
    flushClaudeSseToOpenAI,
    processOpenAIChatChunkToResponses,
    processOpenAIChatSseChunkToResponses,
    processGeminiSseEvent,
    flushPendingGeminiToolCall,
    geminiClaudeStopReason,
    sampleResponseChunk,
    openAIChatToClaudeMessages,
    tryOpenAIChatToGemini,
    claudeMessagesToGemini,
    geminiGeneratePath,
    parseProxyBody,
    onProxyTimeout,
    onProxyError,
    shouldUseCodeAssistUpstream,
    codeAssistUserAgent,
    codeAssistGenerateRequest,
    unwrapCodeAssistSseEvent,
    unwrapCodeAssistResponse,
    parseJsonOrSseJson,
    collectBoundedResponse,
    createGeminiResponsesStream,
    createChatToResponsesBridge,
    responsesToChatWithHistory,
    rememberResponsesFromBridge,
    rejectUnsupportedResponsesNonOpenAIConversion,
    protocolOptions = {},
  } = ctx;
  const {
    boundedResponseContext,
    proxyErrorContext,
    guardConversionStream,
    retryGoogleOfficialAuthOnce,
    handleResponsesToGeminiJson,
    geminiStreamBufferMaxChars,
  } = helpers;
  const processRecoveryEvent = (sink, event, state, model) => {
    observeGeminiRecoveryEvent(event, state);
    processGeminiSseEvent(sink, event, state, model);
  };
  function handleOpenAIResponsesToGeminiMessages(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const sourceParsed = parseProxyBody(clientRes, prepared.buffer);
    if (!sourceParsed) return;
    const parsed = normalizeGeminiResponsesRequest(sourceParsed);
    if (typeof logProxyEvent === 'function') {
      logProxyEvent(
        'gemini_responses_compat',
        geminiResponsesOptionDiagnostics(sourceParsed, parsed)
      );
    }

    const targetModel =
      prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model || 'gemini-pro';
    const useCodeAssist = shouldUseCodeAssistUpstream(prepared, apiKey);
    if (
      rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed, 'Gemini', targetModel, {
        codeAssist: useCodeAssist,
      })
    )
      return;
    const native =
      typeof ctx.resolveResponsesHistory === 'function' &&
      typeof ctx.responsesHistoryToGemini === 'function' &&
      typeof ctx.geminiResponseToResponses === 'function';
    const chatBody = native
      ? resolveResponsesGeminiContext(ctx, clientRes, parsed, targetModel)
      : responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;
    const shouldUseToolPreamble = responsesInputNeedsToolPreamble(parsed.input);
    const toolPreambleText = shouldUseToolPreamble ? responsesToolPreambleText(parsed) : '';
    const requestedTokens =
      parsed.max_output_tokens ?? parsed.max_tokens ?? parsed.max_completion_tokens;
    const outputRecovery = createGeminiOutputRecovery({
      clientReq,
      clientRes,
      prepared,
      model: targetModel,
      codeAssist: useCodeAssist,
      requestedTokens,
      startTime,
      logProxyEvent,
      retry: (nextPrepared) =>
        handleOpenAIResponsesToGeminiMessages(
          clientReq,
          clientRes,
          nextPrepared,
          target,
          apiKey,
          upstreamPath,
          startTime
        ),
    });
    let direct;
    try {
      direct = native
        ? ctx.responsesHistoryToGemini(parsed, chatBody, targetModel, outputRecovery.options, {
            toolPreamble: shouldUseToolPreamble,
          })
        : typeof tryOpenAIChatToGemini === 'function'
          ? tryOpenAIChatToGemini(chatBody, targetModel, outputRecovery.options, {
              toolPreamble: shouldUseToolPreamble,
            })
          : null;
    } catch (error) {
      if (!native || error.code !== 'invalid_request_error') throw error;
      if (typeof logProxyEvent === 'function') {
        logProxyEvent(
          'gemini_responses_conversion_rejected',
          geminiResponsesConversionErrorDiagnostics(error, 'request')
        );
      }
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'Invalid Responses request for Gemini conversion',
        },
      });
      return;
    }
    const claudeBody =
      direct || openAIChatToClaudeMessages(chatBody, targetModel, { target: 'Gemini' });
    let geminiBody = direct?.request;
    if (!direct) {
      claudeBody.reasoning_effort = chatBody.reasoning_effort;
      if (shouldUseToolPreamble) claudeBody.__responsesToolPreamble = true;
      geminiBody = claudeMessagesToGemini(claudeBody, targetModel, outputRecovery.options);
    }
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
          const outputFlow = createConversionStreamOutput({
            proxyRes,
            clientRes,
            clientReq,
            upstreamPath,
            startTime,
            logRequestEnd,
            protocolOptions,
          });
          {
            const clientRes = outputFlow.clientRes;
            const logRequestEnd = outputFlow.logRequestEnd;
            const outputGate = createDeferredGeminiOutput(clientRes, {
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
            const bridge = createChatToResponsesBridge(outputGate.sink, parsed, targetModel);
            if (typeof createGeminiResponsesStream === 'function') {
              attachGeminiResponsesStream({
                proxyRes,
                clientReq,
                clientRes,
                outputFlow,
                outputGate,
                bridge,
                converter: createGeminiResponsesStream(bridge.responseState, {
                  tools: claudeBody.tools,
                  toolPreambleText,
                  maxChars: geminiStreamBufferMaxChars,
                  unwrapPayload: useCodeAssist ? unwrapCodeAssistResponse : undefined,
                }),
                outputRecovery,
                geminiBody,
                guardConversionStream,
                rememberResponsesFromBridge,
                chatBody,
                upstreamPath,
                startTime,
                logRequestEnd,
                requestBodyDiagnostic: summarizeGeminiRequestForDiagnostics(geminiBody),
              });
              return;
            }
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
                processOpenAIChatSseChunkToResponses(
                  outputGate.sink,
                  String(chunk),
                  bridge.responseState
                ),
            };
            const claudeBridge = {
              write: (chunk) => processClaudeSseChunkToOpenAI(chatRes, String(chunk), chatState),
            };
            if (typeof processOpenAIChatChunkToResponses === 'function') {
              chatRes[CHAT_STREAM_CHUNK] = (payload, wire) =>
                processOpenAIChatChunkToResponses(
                  outputGate.sink,
                  payload,
                  wire,
                  bridge.responseState
                );
            }
            if (typeof processClaudeEventToOpenAI === 'function') {
              claudeBridge[CLAUDE_STREAM_EVENT] = (name, data, wire) =>
                processClaudeEventToOpenAI(chatRes, name, data, wire, chatState);
            }
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
                if (streamGuard.hasFailed() || clientRes.destroyed) return;
                processGeminiStreamChunk({
                  sink: claudeBridge,
                  state: geminiState,
                  chunkText,
                  maxChars: geminiStreamBufferMaxChars,
                  processGeminiSseEvent: processRecoveryEvent,
                  targetModel,
                  unwrapEvent: useCodeAssist ? unwrapCodeAssistSseEvent : undefined,
                });
                outputGate.commitIfOutput(geminiState);
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
              if (geminiState.streamFailed || clientRes.destroyed) return;
              streamGuard.markComplete();
              if (geminiState.buffer && geminiState.buffer.trim()) {
                processRecoveryEvent(
                  claudeBridge,
                  useCodeAssist ? unwrapCodeAssistSseEvent(geminiState.buffer) : geminiState.buffer,
                  geminiState,
                  targetModel
                );
                geminiState.buffer = '';
              }
              outputGate.commitIfOutput(geminiState);
              if (
                outputRecovery.retryEmpty({
                  budget: geminiBody.__hpmDiagnostics?.outputBudget,
                  stopReason: geminiState.stopReason,
                  state: geminiState,
                  committed: outputGate.isCommitted(),
                  usage: geminiState.usage,
                })
              ) {
                outputFlow.dispose();
                outputGate.discard();
                return;
              }
              outputGate.commit();
              finishGeminiClaudeStream({
                sink: claudeBridge,
                state: geminiState,
                targetModel,
                unwrapEvent: useCodeAssist ? unwrapCodeAssistSseEvent : undefined,
                processGeminiSseEvent: processRecoveryEvent,
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
          }
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
            if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
              let payload;
              try {
                payload = unwrapCodeAssistResponse(parseJsonOrSseJson(responseBody));
              } catch {
                payload = null;
              } // The conversion handler reports invalid JSON below.
              if (
                isEmptyGeminiBudgetResponse(payload) &&
                outputRecovery.retryEmpty({
                  budget: geminiBody.__hpmDiagnostics?.outputBudget,
                  stopReason: 'max_tokens',
                  usage: { reasoning_tokens: payload.usageMetadata?.thoughtsTokenCount },
                })
              )
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
    // An absolute deadline bounds the recovery attempt even if the socket stays active.
    let deadline;
    const clearDeadline = () => {
      if (deadline) clearTimeout(deadline);
    };
    if (outputRecovery.remainingMs !== null) {
      deadline = setTimeout(() => proxyReq.emit('timeout'), outputRecovery.remainingMs);
      deadline.unref?.();
    }
    proxyReq.once?.('response', (res) => {
      res.once('end', clearDeadline);
      res.once('close', clearDeadline);
    });
    proxyReq.once?.('error', clearDeadline);
    const cancel = () => {
      clearDeadline();
      if (!clientRes.writableEnded) proxyReq.destroy();
    };
    clientRes.once?.('close', cancel);
    proxyReq.once?.('close', () => clientRes.removeListener?.('close', cancel));
    proxyReq.end(requestBody);
  }

  return handleOpenAIResponsesToGeminiMessages;
}
module.exports = { createResponsesGeminiHandler };
