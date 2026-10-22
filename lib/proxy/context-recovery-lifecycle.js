'use strict';

const {
  createContextRecoverySessions,
  initializeContextRecoveryStorage,
} = require('./context-recovery-sessions');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { storageData, storageFailure } = require('./context-recovery-storage-contract');

const unavailable = () => ({ ok: false, code: 'context_recovery_storage_unavailable' });
const disabled = () => ({ ok: false, code: 'context_recovery_disabled' });

async function acknowledgement(pending) {
  try {
    const value = storageData(nativeReaderPromise(pending) ? await pending : pending, 1024);
    if (
      value &&
      !Array.isArray(value) &&
      Object.keys(value).join(',') === 'ok' &&
      value.ok === true
    )
      return { ok: true };
    if (
      value &&
      Object.keys(value).sort().join(',') === 'code,ok' &&
      value.ok === false &&
      value.code === 'context_recovery_disabled'
    )
      return disabled();
  } catch {
    // Native/adapter errors never escape into diagnostics or settings replies.
  }
  return unavailable();
}

// Trusted composition owner. One session and an optional storage capability or
// directory. Opening never reconstructs current read authority by itself.
function createContextRecoveryLifecycle(options = {}) {
  let sessions, storage, closeStorage;
  const methods = Object.create(null);
  try {
    if (
      !options ||
      Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    )
      throw storageFailure();
    for (const name of Reflect.ownKeys(options)) {
      const slot = Object.getOwnPropertyDescriptor(options, name);
      if (
        !['sessions', 'storage', 'directory'].includes(name) ||
        !slot?.enumerable ||
        !Object.hasOwn(slot, 'value')
      )
        throw storageFailure();
    }
    sessions = options.sessions === undefined ? createContextRecoverySessions() : options.sessions;
    storage = options.storage;
    if (storage !== undefined && options.directory !== undefined) throw storageFailure();
    for (const name of ['configure', 'configureAsync', 'shutdownAsync', 'inspect']) {
      const slot = Object.getOwnPropertyDescriptor(sessions, name);
      if (typeof slot?.value !== 'function') throw storageFailure();
      methods[name] = slot.value.bind(sessions);
    }
    for (const name of ['suspend', 'suspendAsync']) {
      const slot = Object.getOwnPropertyDescriptor(sessions, name);
      if (slot && (!Object.hasOwn(slot, 'value') || typeof slot.value !== 'function'))
        throw storageFailure();
      methods[name] = slot ? slot.value.bind(sessions) : undefined;
    }
    if (Boolean(methods.suspend) !== Boolean(methods.suspendAsync)) throw storageFailure();
    if (storage !== undefined || options.directory !== undefined) {
      const state = methods.inspect();
      if (state.closed || state.enabled || state.roots || state.snapshots) throw storageFailure();
      if (options.directory !== undefined) {
        const {
          createContextRecoveryStorageOpening,
        } = require('./context-recovery-storage-opening');
        storage = createContextRecoveryStorageOpening({ directory: options.directory });
      }
      for (const name of ['execute', 'close'])
        if (typeof Object.getOwnPropertyDescriptor(storage, name)?.value !== 'function')
          throw storageFailure();
      closeStorage = Object.getOwnPropertyDescriptor(storage, 'close').value.bind(storage);
    }
  } catch {
    throw storageFailure();
  }
  let requested = null;
  let retaining = false;
  let generation = 0;
  let initializing = storage !== undefined;
  let closing = false;
  let closed = false;
  let failed = false;
  let shutdown;
  let policy = Promise.resolve({ ok: true });
  const initialization =
    storage === undefined
      ? Promise.resolve({ ok: true })
      : acknowledgement(initializeContextRecoveryStorage(sessions, storage)).then((result) => {
          initializing = false;
          if (!result.ok && !closing) failed = true;
          return result;
        });
  function invoke(name, ...args) {
    try {
      return acknowledgement(methods[name](...args));
    } catch {
      return Promise.resolve(unavailable());
    }
  }

  async function settled() {
    const initial = await initialization;
    for (;;) {
      const current = policy;
      const result = await current;
      if (current !== policy) continue;
      if (closing) return disabled();
      if (!initial.ok || failed) return unavailable();
      const state = methods.inspect();
      if (state.closed || (requested === true && !state.enabled)) return disabled();
      return result;
    }
  }
  const service = {
    sessions,
    configure(value) {
      if (typeof value !== 'boolean') throw new TypeError('Invalid recovery lifecycle policy');
      if (closing || failed || (requested === value && (!retaining || value))) return;
      retaining = false;
      requested = value;
      generation++;
      if (storage === undefined) {
        try {
          methods.configure(value);
        } catch {
          failed = true;
          policy = invoke('shutdownAsync');
        }
        return;
      }
      // configureAsync(false) invalidates synchronously before its first await.
      // The session barrier preserves newer disables across discovery and ACKs.
      policy = invoke('configureAsync', value).then((result) => {
        if (!result.ok && result.code !== 'context_recovery_disabled') {
          failed = true;
          void invoke('shutdownAsync');
        }
        return result;
      });
    },
    async configureAsync(value) {
      service.configure(value);
      const revision = generation;
      const result = await settled();
      return revision !== generation ? disabled() : result;
    },
    suspend() {
      if (closing || failed || requested === false) return;
      if (!methods.suspend || !methods.suspendAsync) {
        failed = true;
        policy = invoke('shutdownAsync');
        return;
      }
      requested = false;
      retaining = true;
      generation++;
      if (storage === undefined) {
        try {
          methods.suspend();
        } catch {
          failed = true;
          policy = invoke('shutdownAsync');
        }
        return;
      }
      policy = invoke('suspendAsync').then((result) => {
        if (!result.ok && result.code !== 'context_recovery_disabled') {
          failed = true;
          void invoke('shutdownAsync');
        }
        return result;
      });
    },
    async suspendAsync() {
      service.suspend();
      const revision = generation;
      const result = await settled();
      return revision !== generation ? disabled() : result;
    },
    ready: settled,
    inspect() {
      const state = methods.inspect();
      return {
        requestedEnabled: requested,
        appliedEnabled: state.enabled,
        storage: storage === undefined ? 'memory' : 'persistent',
        state: failed
          ? 'failed'
          : closed
            ? 'closed'
            : closing
              ? 'closing'
              : initializing
                ? 'initializing'
                : state.closed
                  ? 'unavailable'
                  : state.enabled
                    ? 'enabled'
                    : 'disabled',
      };
    },
    shutdownAsync() {
      if (shutdown) return shutdown;
      closing = true;
      // Stop admission immediately, then drain session transactions before the
      // worker exits. A normal exit retains committed records for revalidation.
      const drained = invoke('shutdownAsync');
      shutdown = (async () => {
        await initialization;
        const result = await drained;
        await policy;
        try {
          if (storage !== undefined) {
            const pending = closeStorage();
            const reply = nativeReaderPromise(pending) ? await pending : pending;
            if (reply !== undefined) throw storageFailure();
          }
        } catch {
          failed = true;
        }
        closed = true;
        return result.ok && !failed ? { ok: true } : unavailable();
      })();
      return shutdown;
    },
  };
  return service;
}

module.exports = { createContextRecoveryLifecycle };
