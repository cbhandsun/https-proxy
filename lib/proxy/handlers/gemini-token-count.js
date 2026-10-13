'use strict';

const {
  createGeminiCountTokensRequest,
  parseGeminiCountTokensResponse,
} = require('../gemini-context-management');
const { normalizeGeminiResponsesRequest } = require('../gemini-responses-compat');
const { resolveResponsesGeminiContext } = require('../responses-gemini-request');
const { parsePortOrDefault } = require('../management-utils');

const MAX_COUNT_RESPONSE_BYTES = 1024 * 1024;

function tokenCountFailureReason(statusCode, error) {
  if (error?.code === 'ETIMEDOUT') return 'upstream-timeout';
  if (error) return 'upstream-network-error';
  if (statusCode >= 500) return 'upstream-server-error';
  if (statusCode >= 400) return 'upstream-client-error';
  return 'invalid-upstream-response';
}

function writeTokenCount(clientRes, inputTokens, exact, reason, cachedInputTokens = 0) {
  clientRes.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'access-control-allow-origin': '*',
    'x-hpm-token-count': exact ? 'exact' : 'estimated',
    ...(exact ? {} : { 'x-hpm-token-count-reason': reason }),
  });
  clientRes.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: inputTokens }));
  return {
    exact,
    reason,
    inputTokens,
    cachedInputTokens: exact ? cachedInputTokens : 0,
  };
}

function createGeminiTokenCountHandler(ctx) {
  const {
    http,
    https,
    estimateTokens,
    logRequestEnd,
    parseProxyBody,
    rejectUnsupportedResponsesNonOpenAIConversion,
    resolveResponsesHistory,
    responsesHistoryToGemini,
    sendJsonError,
    tokenCountTimeoutMs = 10_000,
  } = ctx;

  return function handleGeminiResponsesInputTokens(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const source = parseProxyBody(clientRes, prepared.buffer);
    if (!source) return;
    const parsed = normalizeGeminiResponsesRequest(source);
    const targetModel =
      prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model || 'gemini-pro';
    if (
      rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed, 'Gemini', targetModel, {
        codeAssist: false,
      })
    )
      return;
    const context = resolveResponsesGeminiContext(
      { resolveResponsesHistory },
      clientRes,
      parsed,
      targetModel
    );
    if (!context) return;

    let geminiBody;
    try {
      geminiBody = responsesHistoryToGemini(parsed, context, targetModel, {}, {}).request;
    } catch (error) {
      if (error?.code !== 'invalid_request_error') throw error;
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'Invalid Responses input token request for Gemini conversion',
        },
      });
      logRequestEnd(clientReq.method, upstreamPath, startTime, 400, {
        type: 'gemini_input_tokens_invalid',
      });
      return;
    }

    const fallback = (reason, statusCode) => {
      if (clientRes.writableEnded || clientRes.destroyed) return;
      const inputTokens = Math.max(1, estimateTokens(geminiBody));
      const result = writeTokenCount(clientRes, inputTokens, false, reason);
      logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
        type: 'gemini_input_tokens_estimated',
        exact: false,
        reason,
        upstreamStatusCode: Number(statusCode || 0),
        inputTokens: result.inputTokens,
      });
    };

    let countRequest;
    try {
      countRequest = createGeminiCountTokensRequest({
        model: targetModel,
        generateContentRequest: geminiBody,
      });
    } catch (_error) {
      fallback('invalid-count-request', 0);
      return;
    }
    const requestBody = Buffer.from(JSON.stringify(countRequest.body));
    const transport = target.protocol === 'https:' ? https : http;
    let settled = false;
    const settleFallback = (reason, statusCode) => {
      if (settled) return;
      settled = true;
      fallback(reason, statusCode);
    };
    const proxyReq = transport.request(
      {
        hostname: target.hostname,
        port: parsePortOrDefault(target.port, target.protocol === 'https:' ? 443 : 80),
        path: countRequest.path,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json; charset=utf-8',
          'content-length': requestBody.length,
          ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
        },
        timeout: Math.max(100, Math.min(60_000, Number(tokenCountTimeoutMs) || 10_000)),
      },
      (proxyRes) => {
        const chunks = [];
        let bytes = 0;
        proxyRes.on('data', (chunk) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_COUNT_RESPONSE_BYTES) {
            settleFallback('upstream-response-too-large', proxyRes.statusCode);
            proxyRes.destroy();
            return;
          }
          chunks.push(chunk);
        });
        proxyRes.on('aborted', () =>
          settleFallback('upstream-response-aborted', proxyRes.statusCode)
        );
        proxyRes.on('error', (error) =>
          settleFallback(tokenCountFailureReason(proxyRes.statusCode, error), proxyRes.statusCode)
        );
        proxyRes.on('end', () => {
          if (settled) return;
          if (!(proxyRes.statusCode >= 200 && proxyRes.statusCode < 300)) {
            settleFallback(tokenCountFailureReason(proxyRes.statusCode), proxyRes.statusCode);
            return;
          }
          let count;
          try {
            count = parseGeminiCountTokensResponse(
              JSON.parse(Buffer.concat(chunks).toString('utf8'))
            );
          } catch (_error) {
            settleFallback('invalid-upstream-response', proxyRes.statusCode);
            return;
          }
          settled = true;
          const result = writeTokenCount(
            clientRes,
            count.totalTokens,
            true,
            'provider-exact',
            count.cachedContentTokenCount
          );
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, {
            type: 'gemini_input_tokens_exact',
            exact: true,
            reason: 'provider-exact',
            inputTokens: result.inputTokens,
            cachedInputTokens: result.cachedInputTokens,
          });
        });
      }
    );
    proxyReq.on('timeout', () => {
      const error = Object.assign(new Error('Gemini token count timeout'), { code: 'ETIMEDOUT' });
      proxyReq.destroy(error);
    });
    proxyReq.on('error', (error) => settleFallback(tokenCountFailureReason(0, error), 0));
    clientReq.once?.('aborted', () => {
      settled = true;
      proxyReq.destroy();
    });
    proxyReq.end(requestBody);
  };
}

module.exports = {
  MAX_COUNT_RESPONSE_BYTES,
  createGeminiTokenCountHandler,
  tokenCountFailureReason,
};
