'use strict';

const { randomBytes } = require('node:crypto');
const { types } = require('node:util');
const { readJsonBodyFromRequest } = require('./management-utils');

function parseStopIdentity(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).sort().join(',') !== 'instanceId,pid'
  )
    return null;
  const value = {};
  for (const name of ['pid', 'instanceId']) {
    const slot = Object.getOwnPropertyDescriptor(input, name);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) return null;
    value[name] = slot.value;
  }
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    value.pid > 0xffffffff ||
    typeof value.instanceId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.instanceId)
  )
    return null;
  return value;
}

function reply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(text);
}

// The management router must authenticate before entering this handler. A
// public instance identity is only a stale-target guard, never a credential.
// Acceptance is an intent receipt. Only the observed process's successful exit
// after the existing drain coordinator proves completion to the desktop.
function createProxyStopControl() {
  const identity = Object.freeze({ pid: process.pid, instanceId: randomBytes(16).toString('hex') });
  let managementPort;
  let action,
    requested = false;
  return Object.freeze({
    identity,
    bind(shutdown, port) {
      if (
        action ||
        typeof shutdown !== 'function' ||
        types.isProxy(shutdown) ||
        types.isAsyncFunction(shutdown) ||
        types.isGeneratorFunction(shutdown) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      )
        throw new TypeError('Invalid proxy stop composition');
      action = shutdown;
      managementPort = port;
    },
    handle(req, res) {
      if (!action) return reply(res, 503, { error: 'proxy_stop_unavailable' });
      if (
        req.socket?.localPort !== managementPort ||
        req.socket.localAddress !== '127.0.0.1' ||
        req.socket.remoteAddress !== '127.0.0.1'
      )
        return reply(res, 403, { error: 'proxy_stop_listener_invalid' });
      if (req.headers['content-type'] !== 'application/json')
        return reply(res, 415, { error: 'proxy_stop_request_invalid' });
      let aborted = false;
      req.once('aborted', () => {
        aborted = true;
      });
      readJsonBodyFromRequest(
        req,
        (error, input) => {
          if (aborted || res.destroyed) return;
          const target = error ? null : parseStopIdentity(input);
          if (!target) return reply(res, 400, { error: 'proxy_stop_request_invalid' });
          if (target.pid !== identity.pid || target.instanceId !== identity.instanceId)
            return reply(res, 409, { error: 'proxy_stop_target_changed' });
          if (!action) return reply(res, 503, { error: 'proxy_stop_unavailable' });
          if (requested) return reply(res, 409, { error: 'proxy_stop_in_progress' });
          requested = true;
          let finished = false,
            cancelled = false;
          res.once('finish', () => {
            if (cancelled) return;
            finished = true;
            // Let this authenticated response leave the active request before
            // server.close waits for listeners; never wait for drain inside it.
            setImmediate(action);
          });
          res.once('close', () => {
            if (!finished) {
              cancelled = true;
              requested = false;
            }
          });
          reply(res, 202, { accepted: true, ...identity });
        },
        { maxBytes: 128 }
      );
    },
  });
}

module.exports = { createProxyStopControl, parseStopIdentity };
