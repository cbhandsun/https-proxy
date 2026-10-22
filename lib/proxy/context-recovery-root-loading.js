'use strict';

const {
  storageData,
  storageFailure,
  storageReplyData,
} = require('./context-recovery-storage-contract');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const {
  normalizeRecoveryHistoryRequest,
  enableRecoveryHistoryDigestReuse,
} = require('./context-recovery-history-request');
const {
  visitRecoveryStorage,
  visitRecoveryReferenceStorage,
} = require('./context-recovery-storage-scan');
const {
  projectPublishedRecoveryRoot,
  projectPublishedRecoveryReference,
} = require('./context-recovery-restore-projection');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const {
  recoveryRootBinding,
  recoveryRootMetadataBinding,
} = require('./context-recovery-root-policy');

const failure = (code = 'context_recovery_storage_unavailable') => ({ ok: false, code });

// One loader belongs to the existing session owner. No imported copy becomes a
// second writable owner, and request authorization never replaces its clock.
function createRecoveryRootLoading(context) {
  let pending = 0;
  let tail = Promise.resolve();

  function begin(input, results, authorized, compaction) {
    if (pending >= 8) return Promise.resolve(failure('context_recovery_busy'));
    let request, reported, ownerCheck;
    let denied = false;
    function check() {
      if (denied) throw storageFailure();
      try {
        const result = authorized();
        if (nativeReaderPromise(result)) {
          Promise.prototype.then.call(
            result,
            () => {},
            () => {}
          );
          throw storageFailure();
        }
        if (result !== true) throw storageFailure();
        return ownerCheck();
      } catch {
        denied = true;
        throw storageFailure();
      }
    }
    try {
      if (typeof authorized !== 'function' || typeof compaction !== 'boolean')
        throw storageFailure();
      request = normalizeRecoveryHistoryRequest(input, 3);
      reported = storageData(results, 2 * 1024 * 1024);
      if (!Array.isArray(reported) || reported.length > 128) throw storageFailure();
      const calls = new Set();
      for (const result of reported) {
        if (
          !result ||
          Array.isArray(result) ||
          Object.keys(result).sort().join(',') !== 'callId,output' ||
          typeof result.callId !== 'string' ||
          !/^[A-Za-z0-9_.:-]{1,256}$/.test(result.callId) ||
          calls.has(result.callId)
        )
          throw storageFailure();
        calls.add(result.callId);
      }
      ownerCheck = context.capture();
      check();
      enableRecoveryHistoryDigestReuse(request);
      // Validate the request without creating a branch. A missing offline
      // previous response or compact frontier is not itself malformed input.
      const probe = context.probe(request, [], compaction);
      if (probe.code === 'invalid_context_binding') throw storageFailure();
    } catch {
      return Promise.resolve(failure());
    }
    pending++;
    const task = tail.then(async () => {
      try {
        check();
        const execute = context.execute();
        if (!execute) return context.begin(request, reported, compaction, null, check);
        async function storage(command) {
          check();
          const raw = execute(command);
          const value = storageReplyData(
            nativeReaderPromise(raw) ? await raw : raw,
            command.operation
          );
          check();
          return value;
        }
        const candidates = [];
        const policy = fingerprintContextData(request.policy ?? null);
        const referenceOnly = context.referenceScan();
        const collect = (_entry, record) => {
          const root = referenceOnly ? record.reference.metadata : record.state.root;
          if (context.activeRoots().has(root.rootId)) return;
          if (
            root.principal !== request.principal ||
            root.protocol !== request.protocol ||
            root.target !== request.target
          )
            return;
          if (!compaction && root.policyFingerprint !== policy) return;
          const basis = referenceOnly
            ? recoveryRootMetadataBinding(root, request, compaction)
            : recoveryRootBinding(root, request, compaction);
          const state = referenceOnly
            ? projectPublishedRecoveryReference(record.reference, basis, check())
            : projectPublishedRecoveryRoot(record.state, basis, check());
          if (state) candidates.push({ binding: basis, state });
        };
        if (referenceOnly) await visitRecoveryReferenceStorage(storage, collect);
        else await visitRecoveryStorage(storage, context.scan(), collect);
        check();
        // Synchronous callers may have created a live root during storage I/O.
        const active = context.activeRoots();
        const rootId = (entry) => (referenceOnly ? entry.state.metadata : entry.state).rootId;
        const offline = candidates.filter((entry) => !active.has(rootId(entry)));
        const selected = referenceOnly
          ? context.probeMetadata(request, offline, compaction)
          : context.probe(request, offline, compaction);
        check();
        if (!selected.ok) return selected;
        if (selected.reason === 'ambiguous_continuation')
          return failure('context_recovery_ambiguous');
        if (selected.location === 'offline') {
          const candidate = offline.find((entry) => rootId(entry) === selected.rootId);
          if (!candidate) throw storageFailure();
          if (referenceOnly) context.adoptMetadata([candidate]);
          else context.adopt([candidate]);
          check();
        }
        return context.begin(request, reported, compaction, selected, check);
      } catch {
        return failure();
      } finally {
        pending--;
      }
    });
    tail = task.then(() => {});
    return task;
  }

  return {
    begin,
    async drain() {
      for (;;) {
        const current = tail;
        await current;
        if (current === tail) return;
      }
    },
  };
}

module.exports = { createRecoveryRootLoading };
