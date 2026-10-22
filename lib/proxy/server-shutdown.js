'use strict';

const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { storageData } = require('./context-recovery-storage-contract');

async function checked(action, validate) {
  try {
    const pending = action();
    const value = nativeReaderPromise(pending) ? await pending : pending;
    return validate(value) === true;
  } catch {
    return false;
  }
}

function recoveryStopped(input) {
  const value = storageData(input, 1024);
  return value !== null && Object.keys(value).join(',') === 'ok' && value.ok === true;
}

// Stop resource admission synchronously, drain every listener and resource,
// then remove the PID. No failed cleanup can authorize a successful exit.
function createProxyShutdown({
  servers,
  shutdownRecovery,
  beforeListenersClose,
  stopPid,
  reportFailure,
}) {
  if (
    !Array.isArray(servers) ||
    (shutdownRecovery !== undefined && typeof shutdownRecovery !== 'function') ||
    (beforeListenersClose !== undefined && typeof beforeListenersClose !== 'function') ||
    typeof stopPid !== 'function' ||
    typeof reportFailure !== 'function'
  )
    throw new TypeError('Invalid proxy shutdown composition');
  let completion;
  return function shutdown() {
    if (completion) return completion;
    let resolve;
    completion = new Promise((done) => {
      resolve = done;
    });
    const drain =
      shutdownRecovery === undefined
        ? Promise.resolve(true)
        : checked(shutdownRecovery, recoveryStopped);
    const closeListeners = () =>
      servers.slice().map(
        (server) =>
          new Promise((done) => {
            let settled = false;
            const finish = (success) => {
              if (settled) return;
              settled = true;
              done(success);
            };
            try {
              server.close((error) => finish(error === undefined));
            } catch {
              finish(false);
            }
          })
      );
    const listeners =
      beforeListenersClose === undefined
        ? closeListeners()
        : [
            checked(beforeListenersClose, (value) => value === true).then(async (success) => {
              const results = await Promise.all(closeListeners());
              return success && results.every((value) => value === true);
            }),
          ];
    void (async () => {
      const results = await Promise.all([drain, ...listeners]);
      const pidStopped = await checked(stopPid, (value) => value === true);
      const success = pidStopped && results.every((value) => value === true);
      if (!success) {
        // A diagnostic rejection is consumed without waiting for telemetry or
        // executing arbitrary thenables; the cleanup verdict remains failed.
        void checked(reportFailure, () => true);
      }
      resolve(success);
    })();
    return completion;
  };
}

module.exports = { createProxyShutdown };
