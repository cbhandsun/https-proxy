'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { parseEvidenceBudgetState } = require('./context-evidence-budget-state');
const { normalizeRecoveryCheckpointData } = require('./context-recovery-state-data');

const exact = (value, fields) =>
  value && !Array.isArray(value) && Object.keys(value).sort().join(',') === fields;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function invalid() {
  return Object.assign(new TypeError('invalid_recovery_reader_settlement'), {
    code: 'invalid_recovery_reader_settlement',
  });
}

// Trusted owner-to-storage delta, never a model-facing authority or transcript.
// No source data, identities, expiry, binding or publication changes are admitted.
function parseReaderSettlement(input) {
  try {
    const value = normalizeCompactionData(input, 16384);
    if (
      !exact(value, 'budget,kind,ledger,observedAt,rootId,version') ||
      ![1, 2].includes(value.version) ||
      value.kind !== 'recovery-reader-settlement' ||
      typeof value.rootId !== 'string' ||
      !/^hbs_[a-f0-9]{32}$/.test(value.rootId) ||
      !integer(value.observedAt) ||
      !exact(value.ledger, 'readCount,sources') ||
      !integer(value.ledger.readCount) ||
      !Array.isArray(value.ledger.sources) ||
      value.ledger.sources.length > (value.version === 1 ? 64 : 1)
    )
      throw invalid();
    value.budget = parseEvidenceBudgetState(value.budget);
    const ids = new Set();
    for (const source of value.ledger.sources) {
      if (
        !exact(source, 'coveredThrough,readComplete,sourceId') ||
        typeof source.sourceId !== 'string' ||
        !/^hce_[a-f0-9]{32}$/.test(source.sourceId) ||
        ids.has(source.sourceId) ||
        !integer(source.coveredThrough) ||
        source.coveredThrough > 2 * 1024 * 1024 ||
        typeof source.readComplete !== 'boolean'
      )
        throw invalid();
      ids.add(source.sourceId);
    }
    return value;
  } catch {
    throw invalid();
  }
}

function applySettlement(input, delta, referenceOnly) {
  try {
    // Lazy import keeps the storage wire parser independent of checkpoint codecs.
    const {
      parseRootCheckpoint,
      createRootCheckpoint,
    } = require('./context-recovery-root-checkpoint');
    const {
      parseReaderReferenceState,
      createReferenceState,
    } = require('./context-recovery-reference-state');
    const safe = referenceOnly ? null : normalizeRecoveryCheckpointData(input);
    const reference = referenceOnly ? parseReaderReferenceState(input) : null;
    const prior = reference
      ? {
          root: reference.metadata,
          stagedSources: reference.stagedSources,
          publications: reference.publications,
        }
      : parseRootCheckpoint(safe, safe.root);
    const patch = parseReaderSettlement(delta);
    const root = prior.root;
    const readDelta = patch.ledger.readCount - root.ledger.readCount;
    const successDelta = patch.budget.successfulReads - root.budget.successfulReads;
    if (
      patch.rootId !== root.rootId ||
      patch.observedAt < root.observedAt ||
      patch.observedAt < root.ledger.observedAt ||
      patch.observedAt >= root.expiresAt ||
      patch.budget.version !== root.budget.version ||
      patch.budget.calls !== root.budget.calls ||
      patch.budget.returnedBytes > root.budget.returnedBytes ||
      patch.budget.returnedBytes < Math.max(0, root.budget.returnedBytes - 16384) ||
      !integer(readDelta) ||
      readDelta > 1 ||
      !integer(successDelta) ||
      successDelta > readDelta
    )
      throw invalid();
    const progress = new Map(patch.ledger.sources.map((source) => [source.sourceId, source]));
    // Version 1 is the complete live progress inventory. Version 2 contains
    // only the changed source from one reserved read; omission preserves prior
    // progress, never clears it. Old parsers reject version 2 explicitly.
    if (patch.version === 2 && progress.size > readDelta) throw invalid();
    let changes = 0;
    function update(sources) {
      return sources.flatMap((source) => {
        const next = progress.get(source.sourceId);
        progress.delete(source.sourceId);
        if (source.expiresAt <= patch.observedAt) {
          if (next) throw invalid();
          return [];
        }
        if (!next && patch.version === 2) return [source];
        if (
          !next ||
          next.coveredThrough < source.coveredThrough ||
          (source.readComplete && !next.readComplete)
        )
          throw invalid();
        if (
          next.coveredThrough !== source.coveredThrough ||
          next.readComplete !== source.readComplete
        )
          changes++;
        return [
          { ...source, coveredThrough: next.coveredThrough, readComplete: next.readComplete },
        ];
      });
    }
    const sources = update(root.ledger.sources);
    const stagedSources = update(prior.stagedSources);
    if (progress.size || changes > readDelta) throw invalid();
    const nextRoot = {
      ...root,
      observedAt: patch.observedAt,
      budget: patch.budget,
      ledger: {
        ...root.ledger,
        observedAt: patch.observedAt,
        readCount: patch.ledger.readCount,
        sources,
      },
    };
    // The blob owner verifies changed-source bytes/UTF-8 before committing this
    // metadata result. The reference is never treated as a full restore token.
    if (referenceOnly) return createReferenceState(nextRoot, stagedSources, prior.publications);
    const result = createRootCheckpoint(nextRoot, stagedSources, prior.publications ?? []);
    return parseRootCheckpoint(result, result.root);
  } catch {
    throw invalid();
  }
}

function applyReaderSettlement(input, delta) {
  return applySettlement(input, delta, false);
}
function applyReferenceReaderSettlement(input, delta) {
  return applySettlement(input, delta, true);
}

module.exports = { parseReaderSettlement, applyReaderSettlement, applyReferenceReaderSettlement };
