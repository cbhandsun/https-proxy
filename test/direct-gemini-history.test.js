'use strict';

const assert = require('node:assert/strict');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const tools = require('../lib/proxy/tools');
const { optimizeContextMessages } = require('../lib/proxy/context-optimizer');
const { pruneMessagesToTokenBudget } = require('../lib/proxy/context-budget-manager');
const { createGeminiChatStream } = require('../lib/proxy/gemini-chat-stream');
const noop = () => {};
function setup(protocolOptions = {}) {
  const deps = {
    ...tools,
    ...createClaudeFilters({ protocolOptions: { thinkingPolicy: 'passthrough' } }),
    protocolOptions,
    fallbackId: (prefix) => prefix + '_fixture',
    stableHash: () => 'fixture',
    stableCreated: () => 1,
    sampleGeminiToolEvent: noop,
  };
  return { ai: createOpenAIProtocol(deps), gemini: createGeminiProtocol(deps) };
}
const declarations = ['lookup', 'other'].map((name) => ({
  type: 'function',
  function: { name, parameters: { type: 'object', properties: { q: { type: 'string' } } } },
}));
const call = (id = 'a', name = 'lookup', args = '{"q":"中文 😀"}') => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } };
const audio = { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } };
const video = { type: 'input_video', input_video: { data: 'dmlkZW8=', format: 'mp4' } };
const text = (value) => ({ type: 'text', text: value });
const histories = [
  [{ role: 'user', content: [text('image'), image] }],
  [{ role: 'user', content: [audio, video] }],
  [
    { role: 'assistant', content: [image] },
    { role: 'user', content: 'continue' },
  ],
  [
    { role: 'assistant', tool_calls: [call()] },
    { role: 'tool', tool_call_id: 'a', content: 'done' },
  ],
  [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: 'checking', tool_calls: [call('a'), call('b', 'other')] },
    { role: 'tool', tool_call_id: 'b', content: 'second' },
    { role: 'tool', tool_call_id: 'a', content: [text('first'), image] },
    { role: 'user', content: 'next' },
  ],
  [
    { role: 'assistant', tool_calls: [call('a')] },
    { role: 'assistant', tool_calls: [call('b', 'other')] },
    { role: 'tool', tool_call_id: 'a', content: 'first', is_error: true },
    { role: 'tool', tool_call_id: 'b', content: 'second' },
  ],
  [
    { role: 'assistant', tool_calls: [call('a')] },
    { role: 'tool', tool_call_id: 'a', content: 'one' },
    { role: 'assistant', tool_calls: [call('b', 'other')] },
    { role: 'tool', tool_call_id: 'b', content: 'two', status: 'error' },
  ],
  [{ role: 'tool', tool_call_id: 'orphan', content: 'history' }],
];
let compared = 0;
for (const options of [
  { contextWindowPolicy: 'disabled' },
  { maxContextTokens: 24000 },
  { maxContextTokens: 32000, providerCacheHintsPolicy: 'diagnostics-only' },
]) {
  for (const model of ['gemini-2.5-pro', 'gemini-3.8-flash-tiered', 'gemini-3.1-flash-image']) {
    for (const messages of histories) {
      for (const config of [
        {},
        { tools: declarations },
        { tools: declarations, tool_choice: 'none' },
        {
          tools: declarations,
          __nativeWebSearch: 'gemini-google-search',
          __managedWebSearchHistoryAsText: true,
        },
      ]) {
        for (const outputOptions of [{}, { codeAssist: true, requestedTokens: 50000 }]) {
          const { ai, gemini } = setup(options);
          const body = { messages, ...config };
          const snapshot = JSON.stringify(body);
          const old = ai.openAIChatToClaudeMessages(body, model);
          old.reasoning_effort = body.reasoning_effort;
          old.__responsesToolPreamble = true;
          const baseline = gemini.claudeMessagesToGemini(old, model, outputOptions);
          const direct = gemini.tryOpenAIChatToGemini(body, model, outputOptions, {
            toolPreamble: true,
          });
          const comparable = JSON.parse(JSON.stringify(direct.request));
          for (const turn of comparable.contents)
            for (const part of turn.parts) {
              if (part.functionCall) delete part.functionCall.id;
              if (part.functionResponse) delete part.functionResponse.id;
            }
          assert.deepEqual(comparable, baseline);
          assert.equal(JSON.stringify(body), snapshot);
          compared++;
        }
      }
    }
  }
}
const { gemini } = setup();
const direct = (messages, extra = {}, p = gemini) =>
  p.tryOpenAIChatToGemini({ messages, tools: declarations, ...extra }, 'gemini-3.8-flash').request;
