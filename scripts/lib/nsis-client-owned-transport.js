'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { types } = require('node:util');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const { safePath, digest } = require('./nsis-encrypted-contract');
const { hostRoot, validateOwnedSpec, resumeFlag } = require('./nsis-client-owned-launcher.cjs');
const fail = () => new Error('nsis_client_owned_failed');

function createOwnedClientSpawn(input, dependencies, restart) {
  const runtime = dependencies.runtime ?? process,
    start = dependencies.spawn ?? spawn;
  let options;
  try {
    options = dataSnapshot(input, 'nsis_client_owned_failed');
    if (
      Object.keys(options).sort().join(',') !==
      'binarySha256,caseRoot,client,manifestSha256,ownedRoot,powershellExecutable'
    )
      throw fail();
    if (restart && options.client !== restart) throw fail();
    hostRoot(options.ownedRoot, runtime);
    safePath(options.caseRoot, true);
    options.powershellExecutable = safePath(options.powershellExecutable);
    if (
      path.basename(options.powershellExecutable).toLowerCase() !== 'pwsh.exe' ||
      typeof start !== 'function' ||
      types.isProxy(start)
    )
      throw fail();
  } catch {
    throw fail();
  }
  let launches = 0,
    terminal = false,
    refused = false,
    retainedSpec,
    retainedHash;
  return async (inputLaunch) => {
    let child, stopPromise;
    try {
      if (refused || launches >= (restart ? 2 : 1) || (launches !== 0 && !terminal)) throw fail();
      launches++;
      terminal = false;
      const launch = dataSnapshot(inputLaunch, 'nsis_client_owned_failed');
      if (
        Object.keys(launch).some(
          (key) => !['args', 'cwd', 'env', 'executable', 'windowsHide', 'stdio'].includes(key)
        ) ||
        (launch.executable !== undefined &&
          launch.executable !== path.join(options.ownedRoot, 'clients', options.client + '.exe')) ||
        (launch.windowsHide !== undefined && launch.windowsHide !== true) ||
        (launch.stdio !== undefined &&
          (!Array.isArray(launch.stdio) || launch.stdio.join(',') !== 'pipe,pipe,pipe'))
      )
        throw fail();
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(options.ownedRoot, 'payload', 'release-runtime-manifest.json'),
          'utf8'
        )
      );
      const spec = {
        schemaVersion: 1,
        ownedRoot: options.ownedRoot,
        caseRoot: options.caseRoot,
        client: options.client,
        manifestSha256: options.manifestSha256,
        binarySha256: options.binarySha256,
        nodeSha256: manifest.nodeSha256,
        launcherSha256: digest(path.join(__dirname, 'nsis-client-owned-launcher.cjs')),
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
      };
      if (restart === 'claude' && launches === 1 && resumeFlag(spec.args)) throw fail();
      if (restart === 'claude' && launches === 2) {
        spec.schemaVersion = 2;
        spec.predecessorSha256 = retainedHash;
      }
      validateOwnedSpec(spec, runtime);
      const file = path.join(
        options.caseRoot,
        spec.schemaVersion === 2 ? 'client-resume.json' : 'client-launch.json'
      );
      const serialized = JSON.stringify(spec);
      if (Buffer.byteLength(serialized) > 65536) throw fail();
      if (launches === 1 || spec.schemaVersion === 2) {
        fs.writeFileSync(file, serialized, { flag: 'wx', mode: 0o600 });
        if (launches === 1) retainedSpec = serialized;
      } else {
        // A fresh Job may reuse only the original immutable launch grant.
        // Resume is an RPC operation; no executable, argument, home or token
        // can be substituted for the second process.
        safePath(file);
        if (
          serialized !== retainedSpec ||
          fs.statSync(file).size !== Buffer.byteLength(retainedSpec)
        )
          throw fail();
      }
      safePath(file);
      const specSha256 = digest(file);
      if (launches === 1) retainedHash = specSha256;
      else if (spec.schemaVersion === 1 && specSha256 !== retainedHash) throw fail();
      const env = {};
      for (const name of [
        'SystemRoot',
        'WINDIR',
        'PATH',
        'PATHEXT',
        'TEMP',
        'TMP',
        'GITHUB_ACTIONS',
        'RUNNER_ENVIRONMENT',
        'RUNNER_OS',
        'RUNNER_TEMP',
      ])
        if (runtime.env[name]) env[name] = runtime.env[name];
      child = start(
        options.powershellExecutable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(__dirname, 'nsis-client-owned-process.ps1'),
          '-SpecFile',
          file,
          '-SpecSha256',
          specSha256,
        ],
        {
          shell: false,
          windowsHide: true,
          cwd: options.caseRoot,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      let broken = false,
        exited = false;
      let finishExit;
      const exit = new Promise((resolve) => {
        finishExit = resolve;
      });
      child.on('error', () => {
        broken = true;
      });
      child.stdin.on('error', () => {
        broken = true;
      });
      child.stdout.on('error', () => {
        broken = true;
      });
      child.stderr.on('data', () => {}); // Never forward controller/native errors.
      child.stderr.on('error', () => {
        broken = true;
      });
      child.once('close', (code, signal) => {
        exited = true;
        finishExit(code === 0 && signal === null);
      });
      return {
        child,
        stop() {
          if (stopPromise) return stopPromise;
          stopPromise = (async () => {
            child.stdin.end();
            let timer;
            const clean = await Promise.race([
              exit,
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), 20000);
              }),
            ]);
            clearTimeout(timer);
            if (!clean || !exited || broken || digest(file) !== specSha256) throw fail();
            validateOwnedSpec(spec, runtime);
            terminal = true;
            return Object.freeze({ terminal: true, treeStopped: true });
          })().catch(() => {
            refused = true;
            throw fail();
          });
          return stopPromise;
        },
      };
    } catch {
      refused = true;
      if (child?.stdin && !child.stdin.destroyed) child.stdin.end();
      throw fail();
    }
  };
}

function createInstalledClientSpawn(input, dependencies = {}) {
  return createOwnedClientSpawn(input, dependencies, false);
}

// Separate trusted capability for the two-process Codex resume scenario.
// The original public harness capability remains strictly single-use.
function createInstalledCodexRestartSpawn(input, dependencies = {}) {
  return createOwnedClientSpawn(input, dependencies, 'codex');
}

function createInstalledClaudeRestartSpawn(input, dependencies = {}) {
  return createOwnedClientSpawn(input, dependencies, 'claude');
}

module.exports = {
  createInstalledClientSpawn,
  createInstalledCodexRestartSpawn,
  createInstalledClaudeRestartSpawn,
};
