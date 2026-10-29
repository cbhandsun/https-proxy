'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { createReferenceState } = require('./context-recovery-reference-state');
const failed = () => ({ ok: false, code: 'context_recovery_storage_unavailable' });

function publicationPayloads(owner, session) {
  // Terminal cleanup invalidates the session before persisting its journal.
  // Already durable sources need no payload capability; new ones still do.
  return (ids) => (ids.length ? owner.payloads(session, ids) : []);
}

// Only actual session capabilities address these transactions. A lease remains
// held through storage acknowledgement and the local writer finish boundary.
function createRecoveryRootPublication({ acquire, transactions, drop }) {
  const active = new WeakMap();
  const completed = new WeakSet();
  const items = new Set();
  let closed = false;
  function invalidateAll() {
    for (const item of items) {
      item.invalidated = true;
      drop(item.session);
      if (!item.pending) void stop(item).catch(() => {});
    }
  }
  function checkpoint(owner, session) {
    if (transactions.supportsReferenceStates()) {
      const state = owner.metadata(session);
      return createReferenceState(state.metadata, state.stagedSources);
    }
    return owner.checkpoint(session);
  }
  function check(item) {
    if (closed || item.invalidated) throw new Error('Recovery publication unavailable');
    return checkpoint(item.owner, item.session);
  }
  function forget(item) {
    active.delete(item.session);
    items.delete(item);
    item.owner.release();
  }
  function stop(item) {
    if (item.cleanup) return item.cleanup;
    item.invalidated = true;
    drop(item.session);
    item.cleanup = (async () => {
      try {
        if (item.transaction && item.checkpoint)
          await item.transaction.save(item.checkpoint, {
            snapshotId: item.snapshotId,
            state: ['prepared', 'transport-finished'].includes(item.state)
              ? 'withdrawn'
              : 'uncertain',
          });
      } finally {
        forget(item);
      }
    })();
    return item.cleanup;
  }
  function track(session, owner) {
    const item = {
      owner,
      session,
      snapshotId: owner.identity(session).snapshotId,
      state: 'prepared',
      checkpoint: null,
      transaction: null,
      invalidated: false,
      pending: null,
      cleanup: null,
    };
    active.set(session, item);
    items.add(item);
    return item;
  }
  async function perform(item, operation) {
    if (item.pending || item.invalidated || closed) return failed();
    const pending = (async () => {
      try {
        return await operation();
      } catch {
        try {
          await stop(item);
        } catch {
          /* failure never becomes an acknowledgement */
        }
        return failed();
      }
    })();
    item.pending = pending;
    try {
      return await pending;
    } finally {
      if (item.pending === pending) item.pending = null;
    }
  }
  const publication = {
    async prepare(session, output, calls = [], responseId, observed = false, compaction = false) {
      if (closed || active.has(session) || completed.has(session)) return failed();
      let owner, item;
      try {
        const safeOutput = normalizeCompactionData(output, 2 * 1024 * 1024);
        const safeCalls = normalizeCompactionData(calls, 2 * 1024 * 1024);
        const safeId =
          responseId === undefined ? undefined : normalizeCompactionData(responseId, 1024);
        owner = acquire(session);
        item = track(session, owner);
        // Observed responses have already crossed the wire. Failed capture is
        // uncertain, never evidence of write-before-publication durability.
        if (observed) item.state = 'sending';
        return await perform(item, async () => {
          const result = compaction
            ? owner.completeCompaction(session, safeOutput)
            : owner.complete(session, safeOutput, safeCalls, safeId);
          if (!result.ok) {
            forget(item);
            return result;
          }
          item.checkpoint = check(item);
          // A warm publication validates its prior association in the same
          // durable write that authenticates new payloads and journal state.
          // The transaction still denies reads/settlement before that ACK.
          item.transaction = await transactions.begin(
            item.checkpoint,
            publicationPayloads(item.owner, session),
            true
          );
          check(item);
          const acknowledgement = await item.transaction.save(item.checkpoint, {
            snapshotId: item.snapshotId,
            state: observed ? 'transport-finished' : 'prepared',
          });
          if (observed) item.state = 'transport-finished';
          check(item);
          if (transactions.supportsReferenceStates()) {
            try {
              item.owner.evictPersisted(session, acknowledgement);
            } catch {
              item.transaction.fail();
              throw new Error('Recovery publication unavailable');
            }
          }
          check(item);
          if (observed) {
            completed.add(session);
            forget(item);
          }
          return { ok: true };
        });
      } catch {
        if (item) {
          try {
            await stop(item);
          } catch {
            /* fixed failure only */
          }
        } else owner?.release();
        return failed();
      }
    },
    prepareCompaction(session, response) {
      return publication.prepare(session, response, [], undefined, false, true);
    },
    async sending(session) {
      const item = active.get(session);
      if (!item || item.state !== 'prepared') return failed();
      return perform(item, async () => {
        item.checkpoint = check(item);
        // An uncertain sending acknowledgement cannot be a clean withdrawal.
        item.state = 'sending';
        await item.transaction.save(item.checkpoint, {
          snapshotId: item.snapshotId,
          state: 'sending',
        });
        check(item);
        return { ok: true };
      });
    },
    async finished(session) {
      const item = active.get(session);
      if (!item || item.state !== 'sending') return failed();
      return perform(item, async () => {
        item.checkpoint = check(item);
        await item.transaction.save(item.checkpoint, {
          snapshotId: item.snapshotId,
          state: 'transport-finished',
        });
        item.state = 'transport-finished';
        check(item);
        completed.add(session);
        forget(item);
        return { ok: true };
      });
    },
    async withdraw(session) {
      const item = active.get(session);
      if (item) {
        item.invalidated = true;
        drop(session);
        if (item.pending) await item.pending;
        try {
          await stop(item);
          return { ok: true };
        } catch {
          return failed();
        }
      }
      if (!completed.has(session)) {
        drop(session);
        return { ok: true };
      }
      let owner;
      try {
        owner = acquire(session);
        const snapshotId = owner.identity(session).snapshotId;
        const state = checkpoint(owner, session);
        // Revocation takes effect before storage IO. Never reuse an old cached
        // checkpoint after sibling reads may have changed the shared budget.
        drop(session);
        const transaction = await transactions.begin(state, publicationPayloads(owner, session));
        await transaction.save(state, { snapshotId, state: 'withdrawn' });
        completed.delete(session);
        return { ok: true };
      } catch {
        drop(session);
        return failed();
      } finally {
        owner?.release();
      }
    },
    suspend: invalidateAll,
    close() {
      closed = true;
      invalidateAll();
    },
  };
  return publication;
}

module.exports = { createRecoveryRootPublication };
