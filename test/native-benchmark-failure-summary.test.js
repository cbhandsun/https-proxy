'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  summarizeNativeBenchmarkFailure,
} = require('../scripts/lib/native-benchmark-failure-summary');

test('standard, nested, top-level and scalar errors yield content-free hints', () => {
  for (const payload of [
    { error: { code: 'insufficient_quota', type: 'rate_limit_error', message: 'quota exhausted' } },
    {
      response: {
        error: { code: 'insufficient_quota', type: 'rate_limit_error', message: 'quota exhausted' },
      },
    },
    { code: 'insufficient_quota', type: 'rate_limit_error', message: 'quota exhausted' },
  ]) {
    const result = summarizeNativeBenchmarkFailure(payload);
    assert.equal(result.observationValid, true);
    assert.equal(result.code, 'insufficient_quota');
    assert.equal(result.errorType, 'rate_limit_error');
    assert.deepEqual(result.hints, ['quota']);
  }
  assert.deepEqual(summarizeNativeBenchmarkFailure({ error: 'network connection timeout' }).hints, [
    'network',
  ]);
  const all = summarizeNativeBenchmarkFailure({
    error: {
      message:
        'quota; rate limit; invalid bearer authentication; tool function; unsupported policy permission; context too large token limit; network; internal server overloaded; compaction',
    },
  });
  assert.equal(all.hints.length, 10);
});

test('empty, malformed, extreme, cyclic and accessor errors fail safely without effects', () => {
  let invoked = 0;
  const accessor = {
    get error() {
      invoked++;
      return 'secret';
    },
  };
  const cyclic = {};
  cyclic.self = cyclic;
  for (const input of [
    undefined,
    null,
    [],
    'error',
    1,
    Infinity,
    cyclic,
    accessor,
    { error: 'x'.repeat(256 * 1024) },
  ])
    assert.deepEqual(summarizeNativeBenchmarkFailure(input), { observationValid: false });
  assert.equal(invoked, 0);
  for (const error of [null, [], 5, {}, { message: null }]) {
    const result = summarizeNativeBenchmarkFailure({ error });
    assert.equal(result.observationValid, true);
    assert.equal(result.messagePresent, false);
    assert.deepEqual(result.hints, []);
  }
});

test('unknown codes, types, messages and credential fields never enter diagnostics', () => {
  const secret = 'private-secret-value';
  const result = summarizeNativeBenchmarkFailure({
    error: {
      code: secret,
      type: secret,
      message: secret,
      key: secret,
      cookie: secret,
      headers: { authorization: secret },
    },
  });
  assert.equal(result.code, null);
  assert.equal(result.errorType, null);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.hints, []);
  assert.equal(
    summarizeNativeBenchmarkFailure({ error: { message: 'x'.repeat(16384) + 'network' } }).hints
      .length,
    0
  );
});

test('known server and proxy stream codes remain distinguishable from unknown secrets', () => {
  for (const code of [
    'internal_server_error',
    'upstream_response_failed',
    'upstream_stream_error',
    'upstream_stream_incomplete',
    'upstream_stream_invalid_event',
    'invalid_prompt',
    'server_is_overloaded',
  ])
    assert.equal(summarizeNativeBenchmarkFailure({ error: { code } }).code, code);
  for (const type of [
    'server_error',
    'service_unavailable_error',
    'upstream_response_error',
    'upstream_stream_error',
  ])
    assert.equal(summarizeNativeBenchmarkFailure({ error: { type } }).errorType, type);
  assert.equal(
    summarizeNativeBenchmarkFailure({
      error: { code: 'unknown-server-secret', type: 'unknown-server-secret' },
    }).code,
    null
  );
});
