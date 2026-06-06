const assert = require('assert');
const {
  ENV_CHECK_TOOLS,
  getToolInstallProcessSpec,
  isVersionNewer,
  parseVersionText,
} = require('../lib/proxy/env-tools');

assert.strictEqual(parseVersionText('2.1.159 (Claude Code)'), '2.1.159');
assert.strictEqual(parseVersionText('OpenAI.Codex_26.602.4764.0_x64__2p2nqsd0c76g0'), '26.602.4764.0');
assert.strictEqual(parseVersionText('codex-cli 0.137.0-alpha.4'), '0.137.0-alpha.4');

assert.strictEqual(isVersionNewer('0.137.0-alpha.4', '0.137.0'), true);
assert.strictEqual(isVersionNewer('0.137.0', '0.137.0-alpha.4'), false);
assert.strictEqual(isVersionNewer('2.1.159', '2.1.167'), true);
assert.strictEqual(isVersionNewer('2.1.167', '2.1.159'), false);

const codexSpec = getToolInstallProcessSpec(ENV_CHECK_TOOLS.find(tool => tool.id === 'codex'));
if (process.platform === 'win32') {
  assert.strictEqual(codexSpec.file, 'cmd.exe');
  assert.deepStrictEqual(codexSpec.args.slice(0, 5), ['/d', '/s', '/c', 'npm.cmd', 'install']);
} else {
  assert.strictEqual(codexSpec.file, 'npm');
}

console.log('[env-tools.test] ok');
