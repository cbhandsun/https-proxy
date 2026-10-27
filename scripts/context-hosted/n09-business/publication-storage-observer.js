'use strict';
const { types } = require('node:util');
const path = require('node:path');
const { fields, isN09NativePromise } = require('../n09-ack/contract');
const fail = () => new Error('n09_publication_storage_observer_failed');
const states = [
  'unobserved',
  'prepared',
  'sending',
  'transport-finished',
  'uncertain',
  'withdrawn',
];
const capabilities = [
  'Scan',
  'SourcePages',
  'ReaderSettlement',
  'ReferenceWrites',
  'ReferenceStates',
  'ReferenceAdmission',
  'ReferenceScan',
  'ReadSettlement',
];
const empty = () => ({
  operation: 'none',
  transition: 'none',
  rootId: '',
  expiresAt: 0,
  expectedRevision: 0,
});
function own(object, name) {
  if (
    !object ||
    typeof object !== 'object' ||
    types.isProxy(object) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(object))
  )
    throw fail();
  const slot = Object.getOwnPropertyDescriptor(object, name);
  if (!slot || !Object.hasOwn(slot, 'value')) throw fail();
  return slot.value;
}
function describe(request, prior) {
  if (own(request, 'operation') !== 'save-reference-state')
    return { ...empty(), operation: 'other' };
  const scope = own(request, 'scope'),
    expectedRevision = own(request, 'expectedRevision');
  const reference = own(request, 'reference'),
    metadata = own(reference, 'metadata');
  const rootId = own(metadata, 'rootId'),
    expiresAt = own(metadata, 'expiresAt'),
    publications = own(reference, 'publications');
  if (
    typeof scope !== 'string' ||
    !/^[a-f0-9]{64}$/.test(scope) ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    typeof rootId !== 'string' ||
    !/^hbs_[a-f0-9]{32}$/.test(rootId) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 1 ||
    types.isProxy(publications) ||
    !Array.isArray(publications)
  )
    throw fail();
  const length = Object.getOwnPropertyDescriptor(publications, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 512) throw fail();
  const next = new Map();
  for (let i = 0; i < length; i++) {
    const slot = Object.getOwnPropertyDescriptor(publications, String(i));
    if (!slot || !Object.hasOwn(slot, 'value')) throw fail();
    const id = own(slot.value, 'snapshotId'),
      state = own(slot.value, 'state');
    if (
      typeof id !== 'string' ||
      !id.length ||
      id.length > 128 ||
      /[\0\r\n]/.test(id) ||
      !states.includes(state) ||
      next.has(id)
    )
      throw fail();
    next.set(id, state);
  }
  const before = prior.get(scope),
    changes = [];
  if (before) {
    if (before.rootId !== rootId || before.expiresAt !== expiresAt) throw fail();
    for (const [id, state] of next) if (before.publications.get(id) !== state) changes.push(state);
    for (const id of before.publications.keys()) if (!next.has(id)) changes.push('removed');
  }
  return {
    operation: 'save-reference-state',
    transition:
      !before || !changes.length
        ? 'none'
        : changes.length === 1 && states.includes(changes[0])
          ? changes[0]
          : 'ambiguous',
    rootId,
    expiresAt,
    expectedRevision,
    scope,
    publications: next,
  };
}

