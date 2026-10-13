'use strict';
const assert = require('node:assert/strict');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const { rejectContextOverflow } = require('../lib/proxy/context-budget-manager');
const tools = require('../lib/proxy/tools');
const noop = () => {};
function protocol(options = {}, extra = {}) {
  const config = {
    ...tools,
    ...createClaudeFilters({ protocolOptions: { thinkingPolicy: 'drop' } }),
    fallbackId: (prefix, seed) =>
      prefix + '_' + Buffer.from(JSON.stringify(seed)).toString('base64url'),
    protocolOptions: options,
    ...extra,
  };
  return createOpenAIProtocol({ ...config, ...createGeminiProtocol(config) });
}
const ai = protocol();
const declared = [
  {
    name: 'lookup',
    description: 'Find',
    input_schema: { type: 'object', properties: { q: { type: 'string' } } },
  },
];
const call = { type: 'tool_use', id: 'call_fixture', name: 'lookup', input: { q: '中文 😀' } };
const result = {
  type: 'tool_result',
  tool_use_id: 'call_fixture',
  content: [
    { type: 'text', text: 'found' },
    { type: 'text', text: 'more' },
  ],
};
const corpus = [
  [],
  [{ role: 'user', content: '中文 😀' }],
  [{ role: 'user', content: '' }],
  [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    },
  ],
  [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
      ],
    },
  ],
  [
    { role: 'assistant', content: [call] },
    { role: 'user', content: [result] },
  ],
  [
    { role: 'assistant', content: [{ type: 'text', text: 'before' }, call] },
    { role: 'user', content: [result, { type: 'text', text: 'after' }] },
  ],
  [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private', signature: 'signature' },
        { type: 'text', text: 'answer' },
      ],
    },
  ],
  [{ role: 'assistant', content: [{ ...call, id: undefined }] }],
  [{ role: 'assistant', content: [{ ...call, id: 'fc_fixture' }] }],
  [{ role: 'assistant', content: null }],
];
let cases = 0;
for (const messages of corpus)
  for (const system of [
    undefined,
    '',
    [],
    'system',
    [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ],
  ])
    for (const strict of [undefined, false, true])
      for (const choice of [
        undefined,
        { type: 'auto' },
        { type: 'none' },
        { type: 'any' },
        { type: 'tool', name: 'lookup' },
      ])
        for (const codex of [false, true]) {
          const body = {
            messages,
            system,
            tools: declared.map((tool) => ({ ...tool, ...(strict != null ? { strict } : {}) })),
            tool_choice: choice,
            max_tokens: 100,
            ...(codex ? {} : { temperature: 0.7, top_p: 0.9 }),
            thinking: { type: 'enabled', budget_tokens: 4096 },
          };
          const before = JSON.stringify(body);
          assert.deepEqual(
            ai.claudeMessagesToResponsesRequest(body, 'model', { codex }),
            ai.openAIChatToResponsesRequest(ai.claudeMessagesToOpenAIChat(body, 'model'), { codex })
          );
          assert.equal(JSON.stringify(body), before);
          cases++;
        }
const native = ai.claudeMessagesToResponsesRequest(
  {
    messages: [],
    tools: declared,
    service_tier: ' priority ',
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
  },
  'model',
  { codex: false }
);
assert.equal(native.service_tier, 'priority');
assert.equal(native.parallel_tool_calls, false);
assert.equal(native.tool_choice, 'required');
assert.equal(native.tools[0].strict, false);
const failedResult = ai.claudeMessagesToResponsesRequest(
  { messages: [{ role: 'user', content: [{ ...result, is_error: true }] }] },
  'model'
);
assert.equal(failedResult.input[0].status, 'error');
const image = ai.claudeMessagesToResponsesRequest(
  {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }],
      },
    ],
  },
  'model'
);
assert.equal(image.input[0].content[0].image_url, 'https://example.com/image.png');
assert.equal(ai.claudeMessagesToResponsesRequest({}, 'model').input.length, 0);

const invalid = [
  null,
  [],
  { messages: {} },
  { messages: [null] },
  { messages: [{ role: 'system', content: 'SECRET' }] },
  { messages: [{ role: 'user', content: {} }] },
  { messages: [{ role: 'user', content: [null] }] },
  { system: [{ type: 'image', source: {} }] },
  { tools: {} },
  { tools: [null] },
  { tools: [{ name: 'SECRET', input_schema: [] }] },
  { tools: [{ ...declared[0], strict: 'true' }] },
  { tools: [{ ...declared[0], type: 'web_search_20250305' }] },
  { service_tier: 'SECRET\nx' },
  { parallel_tool_calls: 'false' },
  { tool_choice: { type: 'bad' } },
  { tool_choice: { type: 'tool', name: 'SECRET' } },
  { stream: 'true' },
  { stop_sequences: ['SECRET'] },
  { max_tokens: 0 },
  { max_tokens: Number.MAX_SAFE_INTEGER + 1 },
  { temperature: Infinity },
  { top_p: 2 },
  { thinking: { type: 'unknown' } },
  { reasoning_effort: 'bad' },
  { parallel_tool_calls: true, tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
  { tool_choice: { type: 'auto', disable_parallel_tool_use: 'true' } },
];
for (const block of [
  { type: 'document', source: { data: 'SECRET' } },
  { type: 'audio' },
  { type: 'text', text: 5 },
  { type: 'tool_use', name: 'lookup', input: [] },
  { type: 'tool_use', name: '', input: {} },
  { ...call, id: {} },
  { ...result, tool_use_id: {} },
  { ...result, is_error: 'true' },
  { ...result, content: [{ type: 'image', source: { data: 'SECRET' } }] },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'SECRET!' } },
  { type: 'image', source: { type: 'url', url: 'javascript:SECRET' } },
  { type: 'image', source: { type: 'url', url: 'https://example.com/\nSECRET' } },
  { type: 'thinking', thinking: 123 },
])
  invalid.push({
    messages: [{ role: block.type === 'tool_use' ? 'assistant' : 'user', content: [block] }],
  });
