'use strict';

const { types } = require('node:util');
const { storageFailure } = require('./context-recovery-storage-contract');
const { transferStorageFailure } = require('./context-recovery-storage-failure');
const { nativeReaderPromise } = require('./context-recovery-reader-result');

// The private parent port already bounds aggregate bytes and eight requests.
// Preserve eight client slots even when one idle sweep is running. No idle
// backlog, retries, request replay, changed deadlines or expiry renewal.
function createRecoveryStorageSerial(owner) {
  if (
    !owner ||
    types.isProxy(owner) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(owner))
  )
    throw storageFailure();
  const keys = Reflect.ownKeys(owner);
  if (keys.length !== 2 || !keys.includes('execute') || !keys.includes('close'))
    throw storageFailure();
  const methods = Object.create(null);
  for (const name of keys) {
    const value = Object.getOwnPropertyDescriptor(owner, name);
    if (
      !value?.enumerable ||
      !Object.hasOwn(value, 'value') ||
      typeof value.value !== 'function' ||
      types.isProxy(value.value) ||
      types.isGeneratorFunction(value.value)
    )
      throw storageFailure();
    methods[name] = value.value;
  }
  let tail = Promise.resolve(),
    closing,
    aborting,
    ownerClosing;
  let clients = 0,
    idleRunning = false,
    aborted = false;
  async function invoke(name, args) {
    const result = Reflect.apply(methods[name], owner, args);
    if (!nativeReaderPromise(result)) throw storageFailure();
    return await result;
  }
  function submit(request) {
    const result = tail
      .then(() => {
        if (aborted) throw storageFailure();
        return invoke('execute', [request]);
      })
      .then((value) => {
        if (aborted) throw storageFailure();
        return value;
      })
      .catch((error) => {
        throw transferStorageFailure(error);
      });
    tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
  function closeOwned() {
    if (!ownerClosing)
      ownerClosing = invoke('close', []).catch((error) => {
        throw transferStorageFailure(error);
      });
    return ownerClosing;
  }
  function close() {
    if (closing) return closing;
    closing = tail.then(closeOwned).then(
      () => {
        if (aborted) throw storageFailure();
      },
      (error) => {
        throw transferStorageFailure(error);
      }
    );
    return closing;
  }
  function abort() {
    aborted = true;
    if (!aborting) aborting = closeOwned();
    return aborting;
  }
  return Object.freeze({
    execute(request) {
      if (closing || aborted || clients >= 8) return Promise.reject(storageFailure());
      clients++;
      return submit(request).finally(() => {
        clients--;
      });
    },
    idle() {
      if (closing || aborted || clients || idleRunning) return null;
      idleRunning = true;
      return submit({ operation: 'sweep' }).then(
        (result) => {
          idleRunning = false;
          return result;
        },
        (error) => {
          idleRunning = false;
          aborted = true; // Queued requests must not run after a failed sweep.
          throw transferStorageFailure(error);
        }
      );
    },
    close,
    abort,
  });
}

module.exports = { createRecoveryStorageSerial };
