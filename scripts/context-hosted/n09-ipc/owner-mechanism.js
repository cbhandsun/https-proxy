'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fail = () => new Error('n09_owner_mechanism_failed');

// Trusted review caller supplies a frozen candidate and fresh isolated directory.
// This is real forced owner termination, explicitly NOT a business-host test.
function runOwnerMechanism({ candidate, helperSha256, directory, payload, environment }) {
  if (
    typeof candidate !== 'string' ||
    !path.isAbsolute(candidate) ||
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    typeof helperSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(helperSha256) ||
    !payload ||
    !Number.isSafeInteger(payload.state?.expiresAt) ||
    !environment ||
    environment.NODE_OPTIONS ||
    environment.NODE_PATH
  )
    throw fail();
  if (fs.readdirSync(directory).length !== 0) throw fail();
  const helper = path.join(candidate, 'test/helpers/context-recovery-v7-owner.js');
  if (createHash('sha256').update(fs.readFileSync(helper)).digest('hex') !== helperSha256)
    throw fail();
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > 48 * 1024 * 1024) throw fail();
  const pids = new Set();
  const states = [];
  for (const operation of ['save-crash', 'read', 'revoke-crash', 'read-revoked']) {
    const result = spawnSync(
      process.execPath,
      [helper, operation, path.join(directory, 'context')],
      {
        cwd: candidate,
        env: environment,
        input,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 30000,
        maxBuffer: 4096,
      }
    );
    if (result.error || result.stderr || typeof result.stdout !== 'string' || !result.stdout)
      throw fail();
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw fail();
    }
    if (
      Object.keys(report).sort().join(',') !==
        'closeSkipped,commitAcknowledged,exactRead,expiresAt,pid,revoked,version' ||
      !Number.isSafeInteger(report.pid) ||
      report.pid === process.pid ||
      pids.has(report.pid) ||
      report.expiresAt !== payload.state.expiresAt ||
      report.version !== payload.state.version
    )
      throw fail();
    const crash = operation.endsWith('-crash');
    if (
      (crash ? result.status === 0 : result.status !== 0) ||
      report.closeSkipped !== crash ||
      report.commitAcknowledged !== crash ||
      (operation === 'read' && report.exactRead !== true) ||
      (operation === 'read-revoked' && report.revoked !== true)
    )
      throw fail();
    pids.add(report.pid);
    states.push({ operation, pid: report.pid, acknowledgedForcedExit: crash });
  }
  return Object.freeze({
    scope: 'module_owner_forced_kill_mechanism_only',
    states,
    exactReadAfterKill: true,
    revokeDeniedAfterKill: true,
    absoluteExpiryUnchanged: true,
    businessHostQualified: false,
    installedQualified: false,
    n09Complete: false,
  });
}
module.exports = { runOwnerMechanism };
