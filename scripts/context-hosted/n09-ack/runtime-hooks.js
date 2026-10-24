'use strict';

const path = require('node:path');
const { types } = require('node:util');
const {
  fields,
  fail,
  parseN09AckCommand,
  parseN09AckReceipt,
  isN09NativePromise,
  discardN09PromiseRejection,
  wrapN09AckFailure,
} = require('./contract');
const { createN09HostAckObserver } = require('./observer');
const installations = new WeakSet();

function plain(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  for (const key of Reflect.ownKeys(input)) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
  }
  return input;
}
function method(input, name, replaceable = false) {
  plain(input);
  const slot = Object.getOwnPropertyDescriptor(input, name);
  if (
    !slot ||
    typeof slot.value !== 'function' ||
    types.isProxy(slot.value) ||
    (replaceable && (!slot.writable || !slot.configurable))
  )
    throw fail();
  return slot;
}
function directory(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    path.isAbsolute(value) &&
    !/^[\\/]{2}/.test(value) &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) &&
    !value.split(/[\\/]/).some((part) => part === '.' || part === '..')
  );
}
function strictShutdown(pending) {
  if (!isN09NativePromise(pending)) {
    discardN09PromiseRejection(pending);
    throw fail();
  }
  return new Promise((resolve, reject) => {
    Reflect.apply(Promise.prototype.then, pending, [
      (value) => {
        try {
          if (fields(value, ['ok']).ok !== true) throw fail();
          resolve(Object.freeze({ ok: true }));
        } catch {
          reject(fail());
        }
      },
      () => reject(fail()),
    ]);
  });
}

