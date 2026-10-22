'use strict';

const { readJsonBodyFromRequest } = require('./management-utils');
const { storageData } = require('./context-recovery-storage-contract');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { createClearOperations } = require('./context-recovery-clear-operations');
const { createClearOperationHandlers } = require('./context-recovery-clear-operation-handlers');

// Called only by the existing authenticated, origin-checked management router.
// No model-facing selector, credential, path or source reference is accepted.
function createContextRecoveryManagement({ sendJson, lifecycle } = {}) {
  if (typeof sendJson !== 'function') throw new TypeError('Invalid recovery management sender');
  let clear;
  try {
    const slot = lifecycle && Object.getOwnPropertyDescriptor(lifecycle, 'clearAsync');
    if (slot?.enumerable && typeof slot.value === 'function') clear = slot.value.bind(lifecycle);
  } catch {
    // Missing or malformed owners remain unavailable; no alternate owner opens.
  }
  return {
    ...createClearOperationHandlers({
      sendJson,
      operations: createClearOperations({
        execute: () => {
          if (!clear) throw new TypeError();
          return clear();
        },
      }),
    }),
    handleLocalContextRecoveryClearRequest(req, res) {
      let sent = false;
      function reply(status, value) {
        if (sent || res.destroyed || res.writableEnded) return;
        sent = true;
        try {
          sendJson(res, status, value);
        } catch {
          // A terminal response failure cannot rerun a committed clear.
        }
      }
      if (req.method !== 'POST') {
        reply(405, { ok: false, code: 'context_recovery_method_not_allowed' });
        return;
      }
      readJsonBodyFromRequest(
        req,
        (error, input) => {
          try {
            const value = storageData(input, 128);
            if (
              error ||
              !value ||
              Object.keys(value).join(',') !== 'confirm' ||
              value.confirm !== true
            )
              throw new TypeError();
          } catch {
            reply(400, { ok: false, code: 'context_recovery_clear_invalid' });
            return;
          }
          if (req.aborted || res.destroyed || res.writableEnded) return;
          const run = async () => {
            if (!clear) throw new TypeError();
            const pending = clear();
            const result = storageData(
              nativeReaderPromise(pending) ? await pending : pending,
              1024
            );
            if (result?.ok === true && Object.keys(result).join(',') === 'ok') {
              reply(200, { ok: true, scope: 'proxy_context_recovery' });
            } else if (
              result?.ok === false &&
              result.code === 'context_recovery_disabled' &&
              Object.keys(result).sort().join(',') === 'code,ok'
            ) {
              reply(409, { ok: false, code: 'context_recovery_disabled' });
            } else throw new TypeError();
          };
          void run().catch(() =>
            reply(503, { ok: false, code: 'context_recovery_storage_unavailable' })
          );
        },
        { maxBytes: 128 }
      );
    },
  };
}

module.exports = { createContextRecoveryManagement };
