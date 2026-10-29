'use strict';

const { nativeRecoveryProviderAllowed } = require('./context-recovery-http-entry');
const { invokeRecoveryPublication } = require('./context-recovery-publication');

function nativeRecoveryCompactionProviderAllowed(options) {
  return (
    options.kind === 'responses' &&
    ['/v1/responses/compact', '/backend-api/codex/responses/compact'].includes(options.path) &&
    nativeRecoveryProviderAllowed({ ...options, path: options.path.slice(0, -'/compact'.length) })
  );
}

// Called only after the native response collector validates the entire window.
// Publication failure withdraws this branch without changing older checkpoints.
function createRecoveryCompactionPublication(session, authorized) {
  let committed = false;
  let terminal = false;
  let asyncStarted = false;
  let attempted = false;
  let ready = false;
  let transportFinished = false;
  let finishConfirmed = false;
  let cleanup;
  function allowed() {
    try {
      return !terminal && authorized() === true;
    } catch {
      return false;
    }
  }
  const publication = {
    isAuthorized: allowed,
    beforePublish(response) {
      if (asyncStarted || terminal || committed || !authorized()) return false;
      if (!session.completeCompaction(response).ok) return false;
      committed = true;
      if (!authorized()) {
        session.withdraw();
        terminal = true;
        return false;
      }
      return true;
    },
    complete() {
      if (asyncStarted && !finishConfirmed) return;
      terminal = true;
    },
    abort() {
      if (asyncStarted) return publication.abortAsync();
      if (terminal) return;
      terminal = true;
      if (committed) session.withdraw();
      else session.abort();
    },
    async beforePublishAsync(response) {
      if (asyncStarted || committed || !allowed()) return false;
      asyncStarted = true;
      attempted = true;
      try {
        await invokeRecoveryPublication(session, 'compaction', [response]);
        committed = true;
        if (!allowed()) throw new Error('Recovery publication unavailable');
        await invokeRecoveryPublication(session, 'sending');
        if (!allowed()) throw new Error('Recovery publication unavailable');
        ready = true;
        return true;
      } catch {
        await publication.abortAsync();
        return false;
      }
    },
    async completeAsync() {
      if (!ready || transportFinished || !allowed()) {
        await publication.abortAsync();
        return false;
      }
      // Mark synchronously: normal finish -> close must not revoke a pending
      // final persistence ACK. Real authorization changes are still checked.
      transportFinished = true;
      try {
        await invokeRecoveryPublication(session, 'finished');
        if (!allowed()) throw new Error('Recovery publication unavailable');
        finishConfirmed = true;
        return true;
      } catch {
        await publication.abortAsync();
        return false;
      }
    },
    abortAsync() {
      if (cleanup) return cleanup;
      if (terminal) return Promise.resolve(true);
      terminal = true;
      cleanup = (async () => {
        try {
          await invokeRecoveryPublication(session, attempted ? 'withdraw' : 'abort');
          return true;
        } catch {
          return false;
        }
      })();
      return cleanup;
    },
    close() {
      if (transportFinished) return;
      return publication.abortAsync();
    },
  };
  return publication;
}

module.exports = { nativeRecoveryCompactionProviderAllowed, createRecoveryCompactionPublication };
