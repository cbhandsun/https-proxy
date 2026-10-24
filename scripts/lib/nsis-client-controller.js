'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { digest, safePath } = require('./nsis-encrypted-contract');
const { exact } = require('../context-hosted/shared/boundary');
const { buildHostedController } = require('../context-hosted/shared/build-hosted-controller');
const NAMES = [
  'context-recovery-daemon-owned-controller.ps1',
  'context-recovery-daemon-owned-controller.psm1',
  'context-recovery-daemon-start-gate.cjs',
  'nsis-runtime-boundary-job.cs',
  'nsis-lifecycle.psm1',
  'nsis-runtime-boundary.psm1',
];
const fail = () => new Error('installed_client_controller_failed');
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
function transformInstalledController(source, { prepareFile, prepareSha256, temporary }) {
  if (
    typeof source !== 'string' ||
    !/^[a-f0-9]{64}$/.test(prepareSha256) ||
    ![prepareFile, temporary].every(
      (p) => typeof p === 'string' && path.isAbsolute(p) && !/[\0\r\n]/.test(p)
    )
  )
    throw fail();
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw fail();
    source = source.replace(before, after);
  };
  replace(
    "$caseRoot = Join-Path $OwnedRoot ('daemon-http-' + [Guid]::NewGuid().ToString('N'))",
    "$caseRoot = Join-Path (Join-Path $OwnedRoot 'cases') ('daemon-http-' + [Guid]::NewGuid().ToString('N'))"
  );
  replace(
    "    $start.Environment['HPM_DAEMON_OWNED_ROOT'] = $OwnedRoot",
    `    $start.Environment['HPM_INSTALLED_CLIENT_OBSERVER'] = '1'
    $start.Environment['GITHUB_ACTIONS'] = 'true'
    $start.Environment['RUNNER_ENVIRONMENT'] = 'github-hosted'
    $start.Environment['RUNNER_OS'] = 'Windows'
    $start.Environment['RUNNER_TEMP'] = ${literal(temporary)}
    $start.Environment['HPM_DAEMON_OWNED_ROOT'] = $OwnedRoot`
  );
  replace(
    "    $process.StandardInput.Write('1')",
    `    if ((Get-FileHash -LiteralPath ${literal(prepareFile)} -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${prepareSha256}') { throw 'daemon_start_failed' }
    & ${literal(prepareFile)} -Node $Node -CaseRoot $caseRoot -InstallDirectory $InstallDirectory -OwnerPid $process.Id -ManifestSha256 $ManifestSha256 -Token $Request.token -Job $owner.job
    $process.StandardInput.Write('1')`
  );
  return source;
}
function buildInstalledClientController({ candidate, ownedRoot, caSha256 }) {
  try {
    safePath(candidate, true);
    safePath(ownedRoot, true);
    const lib = path.join(candidate, 'scripts/lib');
    const pins = Object.fromEntries(NAMES.map((name) => [name, digest(path.join(lib, name))]));
    const built = buildHostedController({ candidate, ownedRoot, caSha256, sourcePins: pins });
    const file = path.join(built.outputRoot, 'context-recovery-daemon-owned-controller.psm1');
    const prepareFile = path.join(lib, 'nsis-client-observer-prepare.ps1');
    safePath(prepareFile);
    const source = transformInstalledController(fs.readFileSync(file, 'utf8'), {
      prepareFile,
      prepareSha256: digest(prepareFile),
      temporary: path.dirname(ownedRoot),
    });
    fs.writeFileSync(file, source);
    const copyPins = Object.fromEntries(
      Object.keys(built.copyPins).map((name) => [name, digest(path.join(built.outputRoot, name))])
    );
    return Object.freeze({ outputRoot: built.outputRoot, copyPins: Object.freeze(copyPins) });
  } catch {
    throw fail();
  }
}
function createInstalledControllerSpawn(
  { candidate, ownedRoot, manifestSha256, powershellExecutable, controller },
  start = spawn
) {
  let used = false;
  const expected = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    path.join(candidate, 'scripts/lib/context-recovery-daemon-owned-controller.ps1'),
    '-OwnedRoot',
    ownedRoot,
    '-InstallDirectory',
    path.join(ownedRoot, 'payload'),
    '-ManifestSha256',
    manifestSha256,
  ];
  return (executable, args, raw) => {
    try {
      if (
        used ||
        executable !== powershellExecutable ||
        !isDeepStrictEqual(args, expected) ||
        process.env.GITHUB_ACTIONS !== 'true' ||
        process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
        process.env.RUNNER_OS !== 'Windows' ||
        path.join(process.env.RUNNER_TEMP || '', 'hpm-installed-clients') !== ownedRoot
      )
        throw fail();
      const options = exact(raw, ['env', 'windowsHide', 'shell', 'stdio']);
      const expectedEnv = {};
      for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
        if (process.env[name]) expectedEnv[name] = process.env[name];
      if (
        options.windowsHide !== true ||
        options.shell !== false ||
        !isDeepStrictEqual(options.stdio, ['pipe', 'pipe', 'pipe']) ||
        !isDeepStrictEqual({ ...exact(options.env, Object.keys(expectedEnv)) }, expectedEnv)
      )
        throw fail();
      for (const [name, sha] of Object.entries(controller.copyPins))
        if (digest(path.join(controller.outputRoot, name)) !== sha) throw fail();
      const next = args.slice();
      next[4] = path.join(controller.outputRoot, 'context-recovery-daemon-owned-controller.ps1');
      used = true;
      return start(executable, next, {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...expectedEnv,
          GITHUB_ACTIONS: 'true',
          RUNNER_ENVIRONMENT: 'github-hosted',
          RUNNER_OS: 'Windows',
          RUNNER_TEMP: process.env.RUNNER_TEMP,
        },
      });
    } catch {
      throw fail();
    }
  };
}
module.exports = {
  buildInstalledClientController,
  createInstalledControllerSpawn,
  transformInstalledController,
};
