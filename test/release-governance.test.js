'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertSafeReleasePath,
  findSensitiveReleaseEntries,
  isPathInside,
  validateReleaseDirectory,
} = require('../lib/release/governance');
const { isInstallerFile, resolveCargoTargetDir } = require('../scripts/collect-tauri-artifacts');

const repoRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-release-governance-'));
const dependencies = { alpha: '1.0.0', beta: '^2.0.0' };

function write(relative, content = '') {
  const target = path.join(tempRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

try {
  assert.strictEqual(
    isPathInside(path.join(repoRoot, 'dist'), path.join(repoRoot, 'dist', 'portable')),
    true
  );
  assert.strictEqual(isPathInside(path.join(repoRoot, 'dist'), repoRoot), false);
  assert.throws(() => assertSafeReleasePath(repoRoot, repoRoot), /must stay inside/);
  assert.strictEqual(
    assertSafeReleasePath(repoRoot, path.join(repoRoot, 'dist', 'portable')),
    path.join(repoRoot, 'dist', 'portable')
  );
  assert.strictEqual(isInstallerFile('HTTPS Proxy Manager_0.1.0_x64-setup.exe'), true);
  assert.strictEqual(isInstallerFile('debug.pdb'), false);
  assert.strictEqual(
    resolveCargoTargetDir(repoRoot, 'src-tauri/target-release'),
    path.join(repoRoot, 'src-tauri', 'target-release')
  );

  write('openai-proxy.js');
  write('lib/proxy/config.js');
  write('proxy.bat');
  write('proxy.ps1');
  write('proxy.config.example.json', '{}');
  write('runtime/node/node.exe');
  write('https-proxy-manager.exe');
  write('node_modules/alpha/package.json', '{}');
  write('node_modules/beta/package.json', '{}');
  write('node_modules/alpha/.claude/settings.json', '{}');
  write('package.json', JSON.stringify({ private: true, dependencies }));

  let result = validateReleaseDirectory(tempRoot, dependencies);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);

  write('proxy.config.json', JSON.stringify({ profiles: [{ apiKey: 'secret' }] }));
  write('.hpm-runtime/.certs/proxy-key.pem', '-----BEGIN PRIVATE KEY-----\nsecret');
  const findings = findSensitiveReleaseEntries(tempRoot);
  assert.ok(findings.some((finding) => finding.path === 'proxy.config.json'));
  assert.ok(findings.some((finding) => finding.path.includes('.hpm-runtime')));
  assert.ok(findings.some((finding) => finding.path.endsWith('proxy-key.pem')));

  result = validateReleaseDirectory(tempRoot, dependencies);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('Unsafe release content')));

  fs.rmSync(path.join(tempRoot, '.hpm-runtime'), { recursive: true, force: true });
  fs.rmSync(path.join(tempRoot, 'proxy.config.json'), { force: true });
  write(
    'package.json',
    JSON.stringify({
      dependencies: { alpha: 'wrong', beta: '^2.0.0' },
      scripts: { postinstall: 'bad' },
    })
  );
  result = validateReleaseDirectory(tempRoot, dependencies);
  assert.ok(result.errors.some((error) => error.includes('dependency mismatch for alpha')));
  assert.ok(result.errors.some((error) => error.includes('must not contain lifecycle scripts')));

  console.log('[release-governance.test] ok');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
