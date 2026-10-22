'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { openContextRecoveryStorage } = require('../../lib/proxy/context-recovery-storage');
const { createRootCheckpoint } = require('../../lib/proxy/context-recovery-root-checkpoint');
const { parseRecoveryStorageRecord } = require('../../lib/proxy/context-recovery-storage-record');
const {
  restoreContextRecoverySessions,
  exportContextRecoveryRoot,
} = require('../../lib/proxy/context-recovery-sessions');
const { beginContextRecoveryRequest } = require('../../lib/proxy/context-recovery-protocol');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../../lib/proxy/context-evidence-tools');

async function main() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const operation = process.argv[2];
  assert.ok(['save', 'read', 'save-crash', 'revoke-crash', 'read-revoked'].includes(operation));
  assert.ok([7, 8, 9, 10].includes(payload.state.version));
  const scope = createHash('sha256')
    .update('hpm/recovery-root/v1\0' + payload.state.rootId)
    .digest('hex');
  const storage = await openContextRecoveryStorage({ directory: process.argv[3] });
  let runtime;
  let exactRead = false;
  let terminateWithoutClose = false;
  let revoked = false;
  try {
    if (operation === 'save' || operation === 'save-crash') {
      await storage.execute({
        operation: 'save',
        scope,
        expectedRevision: 0,
        expiresAt: payload.state.expiresAt,
        state: createRootCheckpoint(payload.state, []),
      });
      terminateWithoutClose = operation === 'save-crash';
    } else if (operation === 'revoke-crash') {
      await storage.execute({ operation: 'revoke', scope, expectedRevision: 1 });
      terminateWithoutClose = true;
    } else if (operation === 'read-revoked') {
      assert.equal(await storage.execute({ operation: 'load', scope }), null);
      const catalog = await storage.execute({ operation: 'catalog' });
      assert.equal(
        catalog.some((entry) => entry.scope === scope),
        false
      );
      revoked = true;
    } else {
      const catalog = await storage.execute({ operation: 'catalog' });
      const entry = catalog.find((value) => value.scope === scope);
      assert.ok(entry);
      const saved = parseRecoveryStorageRecord(
        await storage.execute({ operation: 'load', scope }),
        entry
      );
      runtime = restoreContextRecoverySessions({ now: Date.now }, [
        { binding: payload.binding, state: saved.state.root },
      ]);
      const session = beginContextRecoveryRequest(runtime, {
        auth: payload.auth,
        prepared: payload.prepared,
        kind: 'responses',
        buffer: Buffer.from(JSON.stringify(payload.body)),
      });
      assert.equal(session.ok, true);
      assert.equal(session.inspect().visibleSources, 1);
      const index = JSON.parse(session.reply(LIST, {}).text);
      const source = index.sources[0];
      assert.equal(
        JSON.parse(session.reply(READ, { sourceId: source.sourceId, digest: source.digest }).text)
          .page.text,
        payload.original
      );
      const exported = exportContextRecoveryRoot(runtime, saved.state.root.rootId);
      assert.equal(exported.version, payload.state.version);
      assert.equal(exported.expiresAt, payload.state.expiresAt);
      exactRead = true;
      session.abort();
    }
  } finally {
    runtime?.close();
    if (!terminateWithoutClose) await storage.close();
  }
  const report =
    JSON.stringify({
      pid: process.pid,
      version: payload.state.version,
      expiresAt: payload.state.expiresAt,
      exactRead,
      revoked,
      closeSkipped: terminateWithoutClose,
      commitAcknowledged: terminateWithoutClose,
    }) + '\n';
  if (terminateWithoutClose) {
    // Commit acknowledgement precedes this OS kill. No worker/SQLite/key
    // shutdown is permitted on this path; the next physical owner must recover.
    process.stdout.write(report, () => process.kill(process.pid, 'SIGKILL'));
  } else process.stdout.write(report);
}

main().catch(() => {
  process.stderr.write('v7_owner_failed\n');
  process.exitCode = 1;
});
