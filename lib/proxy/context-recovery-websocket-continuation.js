'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { RECOVERY_TTL_MS } = require('./context-recovery-limits');

const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const unavailable = () => new Error('Recovery WebSocket continuation unavailable');

// A connection-local join of already completed read-only results to the next
// external tool outputs. Public response IDs are lookup keys, never authority:
// both the original live session and the newly admitted session must authorize.
// No external tool is executed here. Records survive forks until expiry/close.
function createRecoveryWebSocketContinuations({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw unavailable();
  const entries = new Map();
  const tokens = new WeakMap();
  let bytes = 0,
    timer,
    closed = false,
    last = 0;
  function remove(entry) {
    if (entries.get(entry.id) !== entry) return;
    entries.delete(entry.id);
    bytes -= entry.bytes;
    entry.input = [];
  }
  function close() {
    closed = true;
    clearTimeout(timer);
    timer = undefined;
    for (const entry of entries.values()) remove(entry);
  }
  function sweep() {
    if (closed) return;
    let time;
    try {
      time = now();
    } catch {
      close();
      return;
    }
    if (!Number.isSafeInteger(time) || time < last || time < 0) {
      close();
      return;
    }
    last = time;
    for (const entry of entries.values()) {
      let allowed;
      try {
        allowed = entry.available() === true;
      } catch {
        allowed = false;
      }
      if (!allowed || entry.expiresAt <= time) remove(entry);
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (closed || !entries.size) return;
    const remaining = Math.min(...[...entries.values()].map((entry) => entry.expiresAt - last));
    timer = setTimeout(
      () => {
        sweep();
        schedule();
      },
      Math.max(1, Math.min(1000, remaining))
    );
    timer.unref();
  }
  return {
    reserve(id, input, expiresAt, available) {
      sweep();
      if (
        closed ||
        !identity(id) ||
        entries.has(id) ||
        entries.size >= 256 ||
        typeof available !== 'function' ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= last ||
        expiresAt - last > RECOVERY_TTL_MS
      )
        throw unavailable();
      const safe = normalizeCompactionData(input, MAX_WIRE_BYTES);
      if (
        !Array.isArray(safe) ||
        !safe.length ||
        safe.length > 16 ||
        safe.some(
          (item) =>
            !item ||
            Array.isArray(item) ||
            Object.keys(item).sort().join(',') !== 'call_id,output,type' ||
            item.type !== 'function_call_output' ||
            !identity(item.call_id) ||
            typeof item.output !== 'string'
        ) ||
        new Set(safe.map((item) => item.call_id)).size !== safe.length
      )
        throw unavailable();
      const size = Buffer.byteLength(JSON.stringify(safe));
      if (size + bytes > MAX_WIRE_BYTES || available() !== true) throw unavailable();
      const entry = { id, input: safe, expiresAt, available, bytes: size, ready: false };
      const token = Object.freeze({});
      entries.set(id, entry);
      tokens.set(token, entry);
      bytes += size;
      schedule();
      return token;
    },
    commit(token) {
      sweep();
      const entry = tokens.get(token);
      if (closed || !entry || entries.get(entry.id) !== entry || entry.ready) throw unavailable();
      entry.ready = true;
    },
    discard(token) {
      const entry = tokens.get(token);
      if (entry) remove(entry);
      schedule();
    },
    read(id, authorized) {
      sweep();
      const entry = entries.get(id);
      if (!entry) return [];
      if (closed || authorized !== true || !entry.ready) throw unavailable();
      return normalizeCompactionData(entry.input, MAX_WIRE_BYTES);
    },
    blocked(id) {
      sweep();
      return entries.get(id)?.ready === false;
    },
    close,
    inspect() {
      sweep();
      return { closed, records: entries.size, bytes };
    },
  };
}

module.exports = { createRecoveryWebSocketContinuations };
