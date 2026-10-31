'use strict';

const {
  createContextHistoryBranch,
  isContextHistoryBranch,
  commitContextHistoryPlan,
} = require('./context-history-branch');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { collectContextArtifactReferences } = require('./context-artifact-references');
const { estimateTokensForValue } = require('./inline-media');
const { createLogger } = require('./logger');
const log = createLogger('context-pending-plan');

function dataOptions(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  return Reflect.ownKeys(value).every(
    (key) =>
      allowed.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
  );
}

// Owns a private candidate and evidence reservation, not a published window.
// Only an explicit synchronous safe-point commit may replace the captured
// prefix. Appends after planning remain verbatim and undergo fresh admission.
function createPendingContextPlan(input) {
  const fields = [
    'history',
    'snapshot',
    'plan',
    'sourceMessages',
    'transaction',
    'scope',
    'signal',
  ];
  if (!dataOptions(input, fields)) throw new TypeError('Invalid pending context plan');
  const { history, snapshot, plan, sourceMessages, transaction, scope, signal } = input;
  if (
    !isContextHistoryBranch(history) ||
    !history.inspect(snapshot).ok ||
    scope !== history.identity.scope ||
    !dataOptions(plan, ['body', 'changed', 'fits', 'diagnostics']) ||
    plan.fits !== true ||
    typeof plan.changed !== 'boolean' ||
    !Number.isSafeInteger(sourceMessages) ||
    sourceMessages < snapshot.messageCount ||
    sourceMessages > history.stats().messageCount ||
    (signal != null && !(signal instanceof globalThis.AbortSignal)) ||
    (transaction != null &&
      (!dataOptions(transaction, ['put', 'stats', 'commit', 'rollback']) ||
        typeof transaction.commit !== 'function' ||
        typeof transaction.rollback !== 'function'))
  )
    throw new TypeError('Invalid pending context plan');
  const diagnostics = normalizeCompactionData(plan.diagnostics, 64 * 1024);
  const changed = plan.changed;
  if (
    !Number.isSafeInteger(diagnostics.hardBodyBytes) ||
    diagnostics.hardBodyBytes < 1 ||
    !Number.isSafeInteger(diagnostics.operationalInputTokens) ||
    diagnostics.operationalInputTokens < 1
  )
    throw new TypeError('Invalid pending context plan limits');
  const candidateBranch = createContextHistoryBranch(plan.body, history.identity);
  const publish = transaction ? transaction.commit.bind(transaction) : () => ({ ok: true });
  const rollback = transaction ? transaction.rollback.bind(transaction) : () => false;
  let settled = null;
  const cleanup = () => {
    signal?.removeEventListener('abort', cancel);
    candidateBranch.close();
  };
  function reject(reason) {
    if (settled) return settled;
    settled = { ok: false, reason };
    try {
      rollback();
    } catch (error) {
      settled = { ok: false, reason: 'pending_context_rollback_failed' };
      throw error;
    } finally {
      cleanup();
    }
    return settled;
  }
  function cancel() {
    try {
      reject('context_history_cancelled');
    } catch {
      log.error({ code: 'pending_context_cleanup_failed' }, 'Pending context cleanup failed');
    }
  }
  const pending = Object.freeze({
    commit() {
      if (settled) return settled;
      if (signal?.aborted) return reject('context_history_cancelled');
      const current = history.inspect(snapshot);
      if (!current.ok) return reject(current.reason);
      const prefix = candidateBranch.snapshot().body;
      const body = {
        ...prefix,
        messages: [...prefix.messages, ...current.body.messages.slice(sourceMessages)],
      };
      const finalBodyBytes = Buffer.byteLength(JSON.stringify(body));
      const finalEstimatedTokens = estimateTokensForValue(body);
      if (
        finalBodyBytes > diagnostics.hardBodyBytes ||
        finalEstimatedTokens > diagnostics.operationalInputTokens
      )
        return reject('pending_context_budget_rejected');
      try {
        const committed = commitContextHistoryPlan(
          history,
          snapshot,
          body,
          () => publish(collectContextArtifactReferences(body.messages, scope)),
          signal
        );
        if (!committed.ok) return reject(committed.reason);
        const currentOriginalBytes =
          current.body === snapshot.body && Number.isSafeInteger(diagnostics.originalBodyBytes)
            ? diagnostics.originalBodyBytes
            : Buffer.byteLength(JSON.stringify(current.body));
        const currentOriginalTokens =
          current.body === snapshot.body && Number.isSafeInteger(diagnostics.originalEstimatedTokens)
            ? diagnostics.originalEstimatedTokens
            : estimateTokensForValue(current.body);
        settled = {
          ok: true,
          plan: {
            body: committed.body,
            changed,
            fits: true,
            diagnostics: {
              ...diagnostics,
              originalBodyBytes: currentOriginalBytes,
              originalEstimatedTokens: currentOriginalTokens,
              finalBodyBytes,
              finalEstimatedTokens,
              cleanupSavedBytes: Math.max(0, currentOriginalBytes - finalBodyBytes),
              remainingBodyBytes: diagnostics.hardBodyBytes - finalBodyBytes,
              growthReserveSatisfied:
                diagnostics.hardBodyBytes - finalBodyBytes >= (diagnostics.growthReserveBytes || 0),
              historyTransactionStatus: 'committed',
              historyVersion: committed.version,
              artifactTransactionStatus: transaction ? 'committed' : 'unavailable',
              ...(diagnostics.userArchiveStatus === 'staged'
                ? { userArchiveStatus: 'committed' }
                : {}),
              artifactsStored: committed.publication.committedEntries || 0,
              artifactsDiscarded: committed.publication.discardedEntries || 0,
            },
          },
        };
        cleanup();
        return settled;
      } catch (error) {
        reject('pending_context_commit_failed');
        throw error;
      }
    },
    rollback() {
      if (settled) return false;
      reject('pending_context_rolled_back');
      return true;
    },
  });
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return pending;
}

module.exports = { createPendingContextPlan };
