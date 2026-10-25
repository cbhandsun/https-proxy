'use strict';

const test = require('node:test');
const {
  publicationInterruption,
} = require('./helpers/context-recovery-publication-interruption.cjs');

// No protector, anchor repository, WorkerType or clock substitution. These
// cases require the real platform helper; an unavailable native open fails.
for (const transition of ['prepared', 'sending', 'transport-finished', 'uncertain', 'withdrawn']) {
  for (const boundary of ['commit', 'ack']) {
    for (const kill of [true, false]) {
      test(
        `native worker publication ${transition}: ${kill ? 'SIGKILL' : 'release control'} inside ${boundary === 'commit' ? 'actual COMMIT lock wait' : 'durable OS anchor before publication ACK'}`,
        { timeout: 15000 },
        () => publicationInterruption({ transition, boundary, kill, native: true })
      );
    }
  }
}
