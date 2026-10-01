'use strict';

const { sendConversionError } = require('./route-error-utils');
const {
  convertedRateLimitCooldown,
  sendConvertedLocalCooldown,
  shouldApplyConvertedRateLimitCooldown,
} = require('./converted-rate-limit');
const {
  createConvertedChatRequest,
  prepareConvertedChatBody,
} = require('./converted-chat-request');
const { createChatCompletionCollector } = require('../forced-stream-collector');
const { withUpstreamTiming } = require('../request-timing');
const { createUpstreamStreamGuard } = require('./upstream-stream-guard');
const { StringDecoder } = require('node:string_decoder');
const { rejectContextOverflow } = require('../context-budget-manager');
const { readWorkBuddyAuthInfo } = require('../workbuddy-official');
const {
  isWorkBuddyUnauthorizedResponse,
  refreshWorkBuddyOfficialAuth,
} = require('../workbuddy-auth-refresh');
const { createWorkBuddyWbipcClient } = require('../workbuddy-wbipc-client');
const { isWorkBuddyWbipcPayloadTooLarge } = require('../workbuddy-wbipc-payload');
const {
  DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
  DEFAULT_WORKBUDDY_PREFLIGHT_BODY_BYTES,
  DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
  planWorkBuddyWbipcRequest,
} = require('../workbuddy-context-planner');

function collapseOpenAIChatStreamToResponses(options) {
  const {
    proxyRes,
    clientReq,
    clientRes,
    upstreamPath,
    startTime,
    parsed,
    targetModel,
    chatBody,
    maxConversionResponseBytes,
    openAIChatToResponses,
    rememberResponsesFromChatResponse,
    writeJsonResponse,
    sendJsonError,
    logRequestEnd,
  } = options;
  const collector = createChatCompletionCollector(maxConversionResponseBytes);
  let settled = false;

  const fail = (err) => {
    if (settled) return;
    settled = true;
    sendConversionError({
      clientReq,
      clientRes,
      upstreamPath,
      startTime,
      err,
      label: 'OpenAI Chat stream',
      logType: 'openai_chat_stream_to_responses_conversion_error',
      sendJsonError,
      logRequestEnd,
    });
  };

  proxyRes.on('data', (chunk) => {
    if (settled) return;
    try {
      collector.push(chunk);
    } catch (err) {
      if (typeof proxyRes.destroy === 'function') proxyRes.destroy();
      fail(err);
    }
  });
  proxyRes.on('end', () => {
    if (settled) return;
    try {
      const chatPayload = collector.finish();
      const response = openAIChatToResponses(chatPayload, parsed.model || targetModel, parsed);
      rememberResponsesFromChatResponse(response, chatBody, chatPayload);
      writeJsonResponse(clientRes, 200, response);
      settled = true;
      logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
        type: 'responses_to_chat_stream_collapsed',
      });
    } catch (err) {
      fail(err);
    }
  });
  proxyRes.on('error', fail);
  // 'error' does not fire for every truncated stream; 'aborted'/incomplete 'close'
  // otherwise leave the client waiting on a response that will never be written.
  proxyRes.on('aborted', () => fail(new Error('Upstream stream was aborted before completion')));
  proxyRes.on('close', () => {
    if (proxyRes.complete === true) return;
    fail(new Error('Upstream stream closed before completion'));
  });
}

