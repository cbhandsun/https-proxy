'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { storageData, storageWorkerRequest } = require('./context-recovery-storage-contract');
const {
  storageFailureDiagnostic,
  transferStorageFailure,
} = require('./context-recovery-storage-failure');
const { startRecoveryStorageAsyncIdle } = require('./context-recovery-storage-idle');
const { createRecoveryStorageSerial } = require('./context-recovery-storage-serial');

let owner,
  serial,
  idle,
  stopped = false;
async function closeOwner(abort = false) {
  stopped = true;
  let failure;
  try {
    idle?.close();
  } catch (error) {
    failure ??= transferStorageFailure(error);
  }
  try {
    if (serial) await serial[abort ? 'abort' : 'close']();
    else if (owner) await owner.close();
  } catch (error) {
    failure ??= transferStorageFailure(error);
  }
  if (failure) throw failure;
}
async function abortOwner(diagnostic) {
  let cleanupFailed = false;
  try {
    await closeOwner(true);
  } catch {
    cleanupFailed = true;
  } finally {
    try {
      if (diagnostic)
        parentPort.postMessage({
          id: 0,
          ok: false,
          diagnostic: { ...diagnostic, cleanupFailed: diagnostic.cleanupFailed || cleanupFailed },
        });
    } finally {
      parentPort.close();
    }
  }
}
async function main() {
  try {
    parentPort.postMessage({ id: 0, ok: true, phase: 'worker_started' });
    const { createAsyncStorageOwner } = require('./context-recovery-storage-owner');
    const options = storageData(workerData, 16384);
    if (!options || Object.keys(options).join(',') !== 'directory') throw new Error('invalid');
    owner = createAsyncStorageOwner({
      ...options,
      onStartup: ({ phase }) => parentPort.postMessage({ id: 0, ok: true, phase }),
    });
    serial = createRecoveryStorageSerial(owner);
    let idleFailure;
    idle = startRecoveryStorageAsyncIdle({
      execute: () => {
        const pending = serial.idle();
        return pending === null
          ? null
          : pending.catch((error) => {
              idleFailure = storageFailureDiagnostic(error);
              throw error;
            });
      },
      onFailure: () => abortOwner(idleFailure),
    });
    parentPort.postMessage({ id: 0, ok: true });
    parentPort.on('message', async (input) => {
      if (stopped) return;
      let message;
      try {
        message = storageWorkerRequest(input);
        const request = message.parseRequest();
        if (request.operation === 'close') {
          await closeOwner();
          parentPort.postMessage({ id: message.id, ok: true, result: null });
          parentPort.close();
          return;
        }
        const result = await serial.execute(request);
        parentPort.postMessage({ id: message.id, ok: true, result });
      } catch (error) {
        if (Number.isSafeInteger(message?.id) && message.id > 0) {
          const diagnostic = storageFailureDiagnostic(error);
          parentPort.postMessage({
            id: message.id,
            ok: false,
            ...(diagnostic ? { diagnostic } : {}),
          });
          if (stopped) parentPort.close();
        } else await abortOwner();
      }
    });
  } catch {
    try {
      await closeOwner(true);
    } finally {
      parentPort.postMessage({ id: 0, ok: false });
      parentPort.close();
    }
  }
}
void main().catch(() => {
  // Parent observes a terminal worker failure, without raw diagnostics.
  parentPort.close();
});
