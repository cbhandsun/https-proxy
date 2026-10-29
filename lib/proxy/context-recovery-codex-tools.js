'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const FORMAT = 'codex-additional-tools-v1';
const invalid = () => new TypeError('Invalid Codex tool inventory');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseCodexToolInventory(input) {
  const value = normalizeCompactionData(input, 2 * 1024 * 1024);
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !== 'id,role,tools,type' ||
    value.type !== 'additional_tools' ||
    value.role !== 'developer' ||
    typeof value.id !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.id) ||
    !Array.isArray(value.tools) ||
    value.tools.length > 1024 ||
    !value.tools.every(record)
  )
    throw invalid();
  return value;
}

// The protocol parser supplies bounded JSON history. Inspect descriptors as
// well so accidental direct use cannot execute an input accessor.
function codexToolInventory(history) {
  if (!Array.isArray(history) || Object.getPrototypeOf(history) !== Array.prototype)
    throw invalid();
  const length = Object.getOwnPropertyDescriptor(history, 'length')?.value;
  if (
    !Number.isSafeInteger(length) ||
    length > 16384 ||
    Reflect.ownKeys(history).length !== length + 1
  )
    throw invalid();
  let inventory = null;
  for (let index = 0; index < length; index++) {
    const slot = Object.getOwnPropertyDescriptor(history, String(index));
    if (
      !slot?.enumerable ||
      !Object.hasOwn(slot, 'value') ||
      !record(slot.value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(slot.value))
    )
      throw invalid();
    const type = Object.getOwnPropertyDescriptor(slot.value, 'type');
    if (type && (!type.enumerable || !Object.hasOwn(type, 'value'))) throw invalid();
    if (type?.value !== 'additional_tools') continue;
    if (index !== 0 || inventory) throw invalid();
    inventory = parseCodexToolInventory(slot.value);
  }
  return inventory;
}

function codexToolsIdentityFormat(protocol, policy) {
  if (!record(policy) || !Object.hasOwn(policy, 'codexAdditionalTools')) return undefined;
  if (protocol !== 'responses') throw invalid();
  const slot = Object.getOwnPropertyDescriptor(policy, 'codexAdditionalTools');
  if (!slot.enumerable || !Object.hasOwn(slot, 'value')) throw invalid();
  parseCodexToolInventory(slot.value);
  return FORMAT;
}

function codexRecoveryPolicyIdentity(policy, history) {
  const value = normalizeCompactionData(policy, 2 * 1024 * 1024);
  if (!record(value) || Object.hasOwn(value, 'codexAdditionalTools')) throw invalid();
  const inventory = codexToolInventory(history);
  return inventory ? { ...value, codexAdditionalTools: inventory } : value;
}

// Only the compaction continuity chain uses this identity. Normal binding and
// private history retain every original field. The complete inventory also
// belongs to the ordinary policy scope, including its native id.
function codexCompactionItemIdentity(item, index, format) {
  if (format !== FORMAT || index !== 0 || !record(item)) return item;
  const type = Object.getOwnPropertyDescriptor(item, 'type');
  if (type && (!type.enumerable || !Object.hasOwn(type, 'value'))) throw invalid();
  if (type?.value !== 'additional_tools') return item;
  parseCodexToolInventory(item);
  return { type: 'additional_tools', role: 'developer', tools: [] };
}

module.exports = {
  CODEX_TOOLS_IDENTITY_FORMAT: FORMAT,
  codexToolInventory,
  codexToolsIdentityFormat,
  codexCompactionItemIdentity,
  codexRecoveryPolicyIdentity,
};
