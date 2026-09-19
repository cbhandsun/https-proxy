const assert = require('assert');

const { extractSseDataPayloads } = require('../lib/proxy/sse');
const { createHttpUtils } = require('../lib/proxy/handlers/http-utils');
const {
  terminateClientAfterUpstreamFailure,
  writeSseFailureComment,
} = require('../lib/proxy/handlers/failure-terminal');

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
// Regression: when headers were already sent the error path used to do nothing at
// all, leaving the client connection open forever with no request_end event.
let terminatedAfterHeaders = null;
const streamedRes = {
  headersSent: true,
  writableEnded: false,
  chunks: [],
  getHeader(name) {
    return name === 'content-type' ? 'text/event-stream; charset=utf-8' : undefined;
  },
  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  },
  end() {
    this.writableEnded = true;
    terminatedAfterHeaders = this;
  },
};
requestEndCall = null;
onProxyError(streamedRes, 'OpenAI', {
  method: 'POST',
  path: '/v1/responses',
  upstreamPath: '/v1/responses',
  startTime: 123,
  type: 'openai',
  logProxyEvent() {},
  logRequestEnd(method, path, startTime, statusCode, meta) {
    requestEndCall = { method, path, startTime, statusCode, meta };
  },
})({ code: 'ETIMEDOUT', message: 'socket hang up' });
assert.strictEqual(jsonErrorCall, null, 'must not write a second status line');
assert.ok(terminatedAfterHeaders, 'client connection must be terminated after headers were sent');
assert.ok(
  terminatedAfterHeaders.chunks.join('').includes('socket hang up'),
  'SSE clients need a terminal error event describing the failure'
);
{
  const failureEvent = terminatedAfterHeaders.chunks.join('');
  assert.match(failureEvent, /^event: error\ndata: /);
  const failurePayload = JSON.parse(failureEvent.split('data: ')[1].trim());
  assert.deepStrictEqual(failurePayload, {
    type: 'error',
    code: 'proxy_error',
    message: 'OpenAI proxy error: socket hang up',
    param: null,
  });
}
assert.strictEqual(requestEndCall.statusCode, 502);
assert.strictEqual(requestEndCall.meta.type, 'openai_proxy_error');

// Already-ended responses must not be written to again.
{
  let endCalls = 0;
  const ended = {
    writableEnded: true,
    end() {
      endCalls += 1;
    },
  };
  assert.deepStrictEqual(terminateClientAfterUpstreamFailure(ended), {
    terminated: false,
    reason: 'already_ended',
  });
  assert.strictEqual(endCalls, 0);
  assert.deepStrictEqual(terminateClientAfterUpstreamFailure(null), {
    terminated: false,
    reason: 'no_response',
  });
  assert.strictEqual(
    writeSseFailureComment(
      {
        write() {
          throw new Error('closed');
        },
      },
      {}
    ),
    false
  );
}

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

    // Regression: converted routes hardcoded 600s, so a profile timeoutMs had no
    // effect on them while the main forward path honoured it.
    assert.strictEqual(
      utils.upstreamRequestOptions(
        { protocol: 'https:', hostname: 'api.example.test' },
        '/v1/messages',
        {},
        { profile: { timeoutMs: 300000 } }
      ).timeout,
      300000
    );
    assert.strictEqual(
      utils.upstreamRequestOptions(
        { protocol: 'https:', hostname: 'api.example.test' },
        '/v1/messages',
        {},
        { profile: {} }
      ).timeout,
      120000,
      'profile without timeoutMs must fall back to the documented default'
    );
    assert.strictEqual(
      utils.upstreamRequestOptions(
        { protocol: 'https:', hostname: 'api.example.test' },
        '/v1/messages',
        {}
      ).timeout,
      120000
    );
    // Out-of-range and non-numeric values must be bounded, not passed through.
    assert.strictEqual(
      utils.upstreamRequestOptions(
        { protocol: 'https:', hostname: 'api.example.test' },
        '/v1/messages',
        {},
        { profile: { timeoutMs: 99999999 } }
      ).timeout,
      1800000
    );
    assert.strictEqual(
      utils.upstreamRequestOptions(
        { protocol: 'https:', hostname: 'api.example.test' },
        '/v1/messages',
        {},
        { profile: { timeoutMs: 'not-a-number' } }
      ).timeout,
      120000
    );
  } finally {
    if (previousTargetPort === undefined) delete process.env.TARGET_PORT;
    else process.env.TARGET_PORT = previousTargetPort;
  }
}

console.log('[http-utils.test] ok');
