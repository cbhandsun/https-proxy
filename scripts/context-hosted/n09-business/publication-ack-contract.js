'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { fields } = require('../n09-ack/contract');
const fail = () => new Error('n09_publication_ack_control_rejected');
const hex = (value, size) =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const bounded = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const keys = [
  'version',
  'pid',
  'epoch',
  'challenge',
  'kind',
  'generation',
  'callOrdinal',
  'rootId',
  'expiresAt',
  'expectedRevision',
  'transition',
  'holdChallenge',
  'revision',
];
const transitions = ['prepared', 'sending', 'transport-finished', 'uncertain', 'withdrawn'];

// Authentication only: callers must additionally bind each message to their
// one-use state machine. A signed receipt is never a business/storage ACK.
function createPublicationAckContract(input) {
  let key;
  try {
    const { pid, epoch, signingKey } = fields(input, ['pid', 'epoch', 'signingKey']);
    if (!bounded(pid, 1, Number.MAX_SAFE_INTEGER) || !hex(epoch, 32) || !hex(signingKey, 64))
      throw fail();
    key = Buffer.from(signingKey, 'hex');
    let closed = false;
    function parse(input, signal) {
      if (closed) throw fail();
      const value = fields(input, keys);
      if (
        value.version !== 1 ||
        value.pid !== pid ||
        value.epoch !== epoch ||
        !hex(value.challenge, 32) ||
        !(signal ? ['armed', 'held', 'released'] : ['arm', 'release']).includes(value.kind) ||
        !bounded(value.generation, 1, 16) ||
        !bounded(value.callOrdinal, 1, 1024) ||
        typeof value.rootId !== 'string' ||
        !/^hbs_[a-f0-9]{32}$/.test(value.rootId) ||
        !bounded(value.expiresAt, 1, Number.MAX_SAFE_INTEGER) ||
        !bounded(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
        !transitions.includes(value.transition)
      )
        throw fail();
      const beforeHold = value.kind === 'arm' || value.kind === 'armed';
      if (
        beforeHold
          ? value.holdChallenge !== '' ||
            value.revision !== value.expectedRevision ||
            value.callOrdinal >= 1024
          : !hex(value.holdChallenge, 32) || value.revision !== value.expectedRevision + 1
      )
        throw fail();
      return Object.freeze(value);
    }
    const mac = (value, signal) =>
      createHmac('sha256', key)
        .update('hpm.n09.publication.ack.' + (signal ? 'signal' : 'command') + '.v1\0')
        .update(JSON.stringify(value))
        .digest('hex');
    function sign(input, signal) {
      try {
        const payload = parse(input, signal);
        return Object.freeze({ payload, signature: mac(payload, signal) });
      } catch {
        throw fail();
      }
    }
    function verify(input, signal) {
      try {
        const envelope = fields(input, ['payload', 'signature']);
        const payload = parse(envelope.payload, signal);
        if (
          !hex(envelope.signature, 64) ||
          !timingSafeEqual(
            Buffer.from(envelope.signature, 'hex'),
            Buffer.from(mac(payload, signal), 'hex')
          )
        )
          throw fail();
        return payload;
      } catch {
        throw fail();
      }
    }
    return Object.freeze({
      signCommand: (value) => sign(value, false),
      verifyCommand: (value) => verify(value, false),
      signSignal: (value) => sign(value, true),
      verifySignal: (value) => verify(value, true),
      close() {
        closed = true;
        key.fill(0);
      },
    });
  } catch {
    key?.fill(0);
    throw fail();
  }
}

module.exports = { createPublicationAckContract };
