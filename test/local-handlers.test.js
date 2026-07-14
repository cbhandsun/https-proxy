const assert = require('assert');

const { handleCountTokens, sendGeminiRateLimit } = require('../lib/proxy/local-handlers');

function estimateTokens(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean).length;
}

{
  const writes = [];
  let logMeta = null;
  const res = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  sendGeminiRateLimit(
    { method: 'POST' },
    res,
    '/v1/messages',
    Date.now(),
    'gemini-test',
    Infinity,
    'limited',
    {},
    (_method, _path, _start, _status, meta) => {
      logMeta = meta;
      writes.push(meta);
    }
  );
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(res.headers['Retry-After'], '120');
  assert.strictEqual(logMeta.retryAfterSeconds, 120);
  assert.strictEqual(writes.length, 1);
}

{
  const chunks = [];
  const headers = [];
  const events = [];
  const req = { method: 'POST', url: '/v1/messages/count_tokens?beta=true' };
  const res = {
    writeHead(statusCode, nextHeaders) {
      headers.push({ statusCode, headers: nextHeaders });
    },
    end(body) {
      chunks.push(body);
    },
  };
  handleCountTokens(
    req,
    res,
    Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hello world' }] })),
    estimateTokens,
    (method, requestPath, startTime, statusCode, extra) =>
      events.push({ method, requestPath, startTime, statusCode, extra }),
    Date.now()
  );

  assert.strictEqual(headers[0].statusCode, 200);
  assert.deepStrictEqual(JSON.parse(chunks[0]), { input_tokens: 2 });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].requestPath, '/v1/messages/count_tokens?beta=true');
  assert.strictEqual(events[0].statusCode, 200);
  assert.strictEqual(events[0].extra.type, 'local_count_tokens');
  assert.strictEqual(events[0].extra.inputTokens, 2);
}

{
  const req = { method: 'POST', url: '/v1/messages/count_tokens?beta=true' };
  const res = {
    __auditData: { originalModel: '', protocol: '' },
    writeHead() {},
    end() {},
  };

  handleCountTokens(
    req,
    res,
    Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello world' }],
      })
    ),
    estimateTokens,
    () => {},
    Date.now()
  );

  assert.strictEqual(res.__auditData.originalModel, 'claude-sonnet-4-6');
  assert.strictEqual(res.__auditData.protocol, 'claude');
}

console.log('[local-handlers.test] ok');
