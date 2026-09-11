'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  UpstreamStreamPayloadError,
  collapseForcedStreamResponse,
  createChatCompletionCollector,
  createResponsesCollector,
} = require('../lib/proxy/forced-stream-collector');

function createClientResponse() {
  return {
    body: '',
    headers: null,
    statusCode: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body || '';
    },
  };
}

function pushSplit(collector, text, splitPoints) {
  let offset = 0;
  for (const point of splitPoints) {
    collector.push(Buffer.from(text.slice(offset, point)));
    offset = point;
  }
  collector.push(Buffer.from(text.slice(offset)));
}

const chat = createChatCompletionCollector(16 * 1024);
const chatSse = [
  'data: {"id":"chat-1","object":"chat.completion.chunk","created":7,"model":"gemini","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  'data: {"id":"chat-1","object":"chat.completion.chunk","created":7,"model":"gemini","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}',
  'data: {"id":"chat-1","object":"chat.completion.chunk","created":7,"model":"gemini","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
  'data: [DONE]',
].join('\r\n\r\n');
pushSplit(chat, chatSse, [1, 9, 73, 181, chatSse.length - 2]);
assert.deepStrictEqual(chat.finish(), {
  id: 'chat-1',
  created: 7,
  model: 'gemini',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '你好' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
});

const tools = createChatCompletionCollector(4096);
tools.push(
  Buffer.from(
    'data: {"id":"chat-tools","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n'
  )
);
assert.deepStrictEqual(tools.finish().choices[0], {
  index: 0,
  message: {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'weather', arguments: '{"city":"Paris"}' },
      },
    ],
  },
  finish_reason: 'tool_calls',
});

const responses = createResponsesCollector(4096);
responses.push(
  Buffer.from(
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1","object":"response","status":"in_progress"}}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","object":"response","status":"completed","output":[]}}\n\n'
  )
);
assert.deepStrictEqual(responses.finish(), {
  id: 'resp-1',
  object: 'response',
  status: 'completed',
  output: [],
});

const malformed = createChatCompletionCollector(1024);
assert.throws(() => malformed.push(Buffer.from('data: {not-json}\n\n')), /invalid JSON/);

const empty = createChatCompletionCollector(1024);
empty.push(Buffer.from('data: [DONE]\n\n'));
assert.throws(() => empty.finish(), /did not contain a chat completion/);

const oversized = createChatCompletionCollector(8);
assert.throws(() => oversized.push(Buffer.from('data: 123456789\n\n')), /exceeds proxy limit/);

const upstreamError = createChatCompletionCollector(1024);
upstreamError.push(Buffer.from('data: {"error":{"message":"failed"}}\n\n'));
assert.throws(
  () => upstreamError.finish(),
  (error) => error instanceof UpstreamStreamPayloadError && error.payload.error.message === 'failed'
);

const proxyRes = new EventEmitter();
proxyRes.destroy = () => {};
const clientRes = createClientResponse();
collapseForcedStreamResponse({
  clientRes,
  headers: {
    'content-type': 'text/event-stream',
    'content-encoding': 'identity',
    'transfer-encoding': 'chunked',
    'x-upstream': 'preserved',
  },
  kind: 'chat',
  maxBytes: 4096,
  proxyRes,
  sendJsonError() {
    assert.fail('valid SSE must not use the error response path');
  },
  statusCode: 200,
});
proxyRes.emit(
  'data',
  Buffer.from(
    'data: {"id":"chat-bridge","model":"gemini","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n'
  )
);
proxyRes.emit('data', Buffer.from('data: [DONE]\n\n'));
proxyRes.emit('end');
assert.strictEqual(clientRes.statusCode, 200);
assert.strictEqual(clientRes.headers['content-type'], 'application/json; charset=utf-8');
assert.strictEqual(clientRes.headers['content-encoding'], undefined);
assert.strictEqual(clientRes.headers['transfer-encoding'], undefined);
assert.strictEqual(clientRes.headers['x-upstream'], 'preserved');
assert.strictEqual(clientRes.headers['content-length'], Buffer.byteLength(clientRes.body));
assert.strictEqual(JSON.parse(clientRes.body).choices[0].message.content, 'Hello');
assert.doesNotMatch(clientRes.body, /data:/);

const failedProxyRes = new EventEmitter();
failedProxyRes.destroy = () => {};
const failedClientRes = createClientResponse();
let capturedError;
collapseForcedStreamResponse({
  clientRes: failedClientRes,
  headers: { 'content-type': 'text/event-stream' },
  kind: 'chat',
  maxBytes: 4096,
  proxyRes: failedProxyRes,
  sendJsonError(_response, statusCode, payload) {
    capturedError = { statusCode, payload };
  },
  statusCode: 429,
});
failedProxyRes.emit('data', Buffer.from('data: {"error":{"message":"rate limited"}}\n\n'));
failedProxyRes.emit('end');
assert.deepStrictEqual(capturedError, {
  statusCode: 429,
  payload: { error: { message: 'rate limited' } },
});

console.log('[forced-stream-collector.test] ok');
