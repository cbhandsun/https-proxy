'use strict';

const { types } = require('node:util');
const fail = () => new Error('persistent_filterio_invalid');
const MAX_TICK = 9223372036854775807n;
const LIMITS = Object.freeze({ events: 1000000, files: 256, irps: 8192, spans: 8192 });
const MISMATCHES = Object.freeze([
  'unownedFile',
  'unknownFile',
  'fileLifecycle',
  'unknownIrp',
  'irpLifecycle',
  'generationMismatch',
  'keyMismatch',
  'duplicateInit',
  'missingInit',
  'missingCompletion',
  'outOfOrder',
  'initialTimeMismatch',
  'unfinishedIrp',
  'filterFailure',
  'operationFailure',
]);
function data(input, keys) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const slots = Object.getOwnPropertyDescriptors(input);
  const names = Reflect.ownKeys(slots);
  if (names.length !== keys.length || names.some((key) => !keys.includes(key))) throw fail();
  const result = Object.create(null);
  for (const key of keys) {
    const slot = slots[key];
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    result[key] = slot.value;
  }
  return result;
}
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw fail();
  return value;
}
function identity(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw fail();
  return value;
}
function ticks(value, positive = false) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) throw fail();
  const parsed = BigInt(value);
  if (parsed > MAX_TICK || (positive && parsed === 0n)) throw fail();
  return parsed;
}
function pointer(value, nonzero = false) {
  if (
    typeof value !== 'string' ||
    !/^0x[a-f0-9]{16}$/.test(value) ||
    (nonzero && value === '0x0000000000000000')
  )
    throw fail();
  return value;
}
function clock(input) {
  const result = data(input, ['traceId', 'kind', 'frequency']);
  identity(result.traceId);
  if (result.kind !== 'qpc') throw fail();
  result.frequency = ticks(result.frequency, true);
  return result;
}
function options(input) {
  const result = data(input, ['clock', 'owned']);
  result.clock = clock(result.clock);
  result.owned = data(result.owned, ['pid', 'fixtureTag']);
  integer(result.owned.pid, 0xfffffffe);
  identity(result.owned.fixtureTag);
  return result;
}
const BINDING = ['fileObject', 'fileGeneration', 'irp', 'irpGeneration', 'majorFunction'];
const FILTER = [...BINDING, 'routine', 'fileContext', 'callbackData', 'phase'];
const FIELDS = Object.freeze({
  'file-open': ['fileObject', 'fileGeneration', 'ownerPid', 'fixtureTag', 'kind'],
  'file-close': ['fileObject', 'fileGeneration'],
  'irp-begin': BINDING,
  'irp-end': ['irp', 'irpGeneration', 'ntStatus'],
  'irp-invalidate': ['irp', 'irpGeneration'],
  'filter-init': FILTER,
  'filter-complete': [...FILTER, 'initialTime'],
  'filter-failure': [...FILTER, 'status'],
});
function event(input, expectedClock) {
  // Inspect the discriminator through a data descriptor, never an accessor.
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw fail();
  const slot = Object.getOwnPropertyDescriptor(input, 'type');
  if (
    !slot ||
    !Object.hasOwn(slot, 'value') ||
    typeof slot.value !== 'string' ||
    !Object.hasOwn(FIELDS, slot.value)
  )
    throw fail();
  const result = data(input, ['type', 'clock', 'time', ...FIELDS[slot.value]]);
  const actual = clock(result.clock);
  if (actual.traceId !== expectedClock.traceId || actual.frequency !== expectedClock.frequency)
    throw fail();
  delete result.clock; // Retain only normalized scalars, never the caller's nested object.
  result.time = ticks(result.time);
  for (const name of ['fileObject', 'irp', 'routine', 'fileContext', 'callbackData']) {
    if (Object.hasOwn(result, name))
      pointer(result[name], !['fileContext', 'callbackData'].includes(name));
  }
  for (const name of ['fileGeneration', 'irpGeneration']) {
    if (Object.hasOwn(result, name)) integer(result[name]);
  }
  if (
    Object.hasOwn(result, 'majorFunction') &&
    (!Number.isInteger(result.majorFunction) ||
      result.majorFunction < 0 ||
      result.majorFunction > 255)
  )
    throw fail();
  if (Object.hasOwn(result, 'phase') && !['pre', 'post'].includes(result.phase)) throw fail();
  for (const key of ['status', 'ntStatus']) {
    if (
      Object.hasOwn(result, key) &&
      (!Number.isInteger(result[key]) || result[key] < 0 || result[key] > 0xffffffff)
    )
      throw fail();
  }
  if (result.type === 'filter-complete') result.initialTime = ticks(result.initialTime);
  if (result.type === 'file-open') {
    integer(result.ownerPid, 0xfffffffe);
    identity(result.fixtureTag);
    if (!['database', 'journal'].includes(result.kind)) throw fail();
  }
  return result;
}

module.exports = { fail, LIMITS, MISMATCHES, options, event };
