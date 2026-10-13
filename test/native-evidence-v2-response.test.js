'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeEvidenceV2Response } = require('../scripts/lib/native-evidence-v2-response');
const frame = (v) => 'data: ' + JSON.stringify(v) + '\n\n';
const completed = () => ({
  type: 'response.completed',
  response: {
    status: 'completed',
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  },
});
const fixture = (options = {}) =>
  createNativeEvidenceV2Response({ compact: false, standalone: false, status: 200, ...options });

test('response observer streams split UTF-8, CRLF, comments and coalesced events without leaking text', () => {
  let now = 100;
  const f = fixture({ now: () => now++ });
  const bytes = Buffer.from(
    ': keepalive\r\n\r\n' +
      frame({ type: 'response.output_text.delta', delta: '中文🙂secret' }) +
      frame({ type: 'response.output_item.done', item: { type: 'custom_tool_call' } }) +
      frame(completed()) +
      'data: [DONE]\n\n'
  );
  const split = bytes.indexOf(Buffer.from('🙂')) + 1;
  f.push(bytes.subarray(0, split));
  f.push(bytes.subarray(split));
  const r = f.finish();
  assert.equal(r.responseCompletedEvents, 1);
  assert.equal(r.outputFunctionCallCount, 1);
  assert.equal(r.firstVisibleTextMs, 1);
  assert.equal(r.totalMs, 2);
  assert.deepEqual(r.usage, {
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  });
  assert.equal(JSON.stringify(r).includes('secret'), false);
  assert.throws(() => f.finish());
  assert.throws(() => f.push(Buffer.from('')));
});

test('native checkpoint requires the real item lifecycle and stays memory-only', () => {
  const f = fixture({ compact: true });
  const item = { type: 'compaction', encrypted_content: 'opaque-secret' };
  f.push(Buffer.from(frame({ type: 'response.output_item.done', item }) + frame(completed())));
  assert.equal(f.getCheckpoint(), null);
  const r = f.finish();
  assert.equal(r.validNativeWindow, true);
  assert.equal(f.getCheckpoint().encrypted_content, 'opaque-secret');
  assert.equal(JSON.stringify(r).includes('opaque-secret'), false);
  const duplicate = fixture({ compact: true });
  duplicate.push(
    Buffer.from(
      frame({ type: 'response.output_item.done', item }) + frame(completed()) + frame(completed())
    )
  );
  assert.equal(duplicate.finish().validNativeWindow, false);
  const incomplete = fixture({ compact: true });
  incomplete.push(Buffer.from(frame(completed())));
  assert.equal(incomplete.finish().validNativeWindow, false);
});

test('empty/missing usage and duplicate completion do not invent successful observations', () => {
  assert.equal(fixture().finish().responseCompletedEvents, 0);
  const f = fixture();
  const e = completed();
  delete e.response.usage.input_tokens_details;
  f.push(Buffer.from(frame(e) + frame(e)));
  const r = f.finish();
  assert.equal(r.responseCompletedEvents, 2);
  assert.equal(r.usage.cachedInputTokens, null);
  const invalid = fixture();
  const bad = completed();
  bad.response.usage.input_tokens = -1;
  invalid.push(Buffer.from(frame(bad)));
  assert.equal(invalid.finish().usage, undefined);
});

test('response and error failures expose fixed diagnostics only', () => {
  const f = fixture();
  f.push(Buffer.from(frame({ type: 'response.failed', error: { message: 'secret token' } })));
  const r = f.finish();
  assert.equal(r.responseFailedEvents, 1);
  assert.equal(JSON.stringify(r).includes('secret token'), false);
  for (const bytes of [
    Buffer.from('{"error":{"message":"secret"}}'),
    Buffer.from([255]),
    Buffer.from('{broken'),
  ]) {
    const error = fixture({ status: 400 });
    error.push(bytes);
    assert.equal(JSON.stringify(error.finish()).includes('secret'), false);
  }
  const many = fixture();
  assert.throws(() => many.push(Buffer.from(frame({ type: 'error' }).repeat(65))));
});

