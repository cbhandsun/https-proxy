const assert = require('assert');
const { createRequestObservability } = require('../lib/proxy/request-observability');
const { withRequest } = require('../lib/proxy/logger');
const { test } = require('node:test');
const { createObservedRequestHandler } = require('../lib/proxy/request-observability');
const { getReqId } = require('../lib/proxy/logger');

test('observed request wrapper preserves lazy dispatch, request correlation and async scope', async () => {
  for (const mode of ['explicit', 'header', 'generated', 'sent', 'headerError']) {
    const req = { headers: { 'x-request-id': mode === 'generated' ? undefined : 'header-id' } };
    if (mode === 'explicit') req.reqId = 'explicit-id';
    const writes = [];
    const res = {
      headersSent: mode === 'sent',
      setHeader(...args) {
        if (mode === 'headerError') throw new Error('Disconnected response');
        writes.push(args);
      },
    };
    const entry = {};
    const wrapped = createObservedRequestHandler(() => handler);
    const handler = async (...args) => {
      assert.deepStrictEqual(args, [req, res, entry]);
      assert.equal(getReqId(), req.reqId);
      await new Promise(setImmediate);
      assert.equal(getReqId(), req.reqId);
      return 'result';
    };
    const before = getReqId();
    assert.equal(await wrapped(req, res, entry), 'result');
    assert.equal(getReqId(), before);
    assert.equal(typeof req.reqId, 'string');
    assert.ok(req.reqId.length > 0);
    if (mode === 'explicit') assert.equal(req.reqId, 'explicit-id');
    else if (mode !== 'generated') assert.equal(req.reqId, 'header-id');
    assert.deepStrictEqual(
      writes,
      ['sent', 'headerError'].includes(mode) ? [] : [['x-request-id', req.reqId]]
    );
  }
  assert.throws(() => createObservedRequestHandler(null), /Invalid observed request handler/);
});

assert.throws(() => createRequestObservability(), /requires getConfig/);

// Regression: route/proxy_error/proxy events used to be written without reqId, which
// broke the documented request_start -> route -> request_end aggregation by reqId.
{
  const written = [];
  const observability = createRequestObservability({
    appendAuditTextBounded: (current) => current,
    captureRequestBody: () => ({ body: '', truncated: false, originalLength: 0 }),
    createClaudeFilters: () => ({
      normalizeClaudeContent: (value) => value,
      isClaudeThinkingBlock: () => false,
      filterClaudeCompatibleBlocks: (value) => value,
    }),
    createDiagnostics: () => ({
      logProxyEvent: (kind, payload) => written.push({ kind, payload }),
    }),
    estimateTokens: () => 0,
    getConfig: () => ({ diagnostics: { enabled: false } }),
    getReqId: require('../lib/proxy/logger').getReqId,
    isClaudeProfile: () => false,
    isGeminiProfile: () => false,
    isQuietLocalPollRequest: () => false,
    parseBoundedInteger: (value, fallback) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback,
    populateAuditDataFromPreparedWithDeps: () => {},
    sanitizeGeminiToolCall: (call) => ({ name: call && call.name, args: call && call.args }),
    protocolOptions: {},
  });

  withRequest({ reqId: 'req-correlation-1' }, () => {
    observability.logProxyEvent('route', { method: 'POST', path: '/v1/responses?x=1' });
    observability.logProxyEvent('proxy_error', {
      method: 'POST',
      path: '/v1/responses',
      error: 'boom',
    });
    observability.logRequestEnd('POST', '/v1/responses', Date.now(), 502, { type: 'openai' });
  });

  assert.strictEqual(written.length, 3);
  for (const entry of written) {
    assert.strictEqual(
      entry.payload.reqId,
      'req-correlation-1',
      entry.kind + ' must carry the request scope reqId'
    );
  }
  assert.strictEqual(written[0].payload.path, '/v1/responses', 'query string must be stripped');

  // An explicit reqId still wins over the ambient scope.
  withRequest({ reqId: 'ambient' }, () => {
    observability.logProxyEvent('route', { reqId: 'explicit', method: 'POST', path: '/x' });
  });
  assert.strictEqual(written[3].payload.reqId, 'explicit');

  // Outside any request scope the event must still be written, without a reqId.
  observability.logProxyEvent('route', { method: 'POST', path: '/x' });
  assert.strictEqual(written[4].payload.reqId, undefined);
}

console.log('[request-observability.test] ok');
