'use strict';

const { nativeReaderPromise } = require('./context-recovery-reader-result');

// Claim the management listener before calling start. A pending writer owns
// that listener until stop has drained it, so another process cannot acquire
// the port while an old credential write can still finish.
function createStartupCredentials({ write, onReady, onFailure }) {
  if ([write, onReady, onFailure].some((value) => typeof value !== 'function'))
    throw new TypeError('Invalid startup credential composition');
  let completion,
    stopped = false,
    ready = false;
  return {
    ready: () => ready && !stopped,
    start() {
      if (completion) return completion;
      if (stopped) return Promise.resolve(false);
      let resolve;
      completion = new Promise((done) => {
        resolve = done;
      });
      void (async () => {
        try {
          const pending = write();
          const result = nativeReaderPromise(pending) ? await pending : pending;
          if (result !== undefined && typeof result !== 'string')
            throw new TypeError('Invalid startup credential result');
          if (!stopped) {
            ready = true;
            onReady();
          }
          resolve(true);
        } catch {
          ready = false;
          try {
            onFailure();
          } catch {
            // The verdict is already failed; diagnostic callbacks cannot turn
            // cleanup into an unhandled rejection or a successful startup.
          }
          resolve(false);
        }
      })();
      return completion;
    },
    stop() {
      stopped = true;
      ready = false;
      return completion ?? Promise.resolve(true);
    },
  };
}

module.exports = { createStartupCredentials };
