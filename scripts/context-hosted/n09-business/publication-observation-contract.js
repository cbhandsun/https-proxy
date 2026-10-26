'use strict';
const { createHmac, timingSafeEqual } = require('node:crypto');
const { fields } = require('../n09-ack/contract');
const fail = () => new Error('n09_publication_observation_rejected');
const queryKeys = ['version', 'pid', 'epoch', 'sequence', 'challenge'];
const stateKeys = [
  ...queryKeys,
  'generation',
  'callOrdinal',
  'activeCount',
  'operation',
  'transition',
  'rootId',
  'expiresAt',
  'expectedRevision',
  'status',
];
function createPublicationObservationContract(input) {
  let key;
  try {
    const config = fields(input, ['pid', 'epoch', 'signingKey']);
    if (
      !Number.isSafeInteger(config.pid) ||
      config.pid < 1 ||
      typeof config.epoch !== 'string' ||
      !/^[a-f0-9]{32}$/.test(config.epoch) ||
      typeof config.signingKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(config.signingKey)
    )
      throw fail();
    key = Buffer.from(config.signingKey, 'hex');
    const { pid, epoch } = config;
    let closed = false;
    function parse(value, state) {
      if (closed) throw fail();
      const result = fields(value, state ? stateKeys : queryKeys);
      if (
        result.version !== 1 ||
        result.pid !== pid ||
        result.epoch !== epoch ||
        !Number.isSafeInteger(result.sequence) ||
        result.sequence < 1 ||
        result.sequence > 16 ||
        typeof result.challenge !== 'string' ||
        !/^[a-f0-9]{32}$/.test(result.challenge)
      )
        throw fail();
      if (state) {
        if (
          !Number.isSafeInteger(result.generation) ||
          result.generation < 0 ||
          result.generation > 16 ||
          !Number.isSafeInteger(result.callOrdinal) ||
          result.callOrdinal < 0 ||
          result.callOrdinal > 1024 ||
          !Number.isSafeInteger(result.activeCount) ||
          result.activeCount < 0 ||
          result.activeCount > 8 ||
          !['none', 'other', 'save-reference-state'].includes(result.operation) ||
          ![
            'none',
            'ambiguous',
            'prepared',
            'sending',
            'transport-finished',
            'uncertain',
            'withdrawn',
          ].includes(result.transition) ||
          !['idle', 'pending', 'completed', 'failed', 'ambiguous'].includes(result.status) ||
          !Number.isSafeInteger(result.expiresAt) ||
          result.expiresAt < 0 ||
          !Number.isSafeInteger(result.expectedRevision) ||
          result.expectedRevision < 0
        )
          throw fail();
        if (result.operation === 'save-reference-state') {
          if (
            typeof result.rootId !== 'string' ||
            !/^hbs_[a-f0-9]{32}$/.test(result.rootId) ||
            result.expiresAt < 1
          )
            throw fail();
        } else if (
          result.rootId !== '' ||
          result.expiresAt !== 0 ||
          result.expectedRevision !== 0 ||
          result.transition !== 'none'
        )
          throw fail();
        if (
          (result.status === 'pending' &&
            (result.activeCount !== 1 || !result.generation || !result.callOrdinal)) ||
          (result.status === 'ambiguous' && result.activeCount < 2) ||
          (['idle', 'completed'].includes(result.status) && result.activeCount !== 0) ||
          (result.status === 'completed' && (!result.callOrdinal || !result.generation))
        )
          throw fail();
      }
      return Object.freeze(result);
    }
    const mac = (value, state) =>
      createHmac('sha256', key)
        .update('hpm.n09.publication.' + (state ? 'state' : 'query') + '.v1\0')
        .update(JSON.stringify(value))
        .digest('hex');
    function sign(value, state) {
      try {
        const payload = parse(value, state);
        return Object.freeze({ payload, signature: mac(payload, state) });
      } catch {
        throw fail();
      }
    }
    function verify(value, state) {
      try {
        const envelope = fields(value, ['payload', 'signature']);
        const payload = parse(envelope.payload, state);
        if (
          typeof envelope.signature !== 'string' ||
          !/^[a-f0-9]{64}$/.test(envelope.signature) ||
          !timingSafeEqual(
            Buffer.from(envelope.signature, 'hex'),
            Buffer.from(mac(payload, state), 'hex')
          )
        )
          throw fail();
        return payload;
      } catch {
        throw fail();
      }
    }
    return Object.freeze({
      signQuery: (value) => sign(value, false),
      verifyQuery: (value) => verify(value, false),
      signState: (value) => sign(value, true),
      verifyState: (value) => verify(value, true),
      close() {
        if (!closed) {
          closed = true;
          key.fill(0);
        }
      },
    });
  } catch {
    key?.fill(0);
    throw fail();
  }
}
module.exports = { createPublicationObservationContract };
