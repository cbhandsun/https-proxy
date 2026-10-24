'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const childProcess = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const {
  fail,
  digest,
  safePath,
  parseDriverArguments,
  verifyInstallation,
  nativeKeyInvocation,
} = require('./nsis-encrypted-contract');
const { exerciseRecoveryAsync } = require('./nsis-recovery-fixture-state');
const { inventoryStore, isStorageRefusal } = require('./nsis-legacy-refusal');
const { assertLegacyEnrollment } = require('./nsis-legacy-enrollment');
const { createWorkerStartupEvidence } = require('./nsis-worker-startup-evidence');

function verifyReleasedLocks(directory) {
  const { DatabaseSync } = require('node:sqlite');
  for (const name of ['.writer.sqlite', 'checkpoint.sqlite']) {
    const database = new DatabaseSync(safePath(path.join(directory, name)), {
      allowExtension: false,
    });
    try {
      database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');
    } finally {
      database.close();
    }
  }
}

function assertRefusalLayout(directory, operation) {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(safePath(path.join(directory, 'checkpoint.sqlite')), {
    readOnly: true,
    allowExtension: false,
  });
  try {
    const version = database.prepare('PRAGMA user_version').get().user_version;
    if (operation === 'refuse-new-format' ? version !== 3 : ![1, 2].includes(version)) throw fail();
  } finally {
    database.close();
  }
}

async function run(args) {
  if (
    process.platform !== 'win32' ||
    process.execArgv.length !== 0 ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.env.NODE_V8_COVERAGE
  )
    throw fail();
  const input = parseDriverArguments(args);
  const installed = verifyInstallation(input.install, input.manifestSha256);
  if (
    fs.realpathSync.native(process.execPath).toLowerCase() !==
    fs.realpathSync.native(installed.node).toLowerCase()
  )
    throw fail();
  if (
    input.operation === 'seed'
      ? fs.readdirSync(input.store).length !== 0
      : !fs.existsSync(path.join(input.store, '.data-key'))
  )
    throw fail();
  const resolve = Module._resolveFilename;
  const execute = childProcess.execFileSync;
  let storage,
    nativeCalls = 0,
    anchorWrites = 0;
  const startup = createWorkerStartupEvidence();
  Module._resolveFilename = function (...parameters) {
    const resolved = resolve.apply(this, parameters);
    if (
      typeof resolved === 'string' &&
      resolved.replaceAll('\\', '/').includes('/lib/proxy/') &&
      !resolved.toLowerCase().startsWith(input.install.toLowerCase() + path.sep)
    )
      throw fail();
    return resolved;
  };
  // Observe only offline enrollment in this parent. The storage worker loads its
  // own unchanged native backend; no WorkerType, protector or clock is supplied.
  childProcess.execFileSync = function (executable, ...parameters) {
    const key = nativeKeyInvocation(executable, parameters[0], installed.native);
    if (
      parameters[0][0] === '--hpm-context-anchor-v1' &&
      JSON.parse(parameters[1].input).operation === 'compare'
    )
      anchorWrites++;
    const result = execute.call(this, executable, ...parameters);
    if (key) nativeCalls++;
    return result;
  };
  try {
    const imported = (name) => require(path.join(input.install, 'lib/proxy', name));
    const { openContextRecoveryStorage } = imported('context-recovery-storage.js');
    if (input.operation === 'enroll-legacy') {
      const { executeLegacyEnrollmentCommand } = imported('context-recovery-enrollment-command.js');
      // Enrollment is read-only SQLite admission plus an explicit OS anchor.
      // Crucially, do not open a direct owner before the worker's 1 -> 3 upgrade.
      assertLegacyEnrollment({
        command: executeLegacyEnrollmentCommand,
        directory: input.store,
        inventory: () => inventoryStore(input.store),
        evidence: () => ({ nativeCalls, anchorWrites }),
      });
    }
    const refused = ['refuse-legacy', 'refuse-new-format'].includes(input.operation);
    const before = refused ? inventoryStore(input.store) : null;
    if (refused) assertRefusalLayout(input.store, input.operation);
    let refusal;
    try {
      storage = await openContextRecoveryStorage({
        directory: input.store,
        onStartup: startup.observe,
      });
    } catch (error) {
      if (!refused) throw error;
      refusal = error;
    }
    let receipt;
    if (refused) {
      if (storage) {
        await storage.close();
        storage = undefined;
        throw fail();
      }
      if (!isStorageRefusal(refusal)) throw fail();
      startup.receipt(true);
      verifyReleasedLocks(input.store);
      if (!isDeepStrictEqual(before, inventoryStore(input.store))) throw fail();
      receipt = { refused: true, preserved: true, statusCode: 503, fileCount: before.length };
    } else {
      startup.receipt(false);
      const sessions = imported('context-recovery-sessions.js');
      const { createRootCheckpoint } = imported('context-recovery-root-checkpoint.js');
      const { parseRecoveryStorageRecord } = imported('context-recovery-storage-record.js');
      const { LIST_EVIDENCE_TOOL: LIST, READ_EVIDENCE_TOOL: READ } = imported(
        'context-evidence-tools.js'
      );
      receipt = await exerciseRecoveryAsync(
        { sessions, createRootCheckpoint, parseRecoveryStorageRecord, LIST, READ },
        storage,
        input.operation === 'enroll-legacy' ? 'read' : input.operation
      );
      await storage.close();
      storage = undefined;
      receipt.keySha256 = digest(path.join(input.store, '.data-key'));
    }
    if (!isDeepStrictEqual(installed, verifyInstallation(input.install, input.manifestSha256)))
      throw fail();
    return {
      backend: 'default-worker',
      observation: startup.receipt(refused),
      receipt,
      sourceCount: installed.sourceCount,
      manifestSha256: installed.manifestSha256,
    };
  } finally {
    try {
      if (storage) await storage.close();
    } finally {
      Module._resolveFilename = resolve;
      childProcess.execFileSync = execute;
    }
  }
}

module.exports = { run, verifyReleasedLocks, assertRefusalLayout };
