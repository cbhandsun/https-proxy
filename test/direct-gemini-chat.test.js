'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createClaudeStream } = require('../lib/proxy/stream-claude');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const {
  createGeminiJsonResponseHandlers,
} = require('../lib/proxy/handlers/gemini-json-response-handlers');
const { createChatCompletionCollector } = require('../lib/proxy/forced-stream-collector');
const { finishGeminiClaudeStream } = require('../lib/proxy/handlers/route-gemini-utils');
const { parseClaudeSseEvent, deltaPartialJson } = require('../lib/proxy/sse');
const noop = () => {};
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const deps = {
  ...require('../lib/proxy/tools'),
  fallbackId: (prefix, value) => prefix + '_' + hash(value),
  stableHash: hash,
  stableCreated: () => 7,
  filterClaudeCompatibleBlocks: (parts) => parts,
  isClaudeThinkingBlock: (part) => ['thinking', 'redacted_thinking'].includes(part.type),
  parseClaudeSseEvent,
  deltaPartialJson,
  sampleGeminiToolEvent: noop,
  auditToolCall: noop,
  sampleOutboundSse: noop,
};
const tools = [
  { name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
];
function setup(options = {}) {
  const config = { ...deps, protocolOptions: options };
  const gemini = createGeminiProtocol(config);
  const ai = createOpenAIProtocol(config);
  const stream = createClaudeStream({ ...config, ...gemini });
  return { gemini, ai, stream };
}
const usageMetadata = {
  promptTokenCount: 12,
  candidatesTokenCount: 5,
  thoughtsTokenCount: 2,
  cachedContentTokenCount: 3,
  totalTokenCount: 19,
};
const payload = (parts = [], reason = 'STOP') => ({
  candidates: [{ content: { parts }, ...(reason ? { finishReason: reason } : {}) }],
  usageMetadata,
});
const frame = (value) => 'data: ' + JSON.stringify(value) + '\n\n';
const call = {
  functionCall: { name: 'lookup', args: { q: '中文 😀' } },
  thoughtSignature: 'signature',
};
function run(values, direct = true, options = {}, split = false) {
  const { ai, stream } = setup(options);
  const writes = [];
  const sink = {
    write: (wire) => {
      writes.push(wire);
      return true;
    },
  };
  const chat = { id: 'fixture', created: 7, model: 'client', buffer: '', toolCallIndex: 0 };
  if (direct) {
    const converter = stream.createGeminiChatStream(chat, { tools });
    for (const value of values) {
      const raw = typeof value === 'string' ? value : frame(value);
      for (const part of split ? [...raw] : [raw]) converter.processChunk(sink, part);
    }
    if (!converter.state.failed)
      assert.ok(!writes.join('').includes('"tool_calls"'), 'hold tools until transport end');
    converter.finish(sink);
    return { writes, state: converter.state };
  }
  const bridge = { write: (wire) => ai.processClaudeSseChunkToOpenAI(sink, wire, chat) };
  const state = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    tools,
  };
  stream.writeClaudeSseEvent(bridge, 'message_start', {
    type: 'message_start',
    message: { usage: state.usage },
  });
  for (const value of values) stream.processGeminiSseEvent(bridge, frame(value), state, 'upstream');
  finishGeminiClaudeStream({
    sink: bridge,
    state,
    targetModel: 'upstream',
    processGeminiSseEvent: stream.processGeminiSseEvent,
    flushPendingGeminiToolCall: stream.flushPendingGeminiToolCall,
    writeClaudeSseEvent: stream.writeClaudeSseEvent,
    geminiClaudeStopReason: stream.geminiClaudeStopReason,
  });
  ai.flushClaudeSseToOpenAI(sink, chat);
  return { writes, state };
}
function collect(writes) {
  const collector = createChatCompletionCollector(1024 * 1024);
  for (const wire of writes) collector.push(Buffer.from(wire));
  return collector.finish();
}
for (const parts of [
  [],
  [{ text: '中文 😀 " \\ \n' }],
  [{ text: 'reason', thought: true }, { text: 'answer' }],
  [call],
  [{ text: 'before' }, call],
  [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }],
]) {
  const values = [payload(parts)];
  const direct = run(values);
  assert.deepEqual(collect(direct.writes), collect(run(values, false).writes));
  assert.deepEqual(run(values, true, {}, true).writes, direct.writes);
  const { gemini, ai } = setup();
  const old = ai.claudeResponseToOpenAIChat(
    gemini.geminiResponseToClaude(values[0], 'upstream', tools),
    'client'
  );
  const native = gemini.geminiResponseToChat(values[0], 'upstream', tools, {
    clientModel: 'client',
    stableCreated: deps.stableCreated,
  });
  assert.deepEqual(native, old);
}
for (const value of [
  null,
  {},
  { error: { message: 'SECRET' } },
  payload([], null),
  payload([], 'OTHER'),
  payload([{ functionCall: { name: 'lookup', args: [] } }]),
  payload([{ functionCall: { name: 'lookup', args: { q: 1 }, willContinue: true } }]),
  payload([{ text: 123 }]),
]) {
  const result = run([value]);
  assert.equal(result.state.failed, true);
  assert.ok(!result.writes.join('').includes('[DONE]'));
  assert.ok(!result.writes.join('').includes('SECRET'));
  assert.ok(!result.writes.join('').includes('"tool_calls"'));
  const { gemini } = setup();
  assert.throws(
    () =>
      gemini.geminiResponseToChat(value, 'upstream', tools, { stableCreated: deps.stableCreated }),
    (error) => !error.message.includes('SECRET')
  );
}
for (const reason of ['MAX_TOKENS', 'SAFETY', 'RECITATION']) {
  const { gemini } = setup();
  const value = payload([call], reason);
  const result = collect(run([value]).writes);
  assert.equal(
    result.choices[0].finish_reason,
    reason === 'MAX_TOKENS' ? 'length' : 'content_filter'
  );
  assert.equal(result.choices[0].message.tool_calls, undefined);
  const json = gemini.geminiResponseToChat(value, 'upstream', tools, {
    stableCreated: deps.stableCreated,
  });
  assert.equal(json.choices[0].finish_reason, result.choices[0].finish_reason);
  assert.equal(json.choices[0].message.tool_calls, undefined);
}
for (const [values, options] of [
  [[], {}],
  [['data: {invalid\n\n'], {}],
  [[payload([{ text: 'x'.repeat(2048) }])], { maxConversionStreamBytes: 1024 }],
  [[payload([call])], { maxConversionToolArgumentBytes: 1 }],
])
  assert.equal(run(values, true, options).state.failed, true);
