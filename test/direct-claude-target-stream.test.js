'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeStream } = require('../lib/proxy/stream-claude');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const noop = () => {};
function setup(options = {}, extra = {}) {
  const deps = {
    ...require('../lib/proxy/tools'),
    protocolOptions: options,
    fallbackId: (prefix) => prefix + '_fixture',
    stableHash: () => 'fixture',
    sampleOutboundSse: noop,
    auditToolCall: noop,
    sampleGeminiToolEvent: noop,
    ...extra,
  };
  const gemini = createGeminiProtocol(deps);
  const stream = createClaudeStream({ ...deps, ...gemini });
  return { ...createOpenAIProtocol(deps), ...gemini, ...stream };
}
const frame = (value) => 'data: ' + JSON.stringify(value) + '\n\n';
const chat = (delta = {}, finish_reason = null, extra = {}) =>
  frame({ choices: [{ index: 0, delta, finish_reason }], ...extra });
const tool = (argumentsText = '{"q":"中文 😀"}', index = 0) =>
  chat({
    tool_calls: [
      {
        index,
        id: 'call' + index,
        type: 'function',
        function: { name: 'lookup', arguments: argumentsText },
      },
    ],
  });
const gemini = (parts = [], reason = 'STOP') =>
  frame({
    candidates: [{ content: { parts }, ...(reason ? { finishReason: reason } : {}) }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, cachedContentTokenCount: 3 },
  });
const call = { functionCall: { name: 'lookup', args: { q: '中文 😀' } } };
function run(kind, frames, options = {}, split = false, extra = {}) {
  const p = setup(options, extra);
  const writes = [];
  const sink = {
    write: (value) => {
      writes.push(value);
      return true;
    },
  };
  const converter = p[kind === 'chat' ? 'createChatClaudeStream' : 'createGeminiClaudeStream']({
    id: 'msg_fixture',
    model: 'model',
    writeEvent: p.writeClaudeSseEvent,
  });
  converter.start(sink);
  for (const raw of frames) {
    for (const chunk of split ? raw.split('') : [raw]) converter.processChunk(sink, chunk);
  }
  assert.ok(!writes.join('').includes('"type":"tool_use"'), 'tools released before transport end');
  const ok = converter.finish(sink);
  const count = writes.length;
  converter.finish(sink);
  assert.equal(writes.length, count);
  return { writes, ok, state: converter.state };
}
const good = [
  chat({ reasoning_content: 'think' }),
  chat({ content: 'answer 中文 😀' }),
  tool(),
  chat({}, 'tool_calls', {
    usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
  }),
  'data: [DONE]\n\n',
];
for (const [kind, frames] of [
  ['chat', good],
  ['gemini', [gemini([{ thought: true, text: 'think' }, { text: 'answer 中文 😀' }, call])]],
]) {
  const result = run(kind, frames);
  assert.equal(result.ok, true);
  assert.deepEqual(run(kind, frames, {}, true).writes, result.writes);
  const wire = result.writes.join('');
  assert.ok(wire.includes('"stop_reason":"tool_use"'));
  assert.ok(wire.includes('"input_tokens":9'));
  assert.ok(wire.includes('"cache_read_input_tokens":3'));
  assert.equal(result.state.buffer, '');
}
for (const frames of [
  [],
  [tool()],
  [tool(), chat({}, 'length')],
  [tool(), chat({}, 'content_filter')],
  ['data: {"SECRET":broken}\n\n'],
  [frame({ error: { message: 'SECRET' }, choices: [] })],
  [tool('{"q":'), chat({}, 'tool_calls')],
  [tool('[]'), chat({}, 'tool_calls')],
  [chat({}, 'UNKNOWN')],
  ['data: [DONE]\n\n'],
  [chat({ content: {} }), chat({}, 'stop')],
  [chat({ tool_calls: [{ index: -1 }] }), chat({}, 'stop')],
  [
    chat({ tool_calls: [{ index: 1e12, function: { name: 'lookup', arguments: '{}' } }] }),
    chat({}, 'length'),
  ],
  [chat({}, 'stop'), chat({ content: 'SECRET' })],
  [chat({}, 'stop'), 'data: [DONE]\n\n', chat({ content: 'SECRET' })],
]) {
  const result = run('chat', frames);
  const wire = result.writes.join('');
  assert.ok(!wire.includes('"type":"tool_use"'));
  assert.ok(!wire.includes('SECRET'));
  if (frames.includes('data: [DONE]\n\n') && frames.length === 1) assert.equal(result.ok, false);
  if (frames.some((raw) => raw.includes('"length"')))
    assert.ok(wire.includes('"stop_reason":"max_tokens"'));
  else {
    assert.equal(result.ok, false);
    assert.ok(wire.includes('event: error'));
    assert.ok(!wire.includes('message_stop'));
  }
}
for (const frames of [
  [],
  [gemini([call], null)],
  [gemini([call], 'SAFETY')],
  [frame({ error: { message: 'SECRET' } })],
]) {
  const result = run('gemini', frames);
  assert.equal(result.ok, false);
  assert.ok(!result.writes.join('').includes('"type":"tool_use"'));
  assert.ok(!result.writes.join('').includes('SECRET'));
}
const exhausted = run('gemini', [gemini([call], 'MAX_TOKENS')]);
assert.equal(exhausted.ok, true);
assert.ok(!exhausted.writes.join('').includes('"type":"tool_use"'));
for (const options of [
  { maxConversionStreamBytes: 300 },
  { maxConversionToolArgumentBytes: 1 },
  { maxSseBufferChars: 8 },
  { maxConversionToolCalls: 1 },
])
  for (const [kind, frames] of [
    ['chat', [tool(), tool('{}', 1), chat({}, 'tool_calls')]],
    ['gemini', [gemini([call, call])]],
  ]) {
    const result = run(kind, frames, options);
    assert.equal(result.ok, false);
    assert.ok(!result.writes.join('').includes('"type":"tool_use"'));
  }
