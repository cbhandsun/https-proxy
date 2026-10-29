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
  safePath,
} = require('./nsis-encrypted-contract');
const { exerciseRecovery } = require('./nsis-recovery-fixture-state');
const {
  inventoryStore,
  assertLegacyRefusal,
  assertUnknownFormatRefusal,
} = require('./nsis-legacy-refusal');
const { assertLegacyEnrollment } = require('./nsis-legacy-enrollment');
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
  const observation = {
    missingAnchorReads: 0,
    anchorWrites: 0,
    databaseOpened: false,
    engineReady: false,
  };
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
    // The same pinned helper also secures filesystem ACLs and the independent
    // anchor. Only key protect/unprotect dispatch counts as DPAPI evidence.
    const key = nativeKeyInvocation(executable, parameters[0], installed.native);
    const anchor = parameters[0][0] === '--hpm-context-anchor-v1';
    const request = anchor ? JSON.parse(parameters[1].input) : null;
    if (anchor && request.operation === 'compare') observation.anchorWrites++;
    const result = execute.call(this, executable, ...parameters);
    if (key) nativeCalls++;
    if (anchor && request.operation === 'read') {
      const reply = JSON.parse(result);
      if (reply.ok === true && reply.revision === 0 && reply.value === null)
        observation.missingAnchorReads++;
    }
    return result;
  };
  try {
    const imported = (name) => require(path.join(input.install, 'lib/proxy', name));
    const { createStorageOwner } = imported('context-recovery-storage-owner.js');
    if (input.operation === 'enroll-legacy') {
      const { executeLegacyEnrollmentCommand } = imported('context-recovery-enrollment-command.js');
      assertLegacyEnrollment({
        command: executeLegacyEnrollmentCommand,
        directory: input.store,
        inventory: () => inventoryStore(input.store),
        evidence: () => ({ ...observation, nativeCalls }),
      });
    }
    if (['refuse-legacy', 'refuse-new-format'].includes(input.operation)) {
      if (input.operation === 'refuse-new-format') {
        const { DatabaseSync } = require('node:sqlite');
        const inspected = new DatabaseSync(safePath(path.join(input.store, 'checkpoint.sqlite')), {
          readOnly: true,
          allowExtension: false,
        });
        try {
          if (inspected.prepare('PRAGMA user_version').get().user_version !== 3) throw fail();
        } finally {
          inspected.close();
        }
      }
      const assertRefusal =
        input.operation === 'refuse-legacy' ? assertLegacyRefusal : assertUnknownFormatRefusal;
      const receipt = assertRefusal({
        open: () =>
          createStorageOwner({
            directory: input.store,
            onStartup({ phase }) {
              if (phase === 'database_opened') observation.databaseOpened = true;
              if (phase === 'engine_ready' || phase === 'ready') observation.engineReady = true;
            },
          }),
        inventory: () => inventoryStore(input.store),
        evidence: () => ({ ...observation, nativeCalls }),
        verifyClosed() {
          const { DatabaseSync } = require('node:sqlite');
          // A failed owner must release both connections and the lifetime writer
          // transaction. Probe actual locks before the after-inventory, without
          // rewriting either database or opening an absent path.
          for (const name of ['.writer.sqlite', 'checkpoint.sqlite']) {
            const database = new DatabaseSync(safePath(path.join(input.store, name)), {
              allowExtension: false,
            });
            try {
              database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');
            } finally {
              database.close();
            }
          }
        },
      });
      return {
        receipt,
        nativeCalls,
        sourceCount: installed.sourceCount,
        manifestSha256: installed.manifestSha256,
      };
    }
    const sessions = imported('context-recovery-sessions.js');
    const { createRootCheckpoint } = imported('context-recovery-root-checkpoint.js');
    const { parseRecoveryStorageRecord } = imported('context-recovery-storage-record.js');
    const { LIST_EVIDENCE_TOOL: LIST, READ_EVIDENCE_TOOL: READ } = imported(
      'context-evidence-tools.js'
    );
    storage = createStorageOwner({ directory: input.store });
    const receipt = exerciseRecovery(
      { sessions, createRootCheckpoint, parseRecoveryStorageRecord, LIST, READ },
      storage,
      input.operation === 'enroll-legacy' ? 'read' : input.operation
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
