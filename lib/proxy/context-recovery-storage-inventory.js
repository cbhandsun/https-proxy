'use strict';

const { types } = require('node:util');
const { storageFailure } = require('./context-recovery-storage-contract');
const inventories = new WeakMap();
const writes = new Set([
  'save',
  'save-reference',
  'save-reference-state',
  'settle-reader',
  'read-source-and-settle',
  'revoke',
  'revoke-all',
  'revoke-scopes',
  'sweep',
]);
// These observations can remove expired rows, but cannot introduce an eligible
// root identity. Unknown future operations must invalidate the optimization.
const observations = new Set([
  'catalog',
  'scan',
  'scan-reference',
  'inspect',
  'load',
  'load-reference',
  'read-source',
]);
function method(service) {
  if (
    !service ||
    typeof service !== 'object' ||
    types.isProxy(service) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(service))
  )
    return null;
  const slot = Object.getOwnPropertyDescriptor(service, 'execute');
  return slot &&
    Object.hasOwn(slot, 'value') &&
    typeof slot.value === 'function' &&
    !types.isProxy(slot.value)
    ? slot.value
    : null;
}
function snapshot(service) {
  const entry = inventories.get(service);
  if (
    !entry ||
    entry.guards.some(([owner, execute]) => method(owner) !== execute) ||
    !entry.state.valid ||
    entry.state.pending
  )
    return null;
  return entry.state.version;
}

// Private service provenance, not a public request/result or authorization.
// Track writes from every caller, including callers outside the session owner.
function createRecoveryStorageInventory(service) {
  const execute = method(service);
  if (!execute || inventories.has(service)) throw storageFailure();
  const state = { version: 0, pending: 0, valid: true };
  inventories.set(service, { state, guards: [[service, execute]] });
  return Object.freeze({
    begin(operation) {
      if (!state.valid || observations.has(operation)) return () => {};
      // Reserve space for every outstanding completion as well as this write.
      if (state.version > Number.MAX_SAFE_INTEGER - state.pending - 2) {
        state.valid = false;
        return () => {};
      }
      state.version++;
      state.pending++;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        state.version++;
        state.pending--;
      };
    },
    close() {
      state.valid = false;
    },
  });
}

// Only trusted composition may preserve provenance through an unchanged facade.
// Ordinary/injected adapters do not acquire this fact from capability flags.
function aliasRecoveryStorageInventory(alias, source) {
  const execute = method(alias),
    entry = inventories.get(source);
  if (
    !execute ||
    inventories.has(alias) ||
    !entry ||
    entry.guards.length >= 8 ||
    entry.guards.some(([owner, original]) => method(owner) !== original)
  )
    return false;
  inventories.set(alias, { state: entry.state, guards: [...entry.guards, [alias, execute]] });
  return true;
}

// Trusted observation uses this fixed delegating wrapper. It cannot replace a
// result, manufacture an ACK, bypass native mutation tracking or add authority.
function observeRecoveryStorageCalls(service, observe) {
  const entry = inventories.get(service);
  if (!entry) return null;
  const original = method(service);
  const slot = Object.getOwnPropertyDescriptor(service, 'execute');
  if (
    snapshot(service) === null ||
    entry.state.observing ||
    !slot?.writable ||
    !slot.configurable ||
    typeof observe !== 'function' ||
    types.isProxy(observe) ||
    types.isAsyncFunction(observe) ||
    types.isGeneratorFunction(observe)
  )
    throw storageFailure();
  const guard = entry.guards.find(([owner]) => owner === service);
  if (!guard || guard[1] !== original) throw storageFailure();
  let installed = true,
    failed = false,
    closeFailed = false;
  function report(args, result, threw) {
    if (failed) return;
    try {
      const returned = observe(args, result, threw);
      if (returned !== undefined) {
        if (types.isPromise(returned))
          Promise.prototype.then.call(
            returned,
            () => {},
            () => {}
          );
        throw storageFailure();
      }
    } catch {
      failed = true;
      entry.state.valid = false;
    }
  }
  function execute(...args) {
    if (!installed) return Reflect.apply(original, this, args);
    let result;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      report(args, undefined, true);
      throw error;
    }
    report(args, result, false);
    return result;
  }
  Object.defineProperty(service, 'execute', { ...slot, value: execute });
  guard[1] = execute;
  entry.state.observing = true;
  return Object.freeze({
    close() {
      if (!installed) {
        if (closeFailed) throw storageFailure();
        return;
      }
      installed = false;
      const current = Object.getOwnPropertyDescriptor(service, 'execute');
      if (
        !current ||
        current.value !== execute ||
        current.enumerable !== slot.enumerable ||
        current.writable !== slot.writable ||
        current.configurable !== slot.configurable
      ) {
        entry.state.valid = false;
        closeFailed = true;
        throw storageFailure();
      }
      try {
        Object.defineProperty(service, 'execute', slot);
        guard[1] = original;
        entry.state.observing = false;
      } catch {
        entry.state.valid = false;
        closeFailed = true;
      }
      closeFailed ||= failed;
      if (closeFailed) throw storageFailure();
    },
  });
}

// The existing denial index is a superset of eligible stored root identities.
// A certificate never retains a checkpoint, plaintext or read capability.
function createRecoveryRootInventory(storage, roots) {
  if (!types.isMap(roots) || types.isProxy(roots)) throw storageFailure();
  let certificate = null;
  let discoveryClean = false;
  return Object.freeze({
    beforeDiscovery() {
      certificate = null;
      discoveryClean = true;
      return snapshot(storage);
    },
    completeDiscovery(before) {
      const after = snapshot(storage);
      // A lazy native service may not exist before discovery. Zero proves that
      // no caller has written since that service opened, including during scan.
      certificate =
        discoveryClean && after !== null && (after === before || (before === null && after === 0))
          ? after
          : null;
    },
    invalidate() {
      certificate = null;
      discoveryClean = false;
    },
    begin(operation) {
      const before = snapshot(storage);
      if (before === null || before !== certificate) certificate = null;
      let finished = false;
      return (success) => {
        if (finished) return;
        finished = true;
        const after = snapshot(storage);
        if (
          success === true &&
          (writes.has(operation) || observations.has(operation)) &&
          before !== null &&
          certificate === before &&
          after === before + (writes.has(operation) ? 2 : 0)
        )
          certificate = after;
        else certificate = null;
      };
    },
    allActive(active) {
      if (
        certificate === null ||
        snapshot(storage) !== certificate ||
        !types.isSet(active) ||
        types.isProxy(active)
      )
        return false;
      for (const id of Map.prototype.keys.call(roots))
        if (!Set.prototype.has.call(active, id)) return false;
      return true;
    },
  });
}

module.exports = {
  createRecoveryStorageInventory,
  aliasRecoveryStorageInventory,
  observeRecoveryStorageCalls,
  createRecoveryRootInventory,
};
