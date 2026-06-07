function logFilteredToolBody(kind, original, filtered) {
  if (original === filtered) return;
  console.warn('!! filtered invalid tool_use in ' + kind + ' response');
}

function sendGeminiRateLimit(clientReq, clientRes, upstreamPath, startTime, targetModel, retryAfterSeconds, message, meta, logRequestEnd) {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds || 1));
  clientRes.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': String(retryAfter),
    'access-control-allow-origin': '*',
  });
  clientRes.end(JSON.stringify({ error: { type: 'rate_limit_error', message } }));
  logRequestEnd(clientReq.method, upstreamPath, startTime, 429, { type: 'gemini_rate_limit', targetModel, retryAfterSeconds: retryAfter, ...(meta || {}) });
}

function handleCountTokens(clientReq, clientRes, requestBuffer, estimateTokens, logRequestEnd, startTime) {
  let inputTokens = 0;
  try {
    const parsed = JSON.parse(requestBuffer.toString('utf8'));
    if (clientRes.__auditData && !clientRes.__auditData.originalModel && parsed && parsed.model) {
      clientRes.__auditData.originalModel = String(parsed.model);
      if (!clientRes.__auditData.protocol) clientRes.__auditData.protocol = 'claude';
    }
    inputTokens = Math.max(1, estimateTokens(parsed.messages) + estimateTokens(parsed.system) + estimateTokens(parsed.tools));
  } catch (err) {
    inputTokens = 1;
  }

  clientRes.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  });
  clientRes.end(JSON.stringify({ input_tokens: inputTokens }));
  console.log('ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (local count_tokens, ' + inputTokens + ' tokens)');
  if (typeof logRequestEnd === 'function') {
    logRequestEnd(clientReq.method, clientReq.url, startTime || Date.now(), 200, {
      type: 'local_count_tokens',
      inputTokens,
    });
  }
}

module.exports = {
  logFilteredToolBody,
  sendGeminiRateLimit,
  handleCountTokens,
};
