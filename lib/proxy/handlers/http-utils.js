/**
 * 通用 HTTP 工具
 *
 * 反向代理层的工具函数:JSON 响应、请求体解析、上游请求选项、
 * 超时/错误处理、SSE/JSON 解析。所有函数为纯函数(无共享状态),
 * 依赖通过工厂注入。
 */
'use strict';

function createHttpUtils({ log, sendJsonError, CORS_HEADERS, extractSseDataPayloads }) {
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

  function upstreamRequestOptions(target, upstreamPath, headers) {
    return {
      hostname: process.env.TARGET || target.hostname,
      port: parseInt(process.env.TARGET_PORT || target.port, 10),
      path: upstreamPath,
      method: 'POST',
      headers,
      timeout: 600000,
    };
  }

  function onProxyTimeout(proxyReq, label) {
    return () => proxyReq.destroy(new Error(label + ' upstream request timeout'));
  }

  function onProxyError(clientRes, label) {
    return (err) => {
      const msg = (err && err.message) || (err && err.code) || 'unknown';
      log.error(label + ' ' + msg);
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, {
          error: { message: label + ' proxy error: ' + msg, type: 'proxy_error' },
        });
      }
    };
  }

  function parseJsonOrSseJson(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (extractSseDataPayloads) {
      const payloads = extractSseDataPayloads(trimmed);
      const parsedPayloads = [];
      for (const payload of payloads) {
        try { parsedPayloads.push(JSON.parse(payload)); } catch (err) {}
      }

      const chatText = parsedPayloads.map((item) => {
        const choice = item && Array.isArray(item.choices) ? item.choices[0] : null;
        if (!choice) return '';
        if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
        if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
        return '';
      }).join('');
      if (chatText) {
        const source = parsedPayloads.find((item) => item && item.id) || {};
        const usageSource = parsedPayloads.find((item) => item && item.usage) || {};
        return {
          id: source.id,
          choices: [{ index: 0, message: { role: 'assistant', content: chatText }, finish_reason: 'stop' }],
          usage: usageSource.usage,
        };
      }

      const responseText = parsedPayloads
        .filter((item) => item && item.type === 'response.output_text.done' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('');
      if (responseText) {
        const completed = parsedPayloads.find((item) => item && item.type === 'response.completed' && item.response) || null;
        const usage = completed && completed.response && completed.response.usage ? completed.response.usage : null;
        return {
          id: completed && completed.response && completed.response.id,
          choices: [{ index: 0, message: { role: 'assistant', content: responseText }, finish_reason: 'stop' }],
          usage: usage ? {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: usage.total_tokens || 0,
          } : undefined,
        };
      }
      for (let i = parsedPayloads.length - 1; i >= 0; i -= 1) return parsedPayloads[i];
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
