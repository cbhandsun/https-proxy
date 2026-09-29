'use strict';

const assert = require('node:assert/strict');
const {
  createOpenAIChatToResponsesHandler,
} = require('../lib/proxy/handlers/chat-to-responses-handler');
const { createRouteHandlers } = require('../lib/proxy/handlers/route-handlers');

const request = { method: 'POST', url: '/v1/chat/completions', headers: {} };
const prepared = { buffer: Buffer.from('{}'), rewriteTo: '-', profile: {} };
const target = { protocol: 'https:', hostname: 'example.test', path: '/v1' };
const overBudget = { enabled: true, overBudgetTokens: 1 };
let upstreamRequests = 0;
let error = null;
const failTransport = {
  request() {
    upstreamRequests += 1;
    throw new Error('over-budget history must not reach the upstream');
  },
};
const sendJsonError = (_response, status, payload) => {
  error = { status, payload };
};
const responsesBody = {};
Object.defineProperty(responsesBody, '__hpmDiagnostics', {
  value: { contextBudget: overBudget },
});

const chatToResponses = createOpenAIChatToResponsesHandler(
  {
    https: failTransport,
    http: failTransport,
    parseProxyBody: () => ({ model: 'test-model', messages: [] }),
    openAIChatToResponsesRequest: () => responsesBody,
    sendJsonError,
  },
  {}
);
chatToResponses(request, {}, prepared, target, '', '/responses', Date.now());
assert.equal(error.status, 400);
assert.equal(error.payload.error.code, 'context_length_exceeded');
assert.equal(upstreamRequests, 0);

error = null;
const routeHandlers = createRouteHandlers({
  https: failTransport,
  http: failTransport,
  log: { info() {}, warn() {}, error() {} },
  sendJsonError,
  parseProxyBody: () => ({ model: 'test-model', messages: [] }),
  claudeMessagesToOpenAIChat: () => ({ model: 'test-model', messages: [] }),
  openAIChatToResponsesRequest: () => responsesBody,
});
routeHandlers.handleClaudeMessagesToOpenAIResponses(
  request,
  {},
  prepared,
  target,
  '',
  '/responses',
  Date.now()
);
assert.equal(error.status, 400);
assert.equal(error.payload.error.code, 'context_length_exceeded');
assert.equal(upstreamRequests, 0);

console.log('[context-overflow-routes.test] ok');
