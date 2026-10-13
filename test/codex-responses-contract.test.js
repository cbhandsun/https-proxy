'use strict';
const assert = require('node:assert/strict');
const {
  normalizeCodexResponsesRequest: normalize,
  isCodexStreamResponse,
  hasCodexCompactionState,
} = require('../lib/proxy/codex-responses-contract');
const options = { isResponsesRequest: true, target: { path: '/backend-api/codex' } };
const prepare = (body) => ({ profile: {}, buffer: Buffer.from(JSON.stringify(body)) });
for (const input of [
  '',
  'hello',
  [],
  [{ type: 'function_call_output', call_id: 'call', output: 'ok' }],
]) {
  for (const stream of [undefined, null, false, true]) {
    const source = prepare({
      input,
      stream,
      max_output_tokens: 1024,
      text: { format: { type: 'json_object' } },
      store: false,
    });
    const before = source.buffer.toString();
    const result = normalize(source, options);
    const body = JSON.parse(result.buffer);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, '');
    assert.equal(body.max_output_tokens, 1024);
    assert.deepEqual(body.text, { format: { type: 'json_object' } });
    assert.equal(body.store, false);
    assert.deepEqual(
      body.input,
      typeof input === 'string'
        ? [{ role: 'user', content: [{ type: 'input_text', text: input }] }]
        : input
    );
    assert.equal(result.forcedResponseStreaming, stream !== true);
    assert.equal(source.buffer.toString(), before);
    assert.equal(normalize(result, options).forcedResponseStreaming, stream !== true);
    assert.equal(isCodexStreamResponse(result, 200, {}), true);
    assert.equal(isCodexStreamResponse({ ...source, codexStreaming: true }, 200, {}), false);
    for (const status of [199, 300, 400, 503, undefined, '200'])
      assert.equal(isCodexStreamResponse(result, status, {}), false);
    for (const type of ['application/json', 'text/plain', [], {}])
      assert.equal(isCodexStreamResponse(result, 200, { 'content-type': type }), false);
  }
}
const ordinary = prepare({ input: 'ok' });
for (const input of [
  [{ type: 'compaction_trigger' }],
  [{ type: 'compaction', encrypted_content: 'opaque-fixture' }],
]) {
  const result = normalize(prepare({ input }), options);
  assert.equal(hasCodexCompactionState(result), true);
  assert.equal(hasCodexCompactionState({ ...result }), true);
  assert.equal(hasCodexCompactionState(normalize(result, options)), true);
  assert.deepEqual(JSON.parse(result.buffer).input, input);
}
for (const input of ['', [], [{ type: 'message', role: 'user', content: 'compaction_trigger' }]])
  assert.equal(hasCodexCompactionState(normalize(prepare({ input }), options)), false);
assert.equal(hasCodexCompactionState({ codexCompactionState: true }), false);
assert.equal(
  hasCodexCompactionState(
    normalize(prepare({ input: [{ type: 'compaction_trigger' }] }), {
      isResponsesRequest: true,
      target: { path: '/v1' },
    })
  ),
  false
);
assert.equal(normalize(ordinary, { isResponsesRequest: true, target: { path: '/v1' } }), ordinary);
assert.equal(normalize(ordinary, { ...options, isResponsesRequest: false }), ordinary);
assert.equal(
  JSON.parse(
    normalize(
      { ...ordinary, profile: { api: 'openai-codex-responses' } },
      { isResponsesRequest: true }
    ).buffer
  ).stream,
  true
);
for (const body of [
  null,
  [],
  0,
  { input: 1 },
  { input: [null] },
  { input: [[]] },
  { stream: 'true' },
  { instructions: {} },
  { store: true },
  { store: 'false' },
  { context_management: [{ type: 'compaction' }] },
  { max_output_tokens: 0 },
  { max_output_tokens: 1.5 },
  { max_output_tokens: Number.MAX_SAFE_INTEGER + 1 },
]) {
  assert.throws(
    () => normalize(prepare(body), options),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('sensitive')
  );
}
assert.throws(
  () => normalize(prepare({ input: [], context_management: [] }), options),
  (error) =>
    error.code === 'invalid_request_error' &&
    error.param === 'context_management' &&
    !error.message.includes('sensitive')
);
assert.throws(
  () => normalize({ ...ordinary, buffer: Buffer.from('sensitive invalid json') }, options),
  (error) => error.code === 'invalid_request_error' && !error.message.includes('sensitive')
);
for (const requestEncoding of ['gzip', 'br', 'invalid'])
  assert.throws(
    () => normalize(ordinary, { ...options, requestEncoding }),
    (error) => error.code === 'invalid_request_error'
  );
assert.equal(
  JSON.parse(normalize(ordinary, { ...options, requestEncoding: 'identity' }).buffer).stream,
  true
);
assert.equal(JSON.parse(normalize(ordinary, options).buffer).store, false);

for (const previous_response_id of ['', 'resp_sensitive', false, 0, {}, []]) {
  assert.throws(
    () => normalize(prepare({ input: [], previous_response_id }), options),
    (error) =>
      error.code === 'invalid_request_error' &&
      error.param === 'previous_response_id' &&
      !error.message.includes('sensitive')
  );
}
const neutralPrevious = normalize(prepare({ input: [], previous_response_id: null }), options);
assert.equal(Object.hasOwn(JSON.parse(neutralPrevious.buffer), 'previous_response_id'), false);
const publicHistory = prepare({ input: [], previous_response_id: 'resp_public' });
assert.equal(
  normalize(publicHistory, { isResponsesRequest: true, target: { path: '/v1' } }),
  publicHistory
);
