'use strict';

// Cross-process acceptance-channel fixture only. No native daemon qualification.
const {
  createPublicationAckHost,
} = require('../../scripts/context-hosted/n09-business/publication-ack-host');
const fs = require('node:fs');
const caseRoot = process.argv[2];
let observed = {
  generation: 1,
  callOrdinal: 1,
  activeCount: 0,
  operation: 'other',
  transition: 'none',
  rootId: '',
  expiresAt: 0,
  expectedRevision: 0,
  status: 'completed',
};
const host = createPublicationAckHost(
  { caseRoot, pid: process.pid, epoch: 'a'.repeat(32), signingKey: 'b'.repeat(64) },
  { inspect: () => observed, close() {} }
);
host.start();
process.send({ kind: 'ready' });
process.on('message', (message) => {
  if (message.kind === 'ack') {
    if (message.slowRelease) {
      const original = fs.writeFileSync;
      fs.writeFileSync = function (...args) {
        const result = Reflect.apply(original, fs, args);
        if (typeof args[1] === 'string' && args[1].includes('"kind":"released"'))
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5100);
        return result;
      };
    }
    observed = {
      generation: 1,
      callOrdinal: 2,
      activeCount: 0,
      operation: 'save-reference-state',
      transition: message.transition,
      rootId: 'hbs_' + 'd'.repeat(32),
      expiresAt: 123456,
      expectedRevision: 7,
      status: 'completed',
    };
    try {
      host.afterDurableAck({
        rootId: observed.rootId,
        expiresAt: observed.expiresAt,
        revision: message.wrongRevision ? 9 : 8,
      });
      process.send({ kind: 'returned' });
    } catch {
      process.send({ kind: 'rejected' });
    }
  }
});
process.on('disconnect', () => {
  host.close();
  process.exit(0);
});
