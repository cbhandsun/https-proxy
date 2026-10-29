'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safePath, digest } = require('./nsis-encrypted-contract');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const {
  parseRuntimeBoundaryArguments,
  verifyRuntimeBoundaryInstallation,
} = require('./nsis-runtime-boundary-contract');
const { HTTP_DRAIN_PHASES } = require('./nsis-installed-http-drain');
const { digestInstalledClient } = require('./nsis-client-binary');
const { OWNED_STOP_PHASES } = require('./nsis-client-owned-failure');
const fail = () => new Error('installed_client_matrix_failed');
const CLI_PHASES = Object.freeze([
  'seed',
  'compact-1',
  'compact-2',
  'compact-3',
  'between-1',
  'between-2',
  'final',
]);
const CODEX_RESTART_PHASES = Object.freeze([
  'restart-stop',
  'restart-initialize',
  'restart-resume',
]);
const PHASES = [
  'identity',
  'listener',
  'probes',
  'controller',
  'cleanup',
  'complete',
  ...['codex', 'claude'].flatMap((client) =>
    ['default', 'enhanced'].flatMap((mode) =>
      [
        'configure',
        'auth',
        'cli',
        'observe',
        'stop',
        ...CLI_PHASES.map((phase) => 'cli-' + phase),
        ...(client === 'codex' ? CODEX_RESTART_PHASES.map((phase) => 'cli-' + phase) : []),
        ...(client === 'codex' ? OWNED_STOP_PHASES.map((phase) => 'cli-' + phase) : []),
        ...HTTP_DRAIN_PHASES.map((phase) => 'http-drain-' + phase),
      ].map((suffix) => client + '-' + mode + '-' + suffix)
    )
  ),
];
function parseInstalledClientMatrixArguments(input) {
  try {
    const args = dataSnapshot(input, 'installed_client_matrix_failed');
    if (
      !Array.isArray(args) ||
      args.length !== 8 ||
      args.some((value) => typeof value !== 'string')
    )
      throw fail();
    const [
      ownedRoot,
      install,
      manifestSha256,
      networkRoot,
      caSha256,
      leafSha256,
      codexSha256,
      claudeSha256,
    ] = args;
    for (const value of [ownedRoot, install, networkRoot])
      parseRuntimeBoundaryArguments(['settings-matrix', value, value, manifestSha256]);
    if (
      [caSha256, leafSha256, codexSha256, claudeSha256].some(
        (sha) => !/^[a-f0-9]{64}$/.test(sha)
      ) ||
      install !== path.join(ownedRoot, 'payload') ||
      networkRoot !== path.join(ownedRoot, 'n08-hosted-network')
    )
      throw fail();
    return {
      ownedRoot,
      install,
      manifestSha256,
      networkRoot,
      caSha256,
      leafSha256,
      codexSha256,
      claudeSha256,
    };
  } catch {
    throw fail();
  }
}
function verifyInstalledClientMatrixIdentity(request, runtime = process) {
  try {
    if (
      runtime.platform !== 'win32' ||
      runtime.execArgv.length !== 0 ||
      runtime.env.GITHUB_ACTIONS !== 'true' ||
      runtime.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      runtime.env.RUNNER_OS !== 'Windows' ||
      runtime.env.CI !== 'true' ||
      request.ownedRoot !== path.join(runtime.env.RUNNER_TEMP || '', 'hpm-installed-clients') ||
      Object.entries(runtime.env).some(
        ([name, value]) =>
          value && ['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE'].includes(name.toUpperCase())
      )
    )
      throw fail();
    safePath(request.ownedRoot, true);
    safePath(request.networkRoot, true);
    const installed = verifyRuntimeBoundaryInstallation(
      {
        caseId: 'settings-matrix',
        install: request.install,
        caseRoot: path.join(request.ownedRoot, 'client-driver'),
        manifestSha256: request.manifestSha256,
      },
      request.ownedRoot
    );
    if (
      fs.realpathSync.native(runtime.execPath).toLowerCase() !==
        fs.realpathSync.native(installed.node).toLowerCase() ||
      path.resolve(runtime.cwd()).toLowerCase() !== request.install.toLowerCase()
    )
      throw fail();
    for (const client of ['codex', 'claude'])
      if (
        digestInstalledClient(path.join(request.ownedRoot, 'clients', client + '.exe'), client) !==
        request[client + 'Sha256']
      )
        throw fail();
    if (digest(path.join(request.networkRoot, 'ca.pem')) !== request.caSha256) throw fail();
    const candidate = safePath(path.resolve(__dirname, '../..'), true);
    const relative = path.relative(safePath(runtime.env.GITHUB_WORKSPACE, true), candidate);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative)
    )
      throw fail();
    const powershellExecutable = safePath('C:/Program Files/PowerShell/7/pwsh.exe');
    return { candidate, powershellExecutable, node: installed.node };
  } catch {
    throw fail();
  }
}
function createMatrixPhaseWriter(ownedRoot) {
  safePath(ownedRoot, true);
  const stat = fs.statSync(ownedRoot),
    pin = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
  const target = path.join(ownedRoot, 'matrix-phase.json');
  if (fs.existsSync(target)) throw fail();
  return (phase, failed = false) => {
    if (!PHASES.includes(phase) || typeof failed !== 'boolean') throw fail();
    safePath(ownedRoot, true);
    const current = fs.statSync(ownedRoot);
    if (Object.entries(pin).some(([name, value]) => current[name] !== value)) throw fail();
    const temporary = path.join(ownedRoot, 'matrix-phase.tmp');
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, phase, failed }), {
      flag: 'wx',
      mode: 0o600,
    });
    if (fs.existsSync(target)) safePath(target);
    fs.renameSync(temporary, target);
  };
}
module.exports = {
  CLI_PHASES,
  CODEX_RESTART_PHASES,
  parseInstalledClientMatrixArguments,
  verifyInstalledClientMatrixIdentity,
  createMatrixPhaseWriter,
  PHASES,
};
