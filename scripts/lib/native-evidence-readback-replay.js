'use strict';

const { createHash } = require('node:crypto');
const { createNativeEvidenceBenchmarkWorkload } = require('./native-evidence-benchmark-workload');
const {
  LIST_EVIDENCE_TOOL,
  READ_EVIDENCE_TOOL,
} = require('../../lib/client/context-evidence-tools');
const sha = (text) => createHash('sha256').update(text).digest('hex');

// Synthetic offline replay only. No native process, provider transport, actual
// chat history or credentials are read. It tests source fidelity, not model
// reasoning or opaque checkpoint quality.
function replayNativeEvidenceReadback() {
  const candidate = createNativeEvidenceBenchmarkWorkload();
  const original = [];
  function textReply(name, args) {
    const reply = candidate.reply(name, args);
    if (!reply.ok || typeof reply.text !== 'string')
      throw new Error('offline_evidence_replay_failed');
    return reply.text;
  }
  function sourceReply(name, args) {
    const text = textReply(name, args);
    original.push({ bytes: Buffer.byteLength(text), sha256: sha(text) });
    return text;
  }
  try {
    for (const document of ['design', 'verification']) sourceReply('hpm_read_branch', { document });
    let offset = 0;
    do {
      offset = JSON.parse(sourceReply('hpm_read_page', { offsetBytes: offset })).page
        .nextOffsetBytes;
    } while (offset !== null);
    sourceReply('hpm_read_branch', { document: 'release' });
    const before = candidate.diagnostics();
    // Deliberately discard all tool text in the synthetic model-window view.
    const sourceWindowLossSimulated = candidate.inspectInput([]).every((item) => !item.observed);
    const recovered = [];
    let afterSourceId = null;
    do {
      const index = JSON.parse(
        textReply(LIST_EVIDENCE_TOOL, {
          limit: 2,
          ...(afterSourceId ? { afterSourceId } : {}),
        })
      );
      for (const source of index.sources) {
        let text = '';
        let next = 0;
        do {
          const result = JSON.parse(
            textReply(READ_EVIDENCE_TOOL, {
              sourceId: source.sourceId,
              digest: source.digest,
              offsetBytes: next,
              limitBytes: 6144,
            })
          );
          text += result.page.text;
          next = result.page.nextOffsetBytes;
        } while (next !== null);
        const prior = original[recovered.length];
        recovered.push({
          callId: source.callId,
          toolName: source.toolName,
          bytes: Buffer.byteLength(text),
          sha256: sha(text),
          exactOriginalMatch: prior.bytes === Buffer.byteLength(text) && prior.sha256 === sha(text),
          sourceDigestMatches: source.digest === sha(text),
          trust: source.trust,
        });
      }
      afterSourceId = index.nextAfterSourceId;
    } while (afterSourceId !== null);
    const after = candidate.diagnostics();
    return {
      schema: 'hpm.context.evidence-readback-offline',
      version: 1,
      syntheticWorkload: true,
      providerRequests: 0,
      candidateWorkload: candidate.descriptor,
      sourceWindowLossSimulated,
      originalSourceReadCountBefore: before.toolReplies.length,
      originalSourceReadCountAfter: after.toolReplies.length,
      originalToolsReplayed: after.toolReplies.length !== before.toolReplies.length,
      evidence: recovered,
      ledger: after.evidenceLedger,
      readTools: after.evidenceTools,
      offlineFidelityPassed:
        after.readbackComplete &&
        recovered.every((item) => item.exactOriginalMatch && item.sourceDigestMatches),
      nativeCompactionInvoked: false,
      nativeModelSemanticsVerified: false,
      installedClientIntegrationVerified: false,
      matchedLatencyOrEconomicsVerified: false,
    };
  } finally {
    candidate.close();
  }
}

module.exports = { replayNativeEvidenceReadback };
