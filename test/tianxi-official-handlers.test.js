'use strict';

const assert = require('node:assert/strict');
const { createTianxiOfficialHandlers } = require('../lib/proxy/tianxi-official-handlers');

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
      this.ended = true;
    },
  };
}

(async () => {
  let bridgePayload = null;
  const handlers = createTianxiOfficialHandlers({
    sendJsonError() {
      throw new Error('unexpected sendJsonError');
    },
    logRequestEnd() {},
    openAIResponsesToChat() {
      return { messages: [{ role: 'user', content: 'hello' }] };
    },
    callTianxiOfficialBridge(payload) {
      bridgePayload = payload;
      return Promise.resolve({
        bridgeUrl: 'tianxi://test',
        frames: [
          { type: 'task_output', data: { content_type: 'text', content: 'ok' } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ],
      });
    },
    fallbackId: () => 'resp_test',
    stableCreated: () => 123,
  });

  const res = fakeRes();
  await handlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    res,
    Buffer.from(JSON.stringify({ model: 'tianxi/chat', input: 'hello' })),
    {
      model: 'tianxi/chat',
      rewriteTo: 'chat',
      profile: { id: 'tianxi-official' },
      route: {
        from: 'tianxi/chat',
        to: 'chat',
        tianxiAgentId: 'chat',
        tianxiLlm: 'chat',
      },
    },
    Date.now(),
    '/v1/responses'
  );

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'completed');
  assert.equal(bridgePayload.model, 'chat');
  assert.deepEqual(bridgePayload.metadata.tianxi, { agent_id: 'chat', llm: 'chat' });

  const fallbackRes = fakeRes();
  bridgePayload = null;
  await handlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    fallbackRes,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'hello' })),
    {
      model: 'tianxi/super',
      rewriteTo: 'super',
      profile: { id: 'tianxi-official' },
      route: {
        from: 'tianxi/super',
        to: 'super',
      },
    },
    Date.now(),
    '/v1/responses'
  );

  assert.equal(fallbackRes.statusCode, 200);
  assert.equal(bridgePayload.model, 'super');
  assert.deepEqual(bridgePayload.metadata.tianxi, { agent_id: 'super' });

  let capturedError = null;
  const errorHandlers = createTianxiOfficialHandlers({
    sendJsonError(_clientRes, statusCode, payload) {
      capturedError = { statusCode, payload };
      _clientRes.writeHead(statusCode, { 'content-type': 'application/json' });
      _clientRes.end(JSON.stringify(payload));
    },
    logRequestEnd() {},
    openAIResponsesToChat() {
      return { messages: [{ role: 'user', content: 'hello' }] };
    },
    callTianxiOfficialBridge() {
      const err = new Error('tianxi_native_runtime_failed');
      err.diagnostics = {
        cause_code: 'PIPE_FAILED',
        cause_message: 'Authorization: Bearer sat-secret-token ' + 'a'.repeat(140),
      };
      return Promise.reject(err);
    },
    fallbackId: () => 'resp_test',
    stableCreated: () => 123,
  });
  const errorRes = fakeRes();
  await errorHandlers.handleTianxiOfficialResponses(
    { headers: {}, method: 'POST' },
    errorRes,
    Buffer.from(JSON.stringify({ model: 'tianxi/super', input: 'hello' })),
    {
      model: 'tianxi/super',
      rewriteTo: 'super',
      profile: { id: 'tianxi-official' },
      route: { from: 'tianxi/super', to: 'super' },
    },
    Date.now(),
    '/v1/responses'
  );
  assert.equal(capturedError.statusCode, 502);
  const serializedError = JSON.stringify(capturedError.payload);
  assert.equal(capturedError.payload.error.diagnostics.cause_code, 'PIPE_FAILED');
  assert.equal(serializedError.includes('sat-secret-token'), false);
  assert.equal(serializedError.includes('Authorization: Bearer'), false);
  assert.equal(serializedError.includes('a'.repeat(140)), false);

  console.log('[tianxi-official-handlers.test] ok');
})();
