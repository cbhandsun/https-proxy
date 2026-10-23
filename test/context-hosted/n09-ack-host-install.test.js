'use strict';

// Synthetic installed exports and real in-memory sessions only. No persistent
// lifecycle, worker, native helper or registry operation is created.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installN09HostAck } = require('../../scripts/context-hosted/n09-ack/host-install');
const { createN09MailboxClient } = require('../../scripts/context-hosted/n09-ack/mailbox');
const { exportContextRecoveryRoot } = require('../../lib/proxy/context-recovery-sessions');
const { createRootCheckpoint } = require('../../lib/proxy/context-recovery-root-checkpoint');
const {
  referenceStateFromCheckpoint,
} = require('../../lib/proxy/context-recovery-reference-state');
const safe = (error) => error.message === 'n09_host_ack_rejected' && !error.cause;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'n09-host-install-'));
  const install = path.join(root, 'payload');
  const caseRoot = path.join(root, 'case');
  fs.mkdirSync(path.join(install, 'lib/proxy'), { recursive: true });
  fs.mkdirSync(path.join(caseRoot, 'n09-ack'), { recursive: true });
  const real = (name) => JSON.stringify(path.resolve(__dirname, '../../lib/proxy', name));
  const ack = path.join(install, 'lib/proxy/context-recovery-durable-ack.js');
  const lifecycle = path.join(install, 'lib/proxy/context-recovery-lifecycle.js');
  const storage = path.join(install, 'lib/proxy/context-recovery-root-storage.js');
  fs.writeFileSync(
    ack,
    `exports.createRecoveryDurableAck = require(${real('context-recovery-durable-ack.js')}).createRecoveryDurableAck;`
  );
  fs.writeFileSync(
    lifecycle,
    `const {createContextRecoverySessions}=require(${real('context-recovery-sessions.js')});
exports.createContextRecoveryLifecycle = () => { const sessions=createContextRecoverySessions({now:()=>100}); sessions.configure(true); return {sessions,shutdownAsync:()=>sessions.shutdownAsync()}; };`
  );
  fs.writeFileSync(storage, 'exports.neverUsed = true;');
  t.after(() => {
    for (const file of [ack, lifecycle, storage]) delete require.cache[file];
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    ack,
    lifecycle,
    storage,
    input: { install, caseRoot, pid: 123, epoch: 'a'.repeat(32), signingKey: 'b'.repeat(64) },
  };
}

test('host installs on cold fixed exports, observes original ACK and restores without shutting product down', async (t) => {
  const f = fixture(t);
  const host = installN09HostAck(f.input);
  const client = createN09MailboxClient({
    directory: path.join(f.input.caseRoot, 'n09-ack'),
    pid: 123,
    epoch: f.input.epoch,
    signingKey: f.input.signingKey,
  });
  t.after(() => {
    host.close();
    client.close();
  });
  const ack = require(f.ack);
  const factory = require(f.lifecycle);
  const lifecycle = factory.createContextRecoveryLifecycle({
    directory: path.join(f.input.caseRoot, 'runtime/context-recovery-v1'),
  });
  t.after(() => lifecycle.sessions.close());
  const session = lifecycle.sessions.begin({
    principal: 'synthetic-owner',
    protocol: 'chat',
    target: 'target',
    history: [{ role: 'user', content: 'synthetic' }],
  });
  session.complete([{ role: 'assistant', content: 'synthetic' }], [], 'r1');
  const state = referenceStateFromCheckpoint(
    createRootCheckpoint(exportContextRecoveryRoot(lifecycle.sessions, session.snapshotId), [])
  );
  ack.createRecoveryDurableAck(state, 1);
  client.submit({
    version: 1,
    operation: 'arm-save',
    pid: 123,
    epoch: f.input.epoch,
    sequence: 1,
    rootId: state.metadata.rootId,
    expiresAt: state.metadata.expiresAt,
    minRevision: 1,
  });
  assert.equal(host.step(), 'armed');
  assert.equal(client.readReceipt(), null);
  ack.createRecoveryDurableAck(state, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.readReceipt().revision, 2);
  assert.equal(require.cache[f.storage], undefined);
  host.close();
  assert.equal(lifecycle.sessions.inspect().closed, false);
  assert.deepEqual(await lifecycle.shutdownAsync(), { ok: true });
});

test('host rejects warm installed ownership and malformed identity before imports', (t) => {
  const f = fixture(t);
  assert.throws(() => installN09HostAck({ ...f.input, pid: 0 }), safe);
  assert.equal(require.cache[f.ack], undefined);
  require(f.storage);
  assert.throws(() => installN09HostAck(f.input), safe);
  assert.equal(require.cache[f.ack], undefined);
  delete require.cache[f.storage];
  fs.writeFileSync(
    f.lifecycle,
    "require('./context-recovery-root-storage.js'); exports.createContextRecoveryLifecycle=()=>{};"
  );
  assert.throws(() => installN09HostAck(f.input), safe);
});