const poison = run('chat', good, {}, false, {
  cleanToolArgs: () => {
    throw new Error('SECRET');
  },
});
assert.equal(poison.ok, false);
assert.ok(!poison.writes.join('').includes('SECRET'));

function route(
  kind,
  frames,
  { slow = false, cancel = false, abort = false, codeAssist = false } = {}
) {
  const p = setup();
  let callback;
  const writes = [],
    logs = [];
  const converters = [];
  const client = new EventEmitter();
  client.writeHead = noop;
  client.write = (wire) => {
    writes.push(wire);
    return !slow || writes.length !== 1;
  };
  client.end = () => {
    client.writableEnded = true;
    client.emit('finish');
  };
  const ctx = {
    ...p,
    createGeminiClaudeStream: (options) => {
      const converter = p.createGeminiClaudeStream(options);
      converters.push(converter);
      return converter;
    },
    http: {
      request: (_options, cb) => {
        callback = cb;
        return { on: noop, end: noop };
      },
    },
    parseProxyBody: () => ({ model: 'model', stream: true, messages: [] }),
    claudeMessagesToOpenAIChat: () => ({ model: 'model', stream: true, messages: [] }),
    claudeMessagesToGemini: () => ({}),
    shouldUseCodeAssistUpstream: () => codeAssist,
    codeAssistGenerateRequest: () => ({ target: new URL('http://fixture'), body: {} }),
    codeAssistUserAgent: () => 'fixture',
    unwrapCodeAssistResponse: (value) => value.response,
    upstreamRequestOptions: () => ({}),
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    sampleResponseChunk: noop,
    getGeminiCooldown: () => null,
    log: { info: noop, warn: noop },
    logRequestEnd: (...args) => logs.push(args),
    logProxyEvent: noop,
    CORS_HEADERS: {},
    fallbackId: (prefix) => prefix + '_fixture',
    processOpenAISseChunkToClaude: () => assert.fail('legacy Chat adapter selected'),
    processGeminiSseEvent: () => assert.fail('legacy Gemini adapter selected'),
  };
  createRouteHandlers(ctx)[
    kind === 'chat' ? 'handleClaudeMessagesToOpenAIChat' : 'handleGeminiMessages'
  ](
    { method: 'POST' },
    client,
    { rewriteTo: '-', buffer: Buffer.from('{}'), profile: {} },
    { protocol: 'http:', path: '/v1' },
    '',
    '/messages',
    1
  );
  const upstream = new EventEmitter();
  Object.assign(upstream, {
    statusCode: 200,
    setEncoding: noop,
    pause: noop,
    resume: noop,
    destroy: noop,
  });
  callback(upstream);
  for (const raw of frames) {
    upstream.emit('data', Buffer.from(raw));
    if (cancel) client.emit('close');
    if (abort) upstream.emit('aborted');
  }
  upstream.emit('end');
  if (slow) {
    assert.equal(client.writableEnded, undefined);
    assert.equal(logs.length, 0);
    client.emit('drain');
  }
  return { writes, logs, converters };
}
for (const [kind, frames] of [
  ['chat', good],
  ['gemini', [gemini([{ text: 'answer' }, call])]],
]) {
  assert.equal(route(kind, frames).logs.at(-1)[3], 200);
  assert.deepEqual(route(kind, frames, { slow: true }).writes, route(kind, frames).writes);
  assert.equal(route(kind, frames, { cancel: true }).logs.at(-1)[3], 499);
  assert.equal(route(kind, frames, { abort: true }).logs.at(-1)[3], 502);
  const failed = route(kind, []);
  assert.equal(failed.logs.at(-1)[3], 502);
  assert.ok(!failed.writes.join('').includes('message_stop'));
}
assert.equal(
  route('gemini', [frame({ response: JSON.parse(gemini([call]).slice(6)) })], {
    codeAssist: true,
  }).logs.at(-1)[3],
  200
);
const partialStart = gemini(
  [
    {
      functionCall: {
        id: 'partial',
        name: 'lookup',
        willContinue: true,
        partialArgs: [{ jsonPath: '$.q', stringValue: '中文 ', willContinue: true }],
      },
    },
  ],
  null
);
const partialEnd = gemini([
  {
    functionCall: {
      id: 'partial',
      willContinue: false,
      partialArgs: [{ jsonPath: '$.q', stringValue: '😀', willContinue: false }],
    },
  },
]);
assert.equal(route('gemini', [partialStart, partialEnd]).logs.at(-1)[3], 200);
assert.deepEqual(
  route('gemini', [partialStart, partialEnd], { slow: true }).writes,
  route('gemini', [partialStart, partialEnd]).writes
);
assert.equal(route('gemini', [partialStart, partialEnd], { cancel: true }).logs.at(-1)[3], 499);
assert.equal(route('gemini', [partialStart, partialEnd], { abort: true }).logs.at(-1)[3], 502);
assert.equal(
  route('gemini', [partialStart, partialEnd], { cancel: true }).converters[0].state.disposed,
  true
);
assert.equal(
  route('gemini', [partialStart, partialEnd], { abort: true }).converters[0].state.disposed,
  true
);
assert.ok(!route('gemini', [partialStart]).writes.join('').includes('"type":"tool_use"'));
process.stdout.write('[direct-claude-target-stream.test] ok\n');
