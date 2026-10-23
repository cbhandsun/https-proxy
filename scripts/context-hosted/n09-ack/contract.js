'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { types } = require('node:util');
const fail = () =>
  Object.assign(new Error('n09_host_ack_rejected'), { code: 'n09_host_ack_rejected' });
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const hex = (value, length) =>
  typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);

// Native promises may carry async_hooks' own symbol data slots. They are never
// read by Promise.prototype.then. Reject own constructor/then and accessors so
// observing completion cannot execute an unknown getter or species factory.
function isN09NativePromise(value) {
  if (
    !types.isPromise(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Promise.prototype
  )
    return false;
  return Reflect.ownKeys(value).every(
    (name) =>
      typeof name === 'symbol' &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, name), 'value')
  );
}

// Rejection cleanup is possible for a base native promise even when unrelated
// own properties made the strict contract fail. Never inspect a constructor
// accessor or subclass species while rejecting an invalid capability result.
function discardN09PromiseRejection(value) {
  if (
    types.isPromise(value) &&
    !types.isProxy(value) &&
    Object.getPrototypeOf(value) === Promise.prototype &&
    !Object.hasOwn(value, 'constructor')
  )
    Reflect.apply(Promise.prototype.then, value, [undefined, () => {}]);
}

function fields(input, names) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some((name) => !names.includes(name))) throw fail();
  const result = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw fail();
    Object.defineProperty(result, name, { value: descriptor.value, enumerable: true });
  }
  return result;
}
const commandKeys = [
  'version',
  'operation',
  'pid',
  'epoch',
  'sequence',
  'rootId',
  'expiresAt',
  'minRevision',
];
const receiptKeys = [
  'version',
  'kind',
  'durableBoundary',
  'pid',
  'epoch',
  'sequence',
  'rootId',
  'expiresAt',
  'revision',
  'calls',
  'returnedBytes',
  'revisionSource',
  'evidenceLevel',
  'liveDaemonProved',
];
function identity(value) {
  if (
    value.version !== 1 ||
    !integer(value.pid, 1) ||
    !hex(value.epoch, 32) ||
    !integer(value.sequence, 1) ||
    typeof value.rootId !== 'string' ||
    value.rootId.length !== 36 ||
    !/^hbs_[a-f0-9]{32}$/.test(value.rootId) ||
    !integer(value.expiresAt, 1)
  )
    throw fail();
}
function parseN09AckCommand(input) {
  try {
    const value = fields(input, commandKeys);
    identity(value);
    if (
      !['arm-save', 'revoke-bound-root'].includes(value.operation) ||
      !integer(value.minRevision, 1)
    )
      throw fail();
    return Object.freeze(value);
  } catch {
    throw fail();
  }
}
function parseN09AckReceipt(input) {
  try {
    const value = fields(input, receiptKeys);
    identity(value);
    const save = value.kind === 'host-save-completed';
    if (
      (!save && value.kind !== 'host-revoke-completed') ||
      value.durableBoundary !== (save ? 'await-reference-save' : 'await-revokeAsync') ||
      !integer(value.revision, 1) ||
      !integer(value.calls) ||
      !integer(value.returnedBytes) ||
      value.revisionSource !== 'validated-reference-save' ||
      value.evidenceLevel !== 'observer-boundary-only' ||
      value.liveDaemonProved !== false
    )
      throw fail();
    return Object.freeze(value);
  } catch {
    throw fail();
  }
}
function createN09AckContract(input) {
  let key;
  try {
    const config = fields(input, ['pid', 'epoch', 'signingKey']);
    if (!integer(config.pid, 1) || !hex(config.epoch, 32) || !hex(config.signingKey, 64))
      throw fail();
    const { pid, epoch } = config;
    key = Buffer.from(config.signingKey, 'hex');
    let closed = false;
    const domain = (kind) => 'hpm.n09.host-durable-ack.v1\0' + kind + '\0';
    function parsed(kind, value) {
      if (closed) throw fail();
      const result = kind === 'command' ? parseN09AckCommand(value) : parseN09AckReceipt(value);
      if (result.pid !== pid || result.epoch !== epoch) throw fail();
      return result;
    }
    function mac(kind, value) {
      return createHmac('sha256', key)
        .update(domain(kind))
        .update(JSON.stringify(value))
        .digest('hex');
    }
    function sign(kind, input) {
      try {
        const payload = parsed(kind, input);
        return Object.freeze({ payload, signature: mac(kind, payload) });
      } catch {
        throw fail();
      }
    }
    function verify(kind, input) {
      try {
        const envelope = fields(input, ['payload', 'signature']);
        if (!hex(envelope.signature, 64)) throw fail();
        const payload = parsed(kind, envelope.payload);
        if (
          !timingSafeEqual(
            Buffer.from(envelope.signature, 'hex'),
            Buffer.from(mac(kind, payload), 'hex')
          )
        )
          throw fail();
        return payload;
      } catch {
        throw fail();
      }
    }
    return Object.freeze({
      signCommand: (value) => sign('command', value),
      verifyCommand: (value) => verify('command', value),
      signReceipt: (value) => sign('receipt', value),
      verifyReceipt: (value) => verify('receipt', value),
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

module.exports = {
  createN09AckContract,
  parseN09AckCommand,
  parseN09AckReceipt,
  isN09NativePromise,
  discardN09PromiseRejection,
  fields,
  fail,
};
