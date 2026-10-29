'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');
const { fields } = require('../n09-ack/contract');
const { createPublicationAckContract } = require('./publication-ack-contract');
const { createPublicationAckFiles } = require('./publication-observation-files');
const fail = () => new Error('n09_publication_ack_channel_rejected');
const targetKeys = [
  'generation',
  'callOrdinal',
  'rootId',
  'expiresAt',
  'expectedRevision',
  'transition',
];

// Internal capability: configuration comes from the verified bootstrap owner.
// This channel proves a probe handshake, never HTTP completion or a durable ACK.
function createPublicationAckChannel(input) {
  let files, contract;
  try {
    const config = fields(input, ['caseRoot', 'pid', 'epoch', 'signingKey']);
    contract = createPublicationAckContract({
      pid: config.pid,
      epoch: config.epoch,
      signingKey: config.signingKey,
    });
    files = createPublicationAckFiles({
      directory: path.join(
        config.caseRoot,
        'n09-publication-ack-' + config.pid + '-' + config.epoch
      ),
      pid: config.pid,
      epoch: config.epoch,
    });
    let state = 'idle',
      pending = false,
      request,
      held,
      triggerHeld;
    function enter(expected) {
      if (pending || state !== expected) {
        state = 'failed';
        throw fail();
      }
      pending = true;
    }
    async function receive(kind, deadline) {
      for (;;) {
        if (state === 'closed' || state === 'failed' || performance.now() >= deadline) throw fail();
        const wire = files.read(kind, 1);
        if (wire !== null) {
          const value = contract.verifySignal(wire);
          if (value.kind !== kind || performance.now() >= deadline) throw fail();
          const exact = [
            'pid',
            'epoch',
            'challenge',
            'generation',
            'rootId',
            'expiresAt',
            'expectedRevision',
            'transition',
          ];
          if (exact.some((key) => value[key] !== request[key])) throw fail();
          if (kind === 'armed' || kind === 'armed-cancel') {
            if (value.callOrdinal !== request.callOrdinal) throw fail();
          } else if (value.callOrdinal <= request.callOrdinal) throw fail();
          if (
            kind === 'released' &&
            ['callOrdinal', 'holdChallenge', 'revision'].some((key) => value[key] !== held[key])
          )
            throw fail();
          if (
            kind === 'trigger-held' &&
            value.callOrdinal < request.callOrdinal + (request.transition === 'uncertain' ? 2 : 1)
          )
            throw fail();
          if (
            kind === 'held' &&
            request.kind === 'arm-cancel' &&
            (!triggerHeld ||
              value.callOrdinal <= triggerHeld.callOrdinal ||
              value.holdChallenge === triggerHeld.holdChallenge)
          )
            throw fail();
          return value;
        }
        await pause(Math.min(10, Math.max(1, deadline - performance.now())));
      }
    }
    async function operation(expected, next, fn) {
      try {
        const deadline = performance.now() + 750;
        enter(expected);
        const result = await fn(deadline);
        if (state !== expected) throw fail();
        state = next;
        return result;
      } catch {
        if (state !== 'closed') state = 'failed';
        throw fail();
      } finally {
        pending = false;
      }
    }
    function arm(input, cancellation) {
      const signal = cancellation ? 'armed-cancel' : 'armed';
      return operation('idle', signal, async (deadline) => {
        const target = fields(input, targetKeys);
        request = contract.signCommand({
          version: 1,
          pid: config.pid,
          epoch: config.epoch,
          challenge: randomBytes(16).toString('hex'),
          kind: cancellation ? 'arm-cancel' : 'arm',
          ...target,
          holdChallenge: '',
          revision: target.expectedRevision,
        }).payload;
        files.write('arm', 1, JSON.stringify(contract.signCommand(request)));
        return receive(signal, deadline);
      });
    }
    return Object.freeze({
      arm: (input) => arm(input, false),
      armCancellation: (input) => arm(input, true),
      waitTriggerHeld() {
        return operation('armed-cancel', 'trigger-held', async (deadline) => {
          triggerHeld = await receive('trigger-held', deadline);
          return triggerHeld;
        });
      },
      releaseTrigger() {
        try {
          enter('trigger-held');
          files.write(
            'trigger-release',
            1,
            JSON.stringify(contract.signCommand({ ...triggerHeld, kind: 'trigger-release' }))
          );
          state = 'trigger-release-requested';
        } catch {
          if (state !== 'closed') state = 'failed';
          throw fail();
        } finally {
          pending = false;
        }
      },
      waitHeld() {
        return operation(
          request?.kind === 'arm-cancel' ? 'trigger-release-requested' : 'armed',
          'held',
          async (deadline) => {
            held = await receive('held', deadline);
            return held;
          }
        );
      },
      release() {
        try {
          enter('held');
          files.write(
            'release',
            1,
            JSON.stringify(contract.signCommand({ ...held, kind: 'release' }))
          );
          state = 'release-requested';
        } catch {
          if (state !== 'closed') state = 'failed';
          throw fail();
        } finally {
          pending = false;
        }
      },
      waitReleased() {
        return operation('release-requested', 'released', (deadline) =>
          receive('released', deadline)
        );
      },
      close() {
        state = 'closed';
        files.close();
        contract.close();
      },
    });
  } catch {
    for (const resource of [files, contract]) {
      try {
        resource?.close();
      } catch {
        /* construction rejected */
      }
    }
    throw fail();
  }
}

module.exports = { createPublicationAckChannel };
