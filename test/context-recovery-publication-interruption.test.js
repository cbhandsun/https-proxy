'use strict';

const test = require('node:test');
const {
  publicationInterruption,
} = require('./helpers/context-recovery-publication-interruption.cjs');

for (const transition of ['prepared', 'sending', 'transport-finished', 'uncertain', 'withdrawn']) {
  for (const boundary of ['commit', 'ack']) {
    for (const kill of [true, false]) {
      test(
        `publication ${transition}: ${kill ? 'SIGKILL' : 'release control'} inside ${boundary === 'commit' ? 'actual COMMIT lock wait' : 'durable commit before ACK'}`,
        { timeout: 15000 },
        () => publicationInterruption({ transition, boundary, kill })
      );
    }
  }
}
