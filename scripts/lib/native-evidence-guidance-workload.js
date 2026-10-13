'use strict';

const { createHash } = require('node:crypto');
const { createContextEvidenceLedger } = require('../../lib/client/context-evidence-ledger');
const {
  createContextEvidenceNativeTools,
} = require('../../lib/client/context-evidence-native-tools');

// A separate diagnostic candidate, not a mutation of either historical workload.
// The temporary ledger supplies production definitions only; originals remain
// in the existing synthetic diagnostic fixture and are never copied here.
function withNativeEvidenceGuidance(workload) {
  const ledger = createContextEvidenceLedger({
    owner: 'isolated-guidance',
    threadId: 'definitions',
  });
  try {
    const native = createContextEvidenceNativeTools(ledger);
    const plan = native.registration({ delivery: 'code-mode-page' });
    const definitions = native.definitions.map(({ type: _type, ...definition }) => definition);
    const tools = workload.tools.map(
      (tool) => definitions.find((definition) => definition.name === tool.name) ?? tool
    );
    const prompts = workload.prompts.map((prompt) => prompt + '\n' + plan.guidance);
    return {
      ...workload,
      tools,
      prompts,
      descriptor: {
        ...workload.descriptor,
        kind: 'native_retained_read_guidance_diagnostic',
        version: 3,
        historicalWorkloadSha256: workload.descriptor.corpusSha256,
        corpusSha256: createHash('sha256')
          .update(JSON.stringify({ base: workload.descriptor.corpusSha256, tools, prompts }))
          .digest('hex'),
        productNativeDefinitionsUsed: true,
        installedHostIntegrationVerified: false,
        realNativeModelAcceptanceVerified: false,
      },
    };
  } finally {
    ledger.close();
  }
}

module.exports = { withNativeEvidenceGuidance };
