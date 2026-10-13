'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { parseClaudeSseEvent } = require('../lib/proxy/sse');
const { createResponsesChatStreamHandler } = require('../lib/proxy/handlers/responses-chat-stream');
const { isCodexResponsesTarget } = require('../lib/proxy/responses-request-options');
const { createSseEventParser } = require('../lib/proxy/sse-buffer');
const {
  createOpenAIChatToResponsesHandler,
} = require('../lib/proxy/handlers/chat-to-responses-handler');
const {
  createConversionStreamBudget,
  conversionFailureCode,
} = require('../lib/proxy/conversion-stream-budget');
const {
  mergeClaudeStreamUsage,
  claudeUsageToOpenAIChatUsage,
} = require('../lib/proxy/protocol-usage-details');

function protocol(protocolOptions = {}) {
  return createOpenAIProtocol({
    fallbackId: (prefix) => prefix + '_test',
    stableCreated: () => 1,
    parseClaudeSseEvent,
    protocolOptions,
  });
}
function harness() {
  const writes = [];
  return {
    writes,
    sink: {
      write: (chunk) => {
        writes.push(String(chunk));
        return true;
      },
    },
    state: {
      id: 'resp_test',
      model: 'synthetic',
      created: 1,
      created_at: 1,
      buffer: '',
      outputIndex: 0,
      toolCalls: [],
      pendingToolCalls: [],
      completedOutputItems: [],
      done: false,
    },
  };
}
const event = (data) => 'data: ' + JSON.stringify(data) + '\n\n';
const tool = (args, finish = null, index = 0) =>
  event({
    choices: [
      {
        delta: {
          tool_calls: [
            { index, id: 'call_' + index, function: { name: 'lookup', arguments: args } },
          ],
        },
        finish_reason: finish,
      },
    ],
  });

