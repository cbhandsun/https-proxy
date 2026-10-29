'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { keyRequest, keyResponse, keyFailure } = require('./context-recovery-key-contract');

function createContextRecoveryKeyProtector({ WorkerType = Worker, timeoutMs = 20000 } = {}) {
  if (
    typeof WorkerType !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 20000
  )
    throw keyFailure();
  let active = 0;
  function run(operation, value) {
    let request;
    try {
      request = keyRequest({ operation, value });
      if (active >= 2) throw keyFailure();
    } catch {
      return Promise.reject(keyFailure());
    }
    active++;
    return new Promise((resolve, reject) => {
      let worker,
        timer,
        result,
        settled = false,
        stopping = false,
        released = false;
      function release() {
        if (released) return;
        released = true;
        active--;
      }
      function finish(success, releaseCapacity = true) {
        if (releaseCapacity) release();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (success) resolve(result);
        else reject(keyFailure());
      }
      function stop() {
        if (settled || stopping) return;
        stopping = true;
        // The native operation has its own 10s process timeout. Worker capacity
        // is released only after termination, not while native work is alive.
        try {
          Promise.resolve(worker?.terminate()).then(
            () => finish(false),
            () => finish(false, false)
          );
        } catch {
          finish(false, worker === undefined);
        }
      }
      try {
        worker = new WorkerType(path.join(__dirname, 'context-recovery-key-worker.js'), {
          // This trusted worker owns its entry; parent process preloads are unrelated.
          execArgv: [],
          stdout: true,
          stderr: true,
        });
        worker.stdout?.resume();
        worker.stderr?.resume();
        timer = setTimeout(stop, timeoutMs);
        worker.once('error', stop);
        worker.once('exit', (code) => finish(!stopping && code === 0 && result !== undefined));
        worker.on('message', (message) => {
          if (settled || stopping) return;
          try {
            if (result !== undefined) throw keyFailure();
            result = keyResponse(operation, message);
          } catch {
            stop();
          }
        });
        worker.postMessage(request);
      } catch {
        stop();
      }
    });
  }
  return {
    protect: (value) => run('protect', value),
    unprotect: (value) => run('unprotect', value),
  };
}

module.exports = { createContextRecoveryKeyProtector };
