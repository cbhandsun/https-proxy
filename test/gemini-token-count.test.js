'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const {
  createGeminiTokenCountHandler,
  tokenCountFailureReason,
} = require('../lib/proxy/handlers/gemini-token-count');

function response() {
  return {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = String(body || '');
      this.writableEnded = true;
      this.resolve?.();
    },
  };
}

async function invoke(port, model, events, timeout = 500) {
  const clientReq = new EventEmitter();
  clientReq.method = 'POST';
  const clientRes = response();
  const done = new Promise((resolve) => {
    clientRes.resolve = resolve;
  });
  const handler = createGeminiTokenCountHandler({
    http,
    https: require('node:https'),
    estimateTokens: () => 37,
    logRequestEnd: (_method, _path, _start, statusCode, extra) =>
      events.push({ statusCode, extra }),
    parseProxyBody: (_res, buffer) => JSON.parse(buffer.toString('utf8')),
    rejectUnsupportedResponsesNonOpenAIConversion: () => false,
    resolveResponsesHistory: () => ({
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'private prompt' }] }],
    }),
    responsesHistoryToGemini: () => ({
      request: { contents: [{ role: 'user', parts: [{ text: 'private prompt' }] }] },
    }),
    sendJsonError: (res, statusCode, body) => {
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    },
    tokenCountTimeoutMs: timeout,
  });
  handler(
    clientReq,
    clientRes,
    {
      buffer: Buffer.from(JSON.stringify({ model, input: 'private prompt' })),
      rewriteTo: model,
      profile: { protocol: 'gemini' },
    },
    { protocol: 'http:', hostname: '127.0.0.1', port },
    'fixture-secret',
    '/v1/responses/input_tokens',
    Date.now()
  );
  await done;
  return clientRes;
}

async function main() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        path: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks)),
      });
      if (req.url.includes('server-error')) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: { message: 'private upstream failure' } }));
        return;
      }
      if (req.url.includes('timeout')) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ totalTokens: 123, cachedContentTokenCount: 45 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const events = [];
    const exact = await invoke(server.address().port, 'gemini-3.1-pro', events);
    assert.equal(exact.statusCode, 200);
    assert.equal(exact.headers['x-hpm-token-count'], 'exact');
    assert.deepEqual(JSON.parse(exact.body), {
      object: 'response.input_tokens',
      input_tokens: 123,
    });
    assert.equal(events.at(-1).extra.cachedInputTokens, 45);
    assert.equal(received.at(-1).path, '/v1beta/models/gemini-3.1-pro:countTokens');
    assert.equal(received.at(-1).headers['x-goog-api-key'], 'fixture-secret');
    assert.deepEqual(received.at(-1).body, {
      generateContentRequest: {
        contents: [{ role: 'user', parts: [{ text: 'private prompt' }] }],
      },
    });

    const degraded = await invoke(server.address().port, 'server-error', events);
    assert.equal(degraded.headers['x-hpm-token-count'], 'estimated');
    assert.equal(degraded.headers['x-hpm-token-count-reason'], 'upstream-server-error');
    assert.equal(JSON.parse(degraded.body).input_tokens, 37);
    assert.equal(events.at(-1).extra.exact, false);
    assert.equal(JSON.stringify(events).includes('private'), false);

    const timedOut = await invoke(server.address().port, 'timeout', events, 100);
    assert.equal(timedOut.headers['x-hpm-token-count'], 'estimated');
    assert.equal(timedOut.headers['x-hpm-token-count-reason'], 'upstream-timeout');
    assert.equal(JSON.parse(timedOut.body).input_tokens, 37);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(tokenCountFailureReason(400), 'upstream-client-error');
  assert.equal(tokenCountFailureReason(503), 'upstream-server-error');
  assert.equal(tokenCountFailureReason(0, { code: 'ETIMEDOUT' }), 'upstream-timeout');
}

main()
  .then(() => console.log('[gemini-token-count.test] ok'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