const media = direct([{ role: 'user', content: [image, audio, video] }]);
assert.deepEqual(
  media.contents[0].parts.map((part) => part.inlineData.mimeType),
  ['image/png', 'audio/wav', 'video/mp4']
);
const toolMedia = direct([
  { role: 'assistant', tool_calls: [call()] },
  { role: 'tool', tool_call_id: 'a', content: [text('result'), image, audio, video] },
]);
assert.deepEqual(toolMedia.contents[1].parts[0].functionResponse.response, { content: 'result' });
assert.equal(toolMedia.contents[1].parts.filter((part) => part.inlineData).length, 3);
assert.ok(!JSON.stringify(toolMedia.contents[1].parts[0]).includes('aW1hZ2U='));
const orphan = direct([
  { role: 'tool', tool_call_id: 'orphan', name: 'lookup', content: [text('result'), image] },
]);
assert.match(orphan.contents[0].parts[0].text, /Previous tool result \(lookup\)/);
assert.ok(orphan.contents[0].parts[1].inlineData);
assert.ok(!orphan.contents[0].parts.some((part) => part.functionResponse));
const reason = direct([{ role: 'assistant', reasoning_content: 'reason', content: 'answer' }]);
assert.deepEqual(reason.contents[0].parts[0], { thought: true, text: 'reason' });
assert.equal(reason.contents[0].parts[1].text, 'answer');
gemini.rememberGeminiToolCall('signed', 'lookup', { q: 'original' }, 'real-signature');
const signed = direct([
  { role: 'assistant', tool_calls: [call('signed', 'lookup', '{"q":"other"}')] },
  { role: 'tool', tool_call_id: 'signed', content: 'done' },
]);
assert.equal(signed.contents[0].parts[0].thoughtSignature, 'real-signature');
assert.deepEqual(signed.contents[0].parts[0].functionCall.args, { q: 'original' });
assert.equal(signed.contents[0].parts[0].functionCall.id, 'signed');
assert.equal(signed.contents[1].parts[0].functionResponse.id, 'signed');
const parallel = direct([
  { role: 'assistant', tool_calls: [call('first'), call('second')] },
  { role: 'tool', tool_call_id: 'second', content: 'second result' },
  { role: 'tool', tool_call_id: 'first', content: 'first result' },
]);
assert.deepEqual(
  parallel.contents[0].parts.map((part) => part.functionCall.id),
  ['first', 'second']
);
assert.deepEqual(
  parallel.contents[1].parts.map((part) => part.functionResponse.id),
  ['second', 'first']
);
const manyCalls = Array.from({ length: 128 }, (_, index) => call('many_' + index));
const many = direct([
  { role: 'assistant', tool_calls: manyCalls },
  ...manyCalls
    .toReversed()
    .map((entry) => ({ role: 'tool', tool_call_id: entry.id, content: entry.id })),
]);
assert.equal(many.contents[0].parts.length, 128);
assert.equal(many.contents[1].parts.length, 128);
assert.equal(many.contents[1].parts[0].functionResponse.id, 'many_127');

