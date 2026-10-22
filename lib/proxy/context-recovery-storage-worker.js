'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const {
  storageData,
  storageWorkerRequest,
  storageFailure,
} = require('./context-recovery-storage-contract');
const { startRecoveryStorageIdle } = require('./context-recovery-storage-idle');

let owner,
  idle,
  stopped = false;
function closeOwner() {
  stopped = true;
  let failed = false;
  try {
    idle?.close();
  } catch {
    failed = true;
  }
  try {
    owner?.close();
  } catch {
    failed = true;
  }
  if (failed) throw storageFailure();
}
function abortOwner() {
  try {
    closeOwner();
  } catch {
    /* Parent observes terminal worker exit. */
  } finally {
    parentPort.close();
  }
}
try {
  parentPort.postMessage({ id: 0, ok: true, phase: 'worker_started' });
  const { createStorageOwner } = require('./context-recovery-storage-owner');
  const options = storageData(workerData, 16384);
  if (!options || Object.keys(options).join(',') !== 'directory') throw new Error('invalid');
  owner = createStorageOwner({
    ...options,
    onStartup: ({ phase }) => parentPort.postMessage({ id: 0, ok: true, phase }),
  });
  idle = startRecoveryStorageIdle({
    execute: (request) => owner.execute(request),
    onFailure: abortOwner,
  });
  parentPort.postMessage({ id: 0, ok: true });
  parentPort.on('message', (input) => {
    if (stopped) return;
    let message;
    try {
      message = storageWorkerRequest(input);
      const request = message.parseRequest();
      if (request.operation === 'close') {
        closeOwner();
        parentPort.postMessage({ id: message.id, ok: true, result: null });
        parentPort.close();
        return;
      }
      const result = owner.execute(request);
      parentPort.postMessage({ id: message.id, ok: true, result });
    } catch {
      if (Number.isSafeInteger(message?.id) && message.id > 0) {
        parentPort.postMessage({ id: message.id, ok: false });
        if (stopped) parentPort.close();
      } else abortOwner();
    }
  });
} catch {
  try {
    closeOwner();
  } finally {
    parentPort.postMessage({ id: 0, ok: false });
    parentPort.close();
  }
}
