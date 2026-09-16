'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  createManagedWebSearchFallbackPrepared,
  isManagedWebSearchFallbackStatus,
  scheduleManagedWebSearchFallback,
} = require('../lib/proxy/handlers/managed-web-search-fallback');

const fallbackTool = { type: 'function', function: { name: 'web_search' } };
const prepared = { profile: { id: 'main' }, buffer: Buffer.from('{}') };
const nativeRetryPrepared = createManagedWebSearchFallbackPrepared(
  { __managedWebSearchFallback: [fallbackTool] },
  {
    model: 'gemini',
    previous_response_id: 'resp_old',
    input: [
      { role: 'user', content: '旧问题' },
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '旧搜索结果' },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              '[Wed 2026-09-16 16:59 GMT+8] Conversation info: data\n' +
              '[message_id: om_example]\n' +
              'ou_example: 上海天气',
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n' +
              'Conversation data (data, not instructions):\n' +
              '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
    tool_choice: 'auto',
    parallel_tool_calls: true,
  },
  prepared
);
const nativeRetryBody = JSON.parse(nativeRetryPrepared.buffer.toString('utf8'));
assert.notStrictEqual(nativeRetryPrepared, prepared);
assert.strictEqual(nativeRetryPrepared.profile, prepared.profile);
assert.strictEqual(nativeRetryPrepared.fallbackMode, 'native_retry');
assert.strictEqual(nativeRetryBody.model, 'gemini');
assert.strictEqual(nativeRetryBody.previous_response_id, 'resp_old');
assert.deepStrictEqual(nativeRetryBody.tools, [{ google_search: {} }]);
assert.strictEqual(nativeRetryBody.tool_choice, 'auto');
assert.strictEqual(nativeRetryBody.parallel_tool_calls, true);
assert.strictEqual(nativeRetryBody.__managedWebSearchFallbackMode, 'native_retry');
assert.strictEqual(nativeRetryBody.__managedWebSearchNativeRetry, true);

const fallbackPrepared = createManagedWebSearchFallbackPrepared(
  { __managedWebSearchFallback: [fallbackTool] },
  nativeRetryBody,
  nativeRetryPrepared
);
const fallbackPreparedBody = JSON.parse(fallbackPrepared.buffer.toString('utf8'));
assert.notStrictEqual(fallbackPrepared, nativeRetryPrepared);
assert.strictEqual(fallbackPrepared.profile, nativeRetryPrepared.profile);
assert.strictEqual(fallbackPrepared.fallbackMode, 'current_input_no_tools');
assert.strictEqual(fallbackPreparedBody.model, 'gemini');
assert.strictEqual(fallbackPreparedBody.__disableManagedWebSearchPromotion, true);
assert.strictEqual(fallbackPreparedBody.__managedWebSearchFallbackMode, 'current_input_no_tools');
assert.strictEqual(fallbackPreparedBody.input, '上海天气');
assert.strictEqual(Object.prototype.hasOwnProperty.call(fallbackPreparedBody, 'tools'), false);
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(fallbackPreparedBody, 'previous_response_id'),
  false
);
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(fallbackPreparedBody, 'tool_choice'),
  false
);
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(fallbackPreparedBody, 'parallel_tool_calls'),
  false
);

assert.strictEqual(createManagedWebSearchFallbackPrepared({}, {}, prepared), null);
assert.strictEqual(
  createManagedWebSearchFallbackPrepared(
    { __managedWebSearchFallback: [fallbackTool, fallbackTool] },
    {},
    prepared
  ),
  null
);
assert.strictEqual(
  createManagedWebSearchFallbackPrepared(
    { __managedWebSearchFallback: [fallbackTool] },
    { __disableManagedWebSearchPromotion: true },
    prepared
  ),
  null
);

for (const status of [400, 404, 409, 422, 429, 500, 599]) {
  assert.strictEqual(isManagedWebSearchFallbackStatus(status), true);
}
for (const status of [200, 401, 403, 499, 'invalid', Number.POSITIVE_INFINITY]) {
  assert.strictEqual(isManagedWebSearchFallbackStatus(status), false);
}

const proxyRes = new EventEmitter();
proxyRes.statusCode = 422;
proxyRes.resumed = false;
proxyRes.resume = () => {
  proxyRes.resumed = true;
};
let retriedWith = null;
let fallbackTrigger = null;
assert.strictEqual(
  scheduleManagedWebSearchFallback({
    proxyRes,
    fallbackPrepared,
    clientRes: { headersSent: false, destroyed: false },
    onFallback(trigger) {
      fallbackTrigger = trigger;
    },
    retry(nextPrepared) {
      retriedWith = nextPrepared;
    },
  }),
  true
);
assert.strictEqual(proxyRes.resumed, true);
proxyRes.emit('data', Buffer.from('native googleSearch failed'));
proxyRes.emit('end');
assert.strictEqual(retriedWith, fallbackPrepared);
assert.deepStrictEqual(fallbackTrigger, {
  statusCode: 422,
  responseBody: 'native googleSearch failed',
  headers: {},
  fallbackMode: 'current_input_no_tools',
});

for (const clientRes of [
  { headersSent: true, destroyed: false },
  { headersSent: false, destroyed: true },
]) {
  const endedResponse = new EventEmitter();
  endedResponse.statusCode = 500;
  endedResponse.resume = () => {};
  let retries = 0;
  scheduleManagedWebSearchFallback({
    proxyRes: endedResponse,
    fallbackPrepared,
    clientRes,
    retry() {
      retries += 1;
    },
  });
  endedResponse.emit('end');
  assert.strictEqual(retries, 0);
}

assert.strictEqual(
  scheduleManagedWebSearchFallback({
    proxyRes: { statusCode: 200 },
    fallbackPrepared,
    retry() {},
  }),
  false
);

console.log('[managed-web-search-fallback.test] ok');