// Both conversion directions bound aggregate streams and individual tools.
for (const direction of ['Chat', 'Responses']) {
  const method =
    direction === 'Chat'
      ? 'processOpenAIChatSseChunkToResponses'
      : 'processOpenAIResponsesSseChunkToChat';
  const p = protocol({ maxSseBufferChars: 512, maxConversionToolArgumentBytes: 4 });
  const h = harness();
  const chunk =
    direction === 'Chat'
      ? tool('abc')
      : event({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'abc' });
  assert.doesNotThrow(() => {
    p[method](h.sink, chunk, h.state);
    p[method](h.sink, chunk, h.state);
  });
  assert.equal(h.state.failed, true);
  assert.equal(h.writes.join('').includes('abc'), false, 'failure contains no tool input');
  const aggregate = protocol({ maxConversionStreamBytes: 200 });
  const a = harness();
  const heartbeat = ': ' + 'x'.repeat(75) + '\n\n';
  for (let i = 0; i < 3; i++) aggregate[method](a.sink, heartbeat, a.state);
  assert.equal(a.state.failed, true);
  const oversize = harness();
  assert.doesNotThrow(() => p[method](oversize.sink, 'x'.repeat(513), oversize.state));
  assert.equal(oversize.state.failed, true);
}
{
  const p = protocol({ maxConversionToolCalls: 1 });
  const h = harness();
  p.processOpenAIChatSseChunkToResponses(
    h.sink,
    tool('{}', null, 0) + tool('{}', null, 1),
    h.state
  );
  assert.equal(h.state.failed, true);
}
for (const reason of ['length', 'content_filter']) {
  const p = protocol();
  const h = harness();
  p.processOpenAIChatSseChunkToResponses(
    h.sink,
    tool('{"q":', reason) + 'data: [DONE]\n\n',
    h.state
  );
  assert.equal(h.state.completedOutputItems[0].status, 'incomplete');
  assert.equal(h.state.toolCalls.length, 0);
  assert.equal(h.writes.join('').includes('response.function_call_arguments.done'), false);
  assert.equal(h.writes.join('').includes('event: response.incomplete'), true);
  const json = p.openAIChatToResponses(
    {
      choices: [
        {
          message: {
            tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":' } }],
          },
          finish_reason: reason,
        },
      ],
    },
    'synthetic'
  );
  assert.equal(json.output[0].status, 'incomplete');
  assert.equal(
    p.openAIResponsesToChatResponse(json, 'synthetic').choices[0].message.tool_calls,
    undefined
  );
}
{
  const p = protocol();
  const h = harness();
  p.processOpenAIChatSseChunkToResponses(h.sink, tool('{"q":', 'tool_calls'), h.state);
  assert.equal(h.state.failed, true);
  assert.equal(h.state.toolCalls.length, 0);
}
{
  const p = protocol();
  const h = harness();
  p.processOpenAIChatSseChunkToResponses(
    h.sink,
    tool('{"q":') +
      event({
        choices: [{ delta: { content: 'must not follow failure' }, finish_reason: 'stop' }],
      }),
    h.state
  );
  assert.equal(h.state.failed, true);
  assert.equal(h.writes.join('').includes('must not follow failure'), false);
  const response = p.openAIChatToResponses(
    {
      choices: [
        {
          message: { tool_calls: [{ function: { name: 'lookup', arguments: '{"q":' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
    'synthetic'
  );
  assert.equal(response.status, 'failed');
  assert.equal(response.output[0].status, 'incomplete');
}
for (const reason of ['max_output_tokens', 'content_filter']) {
  const response = { status: 'incomplete', incomplete_details: { reason }, output: [] };
  const p = protocol();
  const h = harness();
  p.processOpenAIResponsesSseChunkToChat(
    h.sink,
    event({ type: 'response.incomplete', response }),
    h.state
  );
  const jsonReason = p.openAIResponsesToChatResponse(response, 'synthetic').choices[0]
    .finish_reason;
  assert.ok(h.writes.join('').includes('"finish_reason":"' + jsonReason + '"'));
}
// Malformed events fail immediately; a later completed event cannot hide corruption.
for (const invalid of ['null', '[]', '{bad']) {
  const p = protocol();
  const h = harness();
  p.processOpenAIResponsesSseChunkToChat(
    h.sink,
    'data: ' +
      invalid +
      '\n\n' +
      event({ type: 'response.completed', response: { status: 'completed' } }),
    h.state
  );
  assert.equal(h.state.failed, true);
  assert.equal(h.writes.join('').includes('"finish_reason":"stop"'), false);
}
{
  const p = protocol();
  const h = harness();
  const e = (type, body) =>
    'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...body }) + '\n\n';
  p.processClaudeSseChunkToOpenAI(
    h.sink,
    e('message_start', {
      message: {
        usage: {
          input_tokens: 1000,
          output_tokens: 0,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
        },
      },
    }) +
      e('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } }) +
      e('message_stop', {}),
    h.state
  );
  assert.equal(h.state.usage.prompt_tokens, 2000);
  assert.equal(h.state.usage.cached_input_tokens, 800);
  assert.equal(h.state.usage.total_tokens, 2120);
  const merged = mergeClaudeStreamUsage(
    { input_tokens: 10 },
    { input_tokens: 'secret', cookie: 'secret', output_tokens: '2' }
  );
  assert.deepEqual(merged, { input_tokens: 10, output_tokens: 2 });
  assert.equal(
    claudeUsageToOpenAIChatUsage({
      input_tokens: 1000,
      cached_input_tokens: 800,
      output_tokens: 120,
    }).prompt_tokens,
    1000,
    'Gemini normalized input is not double-counted'
  );
}
{
  const parse = createSseEventParser(10);
  const state = { buffer: '' };
  const seen = [];
  parse(state, 'data: 1\r', 'Test', (e) => seen.push(e));
  parse(state, '\n\r\ndata: 2\n\ndata: 3\n\n', 'Test', (e) => seen.push(e));
  assert.deepEqual(seen, ['data: 1', 'data: 2', 'data: 3']);
  assert.throws(() => parse(state, 'x'.repeat(11), 'Test', () => {}), /event too large/);
  assert.equal(state.buffer, '');
}
// Boundary failures and client cancellation never escape the data callback.
{
  const p = protocol({ maxSseBufferChars: 20 });
  const res = new EventEmitter();
  const upstream = new EventEmitter();
  let ends = 0;
  let destroyed = 0;
  const logs = [];
  res.writeHead = () => {};
  res.write = () => true;
  res.end = () => {
    ends++;
    res.writableEnded = true;
    res.emit('finish');
  };
  upstream.destroy = () => {
    destroyed++;
    upstream.emit('close');
  };
  const handle = createResponsesChatStreamHandler({
    ...p,
    fallbackId: () => 'id',
    stableCreated: () => 1,
    logRequestEnd: (...args) => logs.push(args),
  });
  handle({
    clientReq: { method: 'POST' },
    clientRes: res,
    proxyRes: upstream,
    parsed: {},
    targetModel: 'synthetic',
    upstreamPath: '/v1/chat/completions',
    startTime: 1,
  });
  assert.doesNotThrow(() => upstream.emit('data', 'x'.repeat(21)));
  upstream.emit('end');
  assert.equal(ends, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][3], 502);
  assert.ok(destroyed >= 1);
}
{
  const p = protocol();
  const source = {
    model: 'synthetic',
    messages: [],
    parallel_tool_calls: false,
    max_completion_tokens: 123,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', strict: true, schema: { type: 'object' } },
    },
  };
  const converted = p.openAIChatToResponsesRequest(source, { codex: false });
  assert.equal(converted.parallel_tool_calls, false);
  assert.equal(converted.max_output_tokens, 123);
  assert.equal(converted.text.format.strict, true);
  assert.equal(p.openAIChatToResponsesRequest(source).text.format.strict, true);
  assert.equal(
    p.openAIChatToResponsesRequest({ ...source, response_format: undefined }).max_output_tokens,
    123
  );
  for (const bad of [-1, 0, Infinity, '12', {}, true])
    assert.throws(() =>
      p.openAIChatToResponsesRequest({ ...source, max_completion_tokens: bad }, { codex: false })
    );
  for (const bad of ['false', 0, {}, []])
    assert.throws(() =>
      p.openAIChatToResponsesRequest({ ...source, parallel_tool_calls: bad }, { codex: false })
    );
  for (const type of ['input_audio', 'input_video', 'unknown'])
    assert.throws(
      () =>
        p.openAIChatToResponsesRequest({
          messages: [{ role: 'user', content: [{ type, data: 'private-content' }] }],
        }),
      (err) => !err.message.includes('private-content')
    );
  const image = p.openAIChatToResponsesRequest({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.test/image.png', detail: 'high' },
          },
        ],
      },
    ],
  });
  assert.equal(image.input[0].content[0].detail, 'high');
  assert.throws(() =>
    p.openAIChatToResponsesRequest({
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: 'javascript:private-content' }] },
      ],
    })
  );
  assert.equal(isCodexResponsesTarget({ api: 'openai-codex-responses' }, {}), true);
  assert.equal(isCodexResponsesTarget({}, { path: '/backend-api/codex' }), true);
  assert.equal(isCodexResponsesTarget({}, { path: '/v1' }), false);
}

