'use strict';

// Explicit test-only retained authority. It never reads/writes the store directory,
// invokes native helpers or touches HKCU. Keep one factory per fixture lifetime so
// reopening or restoring SQLite files cannot reset its independently retained slot.
const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { storageDirectory } = require('../../lib/proxy/context-recovery-storage-paths');
const { keyRequest } = require('../../lib/proxy/context-recovery-key-contract');
const { storageFailure } = require('../../lib/proxy/context-recovery-storage-contract');
const {
  parseAnchorSnapshot,
  assertAnchorSuccessor,
} = require('../../lib/proxy/context-recovery-anchor-contract');
const hash = (value) => createHash('sha256').update(value).digest('hex');

function createSyntheticRetainedAnchorFactory() {
  const slots = new Map();
  return function createAnchorRepository(input) {
    try {
      if (
        !input ||
        typeof input !== 'object' ||
        types.isProxy(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      )
        throw storageFailure();
      const names = Reflect.ownKeys(input);
      if (names.length !== 2 || names.some((name) => !['directory', 'dataKey'].includes(name)))
        throw storageFailure();
      const options = Object.create(null);
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          types.isProxy(descriptor.value)
        )
          throw storageFailure();
        options[name] = descriptor.value;
      }
      const directory = storageDirectory(options.directory);
      const dataKey = keyRequest({ operation: 'protect', value: options.dataKey }).value;
      const keyIdentity = hash('hpm.synthetic.anchor/key/v1\0' + dataKey);
      const locationHash = hash(
        'hpm.synthetic.anchor/location/v1\0' +
          (process.platform === 'win32' ? directory.toLowerCase() : directory)
      );
      const identity = Object.freeze({ keyIdentity, locationHash });
      let revision;
      let snapshot;
      let closed = false;
      function close() {
        closed = true;
        snapshot = undefined;
      }
      function guarded(operation) {
        try {
          if (closed) throw storageFailure();
          return operation();
        } catch {
          close();
          throw storageFailure();
        }
      }
      function bound(value) {
        const parsed = parseAnchorSnapshot(value);
        if (parsed.keyIdentity !== keyIdentity || parsed.locationHash !== locationHash)
          throw storageFailure();
        return parsed;
      }
      return Object.freeze({
        identity,
        read() {
          return guarded(() => {
            if (revision !== undefined) throw storageFailure();
            const retained = slots.get(keyIdentity);
            revision = retained?.revision ?? 0;
            snapshot = retained ? bound(retained.snapshot) : null;
            return snapshot;
          });
        },
        commit(value) {
          return guarded(() => {
            if (
              revision === undefined ||
              revision === Number.MAX_SAFE_INTEGER ||
              revision !== (slots.get(keyIdentity)?.revision ?? 0)
            )
              throw storageFailure();
            const next = bound(value);
            if (snapshot !== null) assertAnchorSuccessor(snapshot, next);
            const nextRevision = revision + 1;
            slots.set(keyIdentity, Object.freeze({ revision: nextRevision, snapshot: next }));
            revision = nextRevision;
            snapshot = next;
            return Object.freeze({ revision });
          });
        },
        close,
      });
    } catch {
      throw storageFailure();
    }
  };
}
module.exports = { createSyntheticRetainedAnchorFactory };
