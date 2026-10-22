'use strict';

const { parseRecoveryStorageRecord } = require('./context-recovery-storage-record');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { projectPublishedRecoveryRoot } = require('./context-recovery-restore-projection');
const {
  storageData,
  storageCatalog,
  storageFailure,
  storageReplyData,
} = require('./context-recovery-storage-contract');
const {
  restoreContextRecoverySessions,
  attachContextRecoveryStorage,
} = require('./context-recovery-sessions');

function optionsData(input) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    throw storageFailure();
  const fields = Object.create(null);
  for (const name of Reflect.ownKeys(input)) {
    const slot = Object.getOwnPropertyDescriptor(input, name);
    if (
      !['storage', 'request', 'authorized', 'now'].includes(name) ||
      !slot?.enumerable ||
      !Object.hasOwn(slot, 'value')
    )
      throw storageFailure();
    fields[name] = slot.value;
  }
  return fields;
}

function requestData(input) {
  const request = storageData(input, 2 * 1024 * 1024);
  const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
  if (
    !request ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) =>
        !['principal', 'protocol', 'target', 'policy', 'history', 'previousResponseId'].includes(
          key
        )
    ) ||
    !identity(request.principal) ||
    !identity(request.target) ||
    !['chat', 'responses', 'claude'].includes(request.protocol) ||
    !Array.isArray(request.history) ||
    request.history.length > 16384 ||
    request.history.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)) ||
    (request.previousResponseId !== undefined && !identity(request.previousResponseId))
  )
    throw storageFailure();
  return request;
}

// Private composition primitive. It reconstructs fresh capabilities for a
// current trusted request; no model-supplied root/path/key selector is accepted.
// Runtime adoption/leases remain the caller's responsibility. Merely opening a
// store never calls this function, and it never runs a model or external tool.
async function reauthorizeRecoveryStorage(options) {
  let sessions;
  try {
    const fields = optionsData(options);
    const request = requestData(fields.request);
    const authorized = fields.authorized;
    const now = fields.now === undefined ? Date.now : fields.now;
    const execute = Object.getOwnPropertyDescriptor(fields.storage, 'execute');
    if (
      typeof authorized !== 'function' ||
      typeof now !== 'function' ||
      typeof execute?.value !== 'function'
    )
      throw storageFailure();
    let denied = false;
    function allowed() {
      if (denied) return false;
      try {
        const result = authorized();
        if (nativeReaderPromise(result)) {
          Promise.prototype.then.call(
            result,
            () => {},
            () => {}
          );
          denied = true;
        } else denied = result !== true;
      } catch {
        denied = true;
      }
      return !denied;
    }
    const check = () => {
      if (!allowed()) throw storageFailure();
    };
    function checkedTime() {
      check();
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) throw storageFailure();
      return time;
    }
    const storage = {
      async execute(command) {
        check();
        const pending = execute.value.call(fields.storage, command);
        const result = storageReplyData(
          nativeReaderPromise(pending) ? await pending : pending,
          command.operation
        );
        check();
        return result;
      },
    };
    const catalog = storageCatalog(await storage.execute({ operation: 'catalog' }));
    const roots = [];
    const seen = new Set();
    const policy = fingerprintContextData(request.policy ?? null);
    for (const entry of catalog) {
      const record = parseRecoveryStorageRecord(
        await storage.execute({ operation: 'load', scope: entry.scope }),
        entry
      );
      const root = record.state.root;
      if (seen.has(root.rootId)) throw storageFailure();
      seen.add(root.rootId);
      if (
        root.principal !== request.principal ||
        root.protocol !== request.protocol ||
        root.target !== request.target ||
        root.policyFingerprint !== policy
      )
        continue;
      const state = projectPublishedRecoveryRoot(record.state, request, checkedTime());
      if (state) roots.push({ binding: request, state });
    }
    if (
      fingerprintContextData(catalog) !==
      fingerprintContextData(storageCatalog(await storage.execute({ operation: 'catalog' })))
    )
      throw storageFailure();
    if (!roots.length) return null;
    sessions = restoreContextRecoverySessions({ now: checkedTime }, roots);
    attachContextRecoveryStorage(sessions, storage);
    const session = sessions.begin(request);
    if (!session.ok || session.reason !== 'observed_continuation') {
      await sessions.shutdownAsync();
      return null;
    }
    check();
    return { sessions, session };
  } catch {
    // Shutdown drains without revoking committed records on an unrelated
    // denial/failed restore. No stale capability or raw storage error escapes.
    await sessions?.shutdownAsync();
    throw storageFailure();
  }
}

module.exports = { reauthorizeRecoveryStorage };
