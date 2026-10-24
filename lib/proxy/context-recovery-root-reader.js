'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { storageFailure } = require('./context-recovery-storage-contract');
const { contextRecoveryReaderResult } = require('./context-recovery-reader-result');
const { createRecoveryRootStorage } = require('./context-recovery-root-storage');
const { LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL } = require('./context-evidence-tools');
const { createReferenceState } = require('./context-recovery-reference-state');

// The host pins a real session capability; no model-supplied storage selector.
function createRecoveryRootReader(storage, acquire, sharedStorage) {
  if (typeof acquire !== 'function') throw storageFailure();
  const transactions = sharedStorage ?? createRecoveryRootStorage(storage);
  let closed = false;
  return {
    async reply(session, name, args) {
      if (![LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL].includes(name)) return null;
      if (closed) return { ok: false, code: 'context_recovery_storage_unavailable' };
      let safeArgs;
      try {
        safeArgs = normalizeCompactionData(
          args === undefined && name === LIST_EVIDENCE_TOOL ? {} : args,
          1024
        );
      } catch {
        safeArgs = null;
      }
      let owner;
      try {
        owner = acquire(session);
        function checkpoint(reservation) {
          if (closed) throw storageFailure();
          if (transactions.supportsReferenceStates()) {
            const state = owner.metadata(session, reservation);
            return createReferenceState(state.metadata, state.stagedSources);
          }
          return owner.checkpoint(session, reservation);
        }
        const incremental = transactions.supportsReaderSettlement();
        function check() {
          if (closed) throw storageFailure();
          if (incremental) owner.assertReader(session);
          else checkpoint();
        }
        // A warm reader may defer association checks into its first budget
        // save. The transaction denies source I/O until that save is durable.
        const transaction = await transactions.begin(
          checkpoint(),
          (ids) => owner.payloads(session, ids),
          true,
          true
        );
        check();
        const reservation = owner.reserveBudget();
        const acknowledgement = await transaction.save(checkpoint());
        check();
        if (transactions.supportsReferenceStates()) {
          try {
            owner.evictPersisted(session, acknowledgement);
          } catch {
            transaction.fail();
            throw storageFailure();
          }
        }
        check();
        const result = transactions.supportsSourcePages()
          ? await owner.replyReservedAsync(
              session,
              reservation,
              name,
              safeArgs,
              (source, range, maximum) => transaction.readSource(source, range, maximum)
            )
          : owner.replyReserved(session, reservation, name, safeArgs);
        if (incremental)
          await transaction.settleReader(owner.readerSettlement(session, reservation));
        else await transaction.save(checkpoint(reservation));
        owner.confirmBudget(reservation);
        check();
        contextRecoveryReaderResult(result);
        return result;
      } catch {
        return { ok: false, code: 'context_recovery_storage_unavailable' };
      } finally {
        owner?.release();
      }
    },
    close() {
      closed = true;
    },
  };
}

module.exports = { createRecoveryRootReader };
