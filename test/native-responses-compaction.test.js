'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isResponsesCompactionPath,
  normalizeNativeResponsesCompactionRequest,
  assertNativeCompactionResponse,
} = require('../lib/proxy/native-responses-compaction');
const { isAllowedEntryPath } = require('../lib/proxy/entry-routing');

const response = () => ({
  id: 'compact',
  object: 'response.compaction',
  created_at: 1,
  output: [
    { type: 'message', role: 'user', content: '完整约束🙂', extension: { preserved: true } },
    { type: 'future_state', unknown: ['opaque', 42] },
    { type: 'compaction', encrypted_content: 'opaque native fixture', extension: true },
  ],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  unknown: { untouched: true },
});
function prepare(
  body,
  options = {},
  profile = { protocol: 'openai', api: 'openai-codex-responses' }
) {
  return normalizeNativeResponsesCompactionRequest(
    { profile, buffer: Buffer.from(JSON.stringify(body)) },
    options
  );
}
const base = { model: 'fixture', input: [{ role: 'user', content: '历史🙂', unknown: 42 }] };

test('standalone paths are exact, POST-only on Responses entry, and distinct from generation', () => {
  for (const path of ['/responses/compact', '/v1/responses/compact', '/v1/responses/compact?x=1']) {
    assert.equal(isResponsesCompactionPath(path), true);
    assert.equal(isAllowedEntryPath({ protocol: 'openai-responses' }, 'POST', path), true);
    for (const method of ['GET', 'DELETE', 'PUT'])
      assert.equal(isAllowedEntryPath({ protocol: 'openai-responses' }, method, path), false);
    for (const protocol of ['claude', 'openai-chat'])
      assert.equal(isAllowedEntryPath({ protocol }, 'POST', path), false);
  }
  for (const path of [
    undefined,
    42,
    '/responses',
    '/responses/compact/',
    '/responses/compact/extra',
    '/responses/compactevil',
  ])
    assert.equal(isResponsesCompactionPath(path), false);
});

test('native request preserves all input/options without injecting generation policies', () => {
  const original = JSON.stringify(base);
  const prepared = prepare({
    ...base,
    instructions: '原始策略',
    prompt_cache_key: 'fixture',
    service_tier: 'priority',
    unknown: { future: true },
  });
  const wire = JSON.parse(prepared.buffer);
  assert.deepEqual(wire.input, base.input);
  assert.equal(wire.instructions, '原始策略');
  assert.equal(wire.service_tier, 'priority');
  assert.deepEqual(wire.unknown, { future: true });
  for (const key of ['stream', 'store', 'context_management'])
    assert.equal(Object.hasOwn(wire, key), false);
  assert.equal(JSON.stringify(base), original);
  assert.equal(prepared.bodyChanged, true);
  const compatibility = JSON.parse(
    prepare({ ...base, stream: false, store: false, previous_response_id: null }).buffer
  );
  assert.deepEqual(compatibility, base);
  assert.equal(JSON.parse(prepare({ model: 'fixture', input: 'text' }).buffer).input, 'text');
});

test('empty, malformed, compressed, excessive and non-native input fails before transport', () => {
  for (const body of [
    null,
    [],
    {},
    { ...base, model: '' },
    { ...base, model: 42 },
    { ...base, model: 'bad\nmodel' },
    { ...base, model: 'x'.repeat(257) },
    { ...base, input: '' },
    { ...base, input: [] },
    { ...base, input: [null] },
    { ...base, input: [1] },
    { ...base, input: {} },
    { ...base, instructions: {} },
    { ...base, stream: true },
    { ...base, stream: 'false' },
    { ...base, store: true },
    { ...base, previous_response_id: 'resp_secret' },
    { ...base, context_management: [] },
    { ...base, conversation: 'conv_secret' },
    { ...base, input: [{ type: 'compaction_trigger' }] },
    {
      ...base,
      input: [{ type: 'compaction', encrypted_content: 'hpm-local-compaction-v1:secret' }],
    },
    {
      ...base,
      input: [{ type: 'compaction', encrypted_content: 'hpm-local-compaction-v2:secret' }],
    },
    {
      ...base,
      input: [{ type: 'compaction', encrypted_content: 'hpm-local-compaction-v99:secret' }],
    },
    {
      ...base,
      input: [{ type: 'compaction', encrypted_content: 'ccswitch-compaction-v1:secret' }],
    },
  ])
    assert.throws(() => prepare(body), { code: 'invalid_request_error' });
  assert.throws(() => prepare(base, { requestEncoding: 'gzip' }), {
    code: 'invalid_request_error',
  });
  assert.throws(() => prepare(base, { maxBytes: 1 }), {
    code: 'native_compaction_too_large',
    statusCode: 413,
  });
  assert.throws(() => prepare(base, { maxBytes: 0 }), { code: 'invalid_request_error' });
  assert.throws(() => prepare(base, { method: 'GET' }), {
    code: 'invalid_request_error',
    statusCode: 405,
  });
  assert.throws(
    () =>
      normalizeNativeResponsesCompactionRequest({
        profile: { api: 'openai-codex-responses' },
        buffer: Buffer.from('{secret'),
      }),
    { code: 'invalid_request_error' }
  );
  for (const profile of [
    { protocol: 'workbuddy' },
    { protocol: 'gemini' },
    { protocol: 'claude' },
    { protocol: 'openai', api: 'openai-chat' },
  ])
    assert.throws(() => prepare(base, {}, profile), {
      code: 'native_compaction_unsupported',
      statusCode: 501,
    });
  assert.throws(
    () =>
      normalizeNativeResponsesCompactionRequest({
        profile: { api: 'openai-codex-responses' },
        authProvider: 'workbuddy',
        buffer: Buffer.from(JSON.stringify(base)),
      }),
    { code: 'native_compaction_unsupported' }
  );
});

