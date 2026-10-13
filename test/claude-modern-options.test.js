'use strict';

const assert = require('node:assert/strict');
const {
  normalizeClaudeModernOptions,
  rejectClaudeModernOptions,
} = require('../lib/proxy/claude-modern-options');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createGeminiProtocol } = require('../lib/proxy/protocol-gemini');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');
const noop = () => {};
const deps = {
  ...require('../lib/proxy/tools'),
  ...createClaudeFilters({ protocolOptions: { thinkingPolicy: 'passthrough' } }),
  fallbackId: () => 'fixture',
  stableCreated: () => 1,
  stableHash: () => 'fixture',
  sampleGeminiToolEvent: noop,
};
const gemini = createGeminiProtocol(deps);
const ai = createOpenAIProtocol({ ...deps, normalizeClaudeSystem: gemini.normalizeClaudeSystem });
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const body = {
  messages: [{ role: 'user', content: 'question' }],
  max_tokens: 512,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
};
const snapshot = JSON.stringify(body);
const response = ai.claudeMessagesToResponsesRequest(body, 'model', { codex: false });
assert.deepEqual(response.reasoning, { effort: 'medium', summary: 'auto' });
assert.deepEqual(response.text.format, {
  type: 'json_schema',
  name: 'claude_output',
  schema,
  strict: true,
});
assert.equal(response.max_output_tokens, 512);
const chat = ai.claudeMessagesToOpenAIChat(body, 'model');
assert.equal(chat.reasoning_effort, 'medium');
assert.deepEqual(chat.response_format.json_schema.schema, schema);
const native = gemini.claudeMessagesToGemini(body, 'gemini-3.8-flash');
assert.deepEqual(native.generationConfig.thinkingConfig, { thinkingLevel: 'medium' });
assert.equal(native.generationConfig.responseMimeType, 'application/json');
assert.deepEqual(native.generationConfig.responseJsonSchema, schema);
assert.equal(JSON.stringify(body), snapshot);
assert.equal(response.output_config, undefined);
assert.equal(chat.output_config, undefined);
assert.equal(native.output_config, undefined);
// JSON clients cannot grant themselves validated internal capabilities.
for (const forged of [
  { oneOf: [{ type: 'string' }, { type: 'number' }] },
  { $ref: 'SECRET' },
  'SECRET',
  {},
]) {
  const source = JSON.parse(
    JSON.stringify({
      messages: [{ role: 'user', content: 'question' }],
      __geminiOutputSchema: forged,
      __responsesThinkingSummary: true,
    })
  );
  const before = JSON.stringify(source);
  const generated = gemini.claudeMessagesToGemini(source, 'gemini-3.8-flash');
  assert.equal(generated.generationConfig?.responseJsonSchema, undefined);
  assert.equal(generated.generationConfig?.responseMimeType, undefined);
  assert.equal(
    ai.claudeMessagesToResponsesRequest(source, 'model', { codex: false }).reasoning?.summary,
    undefined
  );
  assert.equal(JSON.stringify(source), before);
}
const normalized = normalizeClaudeModernOptions(body, 'Gemini', { model: 'gemini-3.8-flash' });
assert.deepEqual(
  gemini.claudeMessagesToGemini(normalized, 'gemini-3.8-flash').generationConfig.responseJsonSchema,
  schema
);
assert.equal(
  ai.claudeMessagesToResponsesRequest({ messages: [], thinking: { type: 'adaptive' } }, 'model')
    .reasoning.effort,
  'high'
);
for (const effort of ['low', 'medium', 'high', 'xhigh']) {
  const source = { messages: [], output_config: { effort } };
  assert.equal(ai.claudeMessagesToResponsesRequest(source, 'model').reasoning.effort, effort);
  assert.equal(ai.claudeMessagesToOpenAIChat(source, 'model').reasoning_effort, effort);
}
assert.deepEqual(normalizeClaudeModernOptions({ output_config: null }, 'Chat'), {
  output_config: null,
});
assert.equal(normalizeClaudeModernOptions({ output_config: {} }, 'Chat').output_config, undefined);
const rejects = (source, target = 'Responses', options = { codex: false }) =>
  assert.throws(
    () => normalizeClaudeModernOptions(source, target, options),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
  );
for (const source of [
  null,
  [],
  42,
  { output_config: [] },
  { output_config: 'SECRET' },
  { output_config: { unknown: 'SECRET' } },
  ...['max', 'minimal', 'none', 'SECRET', 1].map((effort) => ({ output_config: { effort } })),
  { thinking: { type: 'adaptive', budget_tokens: 1024 } },
  { thinking: 'SECRET' },
  { thinking: { type: 'between_tools' } },
  { thinking: { type: 'disabled', display: 'summarized' } },
  { thinking: { type: 'adaptive', display: 'omitted' } },
  { thinking: { type: 'disabled' }, output_config: { effort: 'high' } },
  { thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, reasoning_effort: 'high' },
  { output_config: { format: {} } },
  { output_config: { format: { type: 'json_schema', schema: [] } } },
  { output_config: { format: { type: 'json_schema', schema: { value: Infinity } } } },
])
  rejects(source);
