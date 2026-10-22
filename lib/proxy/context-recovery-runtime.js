'use strict';

const path = require('node:path');
const { storageDirectory } = require('./context-recovery-storage-paths');
const { storageData, storageFailure } = require('./context-recovery-storage-contract');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { prepareRecoveryRuntimeDirectory } = require('./context-recovery-runtime-directory');
const { clearInactiveRecoveryStorage } = require('./context-recovery-clear-storage');

const unavailable = () => ({ ok: false, code: 'context_recovery_storage_unavailable' });
const disabled = () => ({ ok: false, code: 'context_recovery_disabled' });

function defaultCreateLifecycle(options) {
  return require('./context-recovery-lifecycle').createContextRecoveryLifecycle(options);
}

function plain(value) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw storageFailure();
  return value;
}
function ownValue(value, name) {
  const slot = Object.getOwnPropertyDescriptor(value, name);
  if (!slot) return undefined;
  if (!slot.enumerable || !Object.hasOwn(slot, 'value')) throw storageFailure();
  return slot.value;
}
function recoveryStorageSettings(config) {
  try {
    const settings = ownValue(plain(config), 'appSettings');
    if (settings === undefined) return { enabled: false, persistent: false };
    plain(settings);
    const enabled = ownValue(settings, 'contextRecoveryEnabled');
    const persistent = ownValue(settings, 'contextRecoveryPersistenceEnabled');
    if (
      (enabled !== undefined && typeof enabled !== 'boolean') ||
      (persistent !== undefined && typeof persistent !== 'boolean')
    )
      throw storageFailure();
    return { enabled: enabled === true, persistent: persistent === true };
  } catch {
    throw storageFailure();
  }
}

async function acknowledged(reply) {
  const value = storageData(nativeReaderPromise(reply) ? await reply : reply, 1024);
  if (value?.ok === true && Object.keys(value).join(',') === 'ok') return true;
  if (
    value?.ok === false &&
    Object.keys(value).sort().join(',') === 'code,ok' &&
    value.code === 'context_recovery_disabled'
  )
    return false;
  throw storageFailure();
}

