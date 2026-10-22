'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const childProcess = require('node:child_process');
const {
  fail,
  digest,
  parseDriverArguments,
  verifyInstallation,
  nativeKeyInvocation,
} = require('./nsis-encrypted-contract');
const { exerciseRecovery } = require('./nsis-recovery-fixture-state');
function run(args) {
  if (process.platform !== 'win32') throw fail();
  const input = parseDriverArguments(args);
  const installed = verifyInstallation(input.install, input.manifestSha256);
  if (
    fs.realpathSync.native(process.execPath).toLowerCase() !==
    fs.realpathSync.native(installed.node).toLowerCase()
  )
    throw fail();
  if (input.operation === 'seed' && fs.readdirSync(input.store).length !== 0) throw fail();
  if (input.operation !== 'seed' && !fs.existsSync(path.join(input.store, '.data-key')))
    throw fail();
  const load = Module._resolveFilename;
  const execute = childProcess.execFileSync;
  let nativeCalls = 0,
    storage;
  Module._resolveFilename = function (...parameters) {
    const resolved = load.apply(this, parameters);
    if (
      typeof resolved === 'string' &&
      resolved.replaceAll('\\', '/').includes('/lib/proxy/') &&
      !resolved.toLowerCase().startsWith(input.install.toLowerCase() + path.sep)
    )
      throw fail();
    return resolved;
  };
  childProcess.execFileSync = function (executable, ...parameters) {
    // The same pinned helper also secures filesystem ACLs. Only actual key
    // protect/unprotect dispatch counts as DPAPI evidence.
    if (nativeKeyInvocation(executable, parameters[0], installed.native)) nativeCalls++;
    return execute.call(this, executable, ...parameters);
  };
  try {
    const imported = (name) => require(path.join(input.install, 'lib/proxy', name));
    const sessions = imported('context-recovery-sessions.js');
    const { createRootCheckpoint } = imported('context-recovery-root-checkpoint.js');
    const { createStorageOwner } = imported('context-recovery-storage-owner.js');
    const { parseRecoveryStorageRecord } = imported('context-recovery-storage-record.js');
    const { LIST_EVIDENCE_TOOL: LIST, READ_EVIDENCE_TOOL: READ } = imported(
      'context-evidence-tools.js'
    );
    storage = createStorageOwner({ directory: input.store });
    const receipt = exerciseRecovery(
      { sessions, createRootCheckpoint, parseRecoveryStorageRecord, LIST, READ },
      storage,
      input.operation
    );
    if (nativeCalls < 1) throw fail();
    receipt.keySha256 = digest(path.join(input.store, '.data-key'));
    return {
      receipt,
      nativeCalls,
      sourceCount: installed.sourceCount,
      manifestSha256: installed.manifestSha256,
    };
  } finally {
    try {
      storage?.close();
    } finally {
      Module._resolveFilename = load;
      childProcess.execFileSync = execute;
    }
  }
}
if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(run(process.argv.slice(2))) + '\n');
  } catch {
    process.stderr.write('nsis_encrypted_qualification_failed\n');
    process.exitCode = 1;
  }
}
module.exports = { run };
