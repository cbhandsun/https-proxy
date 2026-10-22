'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { storageDirectory } = require('./context-recovery-storage-paths');
const { storageData, storageFailure } = require('./context-recovery-storage-contract');
const { nativeReaderPromise } = require('./context-recovery-reader-result');

async function resolved(reply) {
  return storageData(nativeReaderPromise(reply) ? await reply : reply, 1024);
}

// Clears an existing, currently inactive store through the same authenticated
// worker/revocation boundary. Never unlinks the database or its denial
// tombstones, creates a missing store, or imports stored data as read authority.
async function clearInactiveRecoveryStorage(options) {
  let directory,
    openStorage,
    shutdown,
    closeAttempted = false;
  try {
    if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options)))
      throw storageFailure();
    const values = Object.create(null);
    for (const name of Reflect.ownKeys(options)) {
      const slot = Object.getOwnPropertyDescriptor(options, name);
      if (
        !['directory', 'openStorage'].includes(name) ||
        !slot.enumerable ||
        !Object.hasOwn(slot, 'value')
      )
        throw storageFailure();
      values[name] = slot.value;
    }
    directory = storageDirectory(values.directory);
    openStorage = values.openStorage;
    if (openStorage !== undefined && typeof openStorage !== 'function') throw storageFailure();
    let stat;
    try {
      stat = await fs.promises.lstat(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw storageFailure();
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageFailure();
    try {
      const database = await fs.promises.lstat(path.join(directory, 'checkpoint.sqlite'));
      if (!database.isFile() || database.isSymbolicLink() || database.nlink !== 1)
        throw storageFailure();
    } catch (error) {
      if (error?.code === 'ENOENT' && (await fs.promises.readdir(directory)).length === 0) return;
      throw storageFailure();
    }
    // Only an existing validated store needs the persistence execution graph.
    // Loading failures remain inside the owned clear transaction.
    const {
      openContextRecoveryStorage,
      validateStorageResult,
    } = require('./context-recovery-storage');
    const pending = (openStorage ?? openContextRecoveryStorage)({ directory });
    const owner = nativeReaderPromise(pending) ? await pending : pending;
    if (!owner || ![Object.prototype, null].includes(Object.getPrototypeOf(owner)))
      throw storageFailure();
    const close = Object.getOwnPropertyDescriptor(owner, 'close');
    if (typeof close?.value === 'function') shutdown = close.value.bind(owner);
    const execute = Object.getOwnPropertyDescriptor(owner, 'execute');
    if (
      !shutdown ||
      !close.enumerable ||
      !execute?.enumerable ||
      typeof execute.value !== 'function'
    )
      throw storageFailure();
    validateStorageResult(
      'revoke-all',
      await resolved(execute.value.call(owner, { operation: 'revoke-all' }))
    );
    const remaining = validateStorageResult(
      'inspect',
      await resolved(execute.value.call(owner, { operation: 'inspect' }))
    );
    if (remaining.records !== 0 || remaining.bytes !== 0) throw storageFailure();
    closeAttempted = true;
    const reply = shutdown();
    if ((nativeReaderPromise(reply) ? await reply : reply) !== undefined) throw storageFailure();
  } catch {
    if (shutdown && !closeAttempted) {
      try {
        const reply = shutdown();
        if ((nativeReaderPromise(reply) ? await reply : reply) !== undefined)
          throw storageFailure();
      } catch {
        /* A failed clear remains failed even if terminal cleanup also fails. */
      }
    }
    throw storageFailure();
  }
}

module.exports = { clearInactiveRecoveryStorage };
