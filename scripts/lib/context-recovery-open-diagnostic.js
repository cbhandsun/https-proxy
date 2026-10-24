'use strict';

const { types } = require('node:util');
const { openContextRecoveryStorage } = require('../../lib/proxy/context-recovery-storage');
const { storageDirectory } = require('../../lib/proxy/context-recovery-storage-paths');
const {
  createStorageStartupProgress,
} = require('../../lib/proxy/context-recovery-storage-progress');

// Trusted test seam only. The CLI always uses the default worker and deadlines.
// No raw storage reply, path, exception or native response enters this report.
async function diagnoseStorageOpen(directory, openStorage = openContextRecoveryStorage) {
  const events = [];
  let attempt = 0;
  let invalid = false;
  let completedOpens = 0;
  let completedCloses = 0;
  let stage = 'input';
  try {
    directory = storageDirectory(directory);
    if (typeof openStorage !== 'function' || types.isProxy(openStorage)) throw Error();
    for (attempt = 1; attempt <= 2; attempt++) {
      let storage;
      let terminal;
      let lastElapsed = -1;
      const progress = createStorageStartupProgress((event) => events.push({ attempt, ...event }));
      stage = 'open';
      try {
        storage = await openStorage({
          directory,
          onStartup(input) {
            try {
              if (!input || types.isProxy(input)) throw Error();
              const slots = Object.getOwnPropertyDescriptors(input);
              if (
                Reflect.ownKeys(slots).sort().join(',') !== 'elapsedMs,phase' ||
                !Object.hasOwn(slots.phase, 'value') ||
                !Object.hasOwn(slots.elapsedMs, 'value') ||
                !Number.isSafeInteger(slots.elapsedMs.value) ||
                slots.elapsedMs.value < 0 ||
                slots.elapsedMs.value < lastElapsed ||
                terminal !== undefined ||
                events.length >= 64
              )
                throw Error();
              const phase = slots.phase.value;
              lastElapsed = slots.elapsedMs.value;
              if (phase === 'ready' || phase === 'failed') {
                terminal = phase;
                progress.finish(phase === 'ready');
              } else progress.advance(phase);
            } catch {
              invalid = true;
            }
          },
        });
        completedOpens++;
        if (invalid || terminal !== 'ready') throw Error();
        stage = 'inspect';
        const result = await storage.execute({ operation: 'inspect' });
        if (result?.records !== 0 || result?.bytes !== 0) throw Error();
      } finally {
        if (storage) {
          const prior = stage;
          stage = 'close';
          await storage.close();
          completedCloses++;
          stage = prior;
        }
      }
    }
    return { passed: true, completedOpens, completedCloses, events };
  } catch {
    return { passed: false, stage, completedOpens, completedCloses, events };
  }
}

module.exports = { diagnoseStorageOpen };
