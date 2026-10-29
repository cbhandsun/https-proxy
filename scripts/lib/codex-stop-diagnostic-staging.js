'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { safePath, digest, verifyInstallation } = require('./nsis-encrypted-contract');
const { checkoutCommit } = require('./nsis-baseline-transfer');
const { digestInstalledClient } = require('./nsis-client-binary');
const NODE_SHA = '780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b';
const LOCKS = Object.freeze({
  'package.json': 'caaf4101cd3d6b0f84a8f91b8aa40f189dc6ffe82b6e558cb696707184cb36ec',
  'package-lock.json': '00c1c8ff023023b9b9a034adf8dc4a82a3694524f84d71ba3fcaac17d42219c1',
});
const fail = () => new Error('codex_stop_staging_failed');
function verifyToolsLock(tools) {
  safePath(tools, true);
  for (const [name, expected] of Object.entries(LOCKS)) {
    const file = safePath(path.join(tools, name));
    if (fs.statSync(file).size > 16384) throw fail();
    const bytes = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    if (createHash('sha256').update(bytes.replaceAll('\r\n', '\n')).digest('hex') !== expected)
      throw fail();
  }
}
function copyTree(from, to) {
  safePath(from, true);
  fs.mkdirSync(to);
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name),
      target = path.join(to, name);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
      throw fail();
    if (stat.isDirectory()) copyTree(source, target);
    else fs.copyFileSync(safePath(source), target, fs.constants.COPYFILE_EXCL);
  }
}
function verifyDiagnosticRuntime(candidate, staging) {
  safePath(candidate, true);
  safePath(staging, true);
  const file = path.join(staging, 'release-runtime-manifest.json');
  const manifestSha256 = digest(file);
  const verified = verifyInstallation(staging, manifestSha256);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [relative, expected] of Object.entries(manifest.sourceSha256)) {
    if (digest(path.join(candidate, relative)) !== expected) throw fail();
  }
  return {
    ...verified,
    manifestSha256,
    nodeSha256: digest(verified.node),
    nativeSha256: digest(verified.native),
  };
}
function prepareDiagnosticStaging(runtime = process) {
  try {
    const env = runtime.env;
    if (
      runtime.platform !== 'win32' ||
      runtime.version !== 'v22.22.3' ||
      env.GITHUB_ACTIONS !== 'true' ||
      env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      env.RUNNER_OS !== 'Windows' ||
      env.CI !== 'true' ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') ||
      [env.NODE_OPTIONS, env.NODE_PATH, env.NODE_V8_COVERAGE].some(Boolean)
    )
      throw fail();
    const candidate = safePath(path.join(env.GITHUB_WORKSPACE, 'current'), true);
    if (
      candidate !== path.resolve(__dirname, '../..') ||
      checkoutCommit(candidate) !== env.GITHUB_SHA ||
      digest(runtime.execPath) !== NODE_SHA
    )
      throw fail();
    const tools = path.join(candidate, 'tools/nsis-clients');
    verifyToolsLock(tools);
    const staging = safePath(path.join(candidate, 'dist/staging/runtime'), true);
    const verified = verifyDiagnosticRuntime(candidate, staging);
    const manifestSha256 = verified.manifestSha256;
    if (verified.nodeSha256 !== NODE_SHA) throw fail();
    const root = path.join(safePath(env.RUNNER_TEMP, true), 'hpm-installed-clients');
    fs.mkdirSync(root);
    copyTree(staging, path.join(root, 'payload'));
    verifyInstallation(path.join(root, 'payload'), manifestSha256);
    fs.mkdirSync(path.join(root, 'clients'));
    const clients = [
      [
        'codex',
        '@openai/codex-win32-x64',
        '@openai/codex',
        '0.160.1-win32-x64',
        'vendor/x86_64-pc-windows-msvc/bin/codex.exe',
      ],
      [
        'claude',
        '@anthropic-ai/claude-code-win32-x64',
        '@anthropic-ai/claude-code-win32-x64',
        '2.1.292',
        'claude.exe',
      ],
    ];
    const hashes = {};
    for (const [client, directory, name, version, binary] of clients) {
      const packageRoot = path.join(tools, 'node_modules', directory);
      const metadata = safePath(path.join(packageRoot, 'package.json'));
      if (fs.statSync(metadata).size > 16384) throw fail();
      const parsed = JSON.parse(fs.readFileSync(metadata, 'utf8'));
      if (parsed.name !== name || parsed.version !== version) throw fail();
      const original = safePath(path.join(packageRoot, binary));
      const target = path.join(root, 'clients', client + '.exe');
      fs.copyFileSync(original, target, fs.constants.COPYFILE_EXCL);
      hashes[client] = digestInstalledClient(target, client);
      if (hashes[client] !== digestInstalledClient(original, client)) throw fail();
    }
    for (const name of ['client-driver', 'diagnostic-home', 'diagnostic-temp'])
      fs.mkdirSync(path.join(root, name));
    const receipt = {
      schemaVersion: 1,
      scope: 'noninstalled_staged_codex_stop_diagnostic',
      sourceSha: env.GITHUB_SHA,
      manifestSha256,
      nodeSha256: NODE_SHA,
      codexSha256: hashes.codex,
      claudeSha256: hashes.claude,
      installedQualified: false,
      realProvider: false,
      modelRequests: 0,
      npmLocked: true,
      stagingValidated: true,
    };
    fs.writeFileSync(path.join(root, 'staging-identity.json'), JSON.stringify(receipt) + '\n', {
      flag: 'wx',
    });
    verifyToolsLock(tools);
    return receipt;
  } catch {
    throw fail();
  }
}
module.exports = { prepareDiagnosticStaging, verifyToolsLock, verifyDiagnosticRuntime };
