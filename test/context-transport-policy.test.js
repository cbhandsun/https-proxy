'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { createWebSocketProxy } = require('../lib/proxy/websocket-proxy');
const { createContextForwardHeaders } = require('../lib/proxy/context-transport-policy');

test('transport policy preserves ordinary headers and isolates source arrays', () => {
  const input = {
    authorization: 'Bearer fixture',
    accept: ['application/json'],
    n: 3,
    absent: undefined,
  };
  const copy = createContextForwardHeaders(input);
  assert.equal(copy.authorization, input.authorization);
  assert.equal(copy.n, 3);
  assert.equal(Object.hasOwn(copy, 'absent'), false);
  copy.accept.push('text/plain');
  assert.equal(input.accept.length, 1);
  assert.equal(Object.keys(createContextForwardHeaders({})).length, 0);
});

test('transport policy strips local headers case insensitively without invoking their getters', () => {
  const input = {
    Authorization: 'fixture',
    'X-Hpm-Context-Target': 'fixture',
    'X-Hpm-Tool-Discovery': 'fixture',
  };
  Object.defineProperty(input, 'X-Hpm-Evidence-Token', {
    enumerable: true,
    get() {
      throw new Error('must not read');
    },
  });
  assert.deepEqual(Object.keys(createContextForwardHeaders(input, true)), []);
  assert.equal(input.Authorization, 'fixture');
});

test('transport policy refuses malformed values, excessive data and accessors without coercion', () => {
  const bad = [
    null,
    undefined,
    [],
    'headers',
    { bad: {} },
    { bad: Infinity },
    { 'bad\r\nname': 'x' },
    { bad: 'x\r\ny' },
    { bad: 'x'.repeat(65537) },
    { bad: ['valid', 1] },
    { bad: new Array(2) },
    Object.fromEntries(Array.from({ length: 1025 }, (_, i) => ['k' + i, 'v'])),
  ];
  for (const input of bad)
    assert.throws(() => createContextForwardHeaders(input), {
      message: 'Invalid context transport headers',
    });
  let invoked = 0;
  const headers = {};
  Object.defineProperty(headers, 'ordinary', {
    enumerable: true,
    get() {
      invoked++;
      return 'unsafe';
    },
  });
  assert.throws(() => createContextForwardHeaders(headers));
  const array = [];
  Object.defineProperty(array, '0', {
    enumerable: true,
    get() {
      invoked++;
      return 'unsafe';
    },
  });
  assert.throws(() => createContextForwardHeaders({ ordinary: array }));
  assert.equal(invoked, 0);
  assert.throws(() => createContextForwardHeaders({}, 'true'));
});

test('WebSocket upstream never receives proxy context capabilities or entry credentials', async (t) => {
  const original = http.request;
  let forwarded;
  http.request = (options) => {
    forwarded = options.headers;
    const request = new EventEmitter();
    request.end = () => {};
    return request;
  };
  t.after(() => {
    http.request = original;
  });
  const profile = {
    id: 'fixture',
    targetUrl: 'http://127.0.0.1:1/backend',
    authMode: 'official-login',
    apiKey: 'fixture-upstream',
  };
  const handler = createWebSocketProxy({
    getConfig: () => ({
      entryAuth: { enabled: true, keys: [{ id: 'fixture', key: 'fixture-entry', enabled: true }] },
    }),
    getProfiles: () => [profile],
    getActiveProfile: () => profile,
    resolveRoute: () => ({ profile }),
  });
  const socket = new EventEmitter();
  socket.resume = () => socket;
  socket.write = () => true;
  socket.destroy = () => {};
  const headers = {
    host: 'localhost',
    authorization: 'Bearer fixture-entry',
    'x-api-key': 'fixture-entry',
    'proxy-authorization': 'fixture-entry',
    'x-hpm-evidence-token': 'fixture-capability',
    'x-hpm-context-target': 'fixture-target',
    'x-hpm-tool-discovery': 'fixture-discovery',
    upgrade: 'websocket',
  };
  await handler({ url: '/v1/responses', headers, socket: {} }, socket, Buffer.alloc(0), {
    protocol: 'openai-responses',
    listenPort: 3445,
  });
  assert.ok(forwarded);
  for (const name of [
    'x-api-key',
    'proxy-authorization',
    'x-hpm-evidence-token',
    'x-hpm-context-target',
    'x-hpm-tool-discovery',
  ]) {
    assert.equal(forwarded[name], undefined, name);
  }
  assert.equal(forwarded.authorization, 'Bearer fixture-upstream');
  assert.equal(forwarded.upgrade, 'websocket');
  assert.equal(headers['x-hpm-evidence-token'], 'fixture-capability');
});