function createOpenAIResponsesToChatHandler(ctx, routeHelpers) {
  const {
    https,
    http,
    CORS_HEADERS,
    sendJsonError,
    logRequestEnd,
    logProxyEvent,
    writeJsonResponse,
    parseProxyBody,
    upstreamRequestOptions,
    onProxyTimeout,
    onProxyError,
    parseJsonOrSseJson,
    collectBoundedResponse,
    createChatToResponsesBridge,
    responsesToChatWithHistory,
    rememberResponsesFromChatResponse,
    rememberResponsesFromBridge,
    rejectUnsupportedResponsesConversion,
    openAIChatToResponses,
    processOpenAIChatSseChunkToResponses,
    readWorkBuddyAuthInfo: readWorkBuddyAuthInfoOverride = readWorkBuddyAuthInfo,
    refreshWorkBuddyOfficialAuth:
      refreshWorkBuddyOfficialAuthOverride = refreshWorkBuddyOfficialAuth,
    workBuddyWbipcClient: workBuddyWbipcClientOverride,
    protocolOptions = {},
    maxConversionResponseBytes = 16 * 1024 * 1024,
    workbuddyOperationalInputTokens = protocolOptions.workbuddyOperationalInputTokens ||
      DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
    workbuddyPreflightBodyBytes = protocolOptions.workbuddyPreflightBodyBytes ||
      DEFAULT_WORKBUDDY_PREFLIGHT_BODY_BYTES,
    workbuddyTargetBodyBytes = protocolOptions.workbuddyTargetBodyBytes ||
      DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
    workbuddyWbipcRetryBodyBytes = 256 * 1024,
    workbuddyMaxSelectedTools = protocolOptions.workbuddyMaxSelectedTools,
  } = ctx;
  const { boundedResponseContext, handleConvertedJsonResponse, proxyErrorContext } = routeHelpers;
  const guardUpstreamStream = createUpstreamStreamGuard(ctx);
  const workBuddyWbipcClient =
    workBuddyWbipcClientOverride ||
    createWorkBuddyWbipcClient({
      timeoutMs: protocolOptions.workbuddyWbipcTimeoutMs,
      clientVersion: protocolOptions.workbuddyWbipcClientVersion,
    });

  return function handleOpenAIResponsesToOpenAIChat(
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
    if (
      sendConvertedLocalCooldown(
        clientReq,
        clientRes,
        prepared,
        upstreamPath,
        startTime,
        targetModel,
        ctx
      )
    )
      return;
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;
    const clientWantsStream = chatBody.stream === true;
    if (shouldApplyConvertedRateLimitCooldown(prepared)) chatBody.stream = true;
    prepareConvertedChatBody(prepared, chatBody, targetModel, { protocolOptions });
    if (rejectContextOverflow(clientRes, chatBody, sendJsonError)) return;
    const requestBody = Buffer.from(JSON.stringify(chatBody));
    const isWorkBuddy =
      prepared &&
      (prepared.authProvider === 'workbuddy' ||
        (prepared.profile && prepared.profile.protocol === 'workbuddy'));
    function sendEncryptedCredentialError(status, wbipcStatus) {
      sendJsonError(clientRes, 401, {
        error: {
          type: 'authentication_error',
          code: 'workbuddy_encrypted_credentials_unsupported',
          message:
            'WorkBuddy official credentials are encrypted by the current WorkBuddy client and cannot be read directly by this adapter. The local WorkBuddy request bridge was not available; open WorkBuddy, ensure it is signed in, and retry.',
          wbipc_status: wbipcStatus || status || 'unavailable',
        },
      });
      logRequestEnd(clientReq.method, upstreamPath, startTime, 401, {
        type: 'responses_to_chat_error',
        errorType: 'workbuddy_encrypted_credentials_unsupported',
        wbipcStatus: wbipcStatus || status || 'unavailable',
      });
    }

    function sendWbipcPayloadTooLarge(diagnostics) {
      sendJsonError(clientRes, 413, {
        error: {
          type: 'invalid_request_error',
          code: 'workbuddy_request_too_large',
          message:
            'The WorkBuddy request still exceeds the safe operational context after tool selection and conversation compaction. Start a fresh conversation or reread the remaining large input in smaller slices.',
          wbipc_status: 'E_PAYLOAD_TOO_LARGE',
          estimated_input_tokens: diagnostics && diagnostics.finalEstimatedTokens,
          body_bytes: diagnostics && diagnostics.finalBodyBytes,
        },
      });
      logRequestEnd(clientReq.method, upstreamPath, startTime, 413, {
        type: 'responses_to_chat_error',
        errorType: 'workbuddy_request_too_large',
        wbipcStatus: 'E_PAYLOAD_TOO_LARGE',
        bodyBytes: diagnostics && diagnostics.finalBodyBytes,
        estimatedTokens: diagnostics && diagnostics.finalEstimatedTokens,
        droppedMessages: diagnostics && diagnostics.droppedMessages,
        continuationSummaryAdded: diagnostics && diagnostics.continuationSummaryAdded,
        foldedMessages: diagnostics && diagnostics.foldedMessages,
        foldedProtectedMessages: diagnostics && diagnostics.foldedProtectedMessages,
        foldedToolOutputs: diagnostics && diagnostics.foldedToolOutputs,
      });
    }

    function convertBufferedWbipcResponse(responseBody, statusCode, responseHeaders) {
      const proxyRes = { statusCode, headers: responseHeaders || {} };
      if (chatBody.stream && statusCode >= 200 && statusCode < 300 && clientWantsStream) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          ...CORS_HEADERS,
        });
        const bridge = createChatToResponsesBridge(clientRes, parsed, targetModel);
        try {
          processOpenAIChatSseChunkToResponses(clientRes, responseBody, bridge.responseState);
          bridge.flush();
          const failed = bridge.responseState.failed === true;
          if (!failed) rememberResponsesFromBridge(bridge, chatBody);
          clientRes.end();
          logRequestEnd(clientReq.method, upstreamPath, startTime, failed ? 502 : 200, {
            type: failed ? 'responses_to_chat_stream_error' : 'responses_to_chat_stream',
            transport: 'workbuddy_wbipc',
            errorCode: failed ? bridge.responseState.failure?.code : undefined,
          });
        } catch (err) {
          sendConversionError({
            clientReq,
            clientRes,
            upstreamPath,
            startTime,
            err,
            label: 'WorkBuddy WBIPC Chat stream',
            logType: 'workbuddy_wbipc_chat_stream_to_responses_conversion_error',
            sendJsonError,
            logRequestEnd,
          });
        }
        return;
      }

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
        rateLimitCooldown: convertedRateLimitCooldown(prepared, targetModel),
        conversionLabel: 'OpenAI Responses',
        conversionLogType: 'openai_chat_to_responses_conversion_error',
        convert: (body) => {
          const chatPayload = parseJsonOrSseJson(body);
          const response = openAIChatToResponses(chatPayload, parsed.model || targetModel, parsed);
          rememberResponsesFromChatResponse(response, chatBody, chatPayload);
          return response;
        },
      });
    }

    if (isWorkBuddy && !apiKey && prepared.workbuddyAuth?.accessTokenEncrypted) {
      const plannerOptions = {
        operationalInputTokens: workbuddyOperationalInputTokens,
        preflightBodyBytes: workbuddyPreflightBodyBytes,
        targetBodyBytes: workbuddyTargetBodyBytes,
        maxSelectedTools: workbuddyMaxSelectedTools,
      };
      const preflightPlan = planWorkBuddyWbipcRequest(chatBody, plannerOptions);
      if (preflightPlan.diagnostics.preflightApplied && typeof logProxyEvent === 'function') {
        logProxyEvent('workbuddy_context_plan', preflightPlan.diagnostics);
      }
      if (!preflightPlan.fits) {
        sendWbipcPayloadTooLarge(preflightPlan.diagnostics);
        return;
      }
      let effectiveChatBody = preflightPlan.body;
      const requestViaWbipc = (body) =>
        workBuddyWbipcClient.request({
          method: 'POST',
          path: `${target.path || ''}/chat/completions`,
          headers: {
            'content-type': 'application/json',
            accept: body.stream ? 'text/event-stream' : 'application/json',
          },
          body: Buffer.from(JSON.stringify(body)),
        });
      Promise.resolve()
        .then(() => requestViaWbipc(effectiveChatBody))
        .then(async (initialResponse) => {
          let wbipcResponse = initialResponse;
          let retryPlan = null;
          if (isWorkBuddyWbipcPayloadTooLarge(initialResponse)) {
            retryPlan = planWorkBuddyWbipcRequest(effectiveChatBody, {
              ...plannerOptions,
              force: true,
              operationalInputTokens: Math.min(workbuddyOperationalInputTokens, 64 * 1024),
              targetBodyBytes: workbuddyWbipcRetryBodyBytes,
            });
            if (typeof logProxyEvent === 'function') {
              logProxyEvent('workbuddy_wbipc_payload_fallback', {
                retrying: retryPlan.changed === true && retryPlan.fits === true,
                originalBodyBytes: retryPlan.diagnostics.originalBodyBytes,
                retryBodyBytes: retryPlan.diagnostics.finalBodyBytes,
                originalEstimatedTokens: retryPlan.diagnostics.originalEstimatedTokens,
                retryEstimatedTokens: retryPlan.diagnostics.finalEstimatedTokens,
                droppedMessages: retryPlan.diagnostics.droppedMessages || 0,
                continuationSummaryAdded: retryPlan.diagnostics.continuationSummaryAdded === true,
                foldedMessages: retryPlan.diagnostics.foldedMessages || 0,
                foldedProtectedMessages: retryPlan.diagnostics.foldedProtectedMessages || 0,
                foldedToolOutputs: retryPlan.diagnostics.foldedToolOutputs || 0,
                originalProtectedMessageBytes:
                  retryPlan.diagnostics.originalProtectedMessageBytes || 0,
                retryProtectedMessageBytes: retryPlan.diagnostics.finalProtectedMessageBytes || 0,
                originalToolsBytes: retryPlan.diagnostics.originalToolsBytes || 0,
                retryToolsBytes: retryPlan.diagnostics.finalToolsBytes || 0,
                originalToolCount: retryPlan.diagnostics.originalToolCount || 0,
                selectedToolCount: retryPlan.diagnostics.selectedToolCount || 0,
              });
            }
            if (retryPlan.changed === true && retryPlan.fits === true) {
              effectiveChatBody = retryPlan.body;
              wbipcResponse = await requestViaWbipc(effectiveChatBody);
            }
          }
          if (typeof logProxyEvent === 'function') {
            logProxyEvent('workbuddy_wbipc_request', {
              ok: wbipcResponse && wbipcResponse.ok === true,
              status: wbipcResponse && wbipcResponse.status,
              wbipcStatus: wbipcResponse && wbipcResponse.status,
            });
          }
          if (!wbipcResponse || wbipcResponse.ok !== true) {
            if (isWorkBuddyWbipcPayloadTooLarge(wbipcResponse)) {
              sendWbipcPayloadTooLarge(
                retryPlan ? retryPlan.diagnostics : preflightPlan.diagnostics
              );
              return;
            }
            sendEncryptedCredentialError(
              wbipcResponse && wbipcResponse.status,
              wbipcResponse && wbipcResponse.status
            );
            return;
          }
          if (effectiveChatBody !== chatBody) {
            chatBody.messages = effectiveChatBody.messages;
            if (Array.isArray(effectiveChatBody.tools)) chatBody.tools = effectiveChatBody.tools;
          }
          convertBufferedWbipcResponse(
            wbipcResponse.body || '',
            wbipcResponse.status || 502,
            wbipcResponse.headers || {}
          );
        })
        .catch((err) => {
          if (typeof logProxyEvent === 'function') {
            logProxyEvent('workbuddy_wbipc_request', {
              ok: false,
              status: 'error',
              error: err && err.message ? err.message : String(err),
            });
          }
          if (!clientRes.headersSent) sendEncryptedCredentialError('error', 'error');
        });
      return;
    }

    function sendUpstreamChatRequest(currentPrepared, currentApiKey, retryAttempted) {
      const { headers, audit } = createConvertedChatRequest(
        currentPrepared,
        target,
        currentApiKey,
        requestBody
      );
      if (clientRes.__auditData) clientRes.__auditData.upstream = audit;
      const proxyReq = (target.protocol === 'https:' ? https : http).request(
        upstreamRequestOptions(target, target.path + '/chat/completions', headers, {
          profile: currentPrepared.profile,
          fallbackTimeoutMs: 600000,
        }),
        withUpstreamTiming(clientRes, (proxyRes) => {
          if (chatBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            if (!clientWantsStream) {
              collapseOpenAIChatStreamToResponses({
                proxyRes,
                clientReq,
                clientRes,
                upstreamPath,
                startTime,
                parsed,
                targetModel,
                chatBody,
                maxConversionResponseBytes,
                openAIChatToResponses,
                rememberResponsesFromChatResponse,
                writeJsonResponse,
                sendJsonError,
                logRequestEnd,
              });
              return;
            }
            clientRes.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              ...CORS_HEADERS,
            });
            const bridge = createChatToResponsesBridge(clientRes, parsed, targetModel);
            const decoder = new StringDecoder('utf8');
            const streamGuard = guardUpstreamStream(proxyRes, {
              clientRes,
              label: 'OpenAI Chat',
              logType: 'responses_to_chat_stream_aborted',
              method: clientReq.method,
              upstreamPath,
              startTime,
            });
            proxyRes.on('data', (chunk) => {
              if (streamGuard.hasFailed() || bridge.responseState.done) return;
              try {
                processOpenAIChatSseChunkToResponses(
                  clientRes,
                  decoder.write(chunk),
                  bridge.responseState
                );
              } catch (_error) {
                bridge.responseState.invalidEvent = true;
                bridge.responseState.buffer = '';
                bridge.flush();
              }
            });
            proxyRes.on('end', () => {
              if (streamGuard.hasFailed()) return;
              streamGuard.markComplete();
              processOpenAIChatSseChunkToResponses(clientRes, decoder.end(), bridge.responseState);
              bridge.flush();
              const failed = bridge.responseState.failed === true;
              if (!failed) rememberResponsesFromBridge(bridge, chatBody);
              clientRes.end();
              logRequestEnd(clientReq.method, upstreamPath, startTime, failed ? 502 : 200, {
                type: failed ? 'responses_to_chat_stream_error' : 'responses_to_chat_stream',
                errorCode: failed ? bridge.responseState.failure?.code : undefined,
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
              const retryWithFreshWorkBuddyAuth = async () => {
                if (
                  retryAttempted ||
                  !isWorkBuddy ||
                  clientRes.headersSent ||
                  !isWorkBuddyUnauthorizedResponse(proxyRes.statusCode, responseBody)
                ) {
                  return false;
                }
                const refresh = await refreshWorkBuddyOfficialAuthOverride({
                  beforeAuth: currentPrepared.workbuddyAuth,
                  timeoutMs: protocolOptions.workbuddyAuthRefreshTimeoutMs,
                  intervalMs: protocolOptions.workbuddyAuthRefreshIntervalMs,
                });
                if (typeof logProxyEvent === 'function') {
                  logProxyEvent('workbuddy_auth_refresh', {
                    status: refresh.status,
                    triggerStatus: refresh.triggerStatus,
                    before: refresh.before,
                    after: refresh.after,
                  });
                }
                if (refresh.status !== 'refreshed') {
                  if (!clientRes.headersSent) {
                    sendJsonError(clientRes, 401, {
                      error: {
                        type: 'authentication_error',
                        code: 'workbuddy_auth_refresh_failed',
                        message:
                          'WorkBuddy official login could not be refreshed automatically. Open WorkBuddy and sign in again.',
                        refresh_status: refresh.status,
                      },
                    });
                    logRequestEnd(clientReq.method, upstreamPath, startTime, 401, {
                      type: 'responses_to_chat_error',
                      errorType: 'workbuddy_auth_refresh_failed',
                      refreshStatus: refresh.status,
                    });
                  }
                  return true;
                }
                const freshAuth = readWorkBuddyAuthInfoOverride();
                if (!freshAuth || !freshAuth.accessToken) {
                  if (!clientRes.headersSent) {
                    sendJsonError(clientRes, 401, {
                      error: {
                        type: 'authentication_error',
                        code: 'workbuddy_auth_refresh_missing_token',
                        message:
                          'WorkBuddy official login refreshed without a usable access token. Open WorkBuddy and sign in again.',
                      },
                    });
                    logRequestEnd(clientReq.method, upstreamPath, startTime, 401, {
                      type: 'responses_to_chat_error',
                      errorType: 'workbuddy_auth_refresh_missing_token',
                    });
                  }
                  return true;
                }
                sendUpstreamChatRequest(
                  {
                    ...currentPrepared,
                    profile: {
                      ...currentPrepared.profile,
                      apiKey: freshAuth.accessToken,
                      uid: freshAuth.uid,
                      uin: freshAuth.uin,
                    },
                    workbuddyAuth: freshAuth,
                  },
                  freshAuth.accessToken,
                  true
                );
                return true;
              };
              Promise.resolve()
                .then(retryWithFreshWorkBuddyAuth)
                .then((retried) => {
                  if (retried) return;
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
                    rateLimitCooldown: convertedRateLimitCooldown(prepared, targetModel),
                    conversionLabel: 'OpenAI Responses',
                    conversionLogType: 'openai_chat_to_responses_conversion_error',
                    convert: (body) => {
                      const chatPayload = parseJsonOrSseJson(body);
                      const response = openAIChatToResponses(
                        chatPayload,
                        parsed.model || targetModel,
                        parsed
                      );
                      rememberResponsesFromChatResponse(response, chatBody, chatPayload);
                      return response;
                    },
                  });
                })
                .catch((err) => {
                  if (typeof logProxyEvent === 'function') {
                    logProxyEvent('workbuddy_auth_refresh', {
                      status: 'refresh_error',
                      error: err && err.message ? err.message : String(err),
                    });
                  }
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
                    rateLimitCooldown: convertedRateLimitCooldown(currentPrepared, targetModel),
                    conversionLabel: 'OpenAI Responses',
                    conversionLogType: 'openai_chat_to_responses_conversion_error',
                    convert: (body) => {
                      const chatPayload = parseJsonOrSseJson(body);
                      const response = openAIChatToResponses(
                        chatPayload,
                        parsed.model || targetModel,
                        parsed
                      );
                      rememberResponsesFromChatResponse(response, chatBody, chatPayload);
                      return response;
                    },
                  });
                });
            },
            boundedResponseContext(clientReq, startTime, 'responses_to_chat')
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
            'openai_chat_to_responses_proxy_error'
          )
        )
      );
      proxyReq.end(requestBody);
    }

    sendUpstreamChatRequest(prepared, apiKey, false);
  };
}

module.exports = {
  createOpenAIResponsesToChatHandler,
};
