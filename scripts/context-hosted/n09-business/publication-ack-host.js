'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const { fields, discardN09PromiseRejection } = require('../n09-ack/contract');
const { createPublicationAckContract } = require('./publication-ack-contract');
const { createPublicationAckFiles } = require('./publication-observation-files');
const { createPublicationAckBoundary } = require('./publication-ack-boundary');
const fail = () => new Error('n09_publication_ack_host_rejected');
const targetKeys = [
  'generation',
  'callOrdinal',
  'rootId',
  'expiresAt',
  'expectedRevision',
  'transition',
];

// Private test host. It neither owns nor closes the original storage observer.
// The blocking boundary is entered only by the genuine producer's runtime hook.
function createPublicationAckHost(input, observer) {
  let files, contract, boundary, timer;
  try {
    const config = fields(input, ['caseRoot', 'pid', 'epoch', 'signingKey']);
    const { inspect } = fields(observer, ['inspect', 'close']);
    if (
      typeof inspect !== 'function' ||
      types.isProxy(inspect) ||
      types.isAsyncFunction(inspect) ||
      types.isGeneratorFunction(inspect)
    )
      throw fail();
    contract = createPublicationAckContract({
      pid: config.pid,
      epoch: config.epoch,
      signingKey: config.signingKey,
    });
    files = createPublicationAckFiles(
      {
        directory: path.join(
          config.caseRoot,
          'n09-publication-ack-' + config.pid + '-' + config.epoch
        ),
        pid: config.pid,
        epoch: config.epoch,
      },
      true
    );
    let state = 'idle',
      request,
      held;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    function available() {
      if (state === 'closed' || state === 'failed') throw fail();
    }
    function reject() {
      state = 'failed';
      if (timer) clearInterval(timer);
      timer = undefined;
      throw fail();
    }
    function signal(kind, value) {
      files.write(kind, 1, JSON.stringify(contract.signSignal({ ...value, kind })));
    }
    boundary = createPublicationAckBoundary({
      inspect: () => Reflect.apply(inspect, observer, []),
      now: () => performance.now(),
      sleep: (ms) => {
        Atomics.wait(wait, 0, 0, ms);
      },
      publish(receipt) {
        available();
        if (state !== 'armed') throw fail();
        held = Object.freeze({
          ...request,
          callOrdinal: receipt.callOrdinal,
          revision: receipt.revision,
          holdChallenge: randomBytes(16).toString('hex'),
        });
        state = 'holding';
        signal('held', held);
      },
      released() {
        available();
        if (state !== 'holding') throw fail();
        const wire = files.read('release', 1);
        if (wire === null) return false;
        const command = contract.verifyCommand(wire);
        if (
          command.kind !== 'release' ||
          Object.keys(held).some((key) => key !== 'kind' && command[key] !== held[key])
        )
          throw fail();
        return true;
      },
    });
    function step() {
      try {
        available();
        if (state !== 'idle') return state;
        const wire = files.read('arm', 1);
        if (wire === null) return 'idle';
        const value = contract.verifyCommand(wire);
        if (value.kind !== 'arm') throw fail();
        const snapshot = Reflect.apply(inspect, observer, []);
        discardN09PromiseRejection(snapshot);
        const observed = fields(snapshot, [
          'generation',
          'callOrdinal',
          'activeCount',
          'operation',
          'transition',
          'rootId',
          'expiresAt',
          'expectedRevision',
          'status',
        ]);
        if (
          observed.generation !== value.generation ||
          observed.callOrdinal !== value.callOrdinal ||
          observed.activeCount !== 0 ||
          !['idle', 'completed'].includes(observed.status)
        )
          throw fail();
        request = value;
        boundary.arm(
          Object.fromEntries(targetKeys.map((key) => [key, value[key]])),
          ['sending', 'transport-finished'].includes(value.transition)
            ? 'prepared-prefix'
            : 'direct'
        );
        state = 'armed';
        signal('armed', value);
        return state;
      } catch {
        return reject();
      }
    }
    return Object.freeze({
      step,
      afterDurableAck(facts) {
        try {
          available();
          const deadline = state === 'armed' ? performance.now() + 5000 : undefined;
          boundary.afterDurableAck(facts);
          if (state === 'holding') {
            if (performance.now() >= deadline) throw fail();
            state = 'released';
            signal('released', held);
            if (performance.now() >= deadline) throw fail();
          }
        } catch {
          reject();
        }
      },
      start() {
        available();
        if (timer) return reject();
        timer = setInterval(() => {
          try {
            step();
          } catch {
            /* Sticky failure: no receipt can qualify. */
          }
        }, 10);
        timer.unref();
      },
      close() {
        state = 'closed';
        if (timer) clearInterval(timer);
        timer = undefined;
        boundary.close();
        files.close();
        contract.close();
      },
    });
  } catch {
    if (timer) clearInterval(timer);
    for (const resource of [boundary, files, contract]) {
      try {
        resource?.close();
      } catch {
        /* construction rejected */
      }
    }
    throw fail();
  }
}

module.exports = { createPublicationAckHost };
