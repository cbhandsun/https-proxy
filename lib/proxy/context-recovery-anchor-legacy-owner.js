'use strict';

const fs = require('node:fs');
const { types } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { storageDirectory, createStoragePaths } = require('./context-recovery-storage-paths');
const { protectWithCurrentUser } = require('./context-recovery-key-dpapi');
const { keyRequest } = require('./context-recovery-key-contract');
const { storageFailure } = require('./context-recovery-storage-contract');
const { createRecoveryAnchorRepository } = require('./context-recovery-anchor');
const { inspectRecoverySqliteSnapshot } = require('./context-recovery-storage-sqlite');
const {
  recoveryLegacyEnrollmentPreview,
  assertLegacyEnrollment,
} = require('./context-recovery-anchor-enrollment');

function fields(input, allowed, required = allowed) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw storageFailure();
  const names = Reflect.ownKeys(input);
  if (
    required.some((name) => !names.includes(name)) ||
    names.some((name) => typeof name !== 'string' || !allowed.includes(name))
  )
    throw storageFailure();
  const result = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw storageFailure();
    result[name] = descriptor.value;
  }
  return result;
}
function synchronous(value) {
  if (typeof value !== 'function' || types.isProxy(value) || types.isAsyncFunction(value))
    throw storageFailure();
  return value;
}

// Trusted offline composition only. Every invocation obtains a fresh writer lock,
// unwrapped key and authenticated read-only snapshot; callers cannot supply state.
// No worker request or normal startup option grants legacy enrollment authority.
function runLegacyAnchorEnrollment(input, dependencies = {}) {
  let paths, mutex, database, repository, closeRepository;
  let locked = false;
  let failed = false;
  let result;
  try {
    const options = fields(input, ['directory', 'expectedFingerprint'], ['directory']);
    const supplied = Object.hasOwn(options, 'expectedFingerprint');
    if (
      supplied &&
      (typeof options.expectedFingerprint !== 'string' ||
        options.expectedFingerprint.length !== 64 ||
        !/^[a-f0-9]{64}$/.test(options.expectedFingerprint))
    )
      throw storageFailure();
    const trusted = fields(
      dependencies,
      ['protectKey', 'createAnchorRepository', 'inspectSnapshot'],
      []
    );
    const protectKey = synchronous(
      Object.hasOwn(trusted, 'protectKey') ? trusted.protectKey : protectWithCurrentUser
    );
    const createAnchorRepository = synchronous(
      Object.hasOwn(trusted, 'createAnchorRepository')
        ? trusted.createAnchorRepository
        : createRecoveryAnchorRepository
    );
    const inspectSnapshot = synchronous(
      Object.hasOwn(trusted, 'inspectSnapshot')
        ? trusted.inspectSnapshot
        : inspectRecoverySqliteSnapshot
    );
    const directory = storageDirectory(options.directory);
    // createStoragePaths may create ordinary runtime directories. This offline
    // API must refuse a missing legacy directory before invoking that helper.
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageFailure();
    paths = createStoragePaths(directory);
    const lockFile = paths.pinExisting('.writer.sqlite');
    mutex = new DatabaseSync(lockFile, { allowExtension: false });
    mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    locked = true;
    paths.verify();
    const file = paths.pinExisting('checkpoint.sqlite');
    paths.pinExisting('.data-key');
    const wrapped = paths.pinKey();
    keyRequest({ operation: 'unprotect', value: wrapped });
    paths.verify();
    const dataKey = keyRequest({
      operation: 'protect',
      value: protectKey({ operation: 'unprotect', value: wrapped }),
    }).value;
    paths.verify();
    repository = createAnchorRepository({ directory, dataKey });
    const capabilities = fields(repository, ['identity', 'read', 'commit', 'close']);
    closeRepository = synchronous(capabilities.close);
    const identity = fields(capabilities.identity, ['keyIdentity', 'locationHash']);
    const read = synchronous(capabilities.read);
    const commit = synchronous(capabilities.commit);
    paths.verify();
    if (Reflect.apply(read, repository, []) !== null) throw storageFailure();
    paths.verify();
    database = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    // Modern sealed stores are never "legacy" when their independent anchor
    // is missing. Explicit legacy enrollment must not recreate that authority.
    if (![1, 2].includes(database.prepare('PRAGMA user_version').get().user_version))
      throw storageFailure();
    const metadata = fields(inspectSnapshot({ database, dataKey }), [
      'storeId',
      'maxTime',
      'scopes',
    ]);
    paths.verify();
    const snapshot = { version: 1, ...identity, ...metadata };
    if (supplied) {
      const current = assertLegacyEnrollment(snapshot, options.expectedFingerprint);
      paths.verify();
      const receipt = fields(Reflect.apply(commit, repository, [current]), ['revision']);
      if (receipt.revision !== 1) throw storageFailure();
      paths.verify();
      result = Object.freeze({ enrolled: true });
    } else result = recoveryLegacyEnrollmentPreview(snapshot);
    paths.verify();
  } catch {
    failed = true;
  }
  // A committed anchor is never deleted as compensation. Cleanup errors still
  // prevent success, while every remaining resource receives its close attempt.
  for (const action of [
    () => database?.close(),
    () => {
      if (closeRepository && Reflect.apply(closeRepository, repository, []) !== undefined)
        throw storageFailure();
    },
    () => {
      if (locked) mutex.exec('ROLLBACK');
    },
    () => mutex?.close(),
    () => paths?.verify(),
  ]) {
    try {
      action();
    } catch {
      failed = true;
    }
  }
  if (failed) throw storageFailure();
  return result;
}

module.exports = { runLegacyAnchorEnrollment };