// Trusted test infrastructure only. Does not load modules, create lifecycle
// resources, call shutdown on close, or provide any transport/endpoint.
function installN09RuntimeHooks(input) {
  try {
    const config = fields(input, [
      'ackExports',
      'lifecycleExports',
      'expectedDirectory',
      'pid',
      'epoch',
    ]);
    if (
      !directory(config.expectedDirectory) ||
      !Number.isSafeInteger(config.pid) ||
      config.pid < 1 ||
      typeof config.epoch !== 'string' ||
      config.epoch.length !== 32 ||
      !/^[a-f0-9]{32}$/.test(config.epoch)
    )
      throw fail();
    const ackSlot = method(config.ackExports, 'createRecoveryDurableAck', true);
    const factorySlot = method(config.lifecycleExports, 'createContextRecoveryLifecycle', true);
    if (installations.has(config.ackExports) || installations.has(config.lifecycleExports))
      throw fail();
    if (types.isAsyncFunction(ackSlot.value) || types.isAsyncFunction(factorySlot.value))
      throw fail();
    let active,
      constructing = false,
      closed = false,
      failed = false,
      closeFailed = false;
    let sequence = 0;
    const patches = [];
    function available() {
      if (closed || failed) throw fail();
    }
    function patch(object, name, original, value) {
      Object.defineProperty(object, name, { ...original, value });
      patches.push({ object, name, original, value });
    }
    function ack(input, revision) {
      try {
        if (closed) return Reflect.apply(ackSlot.value, config.ackExports, [input, revision]);
        if (constructing || failed) {
          Reflect.apply(ackSlot.value, config.ackExports, [input, revision]);
          failed = true;
          throw fail();
        }
        if (!active) return Reflect.apply(ackSlot.value, config.ackExports, [input, revision]);
        const token = active.observer.createRecoveryDurableAck(input, revision);
        active.last = active.produced;
        active.produced = undefined;
        return token;
      } catch {
        failed = true;
        throw fail();
      }
    }
    function factory(options = {}) {
      available();
      plain(options);
      for (const key of Reflect.ownKeys(options))
        if (!['sessions', 'storage', 'directory'].includes(key)) throw fail();
      const source = Object.getOwnPropertyDescriptors(options);
      const target = source.directory?.value;
      if (source.storage?.value !== undefined) throw fail();
      if (target === undefined) {
        if (constructing) throw fail();
        constructing = true;
        try {
          const result = Reflect.apply(factorySlot.value, config.lifecycleExports, [options]);
          available();
          return result;
        } catch {
          throw fail();
        } finally {
          constructing = false;
        }
      }
      if (target !== config.expectedDirectory || active || constructing) throw fail();
      constructing = true;
      try {
        const lifecycle = Reflect.apply(factorySlot.value, config.lifecycleExports, [options]);
        available();
        plain(lifecycle);
        const sessions = Object.getOwnPropertyDescriptor(lifecycle, 'sessions')?.value;
        const shutdownSlot = method(lifecycle, 'shutdownAsync', true);
        const owner = {
          lifecycle,
          last: undefined,
          produced: undefined,
          localSequence: 0,
          pending: false,
          status: 'active',
          shutdown: undefined,
        };
        const observer = createN09HostAckObserver({
          pid: config.pid,
          epoch: config.epoch,
          createRecoveryDurableAck(reference, revision) {
            const token = Reflect.apply(ackSlot.value, config.ackExports, [reference, revision]);
            owner.produced = Object.freeze({
              rootId: reference.metadata.rootId,
              expiresAt: reference.metadata.expiresAt,
              revision,
            });
            return token;
          },
        });
        observer.bindSessions(sessions);
        owner.observer = observer;
        function shutdown() {
          if (owner.shutdown) return owner.shutdown;
          owner.status = 'closing';
          if (owner.pending) {
            failed = true;
            observer.close();
          }
          try {
            const original = Reflect.apply(shutdownSlot.value, lifecycle, []);
            owner.shutdown = strictShutdown(original).then(
              (value) => {
                observer.close();
                owner.status = 'released';
                if (active === owner) active = undefined;
                return value;
              },
              () => {
                failed = true;
                owner.status = 'failed';
                throw fail();
              }
            );
          } catch {
            failed = true;
            owner.status = 'failed';
            owner.shutdown = Promise.reject(fail());
          }
          return owner.shutdown;
        }
        patch(lifecycle, 'shutdownAsync', shutdownSlot, shutdown);
        active = owner;
        return lifecycle;
      } catch {
        failed = true;
        throw fail();
      } finally {
        constructing = false;
      }
    }
    function invoke(input, operation) {
      available();
      const value = parseN09AckCommand(input);
      const owner = active;
      if (
        !owner ||
        owner.status !== 'active' ||
        owner.pending ||
        !owner.last ||
        value.operation !== operation ||
        value.pid !== config.pid ||
        value.epoch !== config.epoch ||
        value.sequence !== sequence + 1
      )
        throw fail(142);
      if (value.rootId !== owner.last.rootId || value.expiresAt !== owner.last.expiresAt)
        throw fail(143);
      if (value.minRevision !== owner.last.revision) throw fail(144);
      sequence = value.sequence;
      owner.localSequence++;
      owner.pending = true;
      try {
        const pending =
          operation === 'arm-save'
            ? owner.observer.armSave({ ...value, sequence: owner.localSequence })
            : owner.observer.revokeBoundRoot({ ...value, sequence: owner.localSequence });
        return pending
          .then((receipt) => {
            if (closed || failed || active !== owner || owner.status !== 'active') throw fail();
            if (operation === 'revoke-bound-root') owner.status = 'revoked';
            return parseN09AckReceipt({ ...receipt, sequence: value.sequence });
          })
          .catch((error) => {
            failed = true;
            throw wrapN09AckFailure(error, 157);
          })
          .finally(() => {
            owner.pending = false;
          });
      } catch (error) {
        owner.pending = false;
        failed = true;
        throw wrapN09AckFailure(error, 156);
      }
    }
    function close() {
      if (closed) {
        if (closeFailed) throw fail();
        return;
      }
      closed = true;
      active?.observer.close();
      active = undefined;
      for (const entry of patches.reverse()) {
        const current = Object.getOwnPropertyDescriptor(entry.object, entry.name);
        if (
          !current ||
          current.value !== entry.value ||
          current.enumerable !== entry.original.enumerable ||
          current.writable !== entry.original.writable ||
          current.configurable !== entry.original.configurable
        ) {
          closeFailed = true;
          continue;
        }
        try {
          Object.defineProperty(entry.object, entry.name, entry.original);
        } catch {
          closeFailed = true;
        }
      }
      patches.length = 0;
      if (!closeFailed) {
        installations.delete(config.ackExports);
        installations.delete(config.lifecycleExports);
      }
      if (closeFailed) throw fail();
    }
    try {
      installations.add(config.ackExports);
      installations.add(config.lifecycleExports);
      // The ACK producer is intercepted before lifecycle construction can import it.
      patch(config.ackExports, 'createRecoveryDurableAck', ackSlot, ack);
      patch(config.lifecycleExports, 'createContextRecoveryLifecycle', factorySlot, factory);
    } catch {
      try {
        close();
      } catch {
        /* Preserve the fixed installation failure. */
      }
      throw fail();
    }
    return Object.freeze({
      armSave: (value) => invoke(value, 'arm-save'),
      revokeBoundRoot: (value) => invoke(value, 'revoke-bound-root'),
      close,
    });
  } catch {
    throw fail();
  }
}

module.exports = { installN09RuntimeHooks };
