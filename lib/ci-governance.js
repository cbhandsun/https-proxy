'use strict';

function actionReferences(workflowText) {
  return Array.from(
    String(workflowText || '').matchAll(/\buses:\s*([^\s#]+)/g),
    (match) => match[1]
  );
}

function unpinnedActionReferences(workflowText) {
  return actionReferences(workflowText).filter(
    (reference) => !reference.startsWith('./') && !/^[^@\s]+@[a-f0-9]{40}$/i.test(reference)
  );
}

function validateCiGovernance(workflowText, dependabotText) {
  const errors = unpinnedActionReferences(workflowText).map(
    (reference) => `GitHub Action is not pinned to a commit SHA: ${reference}`
  );
  for (const required of [
    'npm ci',
    'npm run format:check',
    'npm run check:ci',
    'npm audit --audit-level=high',
    'npm run test:coverage',
    'npm run test:frontend:coverage',
    'npm run release:check',
    'cargo clippy',
    'node scripts/check-windows-rust-audit.js',
  ]) {
    if (!String(workflowText || '').includes(required)) {
      errors.push(`CI workflow is missing required gate: ${required}`);
    }
  }
  if (String(workflowText || '').includes('npm run frontend:check')) {
    errors.push('CI workflow must not call the removed frontend:check script');
  }
  for (const ecosystem of ['npm', 'cargo', 'github-actions']) {
    if (!String(dependabotText || '').includes(`package-ecosystem: ${ecosystem}`)) {
      errors.push(`Dependabot is missing ecosystem: ${ecosystem}`);
    }
  }
  return errors;
}

function validateReleaseWorkflow(workflowText) {
  const source = String(workflowText || '');
  const errors = [];
  for (const required of [
    'WINDOWS_SIGNING_CERTIFICATE_BASE64 is required',
    'Get-AuthenticodeSignature',
    'npm sbom --sbom-format cyclonedx',
    'cargo-cyclonedx --version 0.5.9',
    'smoke-test-nsis.ps1',
    'scripts/validate-release-version.js',
    'npm run release:portable:from-build',
    'scripts/list-release-assets.js',
    'Verify final release asset selection',
    'Release asset selection failed',
    'actions/attest@',
    'actions/upload-artifact@',
    'gh release create',
  ]) {
    if (!source.includes(required)) {
      errors.push(`Release workflow is missing required control: ${required}`);
    }
  }
  const assetSelectionIndex = source.indexOf('Verify final release asset selection');
  const attestationIndex = source.indexOf('actions/attest@');
  const uploadIndex = source.indexOf('actions/upload-artifact@');
  if (
    assetSelectionIndex >= 0 &&
    attestationIndex >= 0 &&
    uploadIndex >= 0 &&
    (assetSelectionIndex > attestationIndex || assetSelectionIndex > uploadIndex)
  ) {
    errors.push('Release workflow must verify final assets before attestation and artifact upload');
  }
  return errors;
}

module.exports = {
  actionReferences,
  unpinnedActionReferences,
  validateCiGovernance,
  validateReleaseWorkflow,
};