test('standalone JSON is diagnostic, not native lifecycle evidence', () => {
  for (const output of [
    [],
    [{ type: 'compaction', encrypted_content: '' }],
    [{ type: 'compaction', encrypted_content: 'opaque' }],
  ]) {
    const f = fixture({ compact: true, standalone: true });
    f.push(Buffer.from(JSON.stringify({ output })));
    const r = f.finish();
    assert.equal(r.validNativeWindow, output[0]?.encrypted_content === 'opaque');
    assert.equal(f.getCheckpoint(), null);
    assert.equal(r.nativeObservation, undefined);
  }
});

test('malformed, unfinished, oversized events/response and accessors fail closed', () => {
  for (const bytes of [
    Buffer.from([255]),
    Buffer.from('data: {bad}\n\n'),
    Buffer.from('data: null\n\n'),
    Buffer.from('data: []\n\n'),
    Buffer.from('x'.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const f = fixture();
    assert.throws(() => f.push(bytes));
    assert.throws(() => f.finish());
  }
  for (const bytes of [Buffer.from([0xf0]), Buffer.from('data: {}')]) {
    const f = fixture();
    f.push(bytes);
    assert.throws(() => f.finish());
  }
  const huge = fixture();
  assert.throws(() => huge.push(Buffer.alloc(16 * 1024 * 1024 + 1)));
  assert.throws(() => fixture().push('not-buffer'));
  let invoked = 0;
  const input = Object.defineProperty({}, 'compact', {
    enumerable: true,
    get() {
      invoked++;
      return true;
    },
  });
  assert.throws(() => createNativeEvidenceV2Response(input));
  assert.equal(invoked, 0);
  for (const input of [
    null,
    [],
    {},
    { compact: 1, standalone: false, status: 200 },
    { compact: false, standalone: false, status: 600 },
    { compact: false, standalone: false, status: 200, now: 1 },
  ])
    assert.throws(() => createNativeEvidenceV2Response(input));
});

test('partial diagnostics preserve fixed parser stages, terminal counts and usage without payloads', () => {
  for (const [bytes, reason] of [
    [Buffer.from([255]), 'invalid_utf8'],
    [Buffer.from('data: {secret}\n\n'), 'invalid_event_json'],
    [Buffer.from('data: {"private":"secret"}\n\n'), 'invalid_event_shape'],
    [Buffer.from('x'.repeat(2 * 1024 * 1024 + 1)), 'event_limit_or_data_invalid'],
    [Buffer.alloc(16 * 1024 * 1024 + 1), 'response_size_limit'],
  ]) {
    const f = fixture();
    f.push(Buffer.from(frame(completed())));
    assert.throws(() => f.push(bytes));
    const r = f.inspect();
    assert.equal(r.observationFailureReason, reason);
    assert.equal(r.responseCompletedEvents, 1);
    assert.ok(r.responseBytes > 0);
    assert.equal(JSON.stringify(r).includes('secret'), false);
    assert.throws(() => f.finish());
  }
  const unfinished = fixture();
  unfinished.push(Buffer.from('data: {}'));
  assert.throws(() => unfinished.finish());
  assert.equal(unfinished.inspect().observationFailureReason, 'unfinished_event');
  const badChunk = fixture();
  assert.throws(() => badChunk.push('secret'));
  assert.equal(badChunk.inspect().observationFailureReason, 'invalid_chunk');
});

test('HTTP 200 plus a completed event cannot hide invalid status/error/response shape', () => {
  for (const response of [
    null,
    [],
    'secret',
    { status: 'failed' },
    { status: 'incomplete' },
    { status: 'completed', error: { message: 'secret' } },
  ]) {
    const f = fixture();
    f.push(Buffer.from(frame({ type: 'response.completed', response })));
    const r = f.finish();
    assert.equal(r.responseCompletedEvents, 1);
    assert.equal(r.responseFailedEvents, 1);
    assert.equal(JSON.stringify(r).includes('secret'), false);
  }
  const many = fixture();
  assert.throws(() =>
    many.push(Buffer.from(frame({ type: 'response.completed', response: null }).repeat(65)))
  );
  assert.equal(many.inspect().observationFailureReason, 'failure_event_limit');
});
