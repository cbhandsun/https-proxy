'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { parseClaudeSseEvent, deltaPartialJson } = require('../lib/proxy/sse');
const { parseResponsesHistory } = require('../lib/proxy/responses-semantic-history');
const noop = () => {};
const deps = {
  ...require('../lib/proxy/tools'),
  parseClaudeSseEvent,
  deltaPartialJson,
  fallbackId: (prefix) => prefix + '_fixture',
  stableCreated: () => 1,
  isClaudeThinkingBlock: (block) => block?.type === 'thinking',
  filterClaudeCompatibleBlocks: (blocks) => blocks,
};
const ai = createOpenAIProtocol(deps);
const frame = (type, data = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
const frames = [
  frame('message_start', { message: { usage: { input_tokens: 12 } } }),
  frame('content_block_start', {
    index: 0,
    content_block: { type: 'compaction', content: null, encrypted_content: null },
  }),
  frame('content_block_delta', {
    index: 0,
    delta: { type: 'compaction_delta', content: 'bounded summary', encrypted_content: 'opaque' },
  }),
  frame('content_block_stop', { index: 0 }),
  frame('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
  frame('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '中文 😀' } }),
  frame('content_block_stop', { index: 1 }),
  frame('content_block_start', {
    index: 2,
    content_block: { type: 'tool_use', id: 'call_exact', name: 'lookup', input: {} },
  }),
  frame('content_block_delta', {
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"q":"value"}' },
  }),
  frame('content_block_stop', { index: 2 }),
  frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }),
  frame('message_stop'),
];
function route(inputFrames, mode = 'normal', interruptAt = 0, sourceOptions = {}) {
  const writes = [],
    reports = [],
    errors = [];
  const protocol = createOpenAIProtocol(deps);
  const state = createResponsesState({
    ...deps,
    ...protocol,
    sendJsonError: (_res, status, body) => errors.push({ status, body }),
    log: { info: noop, warn: noop },
  });
  state.rememberResponsesHistory('previous', {
    version: 2,
    history: parseResponsesHistory('earlier', deps),
  });
  const client = new EventEmitter();
  client.writeHead = () => {
    client.headersSent = true;
  };
  client.getHeader = () => 'text/event-stream';
  client.write = (wire) => {
    writes.push(wire);
    return mode !== 'slow' || writes.length !== 1;
  };
  client.end = () => {
    client.writableEnded = true;
    client.emit('finish');
  };
  client.destroy = () => {
    client.destroyed = true;
    client.emit('close');
  };
  const upstream = new EventEmitter();
  upstream.statusCode = 200;
  upstream.setEncoding = noop;
  upstream.pause = noop;
  upstream.resume = noop;
  upstream.destroy = () => {
    upstream.destroyed = true;
  };
  let callback, sent;
  const ctx = {
    ...deps,
    ...protocol,
    ...state,
    ...createRequestValidators({
      sendJsonError: (_res, status, body) => errors.push({ status, body }),
    }),
    sendJsonError: (_res, status, body) => errors.push({ status, body }),
    parseProxyBody: () => ({
      model: 'client',
      input: 'next',
      previous_response_id: 'previous',
      stream: true,
      ...sourceOptions,
    }),
    responsesToChatWithHistory: () => assert.fail('Chat history selected'),
    openAIChatToClaudeMessages: () => assert.fail('Chat request selected'),
    openAIResponsesToChat: () => assert.fail('Responses Chat request selected'),
    processClaudeSseChunkToOpenAI: () => assert.fail('Chat response selected'),
    http: {
      request: (_options, cb) => {
        callback = cb;
        return {
          on: noop,
          end: (bytes) => {
            sent = JSON.parse(bytes);
          },
        };
      },
    },
    upstreamRequestOptions: () => ({}),
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    logRequestEnd: (...args) => reports.push(args),
    logProxyEvent: noop,
    CORS_HEADERS: {},
  };
  createRouteHandlers(ctx).handleOpenAIResponsesToClaudeMessages(
    { method: 'POST', headers: {} },
    client,
    { rewriteTo: 'claude-sonnet-4-6', buffer: Buffer.from('{}'), profile: {} },
    { protocol: 'http:', path: '/v1' },
    '',
    '/responses',
    1
  );
  assert.ok(sent.messages[0].content.some((block) => block.text.includes('earlier')));
  callback(upstream);
  for (let i = 0; i < inputFrames.length; i++) {
    upstream.emit('data', Buffer.from(inputFrames[i]));
    if (i === interruptAt && mode === 'cancel') client.destroy();
    if (i === interruptAt && mode === 'abort') upstream.emit('aborted');
  }
  upstream.emit('end');
  if (mode === 'slow') {
    assert.equal(client.writableEnded, undefined);
    assert.equal(reports.length, 0);
    client.emit('drain');
  }
  return { writes, reports, errors, state, sent };
}
const normal = route(frames);
assert.equal(normal.reports.length, 1);
assert.equal(normal.reports[0][3], 200, normal.writes.join(''));
assert.equal(normal.errors.length, 0);
const cached = normal.state.responsesHistory.get('resp_fixture');
assert.equal(cached.version, 2);
const compaction = cached.history
  .flatMap((message) => message.parts)
  .find((part) => part.kind === 'provider_context');
