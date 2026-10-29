'use strict';

const { parseBoundedInteger } = require('./management-utils');
const { inboundActivity } = require('./inbound-activity');

const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_HEADERS_TIMEOUT_MS = 15000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5000;
const DEFAULT_MAX_REQUESTS_PER_SOCKET = 100;
const DEFAULT_MAX_HEADERS_COUNT = 100;

function createConcurrencyGuard(handler, options = {}) {
  if (typeof handler !== 'function') {
    throw new TypeError('createConcurrencyGuard requires a request handler');
  }
  const trackActivity = options.trackActivity === undefined ? true : options.trackActivity;
  if (typeof trackActivity !== 'boolean') {
    throw new TypeError('createConcurrencyGuard requires boolean trackActivity');
  }
  const maxConcurrentRequests = parseBoundedInteger(
    options.maxConcurrentRequests,
    DEFAULT_MAX_CONCURRENT_REQUESTS,
    1,
    10000
  );
  const state =
    options.state && typeof options.state === 'object' ? options.state : { activeRequests: 0 };
  if (!Number.isSafeInteger(state.activeRequests) || state.activeRequests < 0) {
    state.activeRequests = 0;
  }

  function guardedHandler(req, res) {
    if (state.activeRequests >= maxConcurrentRequests) {
      res.writeHead(503, {
        Connection: 'close',
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': '1',
      });
      res.end(JSON.stringify({ error: 'Server is at its concurrent request limit' }));
      res.once('finish', () => req.socket?.destroy?.());
      return;
    }

    state.activeRequests += 1;
    const endActivity = trackActivity ? inboundActivity.beginHttp() : () => {};
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.activeRequests = Math.max(0, state.activeRequests - 1);
      endActivity();
      res.removeListener('finish', release);
      res.removeListener('close', release);
    };

    try {
      res.once('finish', release);
      res.once('close', release);
      handler(req, res);
    } catch (error) {
      release();
      throw error;
    }
  }

  guardedHandler.getActiveRequestCount = () => state.activeRequests;
  guardedHandler.maxConcurrentRequests = maxConcurrentRequests;
  return guardedHandler;
}

function createUpgradeGuard(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('createUpgradeGuard requires a request handler');
  }
  return function guardedUpgrade(req, socket, head) {
    if (
      !socket ||
      typeof socket.once !== 'function' ||
      typeof socket.removeListener !== 'function'
    ) {
      throw new TypeError('createUpgradeGuard requires a socket');
    }
    const endActivity = inboundActivity.beginUpgrade();
    const release = () => {
      socket.removeListener('close', release);
      endActivity();
    };
    try {
      socket.once('close', release);
      return handler(req, socket, head);
    } catch (error) {
      release();
      throw error;
    }
  };
}

function hardenHttpServer(server, options = {}) {
  if (!server || typeof server !== 'object') {
    throw new TypeError('hardenHttpServer requires a server');
  }
  const requestTimeout = parseBoundedInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    1000,
    30 * 60 * 1000
  );
  const headersTimeout = parseBoundedInteger(
    options.headersTimeoutMs,
    DEFAULT_HEADERS_TIMEOUT_MS,
    1000,
    requestTimeout
  );
  server.requestTimeout = requestTimeout;
  server.headersTimeout = headersTimeout;
  server.keepAliveTimeout = parseBoundedInteger(
    options.keepAliveTimeoutMs,
    DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
    500,
    120000
  );
  server.maxRequestsPerSocket = parseBoundedInteger(
    options.maxRequestsPerSocket,
    DEFAULT_MAX_REQUESTS_PER_SOCKET,
    1,
    10000
  );
  server.maxHeadersCount = parseBoundedInteger(
    options.maxHeadersCount,
    DEFAULT_MAX_HEADERS_COUNT,
    16,
    1000
  );
  server.maxConnections = parseBoundedInteger(
    options.maxConnections,
    DEFAULT_MAX_CONNECTIONS,
    1,
    20000
  );
  return server;
}

module.exports = {
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_HEADERS_COUNT,
  DEFAULT_MAX_REQUESTS_PER_SOCKET,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createConcurrencyGuard,
  createUpgradeGuard,
  hardenHttpServer,
};
