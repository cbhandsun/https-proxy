'use strict';

const { parentPort } = require('node:worker_threads');
const { protectWithCurrentUser } = require('./context-recovery-key-dpapi');

parentPort.once('message', (message) => {
  try {
    parentPort.postMessage({ ok: true, value: protectWithCurrentUser(message) });
  } catch {
    parentPort.postMessage({ ok: false });
  } finally {
    parentPort.close();
  }
});
