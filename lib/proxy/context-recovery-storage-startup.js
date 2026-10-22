'use strict';

const { storageData, storageFailure } = require('./context-recovery-storage-contract');
const { nativeReaderPromise } = require('./context-recovery-reader-result');

const failure = () => ({ ok: false, code: 'context_recovery_storage_unavailable' });

// Trusted composition barrier. Lifecycle operations requested during discovery
// run after its denial index is complete and before admission can be installed.
// Errors remain sticky; cleanup still runs and never converts a failed startup
// into success. The barrier owns no read capability or checkpoint content.
function createRecoveryStorageStartup(transactions) {
  let pending = true;
  let failed = false;
  let completion;
  async function result(operation, discovery = false) {
    try {
      const raw = operation();
      const value = storageData(nativeReaderPromise(raw) ? await raw : raw, 1024);
      if (
        discovery
          ? !value ||
            Array.isArray(value) ||
            Object.keys(value).sort().join(',') !== 'ok,roots' ||
            value.ok !== true ||
            !Number.isSafeInteger(value.roots) ||
            value.roots < 0 ||
            value.roots > 4
          : !value ||
            Array.isArray(value) ||
            Object.keys(value).join(',') !== 'ok' ||
            value.ok !== true
      )
        throw storageFailure();
      return { ok: true };
    } catch {
      failed = true;
      return failure();
    }
  }
  let tail = result(() => transactions.discover(), true);
  async function settled() {
    for (;;) {
      const generation = tail;
      await generation;
      if (generation === tail) return failed ? failure() : { ok: true };
    }
  }
  return {
    pending: () => pending,
    enqueue(operation) {
      if (!pending || typeof operation !== 'function') throw storageFailure();
      const task = tail.then(() => result(operation));
      tail = task;
      return task;
    },
    complete(install) {
      if (completion) return completion;
      if (typeof install !== 'function') throw storageFailure();
      completion = (async () => {
        try {
          for (;;) {
            const generation = tail;
            await generation;
            if (generation !== tail) continue;
            pending = false;
            if (failed) throw storageFailure();
            // No await between the stable generation check and installation.
            return install() ? { ok: true } : { ok: false, code: 'context_recovery_disabled' };
          }
        } catch {
          pending = false;
          failed = true;
          throw storageFailure();
        }
      })();
      return completion;
    },
    async drain() {
      const state = await settled();
      try {
        if (completion) await completion;
      } catch {
        return failure();
      }
      return state.ok && !failed ? { ok: true } : failure();
    },
  };
}

module.exports = { createRecoveryStorageStartup };
