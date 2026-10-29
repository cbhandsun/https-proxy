'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const {
  createLazyRouteHandlers,
  ROUTE_HANDLER_NAMES,
} = require('../lib/proxy/lazy-route-handlers');
const fake = () =>
  Object.fromEntries(
    ROUTE_HANDLER_NAMES.map((name) => [
      name,
      function (...args) {
        return { name, args, receiver: this };
      },
    ])
  );
test('Proxy handler import and construction leave conversion routes unloaded in a cold process', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-lazy-route-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const script = `const routes = require.resolve('./lib/proxy/handlers/route-handlers');
    const state = require.resolve('./lib/proxy/handlers/responses-state');
    const validators = require.resolve('./lib/proxy/handlers/request-validators');
    const {createProxyHandlers}=require('./lib/proxy/handlers');
    if(require.cache[routes])throw Error('eager_route_import');
    if(require.cache[state]||require.cache[validators])throw Error('eager_conversion_support_import');
    const h=createProxyHandlers({sendJsonError(){},extractSseDataPayloads(){return[]},fallbackId(){return'fixture'},logProxyEvent(){},logRequestEnd(){}});
    if(require.cache[routes])throw Error('eager_route_construction');
    if(require.cache[state]||require.cache[validators])throw Error('eager_conversion_support_construction');
    if(typeof h.handleOpenAIResponsesToOpenAIChat!=='function'||!(h._responsesHistory instanceof Map))throw Error('public_contract_changed');
    if(!require.cache[state]||require.cache[validators]||h._responsesHistory!==h._responsesHistory)throw Error('shared_state_initialization_failed');
    const imageStore=h._imageJobStore;
    if(!require.cache[routes]||!imageStore||imageStore!==h._imageJobStore)throw Error('shared_route_initialization_failed');
    const {ROUTE_HANDLER_NAMES}=require('./lib/proxy/lazy-route-handlers');
    const actual=require(routes).createRouteHandlers({});
    require('node:assert/strict').deepEqual(Object.keys(actual).sort(),[...ROUTE_HANDLER_NAMES,'_imageJobStore'].sort());`;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: createIsolatedTestEnv(process.env, directory),
  });
  assert.equal(result.status, 0, result.stderr);
});
test('Lazy routes keep synchronous and async returns, receiver and shared state across handler calls', async () => {
  const deps = { marker: 'test' };
  const created = fake();
  const store = new Map();
  created._imageJobStore = store;
  created.handleGeminiMessages = async function (value) {
    return [this, value];
  };
  let loads = 0,
    factories = 0;
  const routes = createLazyRouteHandlers(deps, {
    loadModule() {
      loads++;
      return {
        createRouteHandlers(value) {
          factories++;
          assert.equal(value, deps);
          return created;
        },
      };
    },
  });
  const { handleOpenAIResponsesToOpenAIChat } = routes;
  assert.equal(loads, 0);
  const args = [{ private: 'input' }, null, 7];
  const call = handleOpenAIResponsesToOpenAIChat(...args);
  assert.equal(call.receiver, created);
  assert.deepEqual(call.args, args);
  assert.deepEqual(await routes.handleGeminiMessages('value'), [created, 'value']);
  assert.equal(routes._imageJobStore, store);
  assert.equal(loads, 1);
  assert.equal(factories, 1);
  assert.deepEqual(Object.keys(routes).sort(), [...ROUTE_HANDLER_NAMES, '_imageJobStore'].sort());
});
test('Failed, malformed and recursive lazy factories fail explicitly and never poison the cache', () => {
  for (const loadModule of [null, 1, '', {}])
    assert.throws(() => createLazyRouteHandlers({}, { loadModule }), TypeError);
  for (const value of [
    null,
    [],
    {},
    { createRouteHandlers: 1 },
    { createRouteHandlers: () => null },
    { createRouteHandlers: () => [] },
    { createRouteHandlers: () => ({}) },
  ]) {
    const handlers = createLazyRouteHandlers({}, { loadModule: () => value });
    assert.throws(() => handlers.handleGeminiMessages(), TypeError);
  }
  let tries = 0;
  const error = new Error('fixture_failure');
  const created = fake();
  const retry = createLazyRouteHandlers(
    {},
    {
      loadModule() {
        if (++tries === 1) throw error;
        return { createRouteHandlers: () => created };
      },
    }
  );
  assert.throws(
    () => retry.handleGeminiMessages(),
    (value) => value === error
  );
  assert.equal(retry.handleGeminiMessages().receiver, created);
  assert.equal(tries, 2);
  const recursive = createLazyRouteHandlers(
    {},
    {
      loadModule() {
        recursive.handleGeminiMessages();
      },
    }
  );
  assert.throws(() => recursive.handleGeminiMessages(), /initialization is recursive/);
});