function assertProviderId(protocol, clientId, providerId) {
  const replay = direct(
    [
      { role: 'assistant', tool_calls: [call(clientId)] },
      { role: 'tool', tool_call_id: clientId, content: 'done' },
    ],
    {},
    protocol
  );
  assert.equal(replay.contents[0].parts[0].functionCall.id, providerId);
  assert.equal(replay.contents[1].parts[0].functionResponse.id, providerId);
  assert.equal(replay.contents[0].parts[0].thoughtSignature, 'provider-signature');
}
for (const streamed of [false, true]) {
  const p = setup().gemini;
  const providerId = streamed ? 'provider/stream:42' : 'provider/json:42';
  const payload = {
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          parts: [
            {
              functionCall: { id: providerId, name: 'lookup', args: { q: 'original' } },
              thoughtSignature: 'provider-signature',
            },
          ],
        },
      },
    ],
  };
  let clientId;
  if (streamed) {
    const wires = [];
    const sink = {
      write: (wire) => {
        wires.push(wire);
        return true;
      },
    };
    const converter = createGeminiChatStream({
      deps: { ...tools, ...p },
      chatState: { id: 'fixture', model: 'fixture', created: 1 },
    });
    converter.processChunk(sink, 'data: ' + JSON.stringify(payload) + '\n\n');
    converter.finish(sink);
    assert.equal(converter.state.finished, true);
    assert.ok(!converter.state.failed);
    const chunks = wires
      .filter((wire) => wire.startsWith('data: {'))
      .map((wire) => JSON.parse(wire.slice(6)));
    clientId = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls || [])[0].id;
  } else clientId = p.geminiResponseToClaude(payload, 'fixture', []).content[0].id;
  assertProviderId(p, clientId, providerId);
  // Updating an existing entry at capacity must retain its provider ID.
  for (let index = 0; index < 499; index++)
    p.rememberGeminiToolCall('fill_' + index, 'lookup', {}, 'fill');
  assertProviderId(p, clientId, providerId);
  assertProviderId(p, clientId, providerId);
}

const invalidHistories = [
  [{ role: 'user', content: [{ type: 'unknown', data: 'private-marker' }] }],
  [
    {
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: 'private-marker', format: 'wav' } }],
    },
  ],
  [
    {
      role: 'user',
      content: [{ type: 'input_video', input_video: { data: 'AA==', format: 'exe' } }],
    },
  ],
  [
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://private-marker' } }],
    },
  ],
  [{ role: 'system', content: [image] }],
  [{ role: 'tool', content: 'private-marker' }],
  [{ role: 'assistant', tool_calls: {} }],
  [{ role: 'user', tool_calls: [call()] }],
  [{ role: 'assistant', tool_calls: [call('a', 'lookup', '{private-marker')] }],
  [{ role: 'assistant', tool_calls: [call('a', 'lookup', '[]')] }],
  [{ role: 'assistant', reasoning_content: {} }],
  [{ role: 'user', reasoning_content: 'private-marker' }],
  [{ role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 42 }] }],
];
for (const messages of invalidHistories)
  assert.throws(
    () => direct(messages),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('private-marker')
  );

// A native request must protect the entire latest parallel exchange under pruning.
const limited = setup({ maxContextTokens: 24000 }).gemini;
const largeHistory = [
  ...Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'old'.repeat(6000),
  })),
  { role: 'user', content: 'latest' },
  { role: 'assistant', tool_calls: [call('a'), call('b', 'other')] },
  { role: 'tool', tool_call_id: 'a', content: 'first' },
  { role: 'tool', tool_call_id: 'b', content: [text('second'), image] },
];
const budgeted = direct(largeHistory, { max_tokens: 4000 }, limited);
assert.ok(budgeted.contents.length < largeHistory.length);
assert.equal(budgeted.contents.at(-2).parts.filter((part) => part.functionCall).length, 2);
assert.equal(budgeted.contents.at(-1).parts.filter((part) => part.functionResponse).length, 2);
assert.equal(budgeted.contents.at(-1).parts.filter((part) => part.inlineData).length, 1);

