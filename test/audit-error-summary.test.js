'use strict';
const assert = require('node:assert/strict');
const { captureAuditErrorSummary } = require('../lib/proxy/audit-error-summary');
const {
  installConversationAuditResponseCapture,
  createConversationAuditData,
} = require('../lib/proxy/conversation-audit-utils');
const {
  mergeUsage,
  usageFromSsePayload,
  extractUsageFromJsonPayload,
} = require('../lib/proxy/usage-report');
for (const payload of [undefined, null, '', [], {}, { error: 'private-marker' }, { error: [] }])
  assert.equal(captureAuditErrorSummary({}, payload), false);
const data = {};
assert.equal(
  captureAuditErrorSummary(data, {
    error: { type: 'api_error', code: 500, status: 'INTERNAL', message: 'private-marker' },
  }),
  true
);
assert.deepEqual(data, { errorType: 'api_error', errorCode: 500, upstreamErrorStatus: 'INTERNAL' });
const unsafe = {};
captureAuditErrorSummary(unsafe, {
  error: {
    type: 'private-marker',
    code: 'private-marker',
    status: 'private-marker',
    message: 'private-marker',
  },
});
assert.deepEqual(unsafe, { errorType: 'upstream_error' });
const failed = {};
captureAuditErrorSummary(failed, {
  type: 'response.failed',
  response: { error: { code: 'upstream_stream_incomplete' } },
});
assert.equal(failed.errorCode, 'upstream_stream_incomplete');

for (const streaming of [false, true]) {
  const records = [];
  const response = {
    statusCode: 500,
    writeHead(status) {
      this.statusCode = status;
    },
    write() {},
    end() {},
    __auditData: createConversationAuditData({ id: 'failure_test', captureContent: false }),
  };
  installConversationAuditResponseCapture(response, {
    maxCaptureBytes: 4096,
    maxTextChars: 32,
    captureContent: false,
    mergeUsage,
    usageFromSsePayload,
    extractUsageFromJsonPayload,
    redactHeaders: () => ({}),
    estimateUsageForRecord: () => ({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      source: 'estimated',
    }),
    logUsage() {},
    estimateCost: () => ({ known: false }),
    appendAuditRecord: (record) => records.push(record),
    config: {},
    log: { error() {} },
  });
  const payload = {
    error: {
      type: 'api_error',
      code: 500,
      message: 'private-marker',
      authorization: 'private-marker',
    },
  };
  response.writeHead(500, { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' });
  response.end(streaming ? 'data: ' + JSON.stringify(payload) + '\n\n' : JSON.stringify(payload));
  assert.equal(records.length, 1);
  assert.equal(records[0].errorCode, 500);
  assert.equal(records[0].errorType, 'api_error');
  assert.equal(JSON.stringify(records).includes('private-marker'), false);
}
console.log('[audit-error-summary.test] ok');
