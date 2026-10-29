'use strict';

const assert = require('node:assert/strict');
const https = require('node:https');
const test = require('node:test');
const { createLocalTlsRefresh } = require('../lib/proxy/local-tls-refresh');

test('refresh reads current credentials once and preserves native server receiver', () => {
  const config = Object.freeze({ synthetic: true });
  let calls = 0;
  const servers = [null, undefined, {}, { setSecureContext: false }];
  const server = {
    setSecureContext(value) {
      assert.equal(this, server);
      assert.equal(value, config);
    },
  };
  const refresh = createLocalTlsRefresh({ servers, ensureCert: () => (calls++, config) });
  assert.deepEqual(refresh(), { refreshed: 0 });
  servers.push(server);
  assert.deepEqual(refresh(), { refreshed: 1 });
  servers.push(server);
  assert.deepEqual(refresh(), { refreshed: 2 });
  assert.equal(calls, 3);
});

test('native HTTPS context refresh works without opening a listener or generating a certificate', () => {
  const server = https.createServer();
  const refresh = createLocalTlsRefresh({ servers: [server], ensureCert: () => ({}) });
  assert.deepEqual(refresh(), { refreshed: 1 });
  assert.equal(server.listening, false);
});

test('each refresh uses the latest credential result and propagates source/context failures', () => {
  let version = 0;
  const seen = [];
  const failure = new Error('synthetic TLS failure');
  const refresh = createLocalTlsRefresh({
    servers: [{ setSecureContext: (config) => seen.push(config) }],
    ensureCert() {
      if (version === 2) throw failure;
      return { version: version++ };
    },
  });
  refresh();
  refresh();
  assert.deepEqual(seen, [{ version: 0 }, { version: 1 }]);
  assert.throws(refresh, (error) => error === failure);
  let laterCalls = 0;
  const contextFailure = createLocalTlsRefresh({
    servers: [
      {
        setSecureContext() {
          throw failure;
        },
      },
      {
        setSecureContext() {
          laterCalls++;
        },
      },
    ],
    ensureCert: () => ({}),
  });
  assert.throws(contextFailure, (error) => error === failure);
  assert.equal(laterCalls, 0);
});

test('invalid and executable dependency input is rejected without invoking getters', () => {
  let hooks = 0;
  const getter = Object.defineProperty({ servers: [] }, 'ensureCert', { get: () => hooks++ });
  for (const input of [
    undefined,
    null,
    [],
    false,
    1,
    {},
    { servers: {}, ensureCert() {} },
    { servers: [] },
    getter,
    { servers: [], ensureCert() {}, extra: true },
  ]) {
    assert.throws(() => createLocalTlsRefresh(input), /Invalid local TLS refresh dependencies/);
  }
  assert.equal(hooks, 0);
});
