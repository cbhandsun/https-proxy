'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { fields, fail } = require('./contract');
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const hex = (value, length) =>
  typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);

// An armed/failed control signal is explicitly NOT a durable host ACK.
function createN09MailboxControl(input) {
  let key;
  try {
    const { pid, epoch, signingKey } = fields(input, ['pid', 'epoch', 'signingKey']);
    if (!integer(pid, 1) || !hex(epoch, 32) || !hex(signingKey, 64)) throw fail();
    key = Buffer.from(signingKey, 'hex');
    let closed = false;
    function parse(input) {
      if (closed) throw fail();
      const value = fields(input, ['version', 'pid', 'epoch', 'sequence', 'state']);
      if (
        value.version !== 1 ||
        value.pid !== pid ||
        value.epoch !== epoch ||
        !integer(value.sequence, 1) ||
        value.sequence > 16 ||
        !['armed', 'failed'].includes(value.state)
      )
        throw fail();
      return Object.freeze(value);
    }
    function mac(payload) {
      return createHmac('sha256', key)
        .update('hpm.n09.mailbox.control.v1\0')
        .update(JSON.stringify(payload))
        .digest('hex');
    }
    return Object.freeze({
      sign(input) {
        try {
          const payload = parse(input);
          return Object.freeze({ payload, signature: mac(payload) });
        } catch {
          throw fail();
        }
      },
      verify(input) {
        try {
          const envelope = fields(input, ['payload', 'signature']);
          if (!hex(envelope.signature, 64)) throw fail();
          const payload = parse(envelope.payload);
          if (
            !timingSafeEqual(
              Buffer.from(envelope.signature, 'hex'),
              Buffer.from(mac(payload), 'hex')
            )
          )
            throw fail();
          return payload;
        } catch {
          throw fail();
        }
      },
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

module.exports = { createN09MailboxControl };
