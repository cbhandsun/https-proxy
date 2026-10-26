'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const {
  storageData,
  storageWorkerRequest,
  storageFailure,
} = require('./context-recovery-storage-contract');
const { startRecoveryStorageAsyncIdle } = require('./context-recovery-storage-idle');
const { createRecoveryStorageSerial } = require('./context-recovery-storage-serial');

let owner,
  serial,
  idle,
  stopped = false;
async function closeOwner(abort = false) {
  stopped = true;
  let failed = false;
  try {
    idle?.close();
  } catch {
    failed = true;
  }
  try {
    if (serial) await serial[abort ? 'abort' : 'close']();
    else if (owner) await owner.close();
  } catch {
    failed = true;
  }
  if (failed) throw storageFailure();
}
async function abortOwner() {
  try {
    await closeOwner(true);
  } catch {
    /* Parent observes terminal worker exit. */
  } finally {
    parentPort.close();
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
    idle = startRecoveryStorageAsyncIdle({
      execute: () => serial.idle(),
      onFailure: abortOwner,
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
      } catch {
        if (Number.isSafeInteger(message?.id) && message.id > 0) {
          parentPort.postMessage({ id: message.id, ok: false });
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
