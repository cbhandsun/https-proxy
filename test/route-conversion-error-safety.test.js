'use strict';
const assert = require('node:assert/strict');
const { sendConversionError } = require('../lib/proxy/handlers/route-error-utils');
for (const err of [
  Object.assign(new Error('SECRET token cookie user content'), { code: 'SECRET' }),
  Object.assign(new Error('SECRET'), { code: 'ECONNRESET' }),
  'SECRET',
  {
    toString() {
      throw new Error('SECRET');
    },
  },
  null,
]) {
  for (const headersSent of [false, true]) {
    const outputs = [],
      logs = [];
    const response = {
      headersSent,
      write: (chunk) => outputs.push(chunk),
      end() {
        this.writableEnded = true;
      },
    };
    sendConversionError({
      clientReq: { method: 'POST' },
      clientRes: response,
      upstreamPath: '/fixture',
      startTime: 1,
      err,
      label: 'Fixture',
      logType: 'fixture_conversion_error',
      sendJsonError: (_res, status, body) => outputs.push({ status, body }),
      logRequestEnd: (...args) => logs.push(args),
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0][3], 502);
    assert.ok(!JSON.stringify({ outputs, logs }).includes('SECRET'));
    if (headersSent) assert.equal(response.writableEnded, true);
    else assert.equal(outputs[0].status, 502);
  }
}
