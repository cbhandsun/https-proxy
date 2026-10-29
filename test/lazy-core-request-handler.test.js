'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createLazyCoreRequestHandler } = require('../lib/proxy/lazy-core-request-handler');

test('lazy core preserves lifecycle ownership, request identity, receiver and async result', async () => {
  const lifecycle = {};
  const dependencies = { contextRecoveryLifecycle: lifecycle };
  let loads = 0;
  const receiver = {};
  const request = { headers: {} };
  const response = {};
  const entry = {};
  const result = Promise.resolve('completed');
  const handler = createLazyCoreRequestHandler(dependencies, {
    loadModule() {
      loads++;
      return {
        createCoreRequestHandler(actual) {
          assert.equal(actual, dependencies);
          return function (...args) {
            assert.equal(this, receiver);
            assert.deepEqual(args, [request, response, entry]);
            return result;
          };
        },
      };
    },
  });
  assert.equal(handler.contextRecoveryLifecycle, lifecycle);
  assert.equal(loads, 0);
  assert.equal(handler.call(receiver, request, response, entry), result);
  assert.equal(await handler.call(receiver, request, response, entry), 'completed');
  assert.equal(loads, 1);
});

test('lazy core fails closed, propagates initialization errors and retries without caching failure', () => {
  for (const dependencies of [undefined, null, [], '', 1])
    assert.throws(() => createLazyCoreRequestHandler(dependencies), TypeError);
  for (const loadModule of [true, {}, 'invalid'])
    assert.throws(() => createLazyCoreRequestHandler({}, { loadModule }), TypeError);
  for (const loaded of [null, {}, { createCoreRequestHandler: true }]) {
    const handler = createLazyCoreRequestHandler({}, { loadModule: () => loaded });
    assert.throws(() => handler(), /must export/);
  }
  for (const created of [null, {}, [], true]) {
    const handler = createLazyCoreRequestHandler(
      {},
      {
        loadModule: () => ({ createCoreRequestHandler: () => created }),
      }
    );
    assert.throws(() => handler(), /must return a function/);
  }
  const failure = new Error('synthetic dependency failure');
  let calls = 0;
  const lifecycle = {};
  const handler = createLazyCoreRequestHandler(
    {},
    {
      loadModule() {
        if (++calls === 1) throw failure;
        return {
          createCoreRequestHandler: () =>
            Object.assign(() => 'ok', { contextRecoveryLifecycle: lifecycle }),
        };
      },
    }
  );
  assert.throws(
    () => handler(),
    (problem) => problem === failure
  );
  assert.equal(handler.contextRecoveryLifecycle, lifecycle);
  assert.equal(handler(), 'ok');
  assert.equal(calls, 2);
  const recursive = createLazyCoreRequestHandler({}, { loadModule: () => recursive() });
  assert.throws(() => recursive(), /recursive/);
  assert.throws(() => recursive(), /recursive/);
});

test('production lazy core does not load the implementation until the first request', () => {
  const script = `
    const assert=require('node:assert/strict');
    const Module=require('node:module');
    const original=Module._load;
    const failure=new Error('synthetic_core_unavailable');
    Module._load=function(name,...args){if(name==='./core-request-handler')throw failure;return original.call(this,name,...args);};
    const {createLazyCoreRequestHandler}=require('./lib/proxy/lazy-core-request-handler');
    const lifecycle={};
    const handler=createLazyCoreRequestHandler({contextRecoveryLifecycle:lifecycle});
    assert.equal(handler.contextRecoveryLifecycle,lifecycle);
    assert.throws(()=>handler({headers:{}},{}),problem=>problem===failure);
    Module._load=original;
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
