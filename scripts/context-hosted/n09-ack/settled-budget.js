'use strict';

const { parseReferenceTransition } = require('../../../lib/proxy/context-recovery-reference-state');
const {
  applyReferenceReaderSettlement,
} = require('../../../lib/proxy/context-recovery-reader-settlement');
const { fail } = require('./contract');

// A reserve SAVE has an ACK, while its following reader settlement has its own
// durable revision but no producer ACK. Validate that refund with the production
// settlement codec instead of treating the reserved bytes as final consumption.
function validateN09SettledBudget(priorInput, nextInput, revisionGap) {
  try {
    if (!Number.isSafeInteger(revisionGap) || revisionGap < 2) throw fail();
    const { prior, next } = parseReferenceTransition(nextInput, priorInput);
    if (!prior) throw fail();
    const sources = new Map(
      [...prior.metadata.ledger.sources, ...prior.stagedSources].map((source) => [
        source.sourceId,
        source,
      ])
    );
    const changed = [...next.metadata.ledger.sources, ...next.stagedSources]
      .filter((source) => {
        const old = sources.get(source.sourceId);
        return (
          old &&
          (old.coveredThrough !== source.coveredThrough || old.readComplete !== source.readComplete)
        );
      })
      .map(({ sourceId, coveredThrough, readComplete }) => ({
        sourceId,
        coveredThrough,
        readComplete,
      }));
    applyReferenceReaderSettlement(prior, {
      version: 2,
      kind: 'recovery-reader-settlement',
      rootId: next.metadata.rootId,
      observedAt: next.metadata.observedAt,
      budget: next.metadata.budget,
      ledger: { readCount: next.metadata.ledger.readCount, sources: changed },
    });
  } catch {
    throw fail();
  }
}

module.exports = { validateN09SettledBudget };