// The actual request handler applies the selected endpoint's contract and does
// not send unsupported content, or mistake an internal failure for client input.
for (const codex of [false, true]) {
  let request;
  let sent;
  const errors = [];
  const p = protocol();
  const handle = createOpenAIChatToResponsesHandler(
    {
      http: {
        request: (options) => {
          request = options;
          const req = new EventEmitter();
          req.end = (buffer) => {
            sent = JSON.parse(buffer);
          };
          return req;
        },
      },
      openAIChatToResponsesRequest: p.openAIChatToResponsesRequest,
      parseProxyBody: (_res, buffer) => JSON.parse(buffer),
      sendJsonError: (_res, status, payload) => errors.push({ status, payload }),
      upstreamRequestOptions: (_target, pathname) => ({ pathname }),
      onProxyTimeout: () => () => {},
      onProxyError: () => () => {},
    },
    { proxyErrorContext: () => ({}) }
  );
  const target = {
    protocol: 'http:',
    hostname: codex ? 'chatgpt.com' : 'api.openai.com',
    path: codex ? '/backend-api/codex' : '/v1',
  };
  const body = {
    model: 'synthetic',
    messages: [{ role: 'user', content: 'synthetic' }],
    max_tokens: 123,
    parallel_tool_calls: false,
  };
  const prepared = {
    rewriteTo: '-',
    profile: { protocol: 'openai-responses' },
    buffer: Buffer.from(JSON.stringify(body)),
  };
  handle({ method: 'POST' }, {}, prepared, target, null, '/v1/chat/completions', 1);
  assert.equal(request.pathname, target.path + '/responses');
  assert.equal(sent.parallel_tool_calls, false);
  assert.equal(sent.max_output_tokens, 123);
  assert.equal(
    Object.hasOwn(sent, 'context_management'),
    false,
    'Chat ingress cannot round-trip opaque provider compaction items'
  );
  sent = undefined;
  prepared.buffer = Buffer.from(JSON.stringify({ ...body, context_management: [] }));
  handle({ method: 'POST' }, {}, prepared, target, null, '/v1/chat/completions', 1);
  assert.equal(sent, undefined);
  assert.equal(errors.at(-1).status, 400);
  sent = undefined;
  prepared.buffer = Buffer.from(
    JSON.stringify({
      ...body,
      messages: [{ role: 'user', content: [{ type: 'input_audio', data: 'private-content' }] }],
    })
  );
  handle({ method: 'POST' }, {}, prepared, target, null, '/v1/chat/completions', 1);
  assert.equal(sent, undefined);
  assert.equal(errors[0].status, 400);
  assert.ok(!JSON.stringify(errors).includes('private-content'));
}
{
  const p = protocol();
  for (const messages of [
    {},
    'private-content',
    [null],
    [{ role: 'unknown', content: 'private-content' }],
    [{ role: 'user', content: 42 }],
  ]) {
    assert.throws(
      () => p.openAIChatToResponsesRequest({ messages }),
      (error) =>
        error.code === 'invalid_request_error' && !error.message.includes('private-content')
    );
  }
  assert.throws(
    () =>
      p.openAIResponsesToChatResponse({ status: 'failed', error: { message: 'private-content' } }),
    (error) => !error.message.includes('private-content')
  );
  const inferred = p.openAIChatToResponses(
    {
      choices: [
        {
          message: { tool_calls: [{ function: { arguments: '{"command":"synthetic"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
    'synthetic'
  );
  assert.equal(inferred.output[0].name, 'Bash');
  const malformed = harness();
  p.processOpenAIResponsesSseChunkToChat(
    malformed.sink,
    event({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'lookup', arguments: '{"q":', status: 'completed' },
    }),
    malformed.state
  );
  assert.equal(malformed.state.failed, true);
  assert.equal(malformed.state.failure.code, 'upstream_stream_invalid_tool_arguments');
}
{
  const budget = createConversionStreamBudget({ maxConversionToolArgumentBytes: 4 });
  const entry = { arguments: '' };
  entry.arguments = budget.appendArguments(entry, '中');
  entry.arguments = budget.appendArguments(entry, 'a');
  assert.equal(entry.argumentBytes, 4);
  assert.throws(() => budget.appendArguments(entry, 'b'), /byte limit/);
  assert.throws(() => budget.appendArguments(entry, {}), /string/);
  assert.equal(
    conversionFailureCode({ code: 'private-content' }),
    'upstream_stream_conversion_error'
  );
}
{
  const p = protocol();
  const res = new EventEmitter();
  const upstream = new EventEmitter();
  let destroyed = 0;
  res.writeHead = () => {};
  res.write = () => {
    throw new Error('write after client cancellation');
  };
  res.end = () => {};
  upstream.destroy = () => {
    destroyed++;
    upstream.emit('close');
  };
  const handle = createResponsesChatStreamHandler({
    ...p,
    fallbackId: () => 'id',
    stableCreated: () => 1,
    logRequestEnd: () => {},
  });
  const state = handle({
    clientReq: { method: 'POST' },
    clientRes: res,
    proxyRes: upstream,
    parsed: {},
    targetModel: 'synthetic',
    upstreamPath: '/v1/chat/completions',
    startTime: 1,
  });
  res.destroyed = true;
  res.emit('close');
  assert.equal(state.failed, true);
  assert.equal(state.terminalType, 'client_disconnected');
  assert.equal(destroyed, 1);
  assert.doesNotThrow(() =>
    upstream.emit('data', event({ type: 'response.output_text.delta', delta: 'synthetic' }))
  );
}

console.log('[protocol-conversion-boundaries.test] ok');
