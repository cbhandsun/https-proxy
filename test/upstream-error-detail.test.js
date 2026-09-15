const assert = require('assert');

const {
  DEFAULT_MAX_ERROR_BODY_CHARS,
  boundedErrorBody,
  upstreamErrorDetail,
} = require('../lib/proxy/handlers/upstream-error-detail');

// Structured upstream errors must surface message/status/code so a recurring 400 can
// be diagnosed from the event log instead of by guessing at a time window.
assert.deepStrictEqual(
  upstreamErrorDetail(
    JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
      },
    })
  ),
  {
    upstreamErrorBody:
      '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
    upstreamErrorBodyTruncated: false,
    upstreamErrorBodyLength: 110,
    upstreamErrorMessage: 'API key not valid. Please pass a valid API key.',
    upstreamErrorStatus: 'INVALID_ARGUMENT',
  }
);

// Flat shapes and type/code-only errors are common across providers.
{
  const body = '{"error":{"type":"rate_limit_error"}}';
  assert.deepStrictEqual(upstreamErrorDetail(body), {
    upstreamErrorBody: body,
    upstreamErrorBodyTruncated: false,
    upstreamErrorBodyLength: body.length,
    upstreamErrorCode: 'rate_limit_error',
  });
}
{
  const body = '{"message":"plain top-level"}';
  assert.deepStrictEqual(upstreamErrorDetail(body), {
    upstreamErrorBody: body,
    upstreamErrorBodyTruncated: false,
    upstreamErrorBodyLength: body.length,
    upstreamErrorMessage: 'plain top-level',
  });
}

// Boundary paths: empty, non-JSON HTML, oversized, and malformed input.
assert.deepStrictEqual(upstreamErrorDetail(''), {
  upstreamErrorBody: '',
  upstreamErrorBodyTruncated: false,
  upstreamErrorBodyLength: 0,
});
assert.deepStrictEqual(upstreamErrorDetail(null), {
  upstreamErrorBody: '',
  upstreamErrorBodyTruncated: false,
  upstreamErrorBodyLength: 0,
});
assert.deepStrictEqual(upstreamErrorDetail(undefined), {
  upstreamErrorBody: '',
  upstreamErrorBodyTruncated: false,
  upstreamErrorBodyLength: 0,
});
assert.deepStrictEqual(upstreamErrorDetail({ not: 'a string' }), {
  upstreamErrorBody: '',
  upstreamErrorBodyTruncated: false,
  upstreamErrorBodyLength: 0,
});
assert.deepStrictEqual(upstreamErrorDetail('<html>502 Bad Gateway</html>'), {
  upstreamErrorBody: '<html>502 Bad Gateway</html>',
  upstreamErrorBodyTruncated: false,
  upstreamErrorBodyLength: 28,
});

const oversized = upstreamErrorDetail('{'.repeat(DEFAULT_MAX_ERROR_BODY_CHARS + 500));
assert.strictEqual(oversized.upstreamErrorBodyTruncated, true);
assert.strictEqual(oversized.upstreamErrorBodyLength, DEFAULT_MAX_ERROR_BODY_CHARS + 500);
assert.ok(oversized.upstreamErrorBody.endsWith('...[truncated]'));
assert.strictEqual(
  oversized.upstreamErrorMessage,
  undefined,
  'invalid JSON must not fabricate fields'
);

// custom maxChars still bounds correctly
assert.strictEqual(boundedErrorBody('abcdef', 3).text, 'abc...[truncated]');
assert.strictEqual(boundedErrorBody('abc', 3).truncated, false);
assert.strictEqual(boundedErrorBody('abc', 0).text, 'abc', 'invalid limit falls back to default');
assert.strictEqual(boundedErrorBody('abc', -5).text, 'abc');

// Secrets inside an upstream error body must not reach the log verbatim.
const redacted = upstreamErrorDetail('Authorization: Bearer sk-super-secret-value');
assert.ok(!redacted.upstreamErrorBody.includes('sk-super-secret-value'));
assert.ok(redacted.upstreamErrorBody.includes('[redacted]'));

console.log('[upstream-error-detail.test] ok');