for (const body of invalid)
  assert.throws(
    () => ai.claudeMessagesToResponsesRequest(body, 'model', { codex: false }),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
  );
const poison = protocol(
  {},
  {
    cleanToolArgs: () => {
      throw new Error('SECRET');
    },
  }
);
assert.throws(
  () =>
    poison.claudeMessagesToResponsesRequest(
      { messages: [{ role: 'assistant', content: [call] }] },
      'model'
    ),
  (error) => !JSON.stringify(error).includes('SECRET') && !error.message.includes('SECRET')
);

const budgeted = protocol({
  maxContextTokens: 6000,
  outputReserveTokens: 1,
  toolReserveTokens: 1,
  reasoningReserveTokens: 1,
  safetyMarginTokens: 1,
});
const history = [
  { role: 'user', content: 'old'.repeat(12000) },
  { role: 'assistant', content: 'old answer' },
  { role: 'user', content: 'latest task' },
  { role: 'assistant', content: [call, { ...call, id: 'call_second' }] },
  { role: 'user', content: [result, { ...result, tool_use_id: 'call_second' }] },
];
const retained = budgeted.claudeMessagesToResponsesRequest(
  { messages: history, tools: declared },
  'model'
);
assert.ok(retained.__hpmDiagnostics.contextBudget.droppedCount > 0);
assert.equal(retained.input.filter((item) => item.type === 'function_call').length, 2);
assert.equal(retained.input.filter((item) => item.type === 'function_call_output').length, 2);
assert.ok(!JSON.stringify(retained).includes('__hpmDiagnostics'));
const overflow = budgeted.claudeMessagesToResponsesRequest(
  { messages: [{ role: 'user', content: 'latest' }], system: 'fixed'.repeat(12000) },
  'model'
);
assert.ok(overflow.__hpmDiagnostics.contextBudget.overBudgetTokens > 0);
assert.equal(rejectContextOverflow({}, overflow, noop), true);
const reasoningBudget = protocol({ maxContextTokens: 30000 }).claudeMessagesToResponsesRequest(
  { thinking: { type: 'enabled', budget_tokens: 4096 } },
  'model'
);
assert.equal(reasoningBudget.__hpmDiagnostics.contextBudget.reservedTokens, 8192 + 8192 + 4096);

function route(body, path = '/v1', profile = {}, converter = ai) {
  let sent,
    error,
    requests = 0;
  const ctx = {
    ...converter,
    claudeMessagesToOpenAIChat: () => assert.fail('Chat request bridge selected'),
    openAIChatToResponsesRequest: () => assert.fail('Chat Responses mapper selected'),
    parseProxyBody: () => body,
    sendJsonError: (_res, status, value) => {
      error = { status, value };
    },
    http: {
      request: () => {
        requests++;
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
  };
  createRouteHandlers(ctx).handleClaudeMessagesToOpenAIResponses(
    { method: 'POST' },
    {},
    { rewriteTo: 'rewritten', buffer: Buffer.from('{}'), profile },
    { protocol: 'http:', path },
    '',
    '/messages',
    1
  );
  return { sent, error, requests };
}
const generic = route({ messages: [], max_tokens: 64, temperature: 0.2 });
assert.equal(generic.sent.model, 'rewritten');
assert.equal(generic.sent.max_output_tokens, 64);
assert.equal(generic.sent.temperature, 0.2);
for (const routed of [
  route({ messages: [], max_tokens: 64 }, '/backend-api/codex'),
  route({ messages: [], max_tokens: 64 }, '/v1', { api: 'openai-codex-responses' }),
])
  assert.equal(routed.sent.max_output_tokens, 64);
for (const option of [{ temperature: 0.7 }, { top_p: 0.9 }]) {
  const rejected = route({ messages: [], max_tokens: 64, ...option }, '/backend-api/codex');
  assert.equal(rejected.requests, 0);
  assert.equal(rejected.error.status, 400);
}
for (const body of invalid.filter((value) => value && !Array.isArray(value))) {
  const routed = route(body);
  assert.equal(routed.requests, 0);
  assert.equal(routed.error.status, 400);
  assert.ok(!JSON.stringify(routed.error).includes('SECRET'));
}
assert.equal(
  route({ messages: [{ role: 'assistant', content: [call] }] }, '/v1', {}, poison).error.status,
  502
);
assert.equal(
  route({ messages: [], system: 'fixed'.repeat(12000) }, '/v1', {}, budgeted).error.status,
  400
);
process.stdout.write(`[direct-claude-responses-request.test] ok: ${cases} differential cases\n`);
