'use strict';

const { types } = require('node:util');
const { RECOVERY_TTL_MS } = require('./context-recovery-limits');
const { storageFailure } = require('./context-recovery-storage-contract');

const snapshotKeys = ['version', 'storeId', 'keyIdentity', 'locationHash', 'maxTime', 'scopes'];
const scopeKeys = ['scope', 'revision', 'createdAt', 'expiresAt', 'kind', 'tag'];
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const hash = (value, length) =>
  typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);

// Read each own descriptor once. No getter, coercion or Proxy trap is executed;
// the fixed schema never recursively visits unknown/cyclic input properties.
function record(input, keys) {
  if (input === null || typeof input !== 'object' || types.isProxy(input)) throw storageFailure();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw storageFailure();
  const names = Reflect.ownKeys(input);
  if (names.length !== keys.length) throw storageFailure();
  const values = Object.create(null);
  for (const name of names) {
    if (typeof name !== 'string' || !keys.includes(name)) throw storageFailure();
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw storageFailure();
    values[name] = descriptor.value;
  }
  return values;
}

function scopes(input) {
  if (
    input === null ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  )
    throw storageFailure();
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  if (!integer(length) || length > 256 || Reflect.ownKeys(input).length !== length + 1)
    throw storageFailure();
  const output = [];
  let previous;
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw storageFailure();
    const row = record(descriptor.value, scopeKeys);
    if (
      !hash(row.scope, 64) ||
      !integer(row.revision) ||
      row.revision === 0 ||
      !integer(row.createdAt) ||
      !integer(row.expiresAt) ||
      row.expiresAt <= row.createdAt ||
      row.expiresAt - row.createdAt > RECOVERY_TTL_MS ||
      !['state', 'revoked'].includes(row.kind) ||
      !hash(row.tag, 64) ||
      (previous !== undefined && row.scope <= previous)
    )
      throw storageFailure();
    output.push(
      Object.freeze({
        scope: row.scope,
        revision: row.revision,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        kind: row.kind,
        tag: row.tag,
      })
    );
    previous = row.scope;
  }
  return Object.freeze(output);
}

function parseAnchorSnapshot(input) {
  try {
    const value = record(input, snapshotKeys);
    if (
      value.version !== 1 ||
      !hash(value.storeId, 32) ||
      !hash(value.keyIdentity, 64) ||
      !hash(value.locationHash, 64) ||
      !integer(value.maxTime)
    )
      throw storageFailure();
    return Object.freeze({
      version: 1,
      storeId: value.storeId,
      keyIdentity: value.keyIdentity,
      locationHash: value.locationHash,
      maxTime: value.maxTime,
      scopes: scopes(value.scopes),
    });
  } catch {
    throw storageFailure();
  }
}

// Returns an independently validated frozen current snapshot. Enrollment with
// no previous anchor is a separate trusted operation, never a null bypass here.
function assertAnchorSuccessor(previousInput, currentInput) {
  const previous = parseAnchorSnapshot(previousInput);
  const current = parseAnchorSnapshot(currentInput);
  if (
    ['storeId', 'keyIdentity', 'locationHash'].some((key) => previous[key] !== current[key]) ||
    current.maxTime < previous.maxTime
  )
    throw storageFailure();
  const indexed = new Map(current.scopes.map((row) => [row.scope, row]));
  for (const old of previous.scopes) {
    const row = indexed.get(old.scope);
    const expired = current.maxTime >= old.expiresAt;
    if (!row) {
      if (!expired) throw storageFailure();
      continue;
    }
    // Real engine save prunes expired rows before looking up prior revision.
    // A new lifetime starts at/after the former deadline; an expired clock alone
    // does not authorize restoring a prior revision within the old lifetime.
    if (expired && row.createdAt >= old.expiresAt) continue;
    if (
      row.createdAt !== old.createdAt ||
      row.expiresAt > old.expiresAt ||
      row.revision < old.revision ||
      (old.kind === 'revoked' && row.kind !== 'revoked')
    )
      throw storageFailure();
    if (
      row.revision === old.revision &&
      ['tag', 'kind', 'createdAt', 'expiresAt'].some((key) => row[key] !== old[key])
    )
      throw storageFailure();
  }
  return current;
}

module.exports = { parseAnchorSnapshot, assertAnchorSuccessor };
