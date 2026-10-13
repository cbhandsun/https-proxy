'use strict';
const assert = require('node:assert/strict');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { parseResponsesUpstreamBody } = require('../lib/proxy/responses-upstream-body');
const api = createOpenAIProtocol({ ...require('../lib/proxy/tools'), fallbackId: () => 'fixture' });
const schema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};
for (const codex of [false, true]) {
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    for (const limit of [1, 1024, Number.MAX_SAFE_INTEGER]) {
      const source = { messages: [], [key]: limit };
      const snapshot = JSON.stringify(source);
      assert.equal(api.openAIChatToResponsesRequest(source, { codex }).max_output_tokens, limit);
      assert.equal(JSON.stringify(source), snapshot);
    }
    for (const value of [0, -1, 'sensitive', true, [], {}, 1.5, Infinity])
      assert.throws(
        () => api.openAIChatToResponsesRequest({ messages: [], [key]: value }, { codex }),
        (error) => error.code === 'invalid_request_error' && !error.message.includes('sensitive')
      );
  }
  assert.throws(
    () =>
      api.openAIChatToResponsesRequest(
        { messages: [], max_tokens: 1, max_completion_tokens: 2 },
        { codex }
      ),
    (error) => error.code === 'invalid_request_error'
  );
  assert.equal(
    api.openAIChatToResponsesRequest(
      { messages: [], max_tokens: 1, max_completion_tokens: 1 },
      { codex }
    ).max_output_tokens,
    1
  );
  for (const format of [
    { type: 'text' },
    { type: 'json_object' },
    {
      type: 'json_schema',
      json_schema: { name: 'probe', description: 'metadata', schema, strict: true },
    },
  ]) {
    const source = { messages: [], response_format: format };
    const before = JSON.stringify(source);
    const converted = api.openAIChatToResponsesRequest(source, { codex });
    assert.equal(converted.text.format.type, format.type);
    if (format.json_schema)
      assert.deepEqual(converted.text.format, { type: 'json_schema', ...format.json_schema });
    assert.equal(JSON.stringify(source), before);
  }
  for (const response_format of [
    { type: 'json_schema', json_schema: { name: 'probe', schema: { type: 123 } } },
    [],
    { type: 'json_schema', json_schema: { name: 'probe', schema, strict: 'sensitive' } },
  ])
    assert.throws(
      () => api.openAIChatToResponsesRequest({ messages: [], response_format }, { codex }),
      (error) => error.code === 'invalid_request_error' && !error.message.includes('sensitive')
    );
}
for (const key of ['temperature', 'top_p']) {
  assert.throws(
    () => api.openAIChatToResponsesRequest({ messages: [], [key]: 0.5 }),
    (error) => error.code === 'invalid_request_error'
  );
  assert.equal(
    api.openAIChatToResponsesRequest({ messages: [], [key]: 0.5 }, { codex: false })[key],
    0.5
  );
}
const parseFallback = (text) => JSON.parse(text);
assert.deepEqual(parseResponsesUpstreamBody('{"ok":true}', parseFallback), { ok: true });
const item = {
  id: 'tool',
  type: 'function_call',
  name: 'probe',
  call_id: 'call',
  arguments: '{"ok":true}',
};
const stream =
  ': heartbeat\n\ndata: ' +
  JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) +
  '\n\ndata: ' +
  JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } }) +
  '\n\n';
assert.deepEqual(parseResponsesUpstreamBody(stream, parseFallback).output, [item]);
assert.throws(() => parseResponsesUpstreamBody('data: {bad}\n\n', parseFallback), /invalid JSON/);
assert.throws(
  () => parseResponsesUpstreamBody('data: [DONE]\n\n', parseFallback),
  /terminal response/
);
assert.throws(() => parseResponsesUpstreamBody(stream, parseFallback, { maxBytes: 8 }), /limit/);
assert.throws(
  () =>
    parseResponsesUpstreamBody(
      {
        toString() {
          throw new Error('sensitive');
        },
      },
      parseFallback
    ),
  /body must be text/
);