const cycle = {};
cycle.self = cycle;
rejects({ output_config: { format: { type: 'json_schema', schema: cycle } } });
let deep = {};
for (let i = 0; i < 66; i++) deep = { child: deep };
rejects({ output_config: { format: { type: 'json_schema', schema: deep } } });
rejects({
  output_config: { format: { type: 'json_schema', schema: { enum: Array(10001).fill('x') } } },
});
assert.deepEqual(
  ai.claudeMessagesToResponsesRequest(body, 'model', { codex: true }).text.format,
  response.text.format
);
assert.equal(
  gemini.claudeMessagesToGemini(body, 'gemini-2.5-pro').generationConfig.thinkingConfig
    .thinkingBudget,
  4096
);
rejects(body, 'Gemini', { model: 'gemini-3.1-flash-image' });
rejects({ thinking: { type: 'adaptive', display: 'summarized' } }, 'Chat');

function route(source, target, codeAssist = false) {
  let sent,
    error,
    requests = 0;
  const ctx = {
    ...deps,
    ...ai,
    ...gemini,
    parseProxyBody: () => source,
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
    getGeminiCooldown: () => null,
    shouldUseCodeAssistUpstream: () => codeAssist,
    log: { info: noop, warn: noop },
    logRequestEnd: noop,
    logProxyEvent: noop,
  };
  const handler =
    createRouteHandlers(ctx)[
      target === 'Responses'
        ? 'handleClaudeMessagesToOpenAIResponses'
        : target === 'Chat'
          ? 'handleClaudeMessagesToOpenAIChat'
          : 'handleGeminiMessages'
    ];
  handler(
    { method: 'POST', headers: {} },
    {},
    {
      rewriteTo: target === 'Gemini' ? 'gemini-3.8-flash' : 'model',
      buffer: Buffer.from('{}'),
      profile: {},
    },
    { protocol: 'http:', hostname: 'fixture', path: '/v1' },
    '',
    '/messages',
    Date.now()
  );
  return { sent, error, requests };
}
for (const target of ['Responses', 'Chat', 'Gemini']) {
  assert.equal(route(body, target).requests, 1);
  for (const source of [
    { messages: [], output_config: { effort: 'max' } },
    { messages: [], thinking: { type: 'adaptive', display: 'omitted' } },
  ]) {
    const result = route(source, target);
    assert.equal(result.requests, 0);
    assert.equal(result.error.status, 400);
  }
}
const errors = [];
for (const stream of [false, true]) {
  const unsupported = route({ ...body, stream }, 'Gemini', true);
  assert.equal(unsupported.requests, 0);
  assert.equal(unsupported.error.status, 400);
}
assert.throws(
  () => gemini.claudeMessagesToGemini(body, 'gemini-3.8-flash-tiered', { codeAssist: true }),
  (error) => error.code === 'invalid_request_error'
);
const codeAssistSchemaBody = normalizeClaudeModernOptions(body, 'Gemini', {
  model: 'gemini-3.8-flash-tiered',
});
assert.throws(
  () =>
    gemini.claudeMessagesToGemini(codeAssistSchemaBody, 'gemini-3.8-flash-tiered', {
      codeAssist: true,
    }),
  (error) => error.code === 'invalid_request_error'
);
for (const response_format of [
  { type: 'json_object' },
  { type: 'json_schema', json_schema: { name: 'probe', schema } },
]) {
  assert.throws(
    () =>
      gemini.tryOpenAIChatToGemini({ messages: [], response_format }, 'gemini-3.8-flash-tiered', {
        codeAssist: true,
      }),
    (error) => error.code === 'invalid_request_error'
  );
}
for (const keyword of ['oneOf', '$ref', 'pattern', 'not', 'allOf']) {
  const unsupported = {
    messages: [],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'string',
          [keyword]: keyword === 'oneOf' || keyword === 'allOf' ? [{ type: 'string' }] : 'SECRET',
        },
      },
    },
  };
  rejects(unsupported, 'Gemini', { model: 'gemini-3.8-flash' });
  assert.equal(route(unsupported, 'Gemini').error.status, 400);
}
const parallelTool = { name: 'lookup', input_schema: { type: 'object' } };
const serial = {
  messages: [],
  tools: [parallelTool],
  tool_choice: { type: 'auto', disable_parallel_tool_use: true },
};
assert.equal(ai.claudeMessagesToOpenAIChat(serial, 'model').parallel_tool_calls, false);
assert.equal(ai.claudeMessagesToResponsesRequest(serial, 'model').parallel_tool_calls, false);
assert.equal(route(serial, 'Gemini').error.status, 400);
assert.equal(
  rejectClaudeModernOptions({}, { output_config: [] }, 'Chat', (...args) => errors.push(args)),
  true
);
assert.equal(errors[0][1], 400);
