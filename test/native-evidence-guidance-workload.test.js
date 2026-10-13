'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createNativeEvidenceDiagnosticWorkload,
  verifyNativeEvidenceDiagnosticPlan,
} = require('../scripts/lib/native-evidence-diagnostic-plan');
const { withNativeEvidenceGuidance } = require('../scripts/lib/native-evidence-guidance-workload');
const {
  createNativeEvidenceBenchmarkWorkloadV2,
} = require('../scripts/lib/native-evidence-benchmark-workload-v2');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');

test('guidance regressions enter the unchanged unified unit discovery', () => {
  const root = path.resolve(__dirname, '..');
  const files = selectUnitTestFiles(discoverTestFiles(root), {
    excludedFiles: [],
    excludedPrefixes: ['test/frontend/'],
  });
  assert.equal(files.includes('test/native-evidence-guidance-workload.test.js'), true);
});

test('guidance is a separate deterministic candidate with identical validators and no answer hints', () => {
  const original = createNativeEvidenceDiagnosticWorkload();
  try {
    const before = JSON.stringify(original.tools);
    const candidate = withNativeEvidenceGuidance(original);
    assert.notEqual(candidate.descriptor.corpusSha256, original.descriptor.corpusSha256);
    assert.equal(
      withNativeEvidenceGuidance(original).descriptor.corpusSha256,
      candidate.descriptor.corpusSha256
    );
    assert.equal(JSON.stringify(original.tools), before);
    assert.equal(candidate.descriptor.installedHostIntegrationVerified, false);
    assert.equal(candidate.prompts[0].includes('青瓷'), false);
    for (const tool of original.tools) {
      const next = candidate.tools.find((row) => row.name === tool.name);
      assert.deepEqual(next.inputSchema, tool.inputSchema);
      if (tool.name === 'hpm_list_retained_evidence') {
        assert.match(next.description, /start hpm_list_retained_evidence with \{\}/);
        assert.match(next.description, /1 to 16/);
      }
      if (tool.name === 'hpm_read_retained_evidence') assert.match(next.description, /1 to 65536/);
    }
    assert.equal(candidate.reply('hpm_list_retained_evidence', { limit: 17 }).ok, false);
    assert.equal(candidate.reply('hpm_list_retained_evidence', {}).ok, true);
    assert.equal(candidate.diagnostics().evidenceLedger.retainedEntries, 7);
    const historical = createNativeEvidenceBenchmarkWorkloadV2();
    try {
      assert.equal(
        historical.descriptor.corpusSha256,
        '4748ff0f0873126ce27c0f01404cdfac59d0b216f877ae5df9f8f9451767ef5d'
      );
    } finally {
      historical.close();
    }
  } finally {
    original.close();
  }
});

test('run3 refuses reused authority, changed predecessor or existing attempts before model calls', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-guidance-authority-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.hpm-runtime');
  fs.mkdirSync(runtime);
  const base = path.join(runtime, 'context-native-evidence-diagnostic-20261012-run3');
  const authority = {
    schema: 'hpm.context.native-evidence-diagnostic-authorization',
    version: 1,
    scope: 'one_isolated_native_retained_read_diagnostic',
    userExplicitlyAuthorized: true,
    maximumAdditionalRequests: 6,
    automaticRetries: 0,
    failedAndCompactionRequestsCounted: true,
    reusePreviouslyAuthorizedOfficialLogin: true,
    installedCodexConfigurationMayChange: false,
    productionRestartAuthorized: false,
    providerCredentialCreationAuthorized: false,
    publicationAuthorized: false,
    diagnosticRun: 'run3',
    priorDiagnosticSha256: 'c0a1510c9a38df46a3c65f7278087e30b6ab9f0a5a24b59ed8991addeecb2b4a',
    productNativeGuidanceCandidate: true,
  };
  for (const changed of [
    { diagnosticRun: 'run2' },
    { priorDiagnosticSha256: '0'.repeat(64) },
    { productNativeGuidanceCandidate: false },
    { maximumAdditionalRequests: 7 },
  ]) {
    fs.writeFileSync(base + '-authorization.json', JSON.stringify({ ...authority, ...changed }));
    assert.throws(() => verifyNativeEvidenceDiagnosticPlan(root, 'run3'), {
      code: 'native_diagnostic_authority_unconfirmed',
    });
  }
  fs.writeFileSync(base + '-authorization.json', JSON.stringify(authority));
  for (const suffix of ['-attempt.json', '-result.json']) {
    fs.writeFileSync(base + suffix, '{}');
    assert.throws(() => verifyNativeEvidenceDiagnosticPlan(root, 'run3'), {
      code: 'native_diagnostic_prior_run_must_be_preserved',
    });
    fs.unlinkSync(base + suffix);
  }
});
