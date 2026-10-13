'use strict';

const {
  recoveryError,
  safeData,
  fingerprint,
  validateOriginal,
  validateRetainedInput,
} = require('./context-recovery-data');

// Client-owned, process-local capabilities. No disk, proxy cache or rollout access.
function createRecoveryHistory({ maxBytes }) {
  const snapshots = new Map();
  const pending = new WeakSet();
  let bytes = 0;
  function discard(handle) {
    const snapshot = snapshots.get(handle);
    if (snapshot) bytes -= snapshot.bytes;
    snapshots.delete(handle);
  }
  return {
    capture(request, originalInput, complete) {
      if (complete !== true) throw recoveryError('original_history_unavailable');
      const input = safeData(originalInput, maxBytes);
      validateOriginal(input);
      validateRetainedInput(request, input);
      if (request.conversation != null) throw recoveryError();
      const rebuilt = { ...request, input };
      delete rebuilt.previous_response_id;
      safeData(rebuilt, maxBytes);
      const size = Buffer.byteLength(JSON.stringify(input));
      if (snapshots.size >= 16 || bytes + size > 8 * 1024 * 1024)
        throw recoveryError('client_recovery_history_quota');
      const handle = Object.freeze(Object.create(null));
      snapshots.set(handle, { digest: fingerprint(request), input, bytes: size });
      bytes += size;
      return handle;
    },
    acquire(handle, request) {
      const snapshot = snapshots.get(handle);
      if (!snapshot || snapshot.digest !== fingerprint(request))
        throw recoveryError('original_history_mismatch');
      if (pending.has(handle)) throw recoveryError('client_recovery_busy');
      pending.add(handle);
      return () => {
        if (!snapshots.has(handle)) throw recoveryError('original_history_unavailable');
        return safeData(snapshot.input, maxBytes);
      };
    },
    release(handle) {
      pending.delete(handle);
    },
    discard,
    close() {
      snapshots.clear();
      bytes = 0;
    },
  };
}

module.exports = { createRecoveryHistory };