// Owns storage mode changes, while each lifecycle remains the only owner of its
// session policy, startup barrier and drain. Mode changes invalidate live capabilities;
// there is no implicit migration, authority restoration or memory fallback.
function createContextRecoveryRuntime(options = {}) {
  let dataDirectory, directory, createLifecycle, prepareDirectory, clearInactiveStorage;
  try {
    plain(options);
    if (
      Reflect.ownKeys(options).some(
        (key) =>
          ![
            'dataDirectory',
            'createLifecycle',
            'prepareDirectory',
            'clearInactiveStorage',
          ].includes(key)
      )
    )
      throw storageFailure();
    dataDirectory = storageDirectory(ownValue(options, 'dataDirectory'));
    directory = path.join(dataDirectory, 'context-recovery-v1');
    const factory = ownValue(options, 'createLifecycle');
    const prepare = ownValue(options, 'prepareDirectory');
    const clear = ownValue(options, 'clearInactiveStorage');
    createLifecycle = factory === undefined ? defaultCreateLifecycle : factory;
    prepareDirectory = prepare === undefined ? prepareRecoveryRuntimeDirectory : prepare;
    clearInactiveStorage = clear === undefined ? clearInactiveRecoveryStorage : clear;
    if (
      [createLifecycle, prepareDirectory, clearInactiveStorage].some(
        (value) => typeof value !== 'function'
      )
    )
      throw storageFailure();
  } catch {
    throw storageFailure();
  }
  let current, methods;
  let persistent = false;
  let requestedPersistent = false;
  let requestedEnabled = false;
  let switching = false;
  let clearing = false;
  let clearOperation;
  let failed = false;
  let closing = false;
  let closed = false;
  let generation = 0;
  let transition = Promise.resolve();
  let rejectedCleanup = Promise.resolve(true);
  let shutdown;

  function acquire(mode) {
    let owner, close;
    try {
      owner = plain(createLifecycle(mode ? { directory } : {}));
      close = ownValue(owner, 'shutdownAsync');
      const functions = Object.create(null);
      for (const name of ['configure', 'configureAsync', 'ready', 'inspect', 'shutdownAsync']) {
        const fn = ownValue(owner, name);
        if (typeof fn !== 'function') throw storageFailure();
        functions[name] = fn.bind(owner);
      }
      for (const name of ['suspend', 'suspendAsync']) {
        const fn = ownValue(owner, name);
        if (fn !== undefined && typeof fn !== 'function') throw storageFailure();
        functions[name] =
          fn === undefined
            ? () => {
                throw storageFailure();
              }
            : fn.bind(owner);
      }
      plain(ownValue(owner, 'sessions'));
      current = owner;
      methods = functions;
      persistent = mode;
    } catch {
      if (typeof close === 'function') {
        try {
          rejectedCleanup = acknowledged(close.call(owner)).catch(() => false);
        } catch {
          rejectedCleanup = Promise.resolve(false);
        }
      }
      throw storageFailure();
    }
  }
  try {
    // Caller-supplied factories retain eager validation. The default disabled
    // service has no session authority or storage work to construct yet.
    if (createLifecycle !== defaultCreateLifecycle) acquire(false);
  } catch {
    throw storageFailure();
  }

  function stopAdmission() {
    try {
      if (methods) methods.suspend();
    } catch {
      failed = true;
    }
  }

  function ensureOwner() {
    if (current) return true;
    if (closing || failed) return false;
    try {
      acquire(false);
      return true;
    } catch {
      failed = true;
      return false;
    }
  }

  function reconcile() {
    // Persistence is a retained preference, not permission to create storage.
    // An existing disabled owner may finish its own bounded cleanup; a new
    // persistent storage is opened only for an enabled recovery request.
    if (
      switching ||
      clearing ||
      closing ||
      failed ||
      (!requestedEnabled && !persistent) ||
      persistent === requestedPersistent
    )
      return;
    switching = true;
    stopAdmission();
    transition = (async () => {
      try {
        while (!closing && !failed) {
          if (persistent !== requestedPersistent) {
            const suspended = await acknowledged(methods.suspendAsync());
            if (closing) break;
            if (!suspended) throw storageFailure();
            if (!(await acknowledged(methods.shutdownAsync()))) throw storageFailure();
            if (closing || failed) break;
            if (requestedPersistent && requestedEnabled) {
              const preparing = prepareDirectory(dataDirectory);
              const result = nativeReaderPromise(preparing) ? await preparing : preparing;
              if (result !== undefined) throw storageFailure();
              if (closing || failed) break;
            }
            // Settings may change while directory preparation is awaited.
            // Never open the obsolete persistent mode after a disable.
            acquire(requestedPersistent && requestedEnabled);
          }
          const revision = generation;
          await acknowledged(methods.configureAsync(clearing ? false : requestedEnabled));
          if (revision === generation && (!requestedEnabled || persistent === requestedPersistent))
            break;
        }
      } catch {
        failed = true;
        stopAdmission();
        try {
          await acknowledged(methods.shutdownAsync());
        } catch {
          // Preserve terminal failure; no alternate storage is opened.
        }
        await rejectedCleanup;
      } finally {
        switching = false;
      }
    })();
  }

  const service = {
    get sessions() {
      if (!ensureOwner()) throw storageFailure();
      return current.sessions;
    },
    configure(value) {
      if (typeof value !== 'boolean') throw storageFailure();
      if (closing || failed) return;
      if (requestedEnabled !== value || switching) generation++;
      requestedEnabled = value;
      try {
        if (!current && !value) return;
        if (!ensureOwner()) return;
        // During an in-flight mode change, disables apply synchronously; the
        // new owner's startup barrier orders any earlier asynchronous enable.
        if (switching || clearing || persistent !== requestedPersistent || !value)
          methods.suspend();
        else methods.configure(true);
        reconcile();
      } catch {
        failed = true;
        stopAdmission();
      }
    },
    configureSettings(config) {
      let settings;
      try {
        settings = recoveryStorageSettings(config);
      } catch {
        failed = true;
        stopAdmission();
        throw storageFailure();
      }
      if (closing || failed) return;
      if (settings.persistent !== requestedPersistent) generation++;
      requestedPersistent = settings.persistent;
      service.configure(settings.enabled);
      reconcile();
    },
    async configureAsync(value) {
      service.configure(value);
      const revision = generation;
      const result = await service.ready();
      return revision === generation ? result : disabled();
    },
    async ready() {
      try {
        for (;;) {
          if (clearOperation) await clearOperation;
          const pending = transition;
          await pending;
          if (pending !== transition) continue;
          if (closing) return disabled();
          if (failed) return unavailable();
          if (!current) return { ok: true };
          const owner = current;
          const result = await acknowledged(methods.ready());
          if (owner !== current || switching) continue;
          return result ? { ok: true } : disabled();
        }
      } catch {
        failed = true;
        stopAdmission();
        return unavailable();
      }
    },
    clearAsync() {
      if (clearOperation) return clearOperation;
      if (closing || failed) return Promise.resolve(failed ? unavailable() : disabled());
      // Invalidate online capabilities before the first await. Requests may
      // update desired policy while clearing, but cannot enable admission.
      clearing = true;
      generation++;
      stopAdmission();
      const pending = transition;
      clearOperation = (async () => {
        try {
          await pending;
          if (failed || closing) return failed ? unavailable() : disabled();
          if (methods && !(await acknowledged(methods.configureAsync(false))))
            throw storageFailure();
          if (closing || failed) return failed ? unavailable() : disabled();
          if (!persistent) {
            const reply = clearInactiveStorage({ directory });
            const result = nativeReaderPromise(reply) ? await reply : reply;
            if (result !== undefined) throw storageFailure();
          }
          if (closing || failed) return failed ? unavailable() : disabled();
          // Resume only the latest policy on the same mode. A requested mode
          // change is reconciled after the clear barrier has been released.
          if (persistent === requestedPersistent) {
            clearing = false;
            if (methods) await acknowledged(methods.configureAsync(requestedEnabled));
          }
          return failed ? unavailable() : { ok: true };
        } catch {
          failed = true;
          stopAdmission();
          return unavailable();
        } finally {
          clearing = false;
          clearOperation = undefined;
          reconcile();
        }
      })();
      return clearOperation;
    },
    inspect() {
      let state;
      try {
        state = methods
          ? storageData(methods.inspect(), 1024)
          : { appliedEnabled: false, requestedEnabled: null, state: 'disabled', storage: 'memory' };
        if (
          !state ||
          Object.keys(state).sort().join(',') !== 'appliedEnabled,requestedEnabled,state,storage' ||
          typeof state.appliedEnabled !== 'boolean' ||
          ![null, true, false].includes(state.requestedEnabled) ||
          !['memory', 'persistent'].includes(state.storage) ||
          ![
            'failed',
            'closed',
            'closing',
            'initializing',
            'unavailable',
            'enabled',
            'disabled',
          ].includes(state.state)
        )
          throw storageFailure();
      } catch {
        failed = true;
        stopAdmission();
        state = {
          appliedEnabled: false,
          storage: persistent ? 'persistent' : 'memory',
          state: 'failed',
        };
      }
      return {
        ...state,
        requestedEnabled,
        requestedPersistence: requestedPersistent,
        appliedPersistence: persistent,
        restartRetention: false,
        state: failed
          ? 'failed'
          : closed
            ? 'closed'
            : closing
              ? 'closing'
              : clearing
                ? 'clearing'
                : switching
                  ? 'switching'
                  : state.state,
      };
    },
    shutdownAsync() {
      if (shutdown) return shutdown;
      closing = true;
      // Start the actual shutdown synchronously, so no request can capture a
      // fresh lease while another mode transition is awaiting its ACK.
      let draining;
      try {
        draining = methods ? acknowledged(methods.shutdownAsync()) : Promise.resolve(true);
      } catch {
        failed = true;
      }
      shutdown = (async () => {
        try {
          if (draining && !(await draining)) failed = true;
          await transition;
          if (clearOperation) await clearOperation;
          if (!(await rejectedCleanup)) failed = true;
        } catch {
          failed = true;
        }
        closed = true;
        return failed ? unavailable() : { ok: true };
      })();
      return shutdown;
    },
  };
  return service;
}

module.exports = { createContextRecoveryRuntime, recoveryStorageSettings };
