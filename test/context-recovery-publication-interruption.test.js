'use strict';

const test = require('node:test');
const { installSqlPublicationIoCapture } = require('./helpers/publication-io-capture.cjs');
const observeFailure = installSqlPublicationIoCapture(test);
const {
  publicationInterruption,
} = require('./helpers/context-recovery-publication-interruption.cjs');

for (const transition of ['prepared', 'sending', 'transport-finished', 'uncertain', 'withdrawn']) {
  for (const boundary of ['commit', 'ack']) {
    for (const kill of [true, false]) {
      test(
        `publication ${transition}: ${kill ? 'SIGKILL' : 'release control'} inside ${boundary === 'commit' ? 'actual COMMIT lock wait' : 'durable commit before ACK'}`,
        { timeout: 40000 },
        (t) =>
          observeFailure(() =>
            publicationInterruption({
              transition,
              boundary,
              kill,
              diagnostic: (sample) =>
                t.diagnostic(JSON.stringify({ transition, boundary, kill, ...sample })),
            })
          )
      );
    }
  }
}
