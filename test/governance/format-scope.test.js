'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const prettier = require('prettier');

const root = path.resolve(__dirname, '../..');
const ignorePath = path.join(root, '.prettierignore');

test('formatter excludes generated probes without excluding production or test sources', async () => {
  for (const file of [
    '.codex-tmp/fixture/temporary-probe.cjs',
    'tmp/fixture/temporary-probe.js',
    'runtime/local-evidence-plugin/fixture/package/server.cjs',
    '.hpm-acceptance/fixture/frozen-source.js',
    'tauri-ui/.hpm-acceptance/fixture/frozen-source.js',
  ]) {
    const result = await prettier.getFileInfo(path.join(root, file), { ignorePath });
    assert.equal(result.ignored, true, file);
  }
  for (const file of [
    'openai-proxy.js',
    'lib/proxy/context-recovery-state-data.js',
    'scripts/build-local-evidence-plugin.js',
    'scripts/lib/local-evidence-plugin-build.js',
    'scripts/lib/local-evidence-plugin-bundle.js',
    'test/local-evidence-plugin-bundle.test.js',
    'test/context-recovery-root-state.test.js',
    'test/governance/format-scope.test.js',
    'tauri-ui/src/app/bootstrap.js',
    'tools/trae-openai-bridge-extension/extension.js',
    'lib/proxy/tmp/production.js',
    'lib/proxy/.codex-tmp/production.js',
    'lib/proxy/.hpm-acceptance-extra/production.js',
  ]) {
    const result = await prettier.getFileInfo(path.join(root, file), { ignorePath });
    assert.equal(result.ignored, false, file);
    assert.equal(result.inferredParser, 'babel', file);
  }
});