const nativeExchange = [
  { role: 'user', content: [{ text: 'latest request' }] },
  {
    role: 'assistant',
    content: [{ functionCall: { name: 'lookup', args: {} } }],
    tool_calls: [{ id: 'a' }],
  },
  {
    role: 'user',
    content: [{ functionResponse: { name: 'lookup', response: { content: 'result' } } }],
    tool_result_ids: ['a'],
  },
];
assert.deepEqual(pruneMessagesToTokenBudget(nativeExchange, 1, () => 1).messages, nativeExchange);
const nativeHistory = [
  { role: 'user', content: [{ text: 'old request' }] },
  { role: 'assistant', content: [{ text: 'x'.repeat(5000) }] },
  {
    role: 'user',
    content: [
      { functionResponse: { name: 'lookup', response: { content: 'y'.repeat(5000) } } },
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ],
  },
  {
    role: 'user',
    content: [
      { functionResponse: { name: 'other', response: { error: 'z'.repeat(5000) } } },
      { functionResponse: { name: 'empty', response: { content: '' } } },
      { functionResponse: { name: 'invalid', response: { content: 42 } } },
    ],
  },
  { role: 'user', content: [{ text: 'current request' }] },
];
const nativeSnapshot = JSON.stringify(nativeHistory);
const folded = optimizeContextMessages(nativeHistory, {
  keepRecentTurns: 1,
  maxHistoricalToolChars: 800,
  maxHistoricalMessageChars: 1000,
  foldHistoricalMessages: true,
});
assert.ok(folded.messages[1].content[0].text.length <= 1000);
assert.ok(folded.messages[2].content[0].functionResponse.response.content.length <= 800);
assert.ok(folded.messages[3].content[0].functionResponse.response.error.length <= 800);
assert.deepEqual(folded.messages[2].content[1], nativeHistory[2].content[1]);
assert.deepEqual(folded.messages[3].content.slice(1), nativeHistory[3].content.slice(1));
assert.deepEqual(folded.messages.at(-1), nativeHistory.at(-1));
assert.equal(JSON.stringify(nativeHistory), nativeSnapshot);

// Use real route validators, including invalid input before upstream dispatch.
function runRoute(messages, codeAssist = false) {
  let sent;
  const errors = [];
  const transport = {
    request: () => ({
      on: noop,
      end: (wire) => {
        sent = JSON.parse(wire);
      },
    }),
  };
  const validators = createRequestValidators({
    sendJsonError: (_res, status, error) => errors.push({ status, error }),
  });
  createRouteHandlers({
    ...setup().ai,
    ...gemini,
    ...validators,
    http: transport,
    https: transport,
    parseProxyBody: (_res, body) => JSON.parse(body),
    openAIChatToClaudeMessages: () => assert.fail('Claude request intermediary selected'),
    shouldUseCodeAssistUpstream: () => codeAssist,
    codeAssistGenerateRequest: (_prepared, request) => ({
      target: new URL('http://fixture'),
      body: { request },
    }),
    codeAssistUserAgent: () => 'fixture',
    getGeminiCooldown: () => null,
    onProxyTimeout: () => noop,
    onProxyError: () => noop,
    logRequestEnd: noop,
    logProxyEvent: noop,
  }).handleOpenAIChatToGeminiMessages(
    { method: 'POST', headers: {} },
    { setHeader: noop },
    {
      rewriteTo: '-',
      buffer: Buffer.from(
        JSON.stringify({ model: 'gemini-3.8-flash', messages, tools: declarations })
      ),
      profile: {},
    },
    { protocol: 'http:', path: '/v1' },
    '',
    '/chat/completions',
    1
  );
  return { sent, errors };
}
for (const codeAssist of [false, true]) {
  const valid = runRoute([{ role: 'user', content: [image, audio, video] }], codeAssist);
  assert.deepEqual(valid.errors, []);
  assert.equal((codeAssist ? valid.sent.request : valid.sent).contents[0].parts.length, 3);
  const paired = runRoute(
    [
      { role: 'assistant', tool_calls: [call()] },
      { role: 'tool', tool_call_id: 'a', content: [text('result'), image] },
    ],
    codeAssist
  );
  assert.deepEqual(paired.errors, []);
  assert.equal(
    (codeAssist ? paired.sent.request : paired.sent).contents[1].parts[0].functionResponse.name,
    'lookup'
  );
  for (const messages of invalidHistories) {
    const rejected = runRoute(messages, codeAssist);
    assert.equal(rejected.sent, undefined);
    assert.equal(rejected.errors[0].status, 400);
    assert.equal(rejected.errors[0].error.error.type, 'invalid_request_error');
    assert.ok(!JSON.stringify(rejected.errors).includes('private-marker'));
  }
}
console.log('[direct-gemini-history.test] ok: ' + compared + ' differential cases');
