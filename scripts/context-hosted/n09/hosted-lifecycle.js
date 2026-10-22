'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { types } = require('node:util');
const { exact } = require('../shared/boundary.js');
const { verifyPhysicalPath } = require('../shared/build-hosted-controller.js');
const fail = () => new Error('n09_hosted_lifecycle_rejected');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const NAMES = Object.freeze([
  'n09-ipc-entry.ps1',
  'same-directory-ipc.psm1',
  'same-directory-restart.psm1',
  'n09-ipc-writer.cs',
]);
const POWERSHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
function buildHostedLifecycle(input) {
  try {
    const options = exact(input, ['ownedRoot', 'sourcePins', 'controllerCopySha256']);
    const pins = exact(options.sourcePins, NAMES);
    verifyPhysicalPath(options.ownedRoot, true);
    const controller = path.join(
      options.ownedRoot,
      'n08-hosted-controller/context-recovery-daemon-owned-controller.psm1'
    );
    verifyPhysicalPath(controller, false);
    if (
      !hex(options.controllerCopySha256) ||
      sha(fs.readFileSync(controller)) !== options.controllerCopySha256
    )
      throw fail();
    const sourceRoot = path.resolve(__dirname, '../n09-ipc');
    const originals = Object.create(null);
    for (const name of NAMES) {
      const file = path.join(sourceRoot, name);
      verifyPhysicalPath(file, false);
      originals[name] = fs.readFileSync(file);
      if (!hex(pins[name]) || sha(originals[name]) !== pins[name]) throw fail();
    }
    const original = originals['same-directory-restart.psm1'].toString('utf8');
    const before =
      "$script:N09ControllerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../scripts/lib/context-recovery-daemon-owned-controller.psm1'))";
    if (original.split(before).length !== 2) throw fail();
    const after = "$script:N09ControllerPath = '" + controller.replaceAll("'", "''") + "'";
    const copies = {
      ...originals,
      'same-directory-restart.psm1': Buffer.from(original.replace(before, after)),
    };
    const outputRoot = path.join(options.ownedRoot, 'n09-hosted-lifecycle');
    fs.mkdirSync(outputRoot);
    verifyPhysicalPath(outputRoot, true);
    for (const [name, bytes] of Object.entries(copies)) {
      verifyPhysicalPath(outputRoot, true);
      fs.writeFileSync(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 });
      verifyPhysicalPath(path.join(outputRoot, name), false);
    }
    for (const name of NAMES)
      if (sha(fs.readFileSync(path.join(sourceRoot, name))) !== pins[name]) throw fail();
    return Object.freeze({
      outputRoot,
      copyPins: Object.freeze(
        Object.fromEntries(Object.entries(copies).map(([name, bytes]) => [name, sha(bytes)]))
      ),
    });
  } catch {
    throw fail();
  }
}
// Pure validation: no process or network operation. The bootstrap credential is
// forwarded only in the returned private spawn options and never in a receipt.
function prepareHostedSpawn(input, executable, args, rawOptions) {
  try {
    const settings = exact(input, ['ownedRoot', 'manifestSha256']);
    if (
      typeof settings.ownedRoot !== 'string' ||
      settings.ownedRoot.length > 4096 ||
      !path.isAbsolute(settings.ownedRoot) ||
      /^[\\/]{2}/.test(settings.ownedRoot) ||
      [...settings.ownedRoot].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      settings.ownedRoot.split(/[\\/]/).some((part) => part === '.' || part === '..') ||
      !hex(settings.manifestSha256)
    )
      throw fail();
    const expected = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.resolve(__dirname, '../n09-ipc/n09-ipc-entry.ps1'),
      '-OwnedRoot',
      settings.ownedRoot,
      '-InstallDirectory',
      path.join(settings.ownedRoot, 'payload'),
      '-ManifestSha256',
      settings.manifestSha256,
      '-ParentPid',
      String(process.pid),
    ];
    if (
      executable !== POWERSHELL ||
      types.isProxy(args) ||
      !Array.isArray(args) ||
      args.length !== expected.length
    )
      throw fail();
    for (let index = 0; index < expected.length; index++) {
      const slot = Object.getOwnPropertyDescriptor(args, String(index));
      if (!slot || !Object.hasOwn(slot, 'value') || slot.value !== expected[index]) throw fail();
    }
    const options = exact(rawOptions, ['env', 'windowsHide', 'shell', 'stdio']);
    if (
      options.windowsHide !== true ||
      options.shell !== false ||
      types.isProxy(options.stdio) ||
      !Array.isArray(options.stdio) ||
      options.stdio.length !== 3
    )
      throw fail();
    for (let index = 0; index < 3; index++) {
      const slot = Object.getOwnPropertyDescriptor(options.stdio, String(index));
      if (!slot || !Object.hasOwn(slot, 'value') || slot.value !== 'pipe') throw fail();
    }
    const expectedEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
      if (process.env[name]) expectedEnv[name] = process.env[name];
    const environment = exact(options.env, [
      ...Object.keys(expectedEnv),
      'HPM_N09_BOOTSTRAP_TOKEN',
    ]);
    if (
      Object.keys(expectedEnv).some((name) => environment[name] !== expectedEnv[name]) ||
      typeof environment.HPM_N09_BOOTSTRAP_TOKEN !== 'string' ||
      !/^[a-f0-9]{64}$/.test(environment.HPM_N09_BOOTSTRAP_TOKEN) ||
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      process.env.RUNNER_OS !== 'Windows'
    )
      throw fail();
    const next = expected.slice();
    next[4] = path.join(settings.ownedRoot, 'n09-hosted-lifecycle/n09-ipc-entry.ps1');
    return {
      executable,
      args: next,
      options: {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...environment,
          GITHUB_ACTIONS: 'true',
          RUNNER_ENVIRONMENT: 'github-hosted',
          RUNNER_OS: 'Windows',
        },
      },
    };
  } catch {
    throw fail();
  }
}
function createHostedLifecycleSpawn(settings) {
  let called = false;
  return (executable, args, options) => {
    if (called) throw fail();
    const plan = prepareHostedSpawn(settings, executable, args, options);
    called = true;
    return spawn(plan.executable, plan.args, plan.options);
  };
}
module.exports = { buildHostedLifecycle, prepareHostedSpawn, createHostedLifecycleSpawn };
