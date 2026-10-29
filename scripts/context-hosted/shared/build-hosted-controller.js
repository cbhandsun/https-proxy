'use strict';

// Offline/hosted review infrastructure only; no CLI and no process execution.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { exact } = require('./boundary.js');
const fail = () => new Error('n08_hosted_controller_rejected');
const NAMES = Object.freeze([
  'context-recovery-daemon-owned-controller.ps1',
  'context-recovery-daemon-owned-controller.psm1',
  'context-recovery-daemon-start-gate.cjs',
  'nsis-runtime-boundary-job.cs',
  'nsis-lifecycle.psm1',
  'nsis-runtime-boundary.psm1',
]);
function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function physical(file, directory) {
  if (!path.isAbsolute(file) || /^[\\/]{2}/.test(file)) throw fail();
  for (
    let current = path.resolve(file), first = true;
    ;
    current = path.dirname(current), first = false
  ) {
    const stat = fs.lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase() ||
      (first
        ? directory
          ? !stat.isDirectory()
          : !stat.isFile() || stat.nlink !== 1
        : !stat.isDirectory())
    )
      throw fail();
    if (current === path.dirname(current)) break;
  }
}
function buildHostedController(input) {
  try {
    const options = exact(input, ['candidate', 'ownedRoot', 'sourcePins', 'caSha256']);
    const pins = exact(options.sourcePins, NAMES);
    if (!/^[a-f0-9]{64}$/.test(options.caSha256)) throw fail();
    physical(options.candidate, true);
    physical(options.ownedRoot, true);
    const lib = path.join(options.candidate, 'scripts/lib');
    const original = Object.create(null);
    for (const name of NAMES) {
      if (!/^[a-f0-9]{64}$/.test(pins[name])) throw fail();
      const file = path.join(lib, name);
      physical(file, false);
      original[name] = fs.readFileSync(file);
      if (hash(original[name]) !== pins[name]) throw fail();
    }
    const caFile = path.join(options.ownedRoot, 'n08-hosted-network/ca.pem');
    physical(caFile, false);
    if (hash(fs.readFileSync(caFile)) !== options.caSha256) throw fail();
    let moduleSource = original['context-recovery-daemon-owned-controller.psm1'].toString('utf8');
    const literal = (file) => "'" + file.replaceAll("'", "''") + "'";
    function replace(before, after) {
      if (moduleSource.split(before).length !== 2) throw fail();
      moduleSource = moduleSource.replace(before, after);
    }
    for (const name of [
      'nsis-lifecycle.psm1',
      'nsis-runtime-boundary.psm1',
      'context-recovery-daemon-start-gate.cjs',
      'nsis-runtime-boundary-job.cs',
    ])
      replace("(Join-Path $PSScriptRoot '" + name + "')", literal(path.join(lib, name)));
    replace(
      "    $start.Environment['HPM_DAEMON_OWNED_ROOT'] = $OwnedRoot",
      `    # Hosted test-only trust capability; all process/gate/protocol logic is original.
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') { throw 'daemon_start_failed' }
    $hostedCa = Join-Path $OwnedRoot 'n08-hosted-network/ca.pem'
    Assert-HpmLifecycleArtifactPath $OwnedRoot $hostedCa 'Leaf'
    if ((Get-FileHash -LiteralPath $hostedCa -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${options.caSha256}') { throw 'daemon_start_failed' }
    $start.Environment['NODE_EXTRA_CA_CERTS'] = $hostedCa
    $start.Environment['HPM_DAEMON_OWNED_ROOT'] = $OwnedRoot`
    );
    const outputRoot = path.join(options.ownedRoot, 'n08-hosted-controller');
    fs.mkdirSync(outputRoot);
    physical(outputRoot, true);
    const entries = {
      'context-recovery-daemon-owned-controller.ps1':
        original['context-recovery-daemon-owned-controller.ps1'],
      'context-recovery-daemon-owned-controller.psm1': Buffer.from(moduleSource),
    };
    for (const [name, bytes] of Object.entries(entries)) {
      physical(outputRoot, true);
      fs.writeFileSync(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 });
      physical(path.join(outputRoot, name), false);
    }
    for (const name of NAMES)
      if (hash(fs.readFileSync(path.join(lib, name))) !== pins[name]) throw fail();
    return Object.freeze({
      outputRoot,
      originalPins: Object.freeze({ ...pins }),
      copyPins: Object.freeze(
        Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, hash(bytes)]))
      ),
      caSha256: options.caSha256,
      gateUnchanged: true,
      protocolUnchanged: true,
      deadlinesUnchanged: true,
    });
  } catch {
    throw fail();
  }
}
module.exports = { buildHostedController, verifyPhysicalPath: physical };
