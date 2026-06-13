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
    message: 'Gemini response conversion failed: bad json',
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
    error: 'bad json',
  },
});

console.log('[route-error-utils.test] ok');
