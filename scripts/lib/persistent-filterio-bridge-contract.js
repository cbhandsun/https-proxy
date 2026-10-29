'use strict';

const { types } = require('node:util');
const fail = () => new Error('persistent_filterio_bridge_invalid');
const COMMON = ['type', 'time', 'pid', 'tid', 'version', 'opcode'];
const FILTER = ['irp', 'fileObject', 'routine', 'fileContext', 'callbackData', 'majorFunction'];
const fields = {
  name: ['fileKey', 'fixtureTag', 'kind'],
  'name-delete': ['fileKey'],
  create: ['fileObject', 'irp', 'fixtureTag', 'kind'],
  close: ['fileObject', 'irp'],
  'invalidate-irp': ['irp'],
  flush: ['irp', 'fileObject', 'fileKey'],
  end: ['irp', 'ntStatus'],
  'filter-init': FILTER,
  'filter-complete': [...FILTER, 'initialTime'],
  'filter-failure': [...FILTER, 'status'],
};
const opcodes = {
  name: [0, 32, 36],
  'name-delete': [35],
  create: [64],
  close: [66],
  'invalidate-irp': [64, 65, 66, 67, 68, 69, 70, 71, 72, 74, 75, 77],
  flush: [73],
  end: [76],
  'filter-init': [96, 97],
  'filter-complete': [98, 99],
  'filter-failure': [100, 101],
};
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
  if (names.length !== keys.length || names.some((name) => !keys.includes(name))) throw fail();
  const result = {};
  for (const key of keys) {
    if (!slots[key]?.enumerable || !Object.hasOwn(slots[key], 'value')) throw fail();
    result[key] = slots[key].value;
  }
  return result;
}
function tick(value, positive = false) {
  if (typeof value !== 'string' || /[\r\n]/.test(value) || !/^(?:0|[1-9][0-9]{0,18})$/.test(value))
    throw fail();
  const n = BigInt(value);
  if (n > 9223372036854775807n || (positive && !n)) throw fail();
  return n;
}
function identity(value) {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value))
    throw fail();
}
function clock(input) {
  const row = data(input, ['traceId', 'kind', 'frequency']);
  identity(row.traceId);
  if (row.kind !== 'qpc') throw fail();
  tick(row.frequency, true);
  return Object.freeze(row);
}
function event(input) {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw fail();
  const type = Object.getOwnPropertyDescriptor(input, 'type');
  if (
    !type ||
    !Object.hasOwn(type, 'value') ||
    typeof type.value !== 'string' ||
    !Object.hasOwn(fields, type.value)
  )
    throw fail();
  const row = data(input, [...COMMON, ...fields[type.value]]);
  tick(row.time);
  const versions = row.type.startsWith('filter-')
    ? [3]
    : ['name', 'name-delete'].includes(row.type)
      ? [0, 1, 2, 3]
      : [2, 3];
  if (!versions.includes(row.version) || !opcodes[row.type].includes(row.opcode)) throw fail();
  for (const key of ['pid', 'tid', 'ntStatus', 'status', 'majorFunction']) {
    if (
      Object.hasOwn(row, key) &&
      (!Number.isInteger(row[key]) || row[key] < 0 || row[key] > 0xffffffff)
    )
      throw fail();
  }
  for (const key of ['fileKey', 'fileObject', 'irp', 'routine', 'fileContext', 'callbackData']) {
    if (!Object.hasOwn(row, key)) continue;
    if (
      typeof row[key] !== 'string' ||
      row[key].length !== 18 ||
      !/^0x[a-f0-9]{16}$/.test(row[key]) ||
      (!['fileContext', 'callbackData'].includes(key) && row[key] === '0x0000000000000000')
    )
      throw fail();
  }
  if (Object.hasOwn(row, 'fixtureTag')) {
    if (row.fixtureTag === null) {
      if (row.kind !== null) throw fail();
    } else {
      identity(row.fixtureTag);
      if (!['database', 'journal'].includes(row.kind)) throw fail();
    }
  }
  if (row.type === 'filter-complete') tick(row.initialTime);
  return row;
}

function parsePersistentFilterIoRawLine(line) {
  try {
    if (typeof line !== 'string' || Buffer.byteLength(line) > 2048) throw fail();
    const value = JSON.parse(line);
    if (JSON.stringify(value) !== line) throw fail();
    if (value?.type === 'clock') {
      const row = data(value, ['type', 'kind', 'frequency']);
      if (row.kind !== 'qpc') throw fail();
      tick(row.frequency, true);
      return row;
    }
    return event(value);
  } catch {
    throw fail();
  }
}

module.exports = { fail, data, tick, clock, event, parsePersistentFilterIoRawLine };
