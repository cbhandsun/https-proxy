'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createConcurrencyGuard,
  hardenHttpServer,
} = require('../lib/proxy/inbound-controls');

function createExchange() {
  const req = new EventEmitter();
  req.socket = {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = null;
  res.body = '';
  res.writeHead = (statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers;
  };
  res.end = (body = '') => {
    res.body = String(body);
  };
  return { req, res };
}

assert.throws(() => createConcurrencyGuard(), /requires a request handler/);

const pendingResponses = [];
const state = { activeRequests: 0 };
const guarded = createConcurrencyGuard(
  (_req, res) => {
    pendingResponses.push(res);
  },
  { maxConcurrentRequests: 1, state }
);
const first = createExchange();
guarded(first.req, first.res);
assert.strictEqual(guarded.getActiveRequestCount(), 1);

const overloaded = createExchange();
guarded(overloaded.req, overloaded.res);
assert.strictEqual(overloaded.res.statusCode, 503);
assert.strictEqual(overloaded.res.headers.Connection, 'close');
assert.strictEqual(overloaded.res.headers['Retry-After'], '1');
assert.match(overloaded.res.body, /concurrent request limit/);
overloaded.res.emit('finish');
assert.strictEqual(overloaded.req.socket.destroyed, true);
assert.strictEqual(guarded.getActiveRequestCount(), 1);

first.res.emit('finish');
first.res.emit('close');
assert.strictEqual(guarded.getActiveRequestCount(), 0);

const secondGuard = createConcurrencyGuard(() => {}, {
  maxConcurrentRequests: 1,
  state,
});
const shared = createExchange();
secondGuard(shared.req, shared.res);
assert.strictEqual(guarded.getActiveRequestCount(), 1);
shared.res.emit('close');
assert.strictEqual(guarded.getActiveRequestCount(), 0);

const throwingGuard = createConcurrencyGuard(() => {
  throw new Error('handler failure');
});
const failed = createExchange();
assert.throws(() => throwingGuard(failed.req, failed.res), /handler failure/);
assert.strictEqual(throwingGuard.getActiveRequestCount(), 0);

const defaultGuard = createConcurrencyGuard(() => {}, {
  maxConcurrentRequests: Number.POSITIVE_INFINITY,
});
assert.strictEqual(DEFAULT_MAX_CONCURRENT_REQUESTS, 32);
assert.strictEqual(defaultGuard.maxConcurrentRequests, DEFAULT_MAX_CONCURRENT_REQUESTS);

assert.throws(() => hardenHttpServer(), /requires a server/);
const server = {};
hardenHttpServer(server, {
  requestTimeoutMs: 10000,
  headersTimeoutMs: 20000,
  keepAliveTimeoutMs: 1,
  maxRequestsPerSocket: 0,
  maxHeadersCount: 5000,
  maxConnections: Number.NaN,
});
assert.strictEqual(server.requestTimeout, 10000);
assert.strictEqual(server.headersTimeout, 10000);
assert.strictEqual(server.keepAliveTimeout, 500);
assert.strictEqual(server.maxRequestsPerSocket, 1);
assert.strictEqual(server.maxHeadersCount, 1000);
assert.ok(server.maxConnections > 0);

const defaultServer = {};
hardenHttpServer(defaultServer, {
  requestTimeoutMs: 'invalid',
  headersTimeoutMs: 'invalid',
});
assert.strictEqual(defaultServer.requestTimeout, DEFAULT_REQUEST_TIMEOUT_MS);
assert.strictEqual(defaultServer.headersTimeout, DEFAULT_HEADERS_TIMEOUT_MS);

console.log('[inbound-controls.test] ok');
