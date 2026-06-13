const assert = require('assert');

const { extractSseDataPayloads } = require('../lib/proxy/sse');
const { createHttpUtils } = require('../lib/proxy/handlers/http-utils');

const errors = [];
let jsonErrorCall = null;
let proxyEventCall = null;
let requestEndCall = null;

const { onProxyError, parseJsonOrSseJson } = createHttpUtils({
  CORS_HEADERS: {},
  extractSseDataPayloads,
  log: {
    error(message) {
      errors.push(message);
    },
  },
  sendJsonError(res, statusCode, body) {
    jsonErrorCall = { res, statusCode, body };
  },
});

const handler = onProxyError({ headersSent: false, id: 'client-res' }, 'Gemini', {
  method: 'POST',
  path: '/v1/chat/completions',
  upstreamPath: '/v1beta/models/gemini:generateContent',
  startTime: 123,
  type: 'gemini',
  logType: 'openai_to_gemini_proxy_error',
  extra: { entryProtocol: 'openai-chat' },
  logProxyEvent(eventName, payload) {
    proxyEventCall = { eventName, payload };
  },
  logRequestEnd(method, path, startTime, statusCode, meta) {
    requestEndCall = { method, path, startTime, statusCode, meta };
  },
});

const err = new Error('connect ECONNRESET');
err.code = 'ECONNRESET';
handler(err);

assert.deepStrictEqual(errors, ['Gemini connect ECONNRESET']);
assert.strictEqual(jsonErrorCall.statusCode, 502);
assert.strictEqual(jsonErrorCall.body.error.type, 'proxy_error');
assert.strictEqual(jsonErrorCall.body.error.message, 'Gemini proxy error: connect ECONNRESET');
assert.deepStrictEqual(proxyEventCall, {
  eventName: 'proxy_error',
  payload: {
    method: 'POST',
    path: '/v1/chat/completions',
    upstreamPath: '/v1beta/models/gemini:generateContent',
    error: 'connect ECONNRESET',
    code: 'ECONNRESET',
    type: 'gemini',
    entryProtocol: 'openai-chat',
  },
});
assert.deepStrictEqual(requestEndCall, {
  method: 'POST',
  path: '/v1beta/models/gemini:generateContent',
  startTime: 123,
  statusCode: 502,
  meta: {
    type: 'openai_to_gemini_proxy_error',
    errorType: 'proxy_error',
    error: 'connect ECONNRESET',
    code: 'ECONNRESET',
  },
});

jsonErrorCall = null;
onProxyError({ headersSent: true }, 'OpenAI')({ code: 'ETIMEDOUT' });
assert.strictEqual(jsonErrorCall, null);

assert.deepStrictEqual(parseJsonOrSseJson('{"ok":true}'), { ok: true });
assert.strictEqual(parseJsonOrSseJson(''), null);

assert.deepStrictEqual(
  parseJsonOrSseJson(
    [
      'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"hel"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"total_tokens":3}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
  ),
  {
    id: 'chatcmpl_1',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
    ],
    usage: { total_tokens: 3 },
  }
);

assert.deepStrictEqual(
  parseJsonOrSseJson(
    [
      'event: response.output_text.done',
      'data: {"type":"response.output_text.done","text":"answer"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":2,"output_tokens":4,"total_tokens":6}}}',
      '',
    ].join('\n')
  ),
  {
    id: 'resp_1',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
  }
);

assert.deepStrictEqual(parseJsonOrSseJson('event: done\ndata: {"type":"done","ok":true}\n\n'), {
  type: 'done',
  ok: true,
});
assert.strictEqual(parseJsonOrSseJson('data: [DONE]\n\n'), null);
assert.throws(
  () => parseJsonOrSseJson('data: {not-json}\n\n'),
  /SSE response did not contain any valid JSON data payloads/
);

{
  const previousTargetPort = process.env.TARGET_PORT;
  const utils = createHttpUtils({
    log: { error() {} },
    sendJsonError() {},
    CORS_HEADERS: {},
  });

  try {
    process.env.TARGET_PORT = '-1';
    assert.strictEqual(
      utils.upstreamRequestOptions(
        { protocol: 'https:', hostname: 'api.example.test', port: 9443 },
        '/v1/messages',
        {}
      ).port,
      9443
    );

    process.env.TARGET_PORT = '70000';
    assert.strictEqual(
      utils.upstreamRequestOptions(
        { protocol: 'http:', hostname: 'api.example.test', port: 8080 },
        '/v1/messages',
        {}
      ).port,
      8080
    );

    delete process.env.TARGET_PORT;
    assert.strictEqual(
      utils.upstreamRequestOptions(
        { protocol: 'https:', hostname: 'api.example.test', port: '9443' },
        '/v1/messages',
        {}
      ).port,
      9443
    );
  } finally {
    if (previousTargetPort === undefined) delete process.env.TARGET_PORT;
    else process.env.TARGET_PORT = previousTargetPort;
  }
}

console.log('[http-utils.test] ok');
