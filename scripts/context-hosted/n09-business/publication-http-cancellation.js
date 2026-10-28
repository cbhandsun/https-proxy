'use strict';
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { types } = require('node:util');
const { fields } = require('../n09-ack/contract');
const fail = () => new Error('n09_publication_http_cancellation_failed');
const installations = new WeakSet();

// A server-side witness, bound to the original handler's async context. It sees
// only native transport lifecycle flags, never body, credentials or session.
// The original handler registers its abort listener before this close listener.
function installPublicationHttpCancellation(input) {
  let exported, slot;
  try {
    ({ httpExports: exported } = fields(input, ['httpExports']));
    if (
      !exported ||
      types.isProxy(exported) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(exported)) ||
      installations.has(exported)
    )
      throw fail();
    slot = Object.getOwnPropertyDescriptor(exported, 'tryHandleContextRecoveryHttp');
    if (
      !slot ||
      !Object.hasOwn(slot, 'value') ||
      typeof slot.value !== 'function' ||
      types.isProxy(slot.value) ||
      types.isAsyncFunction(slot.value) ||
      types.isGeneratorFunction(slot.value) ||
      !slot.enumerable ||
      !slot.configurable ||
      !slot.writable
    )
      throw fail();
  } catch {
    throw fail();
  }
  const contexts = new AsyncLocalStorage(),
    active = new Set();
  let closed = false,
    closeFailed = false;
  function transport(options) {
    if (
      !options ||
      typeof options !== 'object' ||
      types.isProxy(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    )
      return null;
    const values = {};
    for (const key of ['kind', 'clientReq', 'clientRes']) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      values[key] = descriptor.value;
    }
    if (
      values.kind !== 'responses' ||
      types.isProxy(values.clientReq) ||
      types.isProxy(values.clientRes) ||
      !(values.clientReq instanceof http.IncomingMessage) ||
      !(values.clientRes instanceof http.ServerResponse) ||
      values.clientRes.req !== values.clientReq
    )
      return null;
    return values.clientRes;
  }
  function wrapped(options, ...rest) {
    if (closed) return Reflect.apply(slot.value, this, [options, ...rest]);
    const response = transport(options);
    if (!response) return Reflect.apply(slot.value, this, [options, ...rest]);
    if (active.size >= 8) throw fail();
    const observation = { cancelled: false };
    return contexts.run(observation, () => {
      const result = Reflect.apply(slot.value, this, [options, ...rest]);
      if (result !== true) return result;
      function clean() {
        response.removeListener('close', onClose);
        response.removeListener('finish', onFinish);
        active.delete(clean);
      }
      function onFinish() {
        clean();
      }
      function onClose() {
        // Finished/public responses and unrelated contexts cannot witness this.
        observation.cancelled =
          !closed &&
          response.destroyed === true &&
          response.headersSent === false &&
          response.writableEnded === false;
        clean();
      }
      active.add(clean);
      response.once('close', onClose);
      response.once('finish', onFinish);
      return result;
    });
  }
  Object.defineProperty(exported, 'tryHandleContextRecoveryHttp', { ...slot, value: wrapped });
  installations.add(exported);
  return Object.freeze({
    wasCancelled() {
      return !closed && contexts.getStore()?.cancelled === true;
    },
    close() {
      if (closed) {
        if (closeFailed) throw fail();
        return;
      }
      closed = true;
      for (const clean of active) clean();
      contexts.disable();
      const current = Object.getOwnPropertyDescriptor(exported, 'tryHandleContextRecoveryHttp');
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
      Object.defineProperty(exported, 'tryHandleContextRecoveryHttp', slot);
      installations.delete(exported);
    },
  });
}
module.exports = { installPublicationHttpCancellation };
