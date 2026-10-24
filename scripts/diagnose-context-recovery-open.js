'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diagnosticIdentity } = require('./lib/context-recovery-diagnostic-identity');
const { diagnoseStorageOpen } = require('./lib/context-recovery-open-diagnostic');

async function main() {
  if (process.argv.length !== 2) throw Error();
  const identity = diagnosticIdentity();
  process.stdout.write(JSON.stringify({ event: 'identity', ...identity }) + '\n');
  if (process.platform !== 'win32' || !identity.nativeSha256) {
    process.stdout.write(
      JSON.stringify({
        event: 'blocked',
        reason: process.platform !== 'win32' ? 'windows_required' : 'native_helper_required',
        attempted: false,
      }) + '\n'
    );
    process.exitCode = 2;
    return;
  }
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'hpm-open-diagnostic-'));
  // Retain this isolated empty database and its OS anchor for local diagnosis.
  // No user-configured directory, existing data or real model is accessed.
  const report = await diagnoseStorageOpen(path.join(root, 'context'));
  process.stdout.write(
    JSON.stringify({
      event: 'result',
      ...report,
      capacityQualified: false,
      realtime24hStarted: false,
    }) + '\n'
  );
  process.exitCode = report.passed ? 0 : 1;
}

main().catch(() => {
  process.stderr.write('context_recovery_open_diagnostic_failed\n');
  process.exitCode = 1;
});
