'use strict';

function rootOwnerFailure() {
  return Object.assign(new Error('context_recovery_root_unavailable'), {
    code: 'context_recovery_root_unavailable',
  });
}

// An explicit private lease, never ambient async context. Invalidating a lease
// does not unlock it: an outstanding storage write must settle before another
// mutation can enter. Revocation may invalidate immediately without waiting.
function createRecoveryRootOwner() {
  let closed = false;
  let current = null;
  return {
    acquire() {
      if (closed || current) throw rootOwnerFailure();
      const token = Object.freeze({});
      current = { token, valid: true };
      return token;
    },
    available(token) {
      return (
        !closed &&
        (current === null ? token === undefined : current.valid && token === current.token)
      );
    },
    invalidate() {
      if (current) current.valid = false;
    },
    release(token) {
      if (!current || current.token !== token) return false;
      current = null;
      return true;
    },
    close() {
      closed = true;
      if (current) current.valid = false;
    },
  };
}

module.exports = { createRecoveryRootOwner, rootOwnerFailure };
