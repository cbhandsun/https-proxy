'use strict';

const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');

const methodName = (value) =>
  typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9/_.-]{0,127}$/.test(value);
const requestId = (value) =>
  (Number.isSafeInteger(value) && value >= 0) ||
  (typeof value === 'string' && value.length > 0 && value.length <= 256);
const error = (code) => Object.assign(new Error('Isolated native RPC failed'), { code });

// Local child-process transport only. Never forwards diagnostics/remote error
// strings to reports; caller callbacks own thread/turn/tool authorization.
function createNativeLoopbackRpc(child, handlers = {}) {
  if (
    !handlers ||
    typeof handlers !== 'object' ||
    Array.isArray(handlers) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(handlers))
  )
    throw error('native_rpc_options_invalid');
  const safeHandlers = {};
  for (const key of Reflect.ownKeys(handlers)) {
    const descriptor = Object.getOwnPropertyDescriptor(handlers, key);
    if (
      !['timeoutMs', 'onFailure', 'onNotification', 'onServerRequest'].includes(key) ||
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable ||
      (key !== 'timeoutMs' && typeof descriptor.value !== 'function')
    )
      throw error('native_rpc_options_invalid');
    safeHandlers[key] = descriptor.value;
  }
  handlers = safeHandlers;
  const timeoutMs = Object.hasOwn(handlers, 'timeoutMs') ? handlers.timeoutMs : 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000)
    throw error('native_rpc_options_invalid');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let sequence = 0;
  let failed = null;
  let notifications = 0;
  let serverRequests = 0;
  let diagnosticBytes = 0;
  const pending = new Map();
  const seenServerIds = new Set();
  const waiting = new Set();

  function fail(code) {
    if (failed) return;
    failed = error(code);
    for (const entry of [...pending.values(), ...waiting]) {
      clearTimeout(entry.timer);
      entry.reject(failed);
    }
    pending.clear();
    waiting.clear();
    try {
      if (handlers.onFailure) handlers.onFailure(code);
    } catch {
      failed = error('native_rpc_observer_failed');
    }
  }

  function send(value) {
    if (failed) throw failed;
    const safe = normalizeCompactionData(value, 2 * 1024 * 1024);
    if (!child.stdin.writable || child.stdin.destroyed) {
      fail('native_rpc_unavailable');
      throw failed;
    }
    try {
      child.stdin.write(JSON.stringify(safe) + '\n');
    } catch {
      fail('native_rpc_send_failed');
      throw failed;
    }
  }

  function receive(value) {
    if (failed) return;
    if (
      (Object.hasOwn(value, 'jsonrpc') && value.jsonrpc !== '2.0') ||
      (Object.hasOwn(value, 'method') &&
        (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error')))
    )
      return fail('native_rpc_invalid_message');
    if (Object.hasOwn(value, 'id') && !Object.hasOwn(value, 'method')) {
      if (!requestId(value.id)) return fail('native_rpc_invalid_reply');
      const entry = pending.get(value.id);
      if (!entry) return fail('native_rpc_unexpected_reply');
      pending.delete(value.id);
      clearTimeout(entry.timer);
      if (Object.hasOwn(value, 'error') && Object.hasOwn(value, 'result')) {
        entry.reject(error('native_rpc_invalid_reply'));
        fail('native_rpc_invalid_reply');
      } else if (Object.hasOwn(value, 'error')) entry.reject(error('native_rpc_rejected'));
      else if (Object.hasOwn(value, 'result')) entry.resolve(value.result);
      else {
        entry.reject(error('native_rpc_invalid_reply'));
        fail('native_rpc_invalid_reply');
      }
      return;
    }
    if (!methodName(value.method)) return fail('native_rpc_invalid_message');
    if (Object.hasOwn(value, 'id')) {
      if (
        !requestId(value.id) ||
        seenServerIds.has(value.id) ||
        !handlers.onServerRequest ||
        ++serverRequests > 128
      )
        return fail('native_rpc_server_request_refused');
      seenServerIds.add(value.id);
      Promise.resolve()
        .then(() => handlers.onServerRequest(value))
        .then((result) => {
          if (!failed) send({ id: value.id, result });
        })
        .catch(() => fail('native_rpc_server_request_refused'));
      return;
    }
    if (++notifications > 4096) return fail('native_rpc_notification_limit');
    try {
      if (handlers.onNotification) handlers.onNotification(value);
      for (const entry of [...waiting]) {
        if (value.method !== entry.method || !entry.predicate(value.params)) continue;
        waiting.delete(entry);
        clearTimeout(entry.timer);
        entry.resolve(value.params);
      }
    } catch {
      fail('native_rpc_observer_failed');
    }
  }

  child.stdout.on('data', (chunk) => {
    if (failed) return;
    try {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > 2 * 1024 * 1024) return fail('native_rpc_line_too_large');
        if (!line.trim()) continue;
        const value = normalizeCompactionData(JSON.parse(line), 2 * 1024 * 1024);
        if (!value || typeof value !== 'object' || Array.isArray(value))
          return fail('native_rpc_invalid_message');
        receive(value);
      }
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) fail('native_rpc_line_too_large');
    } catch {
      fail('native_rpc_invalid_message');
    }
  });
  child.stderr.on('data', (chunk) => {
    diagnosticBytes += chunk.length;
  });
  child.stdout.on('end', () => {
    if (failed) return;
    try {
      buffer += decoder.decode();
      if (buffer.trim()) fail('native_rpc_truncated_stream');
      else fail('native_rpc_stream_closed');
    } catch {
      fail('native_rpc_invalid_message');
    }
  });
  child.stdout.on('error', () => fail('native_rpc_stream_failed'));
  child.stdin.on('error', () => fail('native_rpc_stream_failed'));
  child.stderr.on('error', () => fail('native_rpc_stream_failed'));
  child.on('error', () => fail('native_process_spawn_failed'));
  child.on('exit', () => fail('native_process_exited'));
  child.on('close', () => fail('native_process_exited'));

  return {
    notify(method, params) {
      if (!methodName(method)) throw error('native_rpc_options_invalid');
      send(params === undefined ? { method } : { method, params });
    },
    call(method, params) {
      if (failed) return Promise.reject(failed);
      if (!methodName(method) || pending.size >= 32 || sequence >= 4096)
        return Promise.reject(error('native_rpc_options_invalid'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail('native_rpc_timeout'), timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          send(params === undefined ? { id, method } : { id, method, params });
        } catch {
          fail('native_rpc_send_failed');
        }
      });
    },
    waitFor(method, predicate = () => true, waitTimeoutMs = timeoutMs) {
      if (failed) return Promise.reject(failed);
      if (
        !methodName(method) ||
        typeof predicate !== 'function' ||
        waiting.size >= 8 ||
        !Number.isSafeInteger(waitTimeoutMs) ||
        waitTimeoutMs < 10 ||
        waitTimeoutMs > 120000
      )
        return Promise.reject(error('native_rpc_options_invalid'));
      return new Promise((resolve, reject) => {
        const entry = {
          method,
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => fail('native_rpc_timeout'), waitTimeoutMs),
        };
        waiting.add(entry);
      });
    },
    inspect() {
      return {
        pending: pending.size,
        waiters: waiting.size,
        notifications,
        serverRequests,
        diagnosticBytes,
        failureCode: failed?.code ?? null,
      };
    },
    close() {
      fail('native_rpc_closed');
    },
  };
}

module.exports = { createNativeLoopbackRpc };
