'use strict';

const { types } = require('node:util');
const receipts = new WeakMap();
const operations = new Set([
  'open',
  'advance',
  'begin',
  'reply',
  'complete',
  'abort',
  'reopen',
  'close',
]);
const stages = new Set([
  'storage-open',
  'storage-admission',
  'storage-initialize',
  'storage-configure',
  'runtime-shutdown',
  'storage-close',
  'advance',
  'begin',
  'reply',
  'complete',
  'abort',
]);
const failure = () => new Error('persistent_capacity_execution_failed');
function parse(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 4
  )
    throw failure();
  const value = Object.create(null);
  for (const name of ['operation', 'stage', 'commandIndex', 'scheduledMs']) {
    const slot = Object.getOwnPropertyDescriptor(input, name);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw failure();
    value[name] = slot.value;
  }
  if (
    !operations.has(value.operation) ||
    !stages.has(value.stage) ||
    !Number.isSafeInteger(value.commandIndex) ||
    value.commandIndex < 1 ||
    !Number.isSafeInteger(value.scheduledMs) ||
    value.scheduledMs < 0 ||
    value.scheduledMs > 86400000
  )
    throw failure();
  return Object.freeze(value);
}

// Only an owned result/error can carry this receipt. Never inspect an external
// exception or retain it, its message, stack, request, response or checkpoint.
function declareCapacityFailure(owner, primary, cleanup) {
  if (!owner || typeof owner !== 'object' || types.isProxy(owner)) throw failure();
  if (primary === undefined) {
    if (cleanup !== undefined) throw failure();
    return owner;
  }
  const value = { primary: parse(primary) };
  if (cleanup !== undefined) value.cleanup = parse(cleanup);
  receipts.set(owner, Object.freeze(value));
  return owner;
}
function capacityFailureReceipt(owner) {
  return receipts.get(owner) ?? null;
}
module.exports = { declareCapacityFailure, capacityFailureReceipt };
