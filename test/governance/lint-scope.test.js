'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

const root = path.resolve(__dirname, '../..');

test('lint excludes generated diagnostic copies while retaining every source and test boundary', async () => {
  const eslint = new ESLint({ cwd: root });
  for (const file of [
    '.hpm-acceptance/fixture/archived-source.js',
    'tauri-ui/.hpm-acceptance/fixture/archived-source.js',
    '.codex-tmp/fixture/temporary-probe.cjs',
    'tmp/fixture/temporary-probe.js',
    'runtime/local-evidence-plugin/fixture/package/server.cjs',
  ]) {
    assert.equal(await eslint.isPathIgnored(path.join(root, file)), true, file);
  }
  for (const file of [
    'openai-proxy.js',
    'lib/proxy/context-recovery-storage-sqlite.js',
    'scripts/build-local-evidence-plugin.js',
    'scripts/lib/local-evidence-plugin-build.js',
    'scripts/lib/local-evidence-plugin-bundle.js',
    'test/local-evidence-plugin-bundle.test.js',
    'test/context-recovery-storage-blobs.test.js',
    'test/governance/lint-scope.test.js',
    'tauri-ui/src/app/bootstrap.js',
    'tools/trae-openai-bridge-extension/extension.js',
    'lib/proxy/.hpm-acceptance-extra/production.js',
    'lib/proxy/tmp/production.js',
  ]) {
    assert.equal(await eslint.isPathIgnored(path.join(root, file)), false, file);
    const result = await eslint.lintText('__unresolvedLintScopeProbe();\n', { filePath: file });
    assert.ok(
      result.some((entry) => entry.messages.some((message) => message.ruleId === 'no-undef'))
    );
  }
});
