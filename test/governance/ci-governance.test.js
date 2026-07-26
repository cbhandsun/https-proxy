'use strict';

const assert = require('assert');
const {
  actionReferences,
  unpinnedActionReferences,
  validateCiGovernance,
  validateReleaseWorkflow,
} = require('../../lib/ci-governance');

const pinned = 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd';
assert.deepStrictEqual(actionReferences(`- uses: ${pinned} # v6`), [pinned]);
assert.deepStrictEqual(unpinnedActionReferences(`- uses: ${pinned}\n- uses: ./local-action`), []);
assert.deepStrictEqual(unpinnedActionReferences('- uses: actions/checkout@v6'), [
  'actions/checkout@v6',
]);

const workflow = [
  `- uses: ${pinned}`,
  '- run: npm ci',
  '- run: npm run format:check',
  '- run: npm run check:ci',
  '- run: npm audit --audit-level=high',
  '- run: npm run test:coverage',
  '- run: npm run test:frontend:coverage',
  '- run: npm run release:check',
  '- run: cargo clippy',
  '- run: node scripts/check-windows-rust-audit.js',
].join('\n');
const dependabot = [
  'package-ecosystem: npm',
  'package-ecosystem: cargo',
  'package-ecosystem: github-actions',
].join('\n');
assert.deepStrictEqual(validateCiGovernance(workflow, dependabot), []);
assert.ok(validateCiGovernance('- uses: actions/checkout@v6', '').length >= 8);
assert.ok(
  validateCiGovernance(`${workflow}\n- run: npm run frontend:check`, dependabot).some((error) =>
    error.includes('removed frontend:check')
  )
);
const releaseWorkflow = [
  'WINDOWS_SIGNING_CERTIFICATE_BASE64 is required',
  'Get-AuthenticodeSignature',
  'npm sbom --sbom-format cyclonedx',
  'cargo-cyclonedx --version 0.5.9',
  'smoke-test-nsis.ps1',
  'npm run release:portable:from-build',
  'scripts/list-release-assets.js',
  'Release asset selection failed',
  'actions/attest@' + 'a'.repeat(40),
  'gh release create',
].join('\n');
assert.deepStrictEqual(validateReleaseWorkflow(releaseWorkflow), []);
assert.ok(validateReleaseWorkflow('').length >= 7);

console.log('[ci-governance.test] ok');
