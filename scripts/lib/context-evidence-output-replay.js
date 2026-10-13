'use strict';

const { createHash } = require('node:crypto');
const { createNativeBenchmarkWorkload } = require('./native-compaction-benchmark-workload');
const { createContextEvidenceLedger } = require('../../lib/client/context-evidence-ledger');
const {
  createContextEvidenceNativeTools,
} = require('../../lib/client/context-evidence-native-tools');
const {
  LIST_EVIDENCE_TOOL,
  READ_EVIDENCE_TOOL,
} = require('../../lib/client/context-evidence-tools');
const { observeContextEvidenceIngress } = require('../../lib/client/context-evidence-ingress');

const sha = (text) => createHash('sha256').update(text).digest('hex');

// Deterministic content-free report over synthetic source data. Native result
// envelopes are real adapter outputs, but transformations are explicit local
// fixtures, not a claim about the installed Code Mode implementation.
function replayContextEvidenceOutput() {
  const base = createNativeBenchmarkWorkload();
  const ledger = createContextEvidenceLedger({
    owner: 'offline-output',
    threadId: 'synthetic',
    now: () => 1,
  });
  const native = createContextEvidenceNativeTools(ledger);
  const receipts = [];
  const replies = [];
  function original(name, args, callId) {
    const result = base.reply(name, args);
    if (!result.ok) throw new Error('offline_output_contract_failed');
    receipts.push(
      ledger.capture({
        callId,
        toolName: name,
        arguments: args,
        output: result.text,
        completed: true,
      })
    );
    return result.text;
  }
  try {
    for (const document of ['design', 'verification'])
      original('hpm_read_branch', { document }, 'branch-' + document);
    let offset = 0;
    do {
      offset = JSON.parse(original('hpm_read_page', { offsetBytes: offset }, 'page-' + offset)).page
        .nextOffsetBytes;
    } while (offset !== null);
    original('hpm_read_branch', { document: 'release' }, 'branch-release');
    const originalCount = base.diagnostics().toolReplies.length;
    const sources = JSON.parse(native.reply(LIST_EVIDENCE_TOOL, {}).contentItems[0].text).sources;
    const recovery = [];
    for (const source of sources) {
      let text = '';
      let next = 0;
      do {
        const result = native.reply(READ_EVIDENCE_TOOL, {
          sourceId: source.sourceId,
          digest: source.digest,
          offsetBytes: next,
          limitBytes: 6144,
        });
        if (!result.success) throw new Error('offline_output_contract_failed');
        replies.push(result);
        const value = JSON.parse(result.contentItems[0].text);
        text += value.page.text;
        next = value.page.nextOffsetBytes;
      } while (next !== null);
      recovery.push({
        bytes: Buffer.byteLength(text),
        sha256: sha(text),
        matchesOriginal: sha(text) === source.digest && Buffer.byteLength(text) === source.bytes,
      });
    }
    const texts = replies.map((result) => result.contentItems[0].text);
    const modes = {
      exactNativeEnvelope: replies.map((result) => ({
        type: 'custom_tool_call_output',
        output: JSON.stringify(result),
      })),
      reformattedEnvelope: texts.map((text) => ({
        type: 'custom_tool_call_output',
        output: JSON.stringify(JSON.parse(text), null, 2),
      })),
      nestedEscaping: replies.map((result) => ({
        type: 'custom_tool_call_output',
        output: JSON.stringify(JSON.stringify(result)),
      })),
      truncatedOutput: texts.map((text) => ({
        type: 'custom_tool_call_output',
        output: text.slice(0, -8),
      })),
      receiptOnly: sources.map((source) => ({ type: 'custom_tool_call_output', output: source })),
      promptOnly: texts.map((text) => ({ role: 'user', content: text })),
    };
    const observations = Object.fromEntries(
      Object.entries(modes).map(([name, input]) => {
        const value = observeContextEvidenceIngress(texts, input);
        return [
          name,
          {
            observationValid: value.observationValid,
            exactEnvelopes: value.pages.filter((page) => page.exactEnvelopeObserved).length,
            equivalentEnvelopes: value.pages.filter((page) => page.equivalentEnvelopeObserved)
              .length,
            allExact: value.allExactEnvelopesObserved,
            allEquivalent: value.allEquivalentEnvelopesObserved,
            parseBudgetExceeded: value.parseBudgetExceeded,
          },
        ];
      })
    );
    const toolBytes = replies.map((result) => Buffer.byteLength(JSON.stringify(result)));
    return {
      schema: 'hpm.context.evidence-output-contract-offline',
      version: 1,
      syntheticWorkload: true,
      providerRequests: 0,
      originalSourceReads: originalCount,
      originalToolsReplayed: base.diagnostics().toolReplies.length !== originalCount,
      recoveredSources: recovery,
      retainedPages: replies.length,
      maxNativeResultBytes: Math.max(...toolBytes),
      nativeToolBudget: native.inspect(),
      observations,
      offlineOutputContractPassed:
        recovery.length === receipts.length &&
        recovery.every((item) => item.matchesOriginal) &&
        toolBytes.every((bytes) => bytes <= 16384) &&
        observations.exactNativeEnvelope.allExact &&
        observations.nestedEscaping.allExact &&
        !observations.reformattedEnvelope.allExact &&
        observations.reformattedEnvelope.allEquivalent &&
        ['truncatedOutput', 'receiptOnly', 'promptOnly'].every(
          (name) => !observations[name].allExact && !observations[name].allEquivalent
        ),
      historicalMissingEnvelopesExplained: false,
      nativeCodeModeExecuted: false,
      nativeCompactionInvoked: false,
      installedClientIntegrationVerified: false,
      nativeModelSemanticsVerified: false,
      matchedLatencyOrEconomicsVerified: false,
    };
  } finally {
    ledger.close();
  }
}

module.exports = { replayContextEvidenceOutput };
