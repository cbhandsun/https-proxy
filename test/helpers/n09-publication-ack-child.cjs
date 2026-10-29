'use strict';

// Cross-process acceptance-channel fixture only. No native daemon qualification.
const {
  createPublicationAckHost,
} = require('../../scripts/context-hosted/n09-business/publication-ack-host');
const fs = require('node:fs');
const caseRoot = process.argv[2];
const mode = process.argv[3];
let observationHost;
const {
  createPublicationObservationHost,
} = require('../../scripts/context-hosted/n09-business/publication-observation-host');
let cancellationObserved = true,
  cancellationChecks = 0;
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
  { inspect: () => observed, close() {} },
  {
    ...(mode && mode !== 'timer-only'
      ? {
          serviceObservation() {
            if (mode === 'service-throw') throw new Error('fixture');
            if (mode === 'service-return') return true;
            if (mode === 'service-promise') return Promise.reject(new Error('fixture'));
            if (mode === 'service-reentrant') {
              try {
                host.afterDurableAck({
                  rootId: observed.rootId,
                  expiresAt: observed.expiresAt,
                  revision: 8,
                });
              } catch {}
              return;
            }
            observationHost.step();
          },
        }
      : {}),
    cancellationObserved: () => {
      cancellationChecks++;
      return cancellationObserved;
    },
  } // Channel fixture only; not a real cancellation witness.
);
if (mode === 'observation' || mode === 'timer-only') {
  observationHost = createPublicationObservationHost(
    { caseRoot, pid: process.pid, epoch: 'a'.repeat(32), signingKey: 'b'.repeat(64) },
    { inspect: () => observed, close() {} }
  );
  observationHost.start();
}
host.start();
process.send({ kind: 'ready' });
process.on('message', (message) => {
  if (message.kind === 'cancel-observed') {
    cancellationObserved = true;
    return;
  }
  if (message.kind === 'probe-cancel') {
    void (async () => {
      const deadline = Date.now() + 750;
      while (!cancellationChecks && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      process.send({
        kind: 'cancel-probe',
        checks: cancellationChecks,
        state: host.step(),
        cancelled: cancellationObserved,
      });
    })();
    return;
  }
  if (message.kind === 'cancel-action') {
    if (message.waitForCancellation) cancellationObserved = false;
    void cancellation(message).catch(() => process.send({ kind: 'rejected' }));
    return;
  }
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
      if (
        ['sending', 'transport-finished'].includes(message.transition) &&
        !message.skipPredecessor
      ) {
        const target = observed;
        const predecessors =
          message.transition === 'sending' ? ['prepared'] : ['prepared', 'sending'];
        predecessors.forEach((transition, index) => {
          const expectedRevision = 7 - predecessors.length + index;
          observed = { ...target, transition, expectedRevision, callOrdinal: 2 + index };
          host.afterDurableAck({
            rootId: observed.rootId,
            expiresAt: observed.expiresAt,
            revision: expectedRevision + 1,
          });
        });
        observed = { ...target, callOrdinal: 2 + predecessors.length };
      }
      host.afterDurableAck({
        rootId: observed.rootId,
        expiresAt: observed.expiresAt,
        revision: message.wrongRevision ? 9 : 8,
      });
      if (message.pendingAfterRelease)
        observed = {
          ...observed,
          callOrdinal: observed.callOrdinal + 1,
          activeCount: 1,
          expectedRevision: 8,
          transition: 'sending',
          status: 'pending',
        };
      process.send({ kind: 'returned' });
    } catch {
      process.send({ kind: 'rejected' });
    }
  }
});
process.on('disconnect', () => {
  host.close();
  observationHost?.close();
  process.exit(0);
});

async function cancellation(message) {
  const predecessors = message.transition === 'withdrawn' ? ['prepared'] : ['prepared', 'sending'];
  for (const [index, transition] of predecessors.entries()) {
    observed = {
      generation: 1,
      callOrdinal: 2 + index,
      activeCount: 0,
      operation: 'save-reference-state',
      transition,
      rootId: 'hbs_' + 'd'.repeat(32),
      expiresAt: 123456,
      expectedRevision: 7 - predecessors.length + index,
      status: 'completed',
    };
    host.afterDurableAck({
      rootId: observed.rootId,
      expiresAt: observed.expiresAt,
      revision: observed.expectedRevision + 1,
    });
    if (!message.skipTrigger)
      await host.afterPublicationAction(transition === 'prepared' ? 'prepare' : 'sending');
  }
  observed = {
    ...observed,
    transition: message.transition,
    callOrdinal: 2 + predecessors.length,
    expectedRevision: 7,
  };
  host.afterDurableAck({ rootId: observed.rootId, expiresAt: observed.expiresAt, revision: 8 });
  process.send({ kind: 'returned' });
}
