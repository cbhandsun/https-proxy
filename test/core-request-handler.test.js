const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createCoreRequestHandler } = require('../lib/proxy/core-request-handler');

assert.throws(() => createCoreRequestHandler(), /requires getRuntimeState/);

const handler = createCoreRequestHandler({ getRuntimeState: () => ({}) });
assert.strictEqual(typeof handler, 'function');
assert.strictEqual(handler.name, 'handleRequestInner');

{
  const requestEnds = [];
  const publicHealthHandler = createCoreRequestHandler({
    getRuntimeState: () => ({
      ACTIVE_PROFILE: {},
      CLAUDE_DESKTOP_ROUTES: [],
      CLI_SESSIONS: new Map(),
      CONFIG: { appSettings: { conversationAuditEnabled: false } },
      MANAGEMENT_TOKEN: '',
      MODEL_ROUTES: [],
      PROFILES: [],
    }),
    getClientIp: () => '127.0.0.1',
    isClaudeDesktopRequest: () => false,
    stripClaudeDesktopPrefix: (value) => value,
    isLocalManagementPath: () => false,
    isConversationRequestPath: () => false,
    metricsInstance: { counter: () => ({ inc() {} }) },
    isQuietLocalPollRequest: () => false,
    resolveCliSession: () => ({}),
    log: { info() {} },
    logProxyEvent() {},
    entryLabel: (entry) => entry.protocol,
    installEntryCorsGuard: () => true,
    dispatchLocalManagementRoute: () => false,
    logRequestEnd(method, requestPath, _startTime, statusCode, extra) {
      requestEnds.push({ method, requestPath, statusCode, extra });
    },
  });
  const request = {
    method: 'GET',
    url: '/v1/.well-known/hpm-health',
    headers: { host: 'localhost' },
    reqId: 'req-health-test',
  };
  const response = new EventEmitter();
  response.statusCode = 0;
  response.headers = {};
  response.body = '';
  response.write = () => true;
  response.writeHead = function writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  };
  response.end = function end(body) {
    this.body = body == null ? '' : String(body);
    this.emit('finish');
  };
  publicHealthHandler(request, response, { protocol: 'openai-chat', listenPort: 3447 });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers['X-HPM-Proxy'], 'https-proxy-manager');
  assert.strictEqual(JSON.parse(response.body).entryProtocol, 'openai-chat');
  assert.strictEqual(requestEnds[0].statusCode, 200);
  assert.strictEqual(requestEnds[0].extra.type, 'public_entry_health');
}

const source = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'proxy', 'core-request-handler.js'),
  'utf8'
);
assert.ok(source.includes('authorizeManagementRequest(clientReq, MANAGEMENT_TOKEN)'));
assert.ok(!source.includes('isTauriManagementOrigin'));
assert.ok(!source.includes("searchParams.get('token')"));
const responsePolicyIndex = source.indexOf(
  'currentPrepared = applyResponseStreamingPolicy(currentPrepared'
);
const chatPolicyIndex = source.indexOf(
  'currentPrepared = applyChatStreamingPolicy(currentPrepared'
);
const conversionDispatchIndex = source.indexOf('for (const route of conversionRoutes)');
const conversionStreamMarkerIndex = source.indexOf('forceUpstreamChatStreaming: true');
assert.ok(responsePolicyIndex > conversionDispatchIndex);
assert.ok(chatPolicyIndex > conversionDispatchIndex);
assert.ok(
  conversionStreamMarkerIndex >= 0 && conversionStreamMarkerIndex < conversionDispatchIndex
);

assert.ok(source.includes('const isResponsesRequestPath = isOpenAIResponsesPath(clientPath);'));
assert.ok(source.includes('const isRoutedResponsesConversionRequest ='));

function routeBlock(label) {
  const labelIndex = source.indexOf(`label: '${label}'`);
  assert.ok(labelIndex >= 0, `${label} route should exist`);
  const nextRouteIndex = source.indexOf('\n            {', labelIndex + 1);
  return source.slice(labelIndex, nextRouteIndex === -1 ? undefined : nextRouteIndex);
}

assert.ok(
  routeBlock('responses->claude').includes(
    '(isResponsesEntryRequest || isRoutedResponsesConversionRequest)'
  ),
  'Claude Responses requests routed by path should use Responses-to-Claude conversion'
);
assert.ok(
  routeBlock('responses->gemini').includes(
    '(isResponsesEntryRequest || isRoutedResponsesConversionRequest)'
  ),
  'Gemini Responses requests routed by path should use Responses-to-Gemini conversion'
);
assert.ok(
  !routeBlock('responses->chat').includes('isRoutedResponsesConversionRequest'),
  'OpenAI Responses-to-chat conversion should remain entry-protocol gated'
);

console.log('[core-request-handler.test] ok');
