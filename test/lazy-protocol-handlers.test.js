'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const lazy = require('../lib/proxy/lazy-protocol-handlers');

test('Cold composition leaves protocol implementations unloaded until their first use', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-lazy-protocol-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const script = `const entry = require('./openai-proxy');
    for(const name of ['protocol-openai','protocol-gemini','stream-claude']) {
      require('node:assert/strict').equal(!!require.cache[require.resolve('./lib/proxy/'+name)],false,'eager_protocol_'+name);
    }
    const response = entry.openAIResponsesToChat({model:'fixture',input:'hello'});
    require('node:assert/strict').equal(response.messages[0].content,'hello');
    require('node:assert/strict').ok(require.cache[require.resolve('./lib/proxy/protocol-openai')]);
    process.stdout.write('LAZY_PROTOCOL_COMPOSITION_OK');`;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: createIsolatedTestEnv(process.env, directory),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes('LAZY_PROTOCOL_COMPOSITION_OK'),
    'cold composition did not complete its assertions'
  );
});

test('Lazy protocol surfaces match actual factories, including conditional stream support', () => {
  for (const [name, factory, modulePath] of [
    ['openai', 'createOpenAIProtocol', 'protocol-openai'],
    ['gemini', 'createGeminiProtocol', 'protocol-gemini'],
    ['claude', 'createClaudeStream', 'stream-claude'],
  ])
    for (const dependencies of [{}, { createResponsesStreamEmitter() {} }]) {
      const expected = require('../lib/proxy/' + modulePath)[factory](dependencies);
      const actual = lazy[factory](dependencies);
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), name);
      assert.equal(actual.isInitialized(), false);
      assert.ok(Object.isFrozen(actual));
      for (const key of Object.keys(expected)) assert.equal(typeof actual[key], 'function');
    }
});

test('Destructuring and spreading defer loading and preserve shared state, receiver, async values and errors', async () => {
  const deps = { marker: 'PRIVATE' };
  let loads = 0,
    builds = 0,
    calls = 0;
  const handlers = Object.fromEntries(
    lazy.PROTOCOL_HANDLERS.openai.map((name) => [
      name,
      function (...args) {
        return { name, args, receiver: this, calls: ++calls };
      },
    ])
  );
  handlers.buildResponsesResponse = async function (value) {
    return [this, value];
  };
  const failure = new Error('synthetic failure');
  handlers.flushOpenAIResponsesSseToChat = () => {
    throw failure;
  };
  const protocol = lazy.createOpenAIProtocol(deps, {
    loadModule() {
      loads++;
      return {
        createOpenAIProtocol(value) {
          builds++;
          assert.equal(value, deps);
          return handlers;
        },
      };
    },
  });
  const spread = { ...protocol };
  const { openAIResponsesToChat } = protocol;
  assert.equal(loads, 0);
  const result = openAIResponsesToChat('value', null);
  assert.deepEqual(result.args, ['value', null]);
  assert.equal(result.receiver, handlers);
  assert.equal(spread.openAIResponsesToChat('next').calls, 2);
  assert.deepEqual(await spread.buildResponsesResponse('async'), [handlers, 'async']);
  assert.throws(
    () => spread.flushOpenAIResponsesSseToChat(),
    (error) => error === failure
  );
  assert.equal(protocol.isInitialized(), true);
  assert.equal(loads, 1);
  assert.equal(builds, 1);
});

test('Malformed, failed and recursive protocol initialization fail explicitly and remain retryable', () => {
  assert.throws(
    () => lazy.createOpenAIProtocol({}, { loadModule: false }),
    /Invalid protocol module loader/
  );
  const complete = () =>
    Object.fromEntries(lazy.PROTOCOL_HANDLERS.openai.map((name) => [name, () => 'ready']));
  for (const invalid of [
    null,
    [],
    false,
    {},
    { createOpenAIProtocol: null },
    { createOpenAIProtocol: () => null },
    { createOpenAIProtocol: () => [] },
    { createOpenAIProtocol: () => ({}) },
    {
      createOpenAIProtocol() {
        throw new Error('load failed');
      },
    },
  ]) {
    let first = true;
    const protocol = lazy.createOpenAIProtocol(
      {},
      {
        loadModule() {
          if (first) {
            first = false;
            return invalid;
          }
          return { createOpenAIProtocol: complete };
        },
      }
    );
    assert.throws(() => protocol.openAIResponsesToChat());
    assert.equal(protocol.isInitialized(), false);
    assert.equal(protocol.openAIResponsesToChat(), 'ready');
  }
  let recursive = true;
  const protocol = lazy.createOpenAIProtocol(
    {},
    {
      loadModule() {
        return {
          createOpenAIProtocol() {
            if (recursive) protocol.openAIResponsesToChat();
            return complete();
          },
        };
      },
    }
  );
  assert.throws(() => protocol.openAIResponsesToChat(), /initialization is recursive/);
  recursive = false;
  assert.equal(protocol.openAIResponsesToChat(), 'ready');
});
