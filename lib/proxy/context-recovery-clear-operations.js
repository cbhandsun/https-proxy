'use strict';

const { randomUUID } = require('node:crypto');
const { storageData } = require('./context-recovery-storage-contract');
const { nativeReaderPromise } = require('./context-recovery-reader-result');

const validOperationId = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

// IDs authorize no action on their own. All callers remain behind management
// authentication. Missing IDs are never recreated, including after restart.
function createClearOperations({ execute, clock = Date.now } = {}) {
  if (typeof execute !== 'function' || typeof clock !== 'function')
    throw new TypeError('Invalid clear operation owner');
  const records = new Map();
  let watermark = 0;
  let running = null;
  function sweep() {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 30 * 60 * 1000)
      throw new TypeError('Clear operation clock unavailable');
    watermark = Math.max(watermark, now);
    for (const [id, record] of records) {
      if (record.state !== 'running' && record.expiresAt <= watermark) records.delete(id);
    }
  }
  const error = (code) => ({ ok: false, code });
  const snapshot = (record) => ({
    ok: true,
    scope: 'proxy_context_recovery',
    operationId: record.id,
    state: record.state,
  });
  function lookup(id) {
    sweep();
    return validOperationId(id) ? records.get(id) : null;
  }
  function settle(record, state) {
    record.state = state;
    if (running === record.id) running = null;
  }
  function finish(record, input) {
    try {
      const value = storageData(input, 1024);
      if (value?.ok === true && Object.keys(value).join(',') === 'ok') settle(record, 'succeeded');
      else if (
        value?.ok === false &&
        value.code === 'context_recovery_disabled' &&
        Object.keys(value).sort().join(',') === 'code,ok'
      )
        settle(record, 'disabled');
      else settle(record, 'failed');
    } catch {
      settle(record, 'failed');
    }
  }
  return {
    prepare() {
      sweep();
      if (records.size >= 32) return error('context_recovery_operation_capacity');
      const id = randomUUID();
      const record = { id, state: 'prepared', expiresAt: watermark + 30 * 60 * 1000 };
      records.set(id, record);
      return snapshot(record);
    },
    inspect(id) {
      const record = lookup(id);
      return record ? snapshot(record) : error('context_recovery_operation_unknown');
    },
    cancel(id) {
      const record = lookup(id);
      if (!record) return error('context_recovery_operation_unknown');
      // This synchronous transition races start through the same owner. Once
      // cancelled, delayed/retransmitted starts can never enter execute().
      if (record.state === 'prepared') record.state = 'cancelled';
      return snapshot(record);
    },
    start(id) {
      const record = lookup(id);
      if (!record) return error('context_recovery_operation_unknown');
      if (record.state !== 'prepared') return snapshot(record);
      if (running) return error('context_recovery_operation_busy');
      running = record.id;
      record.state = 'running';
      try {
        const pending = execute();
        if (nativeReaderPromise(pending)) {
          void Promise.prototype.then.call(
            pending,
            (value) => finish(record, value),
            () => settle(record, 'failed')
          );
        } else finish(record, pending);
      } catch {
        settle(record, 'failed');
      }
      return snapshot(record);
    },
  };
}

module.exports = { createClearOperations, validOperationId };