const outputLimited = run([payload([call, call, call])], true, { maxConversionStreamBytes: 850 });
assert.equal(outputLimited.state.failed, true);
assert.ok(!outputLimited.writes.join('').includes('"tool_calls"'));
assert.ok(!outputLimited.writes.join('').includes('[DONE]'));
const poison = createGeminiProtocol({
  ...deps,
  cleanToolArgs: () => {
    throw new Error('SECRET');
  },
});
assert.throws(
  () =>
    poison.geminiResponseToChat(payload([call]), 'upstream', tools, {
      stableCreated: deps.stableCreated,
    }),
  (error) => !error.message.includes('SECRET')
);
const fragmentedTools = [
  payload([{ functionCall: { name: 'lookup', args: { q: 'first' } } }], null),
  payload([{ functionCall: { name: 'lookup', args: { q: 'second' } } }]),
];
assert.deepEqual(collect(run(fragmentedTools).writes), collect(run(fragmentedTools, false).writes));
function route(values, { collapsed = false, slow = false, cancel = false, abort = false } = {}) {
  const { gemini, ai, stream } = setup();
  const writes = [];
  const logs = [];
  let json;
  let callback;
  const client = new EventEmitter();
  client.writeHead = () => {
    assert.equal(collapsed, false);
    client.headersSent = true;
  };
  client.write = (wire) => {
    writes.push(wire);
    return !slow || writes.length !== 1;
  };
  client.end = () => {
    client.writableEnded = true;
    client.emit('finish');
  };
  const ctx = {
    ...deps,
    ...gemini,
    ...ai,
    ...stream,
    http: {
      request: (_options, cb) => {
        callback = cb;
        return { on: noop, end: noop };
      },
    },
    parseProxyBody: () => ({ model: 'client', messages: [], stream: !collapsed }),
    openAIChatToClaudeMessages: () => ({ messages: [], tools }),
    claudeMessagesToGemini: () => ({ contents: [] }),
    rejectUnsupportedOpenAIChatNonOpenAIConversion: () => false,
    geminiGeneratePath: () => '/stream',
    getGeminiCooldown: () => null,
    shouldUseCodeAssistUpstream: () => true,
    codeAssistGenerateRequest: () => ({ target: new URL('http://fixture/stream'), body: {} }),
    unwrapCodeAssistResponse: (value) => value.response,
    codeAssistUserAgent: () => 'fixture',
    upstreamRequestOptions: () => ({}),
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    logRequestEnd: (...args) => logs.push(args),
    logProxyEvent: noop,
    CORS_HEADERS: {},
    maxConversionResponseBytes: 1024 * 1024,
    writeJsonResponse: (_res, status, value) => {
      json = { status, value };
      client.end();
    },
    sendJsonError: (_res, status, value) => {
      json = { status, value };
      client.end();
    },
    processClaudeSseChunkToOpenAI: () => assert.fail('legacy stream bridge selected'),
    geminiResponseToClaude: () => assert.fail('legacy JSON bridge selected'),
  };
  createRouteHandlers(ctx).handleOpenAIChatToGeminiMessages(
    { method: 'POST' },
    client,
    {
      buffer: Buffer.from('{}'),
      rewriteTo: 'upstream',
      profile: {},
      forceUpstreamChatStreaming: collapsed,
    },
    { protocol: 'http:', path: '/v1' },
    '',
    '/chat',
    1
  );
  const upstream = new EventEmitter();
  upstream.statusCode = 200;
  upstream.setEncoding = noop;
  upstream.pause = noop;
  upstream.resume = noop;
  upstream.destroy = noop;
  callback(upstream);
  for (const value of values) {
    upstream.emit('data', Buffer.from(frame({ response: value })));
    if (cancel) client.emit('close');
    if (abort) upstream.emit('aborted');
  }
  upstream.emit('end');
  if (slow) {
    assert.equal(client.writableEnded, undefined);
    assert.equal(logs.length, 0);
    client.emit('drain');
  }
  return { writes, logs, json };
}
const value = payload([{ text: 'answer' }, call]);
assert.equal(route([value]).logs.at(-1)[3], 200);
assert.deepEqual(route([value], { slow: true }).writes, route([value]).writes);
assert.equal(route([value], { cancel: true }).logs.at(-1)[3], 499);
assert.equal(route([value], { abort: true }).logs.at(-1)[3], 502);
const collapsed = route([value], { collapsed: true });
assert.equal(collapsed.json.status, 200);
assert.equal(collapsed.json.value.choices[0].message.content, 'answer');
assert.equal(route([payload([], null)], { collapsed: true }).json.status, 502);
assert.equal(route([{ error: { message: 'SECRET' } }]).logs.at(-1)[3], 502);
const { gemini } = setup();
let jsonResult;
createGeminiJsonResponseHandlers({
  ...gemini,
  stableCreated: deps.stableCreated,
  unwrapCodeAssistResponse: (value) => value.response,
  parseJsonOrSseJson: JSON.parse,
  writeJsonResponse: (_res, status, value) => {
    jsonResult = { status, value };
  },
  logRequestEnd: noop,
  geminiResponseToClaude: () => assert.fail('legacy JSON conversion selected'),
}).handleOpenAIChatToGeminiJson({
  proxyRes: { statusCode: 200 },
  clientReq: { method: 'POST' },
  clientRes: {},
  prepared: {},
  upstreamPath: '/chat',
  startTime: 1,
  responseBody: JSON.stringify({ response: value }),
  targetModel: 'upstream',
  claudeBody: { tools },
  parsed: { model: 'client' },
  geminiBody: {},
});
assert.equal(jsonResult.status, 200);
assert.equal(jsonResult.value.choices[0].message.content, 'answer');
const root = fs.readFileSync(path.join(__dirname, '..', 'openai-proxy.js'), 'utf8');
assert.match(
  root,
  /createProxyHandlers\(\{\s*\.\.\.openAIProtocol,\s*\.\.\.geminiProtocol,[\s\S]*?createGeminiChatStream,/
);
assert.match(root, /const geminiProtocol = createGeminiProtocol\(\{/);
console.log('direct-gemini-chat.test.js passed');
