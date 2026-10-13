'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { createHttpUtils } = require('../lib/proxy/handlers/http-utils');
function setup(protocolOptions = {}) {
  return createGeminiProtocol({
    ...require('../lib/proxy/tools'),
    protocolOptions,
    fallbackId: (prefix) => prefix + '_fixture',
    stableHash: () => 'fixture',
    sampleGeminiToolEvent: () => {},
  });
}
const protocol = setup();
const tool = { functionCall: { name: 'lookup', args: { q: '中文 😀' } } };
const payload = (parts, finishReason = 'STOP') => ({
  candidates: [{ content: { parts }, finishReason }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
});
const convert = (value, p = protocol) => p.geminiResponseToClaude(value, 'fixture', []);
const result = convert(payload([{ text: 'answer' }, tool]));
assert.equal(result.stop_reason, 'tool_use');
assert.deepEqual(result.content[1].input, { q: '中文 😀' });
assert.equal(convert(payload([])).stop_reason, 'end_turn');
assert.equal(convert(payload([{ text: '' }])).content[0].text, '');
for (const [reason, expected] of [
  ['MAX_TOKENS', 'max_tokens'],
  ...['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].map(
    (reason) => [reason, 'stop_sequence']
  ),
]) {
  const input = payload([{ text: 'partial' }, tool], reason);
  const before = JSON.stringify(input);
  const output = convert(input);
  assert.deepEqual(output.content, [{ type: 'text', text: 'partial' }]);
  assert.equal(output.stop_reason, expected);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(convert(payload([tool], reason)).content, []);
}
const invalid = [
  null,
  [],
  {},
  { candidates: [] },
  { error: { message: 'private-marker' }, ...payload([]) },
  { candidates: [{ content: { parts: [tool] } }] },
  ...['', 'UNKNOWN', 'MALFORMED_FUNCTION_CALL', null, 123].map((reason) => payload([tool], reason)),
  payload([null]),
  payload([{ text: 123 }]),
  payload([{ thought: 'private-marker' }]),
  payload([{ thoughtSignature: 123 }]),
  payload([{ functionCall: { name: 'lookup', args: '{private-marker' } }]),
  payload([{ functionCall: { name: 'lookup', args: [] } }]),
  payload([{ functionCall: { name: 'lookup', willContinue: true, partialArgs: [] } }]),
];
for (const input of invalid)
  assert.throws(
    () => convert(input),
    (error) => error instanceof TypeError && !error.message.includes('private-marker')
  );
for (const [options, input] of [
  [{ maxConversionToolCalls: 1 }, payload([tool, tool])],
  [{ maxConversionToolArgumentBytes: 4 }, payload([tool])],
  [{ maxConversionStreamBytes: 64 }, payload([{ text: 'x'.repeat(200) }])],
])
  assert.throws(() => convert(input, setup(options)), /could not be converted safely/);
assert.equal(
  convert(payload([tool]), setup({ maxConversionToolCalls: 1 })).stop_reason,
  'tool_use'
);

// Exercise production dispatch and its fixed 502 conversion error boundary.
function route(input, codeAssist = false) {
  const noop = () => {};
  let callback;
  const logs = [];
  const client = new EventEmitter();
  client.writeHead = (status) => {
    client.status = status;
  };
  client.end = (body) => {
    client.body = JSON.parse(body);
  };
  const sendJsonError = (res, status, body) => {
    res.status = status;
    res.body = body;
  };
  const log = { info: noop, warn: noop };
  const httpUtils = createHttpUtils({ log, sendJsonError, CORS_HEADERS: {} });
  createRouteHandlers({
    ...protocol,
    ...httpUtils,
    http: {
      request: (_options, cb) => {
        callback = cb;
        return { on: noop, end: noop };
      },
    },
    parseProxyBody: () => ({ model: 'fixture', stream: false, messages: [] }),
    claudeMessagesToGemini: () => ({}),
    shouldUseCodeAssistUpstream: () => codeAssist,
    codeAssistGenerateRequest: () => ({ target: new URL('http://fixture'), body: {} }),
    codeAssistUserAgent: () => 'fixture',
    unwrapCodeAssistResponse: (value) => (codeAssist ? value.response : value),
    collectBoundedResponse: (_upstream, _client, _path, _provider, done) => {
      done(JSON.stringify(codeAssist ? { response: input } : input));
    },
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    getGeminiCooldown: () => null,
    log,
    sendJsonError,
    logRequestEnd: (...args) => logs.push(args),
    logProxyEvent: noop,
    CORS_HEADERS: {},
  }).handleGeminiMessages(
    { method: 'POST', url: '/messages' },
    client,
    { rewriteTo: '-', buffer: Buffer.from('{}'), profile: {} },
    { protocol: 'http:', path: '/v1' },
    '',
    '/messages',
    1
  );
  callback({ statusCode: 200 });
  return { client, logs };
}
for (const codeAssist of [false, true]) {
  const good = route(payload([tool]), codeAssist);
  assert.equal(good.client.status, 200);
  assert.equal(good.client.body.stop_reason, 'tool_use');
  const length = route(payload([{ text: 'partial' }, tool], 'MAX_TOKENS'), codeAssist);
  assert.equal(length.client.status, 200);
  assert.deepEqual(length.client.body.content, [{ type: 'text', text: 'partial' }]);
  for (const input of invalid) {
    const failure = route(input, codeAssist);
    assert.equal(failure.client.status, 502);
    assert.equal(failure.logs.at(-1)[3], 502);
    assert.equal(failure.client.body.error.type, 'api_error');
    assert.ok(!JSON.stringify(failure).includes('private-marker'));
    assert.ok(!JSON.stringify(failure.client.body).includes('tool_use'));
  }
}
console.log('[gemini-claude-json-safety.test] ok');
