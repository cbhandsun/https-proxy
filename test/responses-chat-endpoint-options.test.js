'use strict';
const assert = require('node:assert/strict');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');
const noop = () => {};
function route(source) {
  let sent,
    requests = 0;
  const errors = [];
  const sendJsonError = (_res, status, body) => errors.push({ status, body });
  const ai = createOpenAIProtocol({
    ...require('../lib/proxy/tools'),
    fallbackId: () => 'fixture',
  });
  const state = createResponsesState({
    ...ai,
    sendJsonError,
    fallbackId: () => 'fixture',
    log: { info: noop, warn: noop },
  });
  const ctx = {
    ...ai,
    ...state,
    ...createRequestValidators({ sendJsonError }),
    sendJsonError,
    parseProxyBody: () => source,
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
  const before = JSON.stringify(source);
  createOpenAIResponsesToChatHandler(ctx, { proxyErrorContext: () => ({}) })(
    { method: 'POST', headers: {} },
    {},
    { rewriteTo: 'gpt-4o', buffer: Buffer.from('{}'), profile: { protocol: 'openai' } },
    { protocol: 'http:', hostname: 'fixture', path: '/v1' },
    '',
    '/responses',
    1
  );
  assert.equal(JSON.stringify(source), before);
  return { sent, requests, errors };
}
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const format = {
  type: 'json_schema',
  name: 'answer',
  description: 'contract metadata',
  schema,
  strict: true,
};
const mapped = {
  type: 'json_schema',
  json_schema: { name: 'answer', description: 'contract metadata', schema, strict: true },
};
for (const source of [
  { input: 'question', text: { format, verbosity: 'high' } },
  { input: 'question', response_format: mapped },
  { input: 'question', text: { format }, response_format: mapped },
]) {
  const result = route(source);
  assert.equal(result.requests, 1);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.sent.response_format, mapped);
  if (source.text?.verbosity) assert.equal(result.sent.verbosity, 'high');
}
for (const type of ['text', 'json_object']) {
  const result = route({ input: 'question', text: { format: { type } } });
  assert.equal(result.requests, 1);
  assert.deepEqual(result.sent.response_format, type === 'text' ? undefined : { type });
}
for (const source of [
  { text: { format: 'SECRET' } },
  { response_format: { type: 'json_schema', schema } },
  { text: { format }, response_format: { type: 'text' } },
  {
    text: { format },
    response_format: { ...mapped, json_schema: { ...mapped.json_schema, name: 'other' } },
  },
  {
    text: { format },
    response_format: { ...mapped, json_schema: { ...mapped.json_schema, strict: false } },
  },
  { text: { format: { ...format, schema: { type: 'SECRET' } } } },
  { background: true },
  { reasoning: { summary: 'auto' } },
  { text: { verbosity: 'SECRET' } },
  { stream: 'SECRET' },
  { max_output_tokens: -1 },
  { parallel_tool_calls: 'SECRET' },
  { service_tier: 'fast' },
]) {
  const result = route({ input: 'question', ...source });
  assert.equal(result.requests, 0);
  assert.equal(result.errors[0].status, 400);
  assert.ok(!JSON.stringify(result.errors).includes('SECRET'));
}
