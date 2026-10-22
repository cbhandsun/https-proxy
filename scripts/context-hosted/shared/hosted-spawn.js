'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { exact } = require('./boundary.js');
const fail = () => new Error('n08_hosted_spawn_rejected');
function createHostedControllerSpawn(input) {
  const settings = exact(input, [
    'candidate',
    'ownedRoot',
    'manifestSha256',
    'powershellExecutable',
  ]);
  if (!/^[a-f0-9]{64}$/.test(settings.manifestSha256)) throw fail();
  const expected = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    path.join(settings.candidate, 'scripts/lib/context-recovery-daemon-owned-controller.ps1'),
    '-OwnedRoot',
    settings.ownedRoot,
    '-InstallDirectory',
    path.join(settings.ownedRoot, 'payload'),
    '-ManifestSha256',
    settings.manifestSha256,
  ];
  let called = false;
  return (executable, args, rawOptions) => {
    if (
      called ||
      executable !== path.resolve(settings.powershellExecutable) ||
      !Array.isArray(args) ||
      args.length !== expected.length ||
      args.some((value, index) => value !== expected[index])
    )
      throw fail();
    const options = exact(rawOptions, ['env', 'windowsHide', 'shell', 'stdio']);
    if (
      options.windowsHide !== true ||
      options.shell !== false ||
      !Array.isArray(options.stdio) ||
      options.stdio.join(',') !== 'pipe,pipe,pipe' ||
      options.stdio.length !== 3
    )
      throw fail();
    const expectedEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
      if (process.env[name]) expectedEnv[name] = process.env[name];
    const environment = exact(options.env, Object.keys(expectedEnv));
    if (
      Object.keys(expectedEnv).some((name) => environment[name] !== expectedEnv[name]) ||
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      process.env.RUNNER_OS !== 'Windows'
    )
      throw fail();
    const next = args.slice();
    next[4] = path.join(
      settings.ownedRoot,
      'n08-hosted-controller/context-recovery-daemon-owned-controller.ps1'
    );
    called = true;
    return spawn(executable, next, {
      windowsHide: true,
      shell: false,
      stdio: rawOptions.stdio,
      env: {
        ...options.env,
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Windows',
      },
    });
  };
}
module.exports = { createHostedControllerSpawn };
