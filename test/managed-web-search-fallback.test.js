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
const fallbackPrepared = createManagedWebSearchFallbackPrepared(
  { __managedWebSearchFallback: [fallbackTool] },
  { model: 'gemini', tools: [{ google_search: {} }] },
  prepared
);
assert.notStrictEqual(fallbackPrepared, prepared);
assert.strictEqual(fallbackPrepared.profile, prepared.profile);
assert.deepStrictEqual(JSON.parse(fallbackPrepared.buffer.toString('utf8')), {
  model: 'gemini',
  tools: [fallbackTool],
  __disableManagedWebSearchPromotion: true,
});

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
assert.strictEqual(
  scheduleManagedWebSearchFallback({
    proxyRes,
    fallbackPrepared,
    clientRes: { headersSent: false, destroyed: false },
    retry(nextPrepared) {
      retriedWith = nextPrepared;
    },
  }),
  true
);
assert.strictEqual(proxyRes.resumed, true);
proxyRes.emit('end');
assert.strictEqual(retriedWith, fallbackPrepared);

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
