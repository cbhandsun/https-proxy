'use strict';

const { createHash } = require('node:crypto');
const { createNativeEvidenceBenchmarkWorkload } = require('./native-evidence-benchmark-workload');
const {
  createContextEvidenceNativeDelivery,
} = require('../../lib/client/context-evidence-native-delivery');

// A different, explicitly versioned candidate. Historical workloads/harnesses
// are immutable. Only native output guidance changes; the one-shot oracle,
// synthetic originals, state fields and read budgets are unchanged.
function createNativeEvidenceBenchmarkWorkloadV2(options = {}) {
  const base = createNativeEvidenceBenchmarkWorkload(options);
  const definitions = base.tools
    .filter((tool) =>
      ['hpm_list_retained_evidence', 'hpm_read_retained_evidence'].includes(tool.name)
    )
    .map((tool) => ({ type: 'function', ...tool }));
  const plan = createContextEvidenceNativeDelivery(definitions, { delivery: 'code-mode-page' });
  const prompts = base.prompts.map(
    (prompt) => prompt.replaceAll('console.log', 'text') + '\n' + plan.guidance
  );
  return {
    ...base,
    prompts,
    descriptor: {
      ...base.descriptor,
      kind: 'native_paged_evidence_readback_candidate',
      version: 2,
      originalCandidateSha256: base.descriptor.corpusSha256,
      corpusSha256: createHash('sha256')
        .update(
          JSON.stringify({
            base: base.descriptor.corpusSha256,
            prompts,
            tools: base.tools,
            delivery: plan.delivery,
          })
        )
        .digest('hex'),
      nativeOutputPolicy: plan.delivery,
      nativePrintApi: 'text',
      matchedToHistoricalCandidate: false,
      realNativeModelAcceptanceVerified: false,
    },
  };
}

module.exports = { createNativeEvidenceBenchmarkWorkloadV2 };
