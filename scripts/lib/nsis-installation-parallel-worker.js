'use strict';

const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const { digest } = require('./nsis-encrypted-contract');
const path = require('node:path');
const { types } = require('node:util');

function verifyTasks(input, hashFile = digest) {
  if (
    types.isProxy(input) ||
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < 1 ||
    input.length > 2050 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new Error('installation_worker_rejected');
  const completed = [];
  for (let offset = 0; offset < input.length; offset++) {
    const slot = Object.getOwnPropertyDescriptor(input, String(offset));
    if (!slot || !Object.hasOwn(slot, 'value') || !slot.enumerable)
      throw new Error('installation_worker_rejected');
    const task = dataSnapshot(slot.value, 'installation_worker_rejected');
    if (
      !task ||
      Array.isArray(task) ||
      Object.keys(task).sort().join(',') !== 'file,hash,index' ||
      !Number.isSafeInteger(task.index) ||
      task.index < 0 ||
      task.index > 4098 ||
      completed.includes(task.index) ||
      typeof task.file !== 'string' ||
      !path.isAbsolute(task.file) ||
      typeof task.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(task.hash)
    )
      throw new Error('installation_worker_rejected');
    if (hashFile(task.file) !== task.hash) throw new Error('installation_worker_rejected');
    completed.push(task.index);
  }
  return { v: 1, ok: true, completed };
}

if (!isMainThread) {
  try {
    parentPort.postMessage(verifyTasks(workerData));
  } catch {
    parentPort.postMessage({ v: 1, ok: false });
  }
}

module.exports = { verifyTasks };