test('native canonical response is non-destructive including unknown items/fields', () => {
  const value = response();
  const original = JSON.stringify(value);
  assert.equal(assertNativeCompactionResponse(value), value);
  assert.equal(JSON.stringify(value), original);
  const opaque = { ...base, input: value.output };
  assert.deepEqual(JSON.parse(prepare(opaque).buffer), opaque);
});

test('invalid UTF-8 input and incompatible declared protocols fail closed', () => {
  const buffer = Buffer.from(JSON.stringify(base));
  buffer[buffer.indexOf(Buffer.from('🙂'))] = 255;
  assert.throws(() => prepare(base, { originalBuffer: buffer }), {
    code: 'invalid_request_error',
  });
  assert.throws(() => prepare(base, { originalBuffer: 'not bytes' }), {
    code: 'invalid_request_error',
  });
  assert.throws(() => prepare(base, { originalBuffer: Buffer.alloc(1024), maxBytes: 512 }), {
    code: 'native_compaction_too_large',
    statusCode: 413,
  });
  assert.throws(
    () =>
      normalizeNativeResponsesCompactionRequest({
        profile: { protocol: 'openai', api: 'openai-codex-responses' },
        buffer,
      }),
    { code: 'invalid_request_error' }
  );
  assert.throws(() => prepare(base, {}, { protocol: 'gemini', api: 'openai-responses' }), {
    code: 'native_compaction_unsupported',
  });
});

test('incomplete, ambiguous, foreign/local and unbounded compact output is rejected', () => {
  const valid = response();
  for (const value of [
    null,
    [],
    {},
    { ...valid, id: '' },
    { ...valid, created_at: -1 },
    { ...valid, object: 'response' },
    { ...valid, status: 'incomplete' },
    { ...valid, error: {} },
    { ...valid, output: [] },
    { ...valid, output: [null] },
    { ...valid, output: [valid.output[2], valid.output[2]] },
    { ...valid, output: [{ type: 'compaction', encrypted_content: '' }] },
    { ...valid, output: [{ type: 'compaction', encrypted_content: 1 }] },
    {
      ...valid,
      output: [{ type: 'compaction', encrypted_content: 'hpm-local-compaction-v1:secret' }],
    },
    {
      ...valid,
      output: [{ type: 'compaction', encrypted_content: 'hpm-local-compaction-v2:secret' }],
    },
    {
      ...valid,
      output: [{ type: 'compaction', encrypted_content: 'hpm-local-compaction-v99:secret' }],
    },
    {
      ...valid,
      output: [{ type: 'compaction', encrypted_content: 'ccswitch-compaction-v1:secret' }],
    },
    { ...valid, output: [...valid.output, { type: 'compaction_trigger' }] },
    { ...valid, usage: null },
    { ...valid, usage: { input_tokens: -1, output_tokens: 2, total_tokens: 1 } },
    { ...valid, usage: { input_tokens: 10, output_tokens: Infinity, total_tokens: 12 } },
  ])
    assert.throws(() => assertNativeCompactionResponse(value), {
      code: 'upstream_invalid_compaction',
    });
  assert.throws(() => assertNativeCompactionResponse(valid, 1), {
    code: 'upstream_invalid_compaction',
  });
  let invoked = 0;
  const accessor = {
    ...valid,
    get unknown() {
      invoked++;
      return 'secret';
    },
  };
  assert.throws(() => assertNativeCompactionResponse(accessor), {
    code: 'upstream_invalid_compaction',
  });
  assert.equal(invoked, 0);
  const cyclic = response();
  cyclic.unknown = cyclic;
  assert.throws(() => assertNativeCompactionResponse(cyclic), {
    code: 'upstream_invalid_compaction',
  });
});
