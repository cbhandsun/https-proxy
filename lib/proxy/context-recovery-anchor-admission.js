'use strict';

const { types } = require('node:util');
const { storageFailure } = require('./context-recovery-storage-contract');
const {
  parseAnchorSnapshot,
  assertAnchorSuccessor,
} = require('./context-recovery-anchor-contract');

// Private synchronous owner seam. An existing database cannot enroll itself when
// its independently retained anchor is missing. No public request grants this
// authority; the owner determines enrollment from creation under its OS lock.
function fields(input, names) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw storageFailure();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some((name) => !names.includes(name)))
    throw storageFailure();
  const result = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw storageFailure();
    result[name] = descriptor.value;
  }
  return result;
}

function createRecoveryAnchorAdmission(input) {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw storageFailure();
  const clockOnlyScans = Object.hasOwn(input, 'clockOnlyScans');
  const {
    repository,
    allowEnrollment,
    clockOnlyScans: clockMode,
  } = fields(
    input,
    clockOnlyScans
      ? ['repository', 'allowEnrollment', 'clockOnlyScans']
      : ['repository', 'allowEnrollment']
  );
  if (clockOnlyScans && clockMode !== true) throw storageFailure();
  const capabilities = fields(repository, ['identity', 'read', 'commit', 'close']);
  const identity = fields(capabilities.identity, ['keyIdentity', 'locationHash']);
  for (const method of ['read', 'commit', 'close']) {
    const value = capabilities[method];
    if (typeof value !== 'function' || types.isProxy(value) || types.isAsyncFunction(value))
      throw storageFailure();
  }
  let closed = false;
  let validated = false;
  let prior;
  let revision;
  function close() {
    if (closed) return;
    closed = true;
    prior = undefined;
    Reflect.apply(capabilities.close, repository, []);
  }
  function guarded(operation) {
    try {
      if (closed) throw storageFailure();
      return operation();
    } catch {
      try {
        close();
      } catch {
        /* Preserve only the fixed storage error. */
      }
      throw storageFailure();
    }
  }
  function snapshot(input) {
    const safe = fields(
      input,
      clockOnlyScans
        ? ['storeId', 'maxTime', 'scopes', 'headerTag']
        : ['storeId', 'maxTime', 'scopes']
    );
    return parseAnchorSnapshot({ version: clockOnlyScans ? 2 : 1, ...identity, ...safe });
  }
  function commit(current) {
    const receipt = fields(Reflect.apply(capabilities.commit, repository, [current]), ['revision']);
    if (
      !Number.isSafeInteger(receipt.revision) ||
      receipt.revision <= 0 ||
      (revision !== undefined && receipt.revision !== revision + 1)
    )
      throw storageFailure();
    revision = receipt.revision;
    prior = current;
  }
  guarded(() => {
    if (typeof allowEnrollment !== 'boolean') throw storageFailure();
    prior = Reflect.apply(capabilities.read, repository, []);
    if (prior === null && !allowEnrollment) throw storageFailure();
    if (prior !== null) prior = parseAnchorSnapshot(prior);
  });
  const initialStoreId = prior === null ? undefined : prior.storeId;
  return Object.freeze({
    initialStoreId,
    ...(clockOnlyScans ? { initialTime: prior?.maxTime ?? 0 } : {}),
    validateStartup(input, initializing = false) {
      return guarded(() => {
        if (validated || typeof initializing !== 'boolean') throw storageFailure();
        const current = snapshot(input);
        if (prior !== null) {
          // A clock-only scan leaves SQLite bytes unchanged. Catch up only the
          // exact independently anchored header and full row set, never another
          // authenticated old database. The engine must enforce initialTime
          // before its startup clock write, so no earlier wall time is admitted.
          if (clockOnlyScans && prior.version === 2 && current.maxTime < prior.maxTime) {
            if (JSON.stringify({ ...current, maxTime: prior.maxTime }) !== JSON.stringify(prior))
              throw storageFailure();
          } else assertAnchorSuccessor(prior, current);
        } else {
          if (
            !allowEnrollment ||
            !initializing ||
            current.scopes.length !== 0 ||
            current.maxTime !== 0
          )
            throw storageFailure();
          // This empty baseline is durable before the initial SQLite COMMIT.
          // It is an initialization intent, never a save or public-output ACK.
          // A restart may reuse its storeId only when the real schema is empty.
          commit(current);
        }
        validated = true;
      });
    },
    persist(input) {
      return guarded(() => {
        if (!validated) throw storageFailure();
        const current = snapshot(input);
        if (prior !== null) assertAnchorSuccessor(prior, current);
        // commit must return only after native flush and exact CAS readback.
        commit(current);
      });
    },
    close,
  });
}

module.exports = { createRecoveryAnchorAdmission };
