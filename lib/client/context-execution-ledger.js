'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeCompactionData } = require('../proxy/context-compaction-envelope');

const identity = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const invalid = () => new TypeError('Execution record unavailable');
const LIST_EXECUTIONS_TOOL = 'hpm_list_execution_records';

// Observations, not permission grants or an executor. Completed means the MCP
// result returned; it never certifies business success or independent validation.
function createContextExecutionLedger(options = {}) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
    Reflect.ownKeys(options).some(
      (key) =>
        !['now', 'ttlMs'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')
    )
  )
    throw invalid();
  const { now = Date.now, ttlMs = 30 * 60 * 1000 } = options;
  if (
    typeof now !== 'function' ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 2 * 60 * 60 * 1000
  )
    throw invalid();
  const entries = new Map();
  let time = 0;
  let closed = false;
  function clock() {
    if (closed) throw invalid();
    let next;
    try {
      next = now();
    } catch {
      closed = true;
      entries.clear();
      throw invalid();
    }
    if (
      !Number.isSafeInteger(next) ||
      next < time ||
      next < 0 ||
      next > Number.MAX_SAFE_INTEGER - ttlMs
    ) {
      closed = true;
      entries.clear();
      throw invalid();
    }
    time = next;
    for (const [id, entry] of entries) if (time >= entry.expiresAt) entries.delete(id);
  }
  return {
    begin(toolName) {
      clock();
      if (!identity(toolName) || entries.size >= 128) throw invalid();
      const callId = 'hcx_' + randomUUID().replace(/-/g, '');
      entries.set(callId, {
        callId,
        toolName,
        state: 'running',
        verification: 'not_verified',
        retention: 'pending',
        sourceId: null,
        digest: null,
        expiresAt: time + ttlMs,
      });
      return callId;
    },
    finish(callId, input) {
      clock();
      const value = normalizeCompactionData(input, 1024);
      const entry = entries.get(callId);
      if (
        !entry ||
        entry.state !== 'running' ||
        !value ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'digest,retention,sourceId,state' ||
        !['completed', 'failed', 'unknown'].includes(value.state) ||
        !['retained', 'excluded', 'unavailable'].includes(value.retention) ||
        (value.retention === 'retained'
          ? typeof value.sourceId !== 'string' ||
            !/^hce_[a-f0-9]{32}$/.test(value.sourceId) ||
            typeof value.digest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(value.digest)
          : value.sourceId !== null || value.digest !== null)
      )
        throw invalid();
      Object.assign(entry, value);
    },
    list(input = {}) {
      clock();
      const args = normalizeCompactionData(input, 1024);
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).some((key) => !['afterCallId', 'limit'].includes(key)) ||
        (args.afterCallId !== undefined &&
          (typeof args.afterCallId !== 'string' || !/^hcx_[a-f0-9]{32}$/.test(args.afterCallId))) ||
        (args.limit !== undefined &&
          (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 16))
      )
        throw invalid();
      const all = [...entries.values()];
      const start =
        args.afterCallId === undefined
          ? -1
          : all.findIndex((entry) => entry.callId === args.afterCallId);
      if (args.afterCallId !== undefined && start === -1) throw invalid();
      const selected = all.slice(start + 1, start + 1 + (args.limit ?? 16));
      return {
        ok: true,
        scope: 'connection',
        records: selected.map((entry) => ({ ...entry })),
        nextAfterCallId: start + 1 + selected.length < all.length ? selected.at(-1).callId : null,
      };
    },
    close() {
      closed = true;
      entries.clear();
    },
  };
}

const executionToolDefinition = {
  name: LIST_EXECUTIONS_TOOL,
  description:
    'List bounded observations of tools dispatched through this MCP connection. completed is a returned result, not proof of task success; verification remains not_verified. unknown does not authorize retry. No operation is executed by this reader. Follow nextAfterCallId until null.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      afterCallId: { type: 'string', pattern: '^hcx_[a-f0-9]{32}$' },
      limit: { type: 'integer', minimum: 1, maximum: 16 },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

module.exports = { LIST_EXECUTIONS_TOOL, executionToolDefinition, createContextExecutionLedger };
