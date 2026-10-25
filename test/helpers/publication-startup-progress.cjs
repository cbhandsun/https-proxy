'use strict';

const { types } = require('node:util');
const {
  createStorageStartupProgress,
} = require('../../lib/proxy/context-recovery-storage-progress');

// Reuse the production phase validator, without assuming it exports its private
// phase list. Only a closed phase name and bounded integer cross this observer.
function createPublicationStartupProgress() {
  let last = 'unobserved';
  let elapsed = 0;
  let finished = false;
  const phases = createStorageStartupProgress(({ phase }) => {
    last = phase;
  });
  return {
    observe(input) {
      if (
        !input ||
        typeof input !== 'object' ||
        types.isProxy(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      )
        throw new Error('publication_startup_progress_invalid');
      const keys = Reflect.ownKeys(input);
      if (keys.length !== 2 || keys.some((key) => !['phase', 'elapsedMs'].includes(key)))
        throw new Error('publication_startup_progress_invalid');
      const value = Object.create(null);
      for (const name of ['phase', 'elapsedMs']) {
        const slot = Object.getOwnPropertyDescriptor(input, name);
        if (!slot?.enumerable || !Object.hasOwn(slot, 'value'))
          throw new Error('publication_startup_progress_invalid');
        value[name] = slot.value;
      }
      if (
        typeof value.phase !== 'string' ||
        value.phase.length > 64 ||
        !Number.isSafeInteger(value.elapsedMs) ||
        value.elapsedMs < elapsed ||
        value.elapsedMs > 60000 ||
        finished
      ) {
        throw new Error('publication_startup_progress_invalid');
      }
      if (value.phase === 'ready' || value.phase === 'failed') {
        phases.finish(value.phase === 'ready');
        finished = true;
      } else phases.advance(value.phase);
      elapsed = value.elapsedMs;
    },
    describe() {
      return { phase: last, elapsedMs: elapsed };
    },
  };
}
module.exports = { createPublicationStartupProgress };
