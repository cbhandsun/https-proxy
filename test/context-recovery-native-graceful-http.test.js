'use strict';
const test = require('node:test');
const {
  publicationInterruption,
} = require('./helpers/context-recovery-publication-interruption.cjs');
// The actual default worker, DPAPI protector, OS anchor and wall clock are
// mandatory. No injected backend, synthetic clock, fallback or platform skip.
for (const transition of ['prepared', 'sending', 'transport-finished', 'uncertain', 'withdrawn']) {
  for (const boundary of ['commit', 'ack']) {
    test(
      `native worker HTTP normal stop drains ${transition} inside ${boundary === 'commit' ? 'actual COMMIT lock wait' : 'durable OS anchor before publication ACK'}`,
      { timeout: 40000 },
      () =>
        publicationInterruption({ transition, boundary, kill: false, native: true, graceful: true })
    );
  }
}
