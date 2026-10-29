'use strict';
const { types } = require('node:util');
const { fields, isN09NativePromise, discardN09PromiseRejection } = require('../n09-ack/contract');
const fail = () => new Error('n09_publication_action_hook_failed');
const installations = new WeakSet();

// Install before the HTTP entry destructures the real export. The successful
// original result is returned unchanged only after the private observer; neither
// sessions, arguments, response data nor ACK tokens are exposed to that observer.
function installPublicationActionHook(input) {
  let config, slot;
  try {
    config = fields(input, ['publicationExports', 'afterPublicationAction']);
    const exported = config.publicationExports;
    if (
      !exported ||
      types.isProxy(exported) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(exported)) ||
      installations.has(exported) ||
      typeof config.afterPublicationAction !== 'function' ||
      types.isProxy(config.afterPublicationAction) ||
      types.isGeneratorFunction(config.afterPublicationAction)
    )
      throw fail();
    slot = Object.getOwnPropertyDescriptor(exported, 'invokeRecoveryPublication');
    if (
      !slot ||
      !Object.hasOwn(slot, 'value') ||
      typeof slot.value !== 'function' ||
      types.isProxy(slot.value) ||
      !types.isAsyncFunction(slot.value) ||
      types.isGeneratorFunction(slot.value) ||
      !slot.writable ||
      !slot.configurable ||
      !slot.enumerable
    )
      throw fail();
  } catch {
    throw fail();
  }
  let closed = false,
    failed = false,
    notifying = false,
    closeFailed = false;
  function available() {
    if (closed || failed) throw fail();
  }
  async function wrapped(...args) {
    if (closed) return Reflect.apply(slot.value, this, args);
    if (failed || notifying) {
      failed = true;
      throw fail();
    }
    // Original errors remain the original errors and never enter the observer.
    const original = await Reflect.apply(slot.value, this, args);
    try {
      available();
      if (notifying) throw fail();
      const action = args[1];
      if (
        typeof action !== 'string' ||
        ![
          'prepare',
          'public',
          'observed',
          'compaction',
          'sending',
          'finished',
          'withdraw',
          'abort',
        ].includes(action)
      )
        throw fail();
      notifying = true;
      const pending = Reflect.apply(config.afterPublicationAction, undefined, [action]);
      if (pending !== undefined) {
        if (!isN09NativePromise(pending)) {
          discardN09PromiseRejection(pending);
          throw fail();
        }
        if ((await pending) !== undefined) throw fail();
      }
      available();
      return original;
    } catch {
      failed = true;
      throw fail();
    } finally {
      notifying = false;
    }
  }
  Object.defineProperty(config.publicationExports, 'invokeRecoveryPublication', {
    ...slot,
    value: wrapped,
  });
  installations.add(config.publicationExports);
  return Object.freeze({
    close() {
      if (closed) {
        if (closeFailed) throw fail();
        return;
      }
      closed = true;
      const current = Object.getOwnPropertyDescriptor(
        config.publicationExports,
        'invokeRecoveryPublication'
      );
      if (
        !current ||
        current.value !== wrapped ||
        current.enumerable !== slot.enumerable ||
        current.writable !== slot.writable ||
        current.configurable !== slot.configurable
      ) {
        closeFailed = true;
        throw fail();
      }
      Object.defineProperty(config.publicationExports, 'invokeRecoveryPublication', slot);
      installations.delete(config.publicationExports);
    },
  });
}
module.exports = { installPublicationActionHook };
