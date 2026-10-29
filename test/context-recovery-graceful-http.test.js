'use strict';
const test = require('node:test');
const { installPublicationIoCapture } = require('./helpers/publication-io-capture.cjs');
const observeFailure = installPublicationIoCapture(test);
const {
  publicationInterruption,
} = require('./helpers/context-recovery-publication-interruption.cjs');
for (const transition of ['prepared', 'sending', 'transport-finished', 'uncertain', 'withdrawn']) {
  test(
    `encrypted file HTTP normal stop drains ${transition} awaiting publication ACK`,
    { timeout: 40000 },
    () =>
      observeFailure(() =>
        publicationInterruption({ transition, boundary: 'ack', kill: false, graceful: true })
      )
  );
}
