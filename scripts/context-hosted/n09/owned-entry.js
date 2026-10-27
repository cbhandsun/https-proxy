'use strict';

// Fixed child entry. Before the original Job assignment grant, core modules only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isBuiltin } = require('node:module');
const { types } = require('node:util');
const fail = () => new Error('n09_owned_entry_rejected');
// Fixed phases: entry/composition/probes, 98..100 cleanup, 101..138 business startup.
let failureExitCode = 64;
let primaryFailurePhase = 64;
let businessCasePhase = 0;
function publicReadFailurePhase(casePhase) {
  // Only the outer reviewed driver chooses the case. No request data survives.
  return Number.isInteger(casePhase) && casePhase >= 80 && casePhase <= 83
    ? 247 + casePhase - 80
    : 230;
}
function verifyPinnedClosure(pins, roots, dynamicTargets = []) {
  if (
    !pins ||
    typeof pins !== 'object' ||
    types.isProxy(pins) ||
    Array.isArray(pins) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(pins))
  )
    throw fail();
  const normalized = new Map();
  for (const [name, slot] of Object.entries(Object.getOwnPropertyDescriptors(pins))) {
    if (
      !Object.hasOwn(slot, 'value') ||
      !slot.enumerable ||
      typeof slot.value !== 'string' ||
      !/^[a-f0-9]{64}$/.test(slot.value) ||
      !path.isAbsolute(name) ||
      /^[\\/]{2}/.test(name)
    )
      throw fail();
    const key = path.resolve(name).toLowerCase();
    if (normalized.has(key)) throw fail();
    normalized.set(key, slot.value);
  }
  const queue = [...roots, ...dynamicTargets],
    visited = new Set();
  while (queue.length) {
    const file = path.resolve(queue.pop()),
      key = file.toLowerCase();
    if (visited.has(key)) continue;
    if (!normalized.has(key)) throw fail(); // BEFORE reading or executing it.
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2097152)
      throw fail();
    const source = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(source).digest('hex') !== normalized.get(key))
      throw fail();
    visited.add(key);
    if (file.endsWith('.json')) continue;
    let code = source.toString('utf8');
    code = code.replace(
      /\brequire\s*\(\s*path\.join\s*\(\s*options\.install\s*,\s*(['"])lib\/proxy\/context-recovery-(?:durable-ack|lifecycle|storage|storage-contract|storage-inventory)\.js\1\s*\)\s*\)/g,
      () => {
        if (file !== path.resolve(__dirname, '../n09-ack/host-install.js')) throw fail();
        return '';
      }
    );
    code = code.replace(
      /\brequire\s*\(\s*path\.join\s*\(\s*options\.candidate\s*,\s*(['"])scripts\/lib\/context-recovery-daemon-owned-(?:transport|adapter)\.js\1\s*\)\s*\)/g,
      () => {
        if (path.basename(file) !== 'observed-composition.js' || dynamicTargets.length !== 2)
          throw fail();
        return '';
      }
    );
    code = code.replace(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g, (_whole, _quote, name) => {
      if (isBuiltin(name)) return '';
      if (!name.startsWith('./') && !name.startsWith('../')) throw fail();
      const base = path.resolve(path.dirname(file), name);
      const choices = [
        base,
        base + '.js',
        base + '.cjs',
        base + '.json',
        path.join(base, 'index.js'),
      ].filter((candidate) => normalized.has(candidate.toLowerCase()));
      if (choices.length !== 1) throw fail();
      queue.push(choices[0]);
      return '';
    });
    // The reviewed composition has only the two fixed dynamic candidate imports
    // above. All other lazy and transitive imports must be explicit literals.
    if (/\brequire\s*\(/.test(code)) throw fail();
  }
  return Object.freeze({ files: visited.size });
}
async function main() {
  if (
    process.platform !== 'win32' ||
    process.argv.length !== 4 ||
    process.execArgv.length !== 0 ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.RUNNER_OS !== 'Windows'
  )
    throw fail();
  const ownedRoot = path.resolve(process.argv[2]);
  const expectedPlan = process.argv[3];
  if (!/^[a-f0-9]{64}$/.test(expectedPlan)) throw fail();
  failureExitCode = 65;
  let grant = '';
  for await (const chunk of process.stdin) {
    grant += chunk.toString('utf8');
    if (grant.length > 1) throw fail();
  }
  if (grant !== '1') throw fail();
  const physical = (file, directory) => {
    if (!path.isAbsolute(file) || /^[\\/]{2}/.test(file)) throw fail();
    let current = path.resolve(file),
      first = true;
    for (;;) {
      const stat = fs.lstatSync(current);
      if (
        stat.isSymbolicLink() ||
        (first
          ? directory
            ? !stat.isDirectory()
            : !stat.isFile() || stat.nlink !== 1
          : !stat.isDirectory())
      )
        throw fail();
      const parent = path.dirname(current);
      if (parent === current) break;
      first = false;
      current = parent;
    }
  };
  failureExitCode = 66;
  physical(ownedRoot, true);
  const planFile = path.join(ownedRoot, 'n09-hosted-plan.json');
  physical(planFile, false);
  failureExitCode = 67;
  if (fs.statSync(planFile).size > 65536) throw fail();
  const planBytes = fs.readFileSync(planFile);
  if (crypto.createHash('sha256').update(planBytes).digest('hex') !== expectedPlan) throw fail();
  const planText = planBytes.toString('utf8');
  if (!Buffer.from(planText).equals(planBytes)) throw fail();
  const parsed = JSON.parse(planText);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !parsed.loadedPins ||
    typeof parsed.loadedPins !== 'object' ||
    Array.isArray(parsed.loadedPins)
  )
    throw fail();
  failureExitCode = 68;
  const pins = Object.entries(parsed.loadedPins);
  if (pins.length < 1 || pins.length > 512) throw fail();
  for (const [file, expected] of pins) {
    physical(file, false);
    if (
      typeof expected !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      fs.statSync(file).size > 2097152 ||
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected
    )
      throw fail();
  }
  failureExitCode = 69;
  verifyPinnedClosure(parsed.loadedPins, [
    __filename,
    path.join(__dirname, 'composition.js'),
    path.resolve(__dirname, '../n09-ack/host-install.js'),
    path.resolve(__dirname, '../n09-ack/bootstrap-contract.js'),
  ]);
  failureExitCode = 70;
  const { exact } = require('../shared/boundary.js');
  const plan = exact(parsed, [
    'candidate',
    'ownedRoot',
    'manifestSha256',
    'controllerPins',
    'lifecyclePins',
    'loadedPins',
    'networkRoot',
    'caSha256',
    'leafSha256',
    'negativeAddress',
  ]);
  if (path.resolve(plan.ownedRoot).toLowerCase() !== ownedRoot.toLowerCase()) throw fail();
  failureExitCode = 71;
  const { composeHostedN09 } = require('./composition.js');
  const result = await composeHostedN09(plan, (phase) => {
    if (
      !Number.isInteger(phase) ||
      !(
        (phase >= 73 && phase <= 85) ||
        (phase >= 86 && phase <= 96) ||
        (phase >= 98 && phase <= 138) ||
        (phase >= 140 && phase <= 159) ||
        (phase >= 162 && phase <= 199) ||
        phase === 201 ||
        (phase >= 203 && phase <= 209) ||
        (phase >= 211 && phase <= 246) ||
        phase === 251 ||
        phase === 252 ||
        phase === 253 ||
        phase === 254 ||
        phase === 255 ||
        [200, 202, 210].includes(phase)
      )
    )
      throw fail();
    if (
      (phase >= 80 && phase <= 83) ||
      phase === 85 ||
      phase === 86 ||
      phase === 158 ||
      phase === 159
    )
      businessCasePhase = phase;
    const reported = phase === 230 ? publicReadFailurePhase(businessCasePhase) : phase;
    failureExitCode = reported;
    if (phase < 98 || phase >= 101) primaryFailurePhase = reported;
  });
  failureExitCode = 72;
  if (
    result.originalControllerReused !== true ||
    result.tlsValidationDisabled !== false ||
    result.remoteModelRequests !== 0 ||
    result.networkProof?.probesPassed !== true ||
    result.networkProof.tlsVerified !== true ||
    result.networkProof.nonLoopbackBlocked !== true ||
    result.networkProof.listenerOwned !== true ||
    result.committed?.adapterCommittedObservation !== true ||
    result.committed.adapterExactReadAfterRestart !== true ||
    result.committed.hostDurableAckObserved !== false ||
    result.clear?.adapterClearBoundaryObserved !== true ||
    result.clear.oldReceiptDeniedAfterToggle !== true ||
    ['save', 'revoke'].some(
      (operation) =>
        result[operation]?.operation !== operation ||
        result[operation].adapterDurableAckObserved !== true ||
        result[operation].sameDirectoryNewPid !== true ||
        result[operation].n09Complete !== false
    ) ||
    result.n09Complete !== false ||
    result.backup?.adapterBackupRollbackObserved !== true ||
    result.backup.adapterRevokeBoundaryObserved !== true ||
    result.backup.restoredStorageRejected !== true ||
    result.backup.independentAnchorRestored !== false ||
    result.backup.sameDirectoryNewPid !== true ||
    result.backup.positiveReadBeforeRevoke !== true ||
    result.backup.n09Complete !== false ||
    result.unpublished?.evidenceLevel !== 'adapter-orchestration-only' ||
    result.unpublished.boundary !== 'upstream-public-final-held' ||
    result.unpublished.interruptedWithZeroPublicBytes !== true ||
    result.unpublished.sameDirectoryNewPid !== true ||
    result.unpublished.originalReadAfterRestart !== true ||
    result.unpublished.commitInProgressQualified !== false ||
    result.unpublished.publicationCommitQualified !== false ||
    result.unpublished.n09Complete !== false ||
    result.cleanup?.adaptersClosed !== 8 ||
    result.cleanup.listenerClosed !== true
  )
    throw fail();
  for (const [name, kill] of [
    ['preparedKill', true],
    ['preparedRelease', false],
  ]) {
    const value = result[name];
    if (
      value?.evidenceLevel !== 'adapter-orchestration-only' ||
      value.boundary !== 'prepared-save-reference-state-commit-pending' ||
      value.forcedKill !== kill ||
      value.interruptedWithZeroPublicBytes !== kill ||
      value.positivePublicCompletion !== !kill ||
      value.actualPreparedWritePending !== true ||
      value.readAdmissionBlocked !== true ||
      value.sameDirectoryNewPid !== true ||
      value.originalReadAfterRestart !== true ||
      value.originalExpiryPreserved !== true ||
      value.n09Complete !== false
    )
      throw fail();
  }
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      phase: 'n09_owned_scenario_closed',
      probesPassed: true,
      tlsVerified: true,
      nonLoopbackBlocked: true,
      listenerOwned: true,
      syntheticSocketsClosed: result.cleanup.listenerClosed,
      cases: 8,
      n09Complete: false,
    }) + '\n'
  );
}
if (require.main === module)
  main().catch(() => {
    process.stderr.write('n09_owned_entry_rejected\n');
    if ((failureExitCode >= 98 && failureExitCode <= 100) || businessCasePhase !== 0)
      process.stderr.write('n09_primary_phase=' + primaryFailurePhase + '\n');
    if (businessCasePhase !== 0) process.stderr.write('n09_case_phase=' + businessCasePhase + '\n');
    process.exitCode = failureExitCode;
  });
module.exports = { verifyPinnedClosure, publicReadFailurePhase };
