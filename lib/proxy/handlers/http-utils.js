/**
 * 通用 HTTP 工具
 *
 * 反向代理层的工具函数:JSON 响应、请求体解析、上游请求选项、
 * 超时/错误处理、SSE/JSON 解析。所有函数为纯函数(无共享状态),
 * 依赖通过工厂注入。
 */
'use strict';

const { parsePortOrDefault } = require('../management-utils');
const { terminateClientAfterUpstreamFailure } = require('./failure-terminal');
const { safeErrorCode } = require('./upstream-stream-guard');
const { resolveUpstreamTimeout } = require('./upstream-timeout');

function createHttpUtils({ log, sendJsonError, CORS_HEADERS, extractSseDataPayloads }) {
  function contentTypeIsEventStream(clientRes) {
    try {
      if (!clientRes || typeof clientRes.getHeader !== 'function') return false;
      const contentType = clientRes.getHeader('content-type');
      return typeof contentType === 'string' && contentType.indexOf('text/event-stream') >= 0;
    } catch (err) {
      return false;
    }
  }

  function writeJsonResponse(clientRes, statusCode, payload, extraHeaders) {
    const body = JSON.stringify(payload);
    clientRes.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...CORS_HEADERS,
      ...(extraHeaders || {}),
    });
    clientRes.end(body);
  }

  function parseProxyBody(clientRes, buffer) {
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      sendJsonError(clientRes, 400, {
        error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' },
      });
      return null;
    }
  }

  function upstreamRequestOptions(target, upstreamPath, headers, options) {
    const defaultPort = target && target.protocol === 'https:' ? 443 : 80;
    const fallbackPort = parsePortOrDefault(target && target.port, defaultPort);
    return {
      hostname: process.env.TARGET || target.hostname,
      port: parsePortOrDefault(process.env.TARGET_PORT || target.port, fallbackPort),
      path: upstreamPath,
      method: 'POST',
      headers,
      // Was hardcoded to 600s while the main forward path honoured profile.timeoutMs
      // (120s default), so the same profile behaved differently per entry point.
      timeout:
        options && Number.isFinite(Number(options.timeout))
          ? Number(options.timeout)
          : resolveUpstreamTimeout(options && options.profile, {
              fallbackMs: options && options.fallbackTimeoutMs,
            }),
    };
  }

  function onProxyTimeout(proxyReq, label) {
    return () => proxyReq.destroy(new Error(label + ' upstream request timeout'));
  }

  function onProxyError(clientRes, label, context = {}) {
    return (err) => {
      const code = safeErrorCode(err) || 'UPSTREAM_ERROR';
      const observed =
        typeof context.getFailureDiagnostics === 'function'
          ? context.getFailureDiagnostics(err)
          : null;
      const diagnostics =
        observed && typeof observed === 'object' && !Array.isArray(observed) ? observed : {};
      const message = label + ' proxy error: ' + code;
      log.error(label + ' ' + code);
      if (typeof context.logProxyEvent === 'function') {
        context.logProxyEvent('proxy_error', {
          method: context.method,
          path: context.path,
          upstreamPath: context.upstreamPath,
          type: context.type || String(label || '').toLowerCase(),
          ...(context.extra || {}),
          ...diagnostics,
          error: 'Upstream request failed',
          code,
        });
      }
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, {
          error: { message, type: 'proxy_error' },
        });
      } else {
        // Headers already went out (usually a streaming response), so the status code
        // can no longer be changed. Without an explicit end the client waits forever
        // for a terminal event that will never arrive.
        terminateClientAfterUpstreamFailure(clientRes, {
          stream: contentTypeIsEventStream(clientRes),
          payload: { error: { type: 'proxy_error', message } },
        });
      }
      if (typeof context.logRequestEnd === 'function') {
        context.logRequestEnd(
          context.method,
          context.upstreamPath || context.path,
          context.startTime,
          502,
          {
            type:
              context.logType ||
              (context.type || String(label || '').toLowerCase()) + '_proxy_error',
            errorType: 'proxy_error',
            ...diagnostics,
            error: 'Upstream request failed',
            code,
          }
        );
      }
    };
  }

  function parseJsonOrSseJson(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (extractSseDataPayloads) {
      const isSseText = /^\s*(event:|data:)/.test(trimmed);
      const payloads = extractSseDataPayloads(trimmed);
      const parsedPayloads = [];
      for (const payload of payloads) {
        try {
          parsedPayloads.push(JSON.parse(payload));
        } catch (err) {}
      }
      if (isSseText && payloads.length > 0 && parsedPayloads.length === 0) {
        throw new Error('SSE response did not contain any valid JSON data payloads');
      }

      const chatText = parsedPayloads
        .map((item) => {
          const choice = item && Array.isArray(item.choices) ? item.choices[0] : null;
          if (!choice) return '';
          if (choice.message && typeof choice.message.content === 'string')
            return choice.message.content;
          if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
          return '';
        })
        .join('');
      if (chatText) {
        const source = parsedPayloads.find((item) => item && item.id) || {};
        const usageSource = parsedPayloads.find((item) => item && item.usage) || {};
        return {
          id: source.id,
          choices: [
            { index: 0, message: { role: 'assistant', content: chatText }, finish_reason: 'stop' },
          ],
          usage: usageSource.usage,
        };
      }

      const responseText = parsedPayloads
        .filter(
          (item) =>
            item && item.type === 'response.output_text.done' && typeof item.text === 'string'
        )
        .map((item) => item.text)
        .join('');
      if (responseText) {
        const completed =
          parsedPayloads.find(
            (item) => item && item.type === 'response.completed' && item.response
          ) || null;
        const usage =
          completed && completed.response && completed.response.usage
            ? completed.response.usage
            : null;
        return {
          id: completed && completed.response && completed.response.id,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: responseText },
              finish_reason: 'stop',
            },
          ],
          usage: usage
            ? {
                prompt_tokens: usage.input_tokens || 0,
                completion_tokens: usage.output_tokens || 0,
                total_tokens: usage.total_tokens || 0,
              }
            : undefined,
        };
      }
      for (let i = parsedPayloads.length - 1; i >= 0; i -= 1) return parsedPayloads[i];
      if (isSseText) return null;
    }
    return JSON.parse(trimmed);
  }

  return {
    writeJsonResponse,
    parseProxyBody,
    upstreamRequestOptions,
    onProxyTimeout,
    onProxyError,
    parseJsonOrSseJson,
  };
}

module.exports = { createHttpUtils };
