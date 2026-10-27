'use strict';

const { types } = require('node:util');
const { fields, isN09NativePromise, discardN09PromiseRejection } = require('../n09-ack/contract');
const fail = () => new Error('n09_lifecycle_client_failed');
function createOwnedPublicationAck(resource, validate) {
  try {
    discardN09PromiseRejection(resource);
    const methods = fields(resource, ['arm', 'waitHeld', 'release', 'waitReleased', 'close']);
    if (
      typeof validate !== 'function' ||
      types.isProxy(validate) ||
      types.isAsyncFunction(validate) ||
      types.isGeneratorFunction(validate) ||
      Object.values(methods).some(
        (value) =>
          typeof value !== 'function' || types.isProxy(value) || types.isGeneratorFunction(value)
      ) ||
      ['release', 'close'].some((name) => types.isAsyncFunction(methods[name]))
    )
      throw fail();
    let closed = false,
      failed = false,
      closeFailed = false;
    function available() {
      if (closed || failed) throw fail();
      const result = validate();
      discardN09PromiseRejection(result);
      if (result !== undefined) throw fail();
    }
    async function call(name, ...args) {
      try {
        available();
        const pending = Reflect.apply(methods[name], resource, args);
        if (!isN09NativePromise(pending)) {
          discardN09PromiseRejection(pending);
          throw fail();
        }
        const result = await pending;
        available();
        return result;
      } catch {
        failed = true;
        throw fail();
      }
    }
    return Object.freeze({
      arm: (...args) => call('arm', ...args),
      waitHeld: () => call('waitHeld'),
      waitReleased: () => call('waitReleased'),
      release() {
        try {
          available();
          const result = Reflect.apply(methods.release, resource, []);
          discardN09PromiseRejection(result);
          if (result !== undefined) throw fail();
          available();
        } catch {
          failed = true;
          throw fail();
        }
      },
      close() {
        if (closed) {
          if (closeFailed) throw fail();
          return;
        }
        closed = true;
        try {
          const result = Reflect.apply(methods.close, resource, []);
          discardN09PromiseRejection(result);
          if (result !== undefined) throw fail();
        } catch {
          closeFailed = true;
          throw fail();
        }
      },
    });
  } catch {
    throw fail();
  }
}
module.exports = { createOwnedPublicationAck };