// Observes the genuine default storage constructor/result before opening imports
// it. The original options, Worker, requests, receiver and promise identities
// remain unchanged. No key/blob/output is retained and no ACK is manufactured.
function installPublicationStorageObserver(input) {
  const { storageExports, storageContract, storageInventory, expectedDirectory } = fields(input, [
    'storageExports',
    'storageContract',
    'storageInventory',
    'expectedDirectory',
  ]);
  const observeCalls = own(storageInventory, 'observeRecoveryStorageCalls');
  if (
    typeof observeCalls !== 'function' ||
    types.isProxy(observeCalls) ||
    types.isAsyncFunction(observeCalls) ||
    types.isGeneratorFunction(observeCalls)
  )
    throw fail();
  if (
    !storageExports ||
    typeof storageExports !== 'object' ||
    types.isProxy(storageExports) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(storageExports))
  )
    throw fail();
  const original = Object.getOwnPropertyDescriptor(storageExports, 'openContextRecoveryStorage');
  if (
    !original ||
    !original.writable ||
    !original.configurable ||
    typeof original.value !== 'function' ||
    types.isProxy(original.value) ||
    typeof expectedDirectory !== 'string' ||
    !path.isAbsolute(expectedDirectory) ||
    /^[\\/]{2}/.test(expectedDirectory) ||
    expectedDirectory.split(/[\\/]/).some((part) => part === '.' || part === '..') ||
    expectedDirectory.length > 4096 ||
    /[\0\r\n]/.test(expectedDirectory)
  )
    throw fail();
  const flags = capabilities.map((name) => ({
    supports: own(storageContract, 'supportsRecovery' + name),
    declare: own(storageContract, 'declareRecovery' + name),
  }));
  if (
    flags.some((pair) =>
      Object.values(pair).some(
        (value) =>
          typeof value !== 'function' ||
          types.isProxy(value) ||
          types.isAsyncFunction(value) ||
          types.isGeneratorFunction(value)
      )
    )
  )
    throw fail();
  let generation = 0,
    callOrdinal = 0,
    closed = false,
    failed = false,
    closeFailed = false;
  let last = { ...empty(), status: 'idle', callOrdinal: 0 };
  const active = new Map(),
    prior = new Map(),
    patches = [];
  function bind(service, ownerGeneration) {
    try {
      if (closed || failed || ownerGeneration !== generation) throw fail();
      own(service, 'execute');
      const slot = Object.getOwnPropertyDescriptor(service, 'execute');
      if (
        !slot ||
        !slot.writable ||
        !slot.configurable ||
        typeof slot.value !== 'function' ||
        types.isProxy(slot.value)
      )
        throw fail();
      function observe(args, pending, threw) {
        if (closed) return;
        let record;
        try {
          if (
            failed ||
            ownerGeneration !== generation ||
            args.length !== 1 ||
            active.size >= 8 ||
            callOrdinal >= 1024
          )
            throw fail();
          record = { ...describe(args[0], prior), callOrdinal: ++callOrdinal, status: 'pending' };
          active.set(record.callOrdinal, record);
        } catch {
          failed = true;
        }
        if (threw) {
          failed = true;
          if (record) active.delete(record.callOrdinal);
          return;
        }
        if (!isN09NativePromise(pending)) {
          failed = true;
          return;
        }
        Reflect.apply(Promise.prototype.then, pending, [
          (result) => {
            if (closed || !record) return;
            try {
              if (ownerGeneration !== generation) throw fail();
              if (record.operation === 'save-reference-state') {
                if (
                  own(result, 'revision') !== record.expectedRevision + 1 ||
                  (prior.size >= 4 && !prior.has(record.scope))
                )
                  throw fail();
                prior.set(record.scope, {
                  rootId: record.rootId,
                  expiresAt: record.expiresAt,
                  publications: record.publications,
                });
              }
              record.status = 'completed';
              last = record;
            } catch {
              failed = true;
            } finally {
              active.delete(record.callOrdinal);
            }
          },
          () => {
            if (!closed) {
              failed = true;
              if (record) active.delete(record.callOrdinal);
            }
          },
        ]);
      }
      const tap = observeCalls(service, observe);
      const execute = tap
        ? own(service, 'execute')
        : function (...args) {
            let pending;
            try {
              pending = Reflect.apply(slot.value, this, args);
            } catch (error) {
              observe(args, undefined, true);
              throw error;
            }
            observe(args, pending, false);
            return pending;
          };
      if (tap) {
        const closeTap = own(tap, 'close');
        if (
          typeof closeTap !== 'function' ||
          types.isProxy(closeTap) ||
          types.isAsyncFunction(closeTap) ||
          types.isGeneratorFunction(closeTap)
        )
          throw fail();
        patches.push({ tap, closeTap });
      }
      for (const pair of flags) {
        const supported = pair.supports(slot.value);
        if (typeof supported !== 'boolean') throw fail();
        if (supported && pair.declare(execute) !== execute) throw fail();
      }
      if (!tap) {
        Object.defineProperty(service, 'execute', { ...slot, value: execute });
        patches.push({ object: service, name: 'execute', original: slot, value: execute });
      }
    } catch {
      failed = true;
    }
  }
  function open(...args) {
    if (closed) return Reflect.apply(original.value, this, args);
    let selected, ownerGeneration;
    try {
      selected = own(args[0], 'directory') === expectedDirectory;
      if (selected) {
        if (
          closed ||
          failed ||
          args.length !== 1 ||
          generation >= 16 ||
          active.size ||
          Reflect.ownKeys(args[0]).some((name) => !['directory', 'onStartup'].includes(name))
        )
          throw fail();
        ownerGeneration = ++generation;
        prior.clear();
        callOrdinal = 0;
        last = { ...empty(), status: 'idle', callOrdinal: 0 };
      }
    } catch {
      failed = true;
      throw fail();
    }
    const pending = Reflect.apply(original.value, this, args);
    if (selected && !closed) {
      if (!isN09NativePromise(pending)) failed = true;
      else
        Reflect.apply(Promise.prototype.then, pending, [
          (service) => bind(service, ownerGeneration),
          () => {
            if (!closed) failed = true;
          },
        ]);
    }
    return pending;
  }
  Object.defineProperty(storageExports, 'openContextRecoveryStorage', { ...original, value: open });
  patches.push({
    object: storageExports,
    name: 'openContextRecoveryStorage',
    original,
    value: open,
  });
  return Object.freeze({
    inspect() {
      if (closed) throw fail();
      const record =
        failed || active.size > 1
          ? { ...empty(), status: failed ? 'failed' : 'ambiguous', callOrdinal }
          : active.size
            ? [...active.values()][0]
            : last;
      const { operation, transition, rootId, expiresAt, expectedRevision, status } = record;
      return Object.freeze({
        generation,
        callOrdinal: record.callOrdinal,
        activeCount: active.size,
        operation,
        transition,
        rootId,
        expiresAt,
        expectedRevision,
        status,
      });
    },
    close() {
      if (closed) {
        if (closeFailed) throw fail();
        return;
      }
      closed = true;
      active.clear();
      prior.clear();
      for (const entry of patches.reverse()) {
        if (entry.tap) {
          try {
            if (Reflect.apply(entry.closeTap, entry.tap, []) !== undefined) throw fail();
          } catch {
            closeFailed = true;
          }
          continue;
        }
        const current = Object.getOwnPropertyDescriptor(entry.object, entry.name);
        if (
          !current ||
          current.value !== entry.value ||
          current.enumerable !== entry.original.enumerable ||
          current.writable !== entry.original.writable ||
          current.configurable !== entry.original.configurable
        ) {
          closeFailed = true;
          continue;
        }
        try {
          Object.defineProperty(entry.object, entry.name, entry.original);
        } catch {
          closeFailed = true;
        }
      }
      patches.length = 0;
      if (closeFailed) throw fail();
    },
  });
}
module.exports = { installPublicationStorageObserver };
