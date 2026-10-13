const assert = require('assert');

const { sendConversionError } = require('../lib/proxy/handlers/route-error-utils');

let jsonErrorCall = null;
let logEndCall = null;

sendConversionError({
  clientReq: { method: 'POST' },
  clientRes: { id: 'res' },
  upstreamPath: '/v1/messages',
  startTime: 123,
  err: new Error('bad json'),
  label: 'Gemini response',
  logType: 'gemini_conversion_error',
  sendJsonError(res, statusCode, body) {
    jsonErrorCall = { res, statusCode, body };
  },
  logRequestEnd(method, path, startTime, statusCode, meta) {
    logEndCall = { method, path, startTime, statusCode, meta };
  },
});

assert.strictEqual(jsonErrorCall.res.id, 'res');
assert.strictEqual(jsonErrorCall.statusCode, 502);
assert.deepStrictEqual(jsonErrorCall.body, {
  error: {
    type: 'api_error',
    message: 'Gemini response conversion failed',
  },
});
assert.deepStrictEqual(logEndCall, {
  method: 'POST',
  path: '/v1/messages',
  startTime: 123,
  statusCode: 502,
  meta: {
    type: 'gemini_conversion_error',
    errorType: 'conversion_failed',
    errorCode: null,
  },
});

// Regression: a conversion failure after the response already started must end the
// client stream instead of silently leaving the connection open.
{
  let endCalls = 0;
  let jsonCalls = 0;
  const chunks = [];
  const streamedRes = {
    headersSent: true,
    writableEnded: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      endCalls += 1;
      this.writableEnded = true;
    },
  };
  logEndCall = null;
  sendConversionError({
    clientReq: { method: 'POST' },
    clientRes: streamedRes,
    upstreamPath: '/v1/messages',
    startTime: 123,
    err: new Error('stream broke'),
    label: 'Gemini response',
    logType: 'gemini_conversion_error',
    sendJsonError() {
      jsonCalls += 1;
    },
    logRequestEnd(method, path, startTime, statusCode, meta) {
      logEndCall = { method, path, startTime, statusCode, meta };
    },
  });
  assert.strictEqual(jsonCalls, 0, 'must not attempt a second status line');
  assert.strictEqual(endCalls, 1);
  assert.ok(chunks.join('').includes('Gemini response conversion failed'));
  assert.ok(!chunks.join('').includes('stream broke'));
  assert.strictEqual(logEndCall.statusCode, 502);
  assert.strictEqual(logEndCall.meta.type, 'gemini_conversion_error');
}

// A fixed local failure code remains diagnosable without leaking exception data.
for (const code of ['invalid_context_history', 'PRIVATE_TOKEN_VALUE']) {
  const err = Object.assign(new TypeError('PRIVATE_USER_CONTENT'), { code });
  sendConversionError({
    clientReq: { method: 'POST' },
    clientRes: {},
    upstreamPath: '/v1/responses',
    startTime: 123,
    err,
    label: 'WorkBuddy context preparation',
    logType: 'workbuddy_context_preparation_error',
    sendJsonError(_res, status, payload) {
      jsonErrorCall = { status, payload };
    },
    logRequestEnd(_method, _path, _start, _status, meta) {
      logEndCall = meta;
    },
  });
  assert.equal(logEndCall.errorCode, code === 'invalid_context_history' ? code : null);
  const diagnostics = JSON.stringify({ jsonErrorCall, logEndCall });
  assert.ok(!diagnostics.includes('PRIVATE_USER_CONTENT'));
  assert.ok(!diagnostics.includes('PRIVATE_TOKEN_VALUE'));
}

console.log('[route-error-utils.test] ok');
