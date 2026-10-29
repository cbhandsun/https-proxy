'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { types } = require('node:util');
const fail = () =>
  Object.assign(new Error('n09_host_ack_rejected'), { code: 'n09_host_ack_rejected' });
const hex = (value, length) =>
  typeof value === 'string' && value.length === length && !/[^a-f0-9]/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

// Copy descriptors in their original enumeration order: PowerShell signs the
// ordered JSON representation. Never invoke a caller's accessor or Proxy trap.
function record(input, expected, maximum = expected?.length) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const keys = Reflect.ownKeys(input);
  if (
    !keys.length ||
    keys.length > maximum ||
    (expected && (keys.length !== expected.length || keys.some((key) => !expected.includes(key))))
  )
    throw fail();
  const output = {};
  for (const key of keys) {
    if (typeof key !== 'string') throw fail();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw fail();
    Object.defineProperty(output, key, { value: descriptor.value, enumerable: true });
  }
  return output;
}

function pins(input) {
  const output = record(input, undefined, 512);
  for (const name of Object.keys(output)) {
    if (
      /[\\:]/.test(name) ||
      [...name].some(
        (character) =>
          character.charCodeAt(0) < 32 ||
          (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)
      ) ||
      name.split('/').some((part) => !part || part === '.' || part === '..') ||
      !/\.(?:js|cjs|json)$/.test(name) ||
      !hex(output[name], 64)
    )
      throw fail();
  }
  if (!Object.hasOwn(output, 'scripts/context-hosted/n09-ack/host-install.js')) throw fail();
  return Object.freeze(output);
}

function createN09BootstrapContract(input) {
  let key;
  try {
    const config = record(input, ['token', 'pid', 'manifestSha256']);
    if (
      typeof config.token !== 'string' ||
      config.token.length < 32 ||
      config.token.length > 256 ||
      /[^a-zA-Z0-9_-]/.test(config.token) ||
      !positive(config.pid) ||
      !hex(config.manifestSha256, 64)
    )
      throw fail();
    const { pid, manifestSha256 } = config;
    key = Buffer.from(config.token, 'ascii');
    let closed = false;
    function parse(input) {
      if (closed) throw fail();
      const source = record(input, ['version', 'pid', 'epoch', 'manifestSha256', 'sourcePins']);
      if (
        source.version !== 1 ||
        source.pid !== pid ||
        source.manifestSha256 !== manifestSha256 ||
        !hex(source.epoch, 32)
      )
        throw fail();
      const output = {};
      for (const name of Object.keys(source))
        Object.defineProperty(output, name, {
          value: name === 'sourcePins' ? pins(source[name]) : source[name],
          enumerable: true,
        });
      return Object.freeze(output);
    }
    const mac = (value) =>
      createHmac('sha256', key)
        .update('hpm.n09.bootstrap.v1\0')
        .update(JSON.stringify(value))
        .digest('hex');
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
          if (closed) throw fail();
          const envelope = record(input, ['payload', 'signature']);
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
      mailboxKey(input) {
        try {
          const payload = parse(input);
          return createHmac('sha256', key)
            .update(
              'hpm.n09.mailbox.key.v1\0' +
                String(pid) +
                '\0' +
                payload.epoch +
                '\0' +
                manifestSha256
            )
            .digest('hex');
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

module.exports = { createN09BootstrapContract };
