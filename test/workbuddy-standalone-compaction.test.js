'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeWorkBuddyStandaloneCompactionRequest: normalize,
} = require('../lib/proxy/workbuddy-standalone-compaction');
const source = {
  model: 'workbuddy/model',
  input: [{ role: 'user', content: '精确要求🙂', future: { keep: true } }],
};
function prepared(body = source) {
  return {
    authProvider: 'workbuddy',
    profile: { id: 'owner', protocol: 'workbuddy' },
    workbuddyAuth: { accessTokenEncrypted: true },
    buffer: Buffer.from(JSON.stringify(body)),
  };
}
test('valid stateless input is owned and gets one internal trigger with no caller mutation', () => {
  const before = JSON.stringify(source);
  const input = prepared({
    ...source,
    instructions: '保留策略🙂',
    stream: false,
    store: false,
    previous_response_id: null,
  });
  const normalized = normalize(input);
  const body = JSON.parse(normalized.buffer);
  assert.equal(normalized.workbuddyStandaloneCompaction, true);
  assert.equal(normalized.bodyChanged, true);
  assert.deepEqual(body.input, [...source.input, { type: 'compaction_trigger' }]);
  assert.equal(body.instructions, '保留策略🙂');
  assert.equal(body.stream, undefined);
  assert.equal(body.store, undefined);
  assert.equal(body.previous_response_id, undefined);
  assert.equal(JSON.stringify(source), before);
  assert.equal(JSON.parse(input.buffer).stream, false);
  const text = JSON.parse(normalize(prepared({ model: 'm', input: '中文🙂' })).buffer);
  assert.deepEqual(text.input[0], { type: 'message', role: 'user', content: '中文🙂' });
});
test('unsupported controls and stateful requests are not silently downgraded', () => {
  for (const extra of [
    { tools: [] },
    { service_tier: 'priority' },
    { prompt_cache_key: 'PRIVATE' },
    { stream: true },
    { stream: null },
    { store: true },
    { instructions: null },
    { previous_response_id: 'resp_prior' },
    { conversation: 'id' },
    { context_management: [] },
  ])
    assert.throws(
      () => normalize(prepared({ ...source, ...extra })),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.ok(!error.message.includes('PRIVATE'));
        return true;
      }
    );
});
test('empty malformed primitive and extreme inputs fail before routing', () => {
  for (const body of [
    null,
    [],
    {},
    { ...source, model: ' ' },
    { ...source, model: ' m' },
    { ...source, model: 'm\n' },
    { ...source, model: 'm'.repeat(257) },
    { ...source, input: [] },
    { ...source, input: ' ' },
    { ...source, input: [null] },
    { ...source, input: [1] },
    { ...source, input: [[]] },
    { ...source, input: [{ type: 'compaction_trigger' }] },
    { ...source, input: Array.from({ length: 2049 }, () => ({ role: 'user', content: '' })) },
  ])
    assert.throws(() => normalize(prepared(body)), { code: 'invalid_request_error' });
  for (const buffer of [Buffer.from('{'), Buffer.from([0xff]), null])
    assert.throws(() => normalize({ ...prepared(), buffer }), { code: 'invalid_request_error' });
});
test('method, encoding, original UTF-8, credential mechanism and exact byte limits remain enforced', () => {
  const input = prepared();
  assert.throws(() => normalize(input, { method: 'GET' }), { statusCode: 405 });
  assert.throws(() => normalize(input, { requestEncoding: 'gzip' }), { statusCode: 400 });
  assert.throws(() => normalize(input, { originalBuffer: Buffer.from([0xff]) }), {
    statusCode: 400,
  });
  assert.throws(() => normalize(input, { apiKey: 'PRIVATE' }), { statusCode: 501 });
  assert.throws(() => normalize({ ...input, workbuddyAuth: {} }), { statusCode: 501 });
  assert.throws(() => normalize({ ...input, authProvider: 'other', profile: {} }), {
    statusCode: 501,
  });
  for (const maxBytes of [0, -1, Infinity, 0.5])
    assert.throws(() => normalize(input, { maxBytes }), { statusCode: 400 });
  assert.throws(() => normalize(input, { maxBytes: input.buffer.length - 1 }), { statusCode: 413 });
  assert.throws(() => normalize(input, { maxBytes: input.buffer.length }), { statusCode: 413 });
  const result = normalize(input, {
    requestEncoding: 'identity',
    maxBytes: input.buffer.length + 64,
  });
  assert.ok(result.buffer.length <= input.buffer.length + 64);
});
test('local replay items and unknown item fields survive; hostile property names stay inert data', () => {
  const body = JSON.parse(
    '{"model":"m","input":[{"type":"compaction","encrypted_content":"hpm-local-compaction-v1:opaque","__proto__":{"polluted":true}}]}'
  );
  const result = JSON.parse(normalize(prepared(body)).buffer);
  assert.deepEqual(result.input[0], body.input[0]);
  assert.equal({}.polluted, undefined);
  assert.throws(
    () =>
      normalize(
        prepared({ ...source, input: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] })
      ),
    { statusCode: 413 }
  );
});
