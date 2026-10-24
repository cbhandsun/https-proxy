'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const { safePath, digest, verifyInstallation } = require('./nsis-encrypted-contract');
const { digestInstalledClient } = require('./nsis-client-binary');
const fail = () => new Error('nsis_client_owned_failed');
const equal = (a, b) => a.toLowerCase() === b.toLowerCase();
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function inside(root, value) {
  const relative = path.relative(root, value);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}
function hostRoot(root, runtime = process) {
  if (
    runtime.platform !== 'win32' ||
    runtime.env.GITHUB_ACTIONS !== 'true' ||
    runtime.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    runtime.env.RUNNER_OS !== 'Windows' ||
    typeof runtime.env.RUNNER_TEMP !== 'string' ||
    path.resolve(runtime.env.RUNNER_TEMP) !== runtime.env.RUNNER_TEMP ||
    typeof root !== 'string' ||
    path.resolve(root) !== root ||
    !equal(root, path.join(runtime.env.RUNNER_TEMP, 'hpm-installed-clients'))
  )
    throw fail();
  return safePath(root, true);
}
function validateOwnedSpec(input, runtime = process, requireNode = false) {
  try {
    const value = dataSnapshot(input, 'nsis_client_owned_failed');
    if (
      Object.keys(value).sort().join(',') !==
        'args,binarySha256,caseRoot,client,cwd,env,launcherSha256,manifestSha256,nodeSha256,ownedRoot,schemaVersion' ||
      value.schemaVersion !== 1 ||
      !['codex', 'claude'].includes(value.client) ||
      !['binarySha256', 'launcherSha256', 'manifestSha256', 'nodeSha256'].every((key) =>
        sha(value[key])
      )
    )
      throw fail();
    const root = hostRoot(value.ownedRoot, runtime),
      caseRoot = safePath(value.caseRoot, true);
    if (
      !inside(root, caseRoot) ||
      path.resolve(value.caseRoot) !== value.caseRoot ||
      !equal(value.cwd, caseRoot) ||
      ['clients', 'payload'].some(
        (name) => equal(caseRoot, path.join(root, name)) || inside(path.join(root, name), caseRoot)
      )
    )
      throw fail();
    if (
      !Array.isArray(value.args) ||
      value.args.length < 1 ||
      value.args.length > 128 ||
      value.args.some(
        (arg) => typeof arg !== 'string' || Buffer.byteLength(arg) > 16384 || /[\0\r\n]/.test(arg)
      ) ||
      Buffer.byteLength(JSON.stringify(value.args)) > 32768 ||
      (value.client === 'codex'
        ? value.args.slice(0, 3).join(',') !== 'app-server,--listen,stdio://'
        : value.args[0] !== '--bare')
    )
      throw fail();
    const base = ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT'];
    const homes = [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
    ];
    const extra = [
      'HPM_NSIS_CLIENT_ENTRY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'DISABLE_AUTOUPDATER',
    ];
    if (
      !value.env ||
      Array.isArray(value.env) ||
      Object.keys(value.env).some((name) => ![...base, ...homes, ...extra].includes(name))
    )
      throw fail();
    for (const [name, content] of Object.entries(value.env)) {
      if (typeof content !== 'string' || content.length > 16384 || /[\0\r\n]/.test(content))
        throw fail();
      if (base.includes(name) && content !== runtime.env[name]) throw fail();
      if (
        homes.includes(name) &&
        (!inside(caseRoot, content) || safePath(content, true) !== content)
      )
        throw fail();
    }
    if (
      !['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'].every((key) =>
        Object.hasOwn(value.env, key)
      )
    )
      throw fail();
    if (value.client === 'codex') {
      if (
        !value.env.CODEX_HOME ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(value.env.HPM_NSIS_CLIENT_ENTRY || '') ||
        Object.keys(value.env).some((name) => name.startsWith('ANTHROPIC_'))
      )
        throw fail();
    } else if (
      !value.env.CLAUDE_CONFIG_DIR ||
      !/^http:\/\/(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}(?:\/v1)?\/?$/.test(
        value.env.ANTHROPIC_BASE_URL || ''
      ) ||
      !/^hpm-synthetic-[A-Za-z0-9-]{16,128}$/.test(value.env.ANTHROPIC_AUTH_TOKEN || '') ||
      value.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== '1' ||
      value.env.DISABLE_AUTOUPDATER !== '1'
    )
      throw fail();
    const installation = verifyInstallation(path.join(root, 'payload'), value.manifestSha256);
    const binary = safePath(path.join(root, 'clients', value.client + '.exe'));
    if (
      digest(installation.node) !== value.nodeSha256 ||
      digestInstalledClient(binary, value.client) !== value.binarySha256 ||
      digest(__filename) !== value.launcherSha256
    )
      throw fail();
    if (
      requireNode &&
      (runtime.execArgv.length !== 0 ||
        runtime.env.NODE_OPTIONS ||
        runtime.env.NODE_PATH ||
        runtime.env.NODE_V8_COVERAGE ||
        !equal(fs.realpathSync.native(runtime.execPath), fs.realpathSync.native(installation.node)))
    )
      throw fail();
    return { spec: value, installation, binary };
  } catch {
    throw fail();
  }
}
function loadOwnedSpec(file, expected, runtime = process) {
  try {
    file = safePath(file);
    if (!sha(expected) || fs.statSync(file).size > 65536 || digest(file) !== expected) throw fail();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    const value = JSON.parse(text);
    if (JSON.stringify(value) !== text || file !== path.join(value.caseRoot, 'client-launch.json'))
      throw fail();
    return validateOwnedSpec(value, runtime, true);
  } catch {
    throw fail();
  }
}
function runLauncher(runtime = process, read = fs.readSync, start = spawn) {
  try {
    // Consume exactly the grant byte; all following bytes belong to CLI stdin.
    const gate = Buffer.alloc(1);
    if (read(0, gate, 0, 1, null) !== 1 || gate[0] !== 49 || runtime.argv.length !== 4)
      throw fail();
    const original = loadOwnedSpec(runtime.argv[2], runtime.argv[3], runtime);
    const child = start(original.binary, original.spec.args, {
      cwd: original.spec.cwd,
      env: original.spec.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const reject = () => {
      runtime.exitCode = 1;
      child.stdin.destroy();
      runtime.stdin.destroy();
    };
    child.on('error', reject);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', reject);
    runtime.stdin.on('error', reject);
    runtime.stdout.on('error', reject);
    runtime.stdin.pipe(child.stdin);
    child.stdout.pipe(runtime.stdout);
    let stderrBytes = 0;
    child.stderr.on('data', (bytes) => {
      stderrBytes += bytes.length;
      if (stderrBytes > 262144) reject();
    });
    child.once('close', (code, signal) => {
      if (code !== 0 || (signal !== null && signal !== undefined)) runtime.exitCode = 1;
      try {
        loadOwnedSpec(runtime.argv[2], runtime.argv[3], runtime);
      } catch {
        runtime.exitCode = 1;
      }
      runtime.stdin.destroy();
    });
  } catch {
    throw fail();
  }
}
if (require.main === module) {
  try {
    runLauncher();
  } catch {
    process.stderr.write('nsis_client_owned_failed\n');
    process.exitCode = 1;
  }
}
module.exports = { hostRoot, validateOwnedSpec, loadOwnedSpec, runLauncher };