assert.deepEqual(compaction, {
  kind: 'provider_context',
  provider: 'anthropic',
  data: { type: 'compaction', content: 'bounded summary', encrypted_content: 'opaque' },
});
assert.ok(!normal.writes.join('').includes('opaque'));
const call = cached.history
  .flatMap((message) => message.parts)
  .find((part) => part.kind === 'call');
assert.equal(call.id, 'call_exact');
assert.deepEqual(call.args, { q: 'value' });
const continuation = normal.state.resolveResponsesHistory(
  {},
  { previous_response_id: 'resp_fixture', input: 'continue' },
  'model'
);
assert.equal(continuation.history.at(-1).parts[0].text, 'continue');
assert.deepEqual(
  ai
    .responsesHistoryToClaude({}, continuation, 'target', {
      nativeContextManagement: true,
    })
    .messages.find((message) => message.content.some((block) => block.type === 'compaction'))
    .content[0],
  { type: 'compaction', content: 'bounded summary', encrypted_content: 'opaque' }
);
const slow = route(frames, 'slow');
assert.deepEqual(slow.writes, normal.writes);
assert.deepEqual(slow.state.responsesHistory.get('resp_fixture'), cached);
for (const mode of ['normal', 'slow', 'cancel', 'abort']) {
  const privateResult = route(frames, mode, 5, { store: false });
  assert.equal(privateResult.state.responsesHistory.has('previous'), true);
  assert.equal(privateResult.state.responsesHistory.has('resp_fixture'), false);
  assert.equal(privateResult.state.responsesSummaries.has('resp_fixture'), false);
  if (mode === 'normal' || mode === 'slow') {
    assert.equal(privateResult.reports[0][3], 200);
    assert.equal(
      privateResult.state.resolveResponsesHistory(
        {},
        { previous_response_id: 'resp_fixture', input: 'continue' },
        'model'
      ),
      null
    );
    assert.equal(privateResult.errors.at(-1).status, 400);
  }
}
for (const [items, mode, status] of [
  [frames, 'cancel', 499],
  [frames, 'abort', 502],
  [[], 'normal', 502],
  [frames.slice(0, -1), 'normal', 502],
  [['event: message_start\ndata: {SECRET\n\n'], 'normal', 502],
]) {
  const result = route(items, mode);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0][3], status);
  assert.equal(result.state.responsesHistory.size, 1);
  assert.equal(result.state.responsesHistory.has('resp_fixture'), false);
  assert.ok(!result.writes.join('').includes('event: response.completed\n'));
  assert.ok(!result.writes.join('').includes('"type":"function_call"'));
  assert.ok(!JSON.stringify(result.reports).includes('SECRET'));
}
for (const mode of ['cancel', 'abort']) {
  for (const interruptAt of [5, 7]) {
    const result = route(frames, mode, interruptAt);
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0][3], mode === 'cancel' ? 499 : 502);
    assert.equal(result.state.responsesHistory.size, 1);
    assert.ok(!result.writes.join('').includes('"type":"function_call"'));
  }
}
