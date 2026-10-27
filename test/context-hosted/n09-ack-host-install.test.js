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
const {
  createPublicationObservationContract,
} = require('../../scripts/context-hosted/n09-business/publication-observation-contract');
const {
  createPublicationObservationFiles,
} = require('../../scripts/context-hosted/n09-business/publication-observation-files');
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
  const service = path.join(install, 'lib/proxy/context-recovery-storage.js');
  const opening = path.join(install, 'lib/proxy/context-recovery-storage-opening.js');
  const contract = path.join(install, 'lib/proxy/context-recovery-storage-contract.js');
  const inventory = path.join(install, 'lib/proxy/context-recovery-storage-inventory.js');
  fs.writeFileSync(
    service,
    `exports.service = {execute: request => exports.next ?? Promise.resolve({revision:request.expectedRevision+1}), close(){}};
exports.openContextRecoveryStorage = () => (exports.opening = Promise.resolve(exports.service));
exports.originalOpen = exports.openContextRecoveryStorage;`
  );
  fs.writeFileSync(opening, 'exports.neverUsed = true;');
  fs.writeFileSync(
    contract,
    `module.exports = require(${real('context-recovery-storage-contract.js')});`
  );
  fs.writeFileSync(
    inventory,
    `module.exports = require(${real('context-recovery-storage-inventory.js')});`
  );
  fs.writeFileSync(
    ack,
    `exports.createRecoveryDurableAck = require(${real('context-recovery-durable-ack.js')}).createRecoveryDurableAck;`
  );
  fs.writeFileSync(
    lifecycle,
    `exports.capturedOpen = require('./context-recovery-storage.js').openContextRecoveryStorage;
const {createContextRecoverySessions}=require(${real('context-recovery-sessions.js')});
exports.createContextRecoveryLifecycle = () => { const sessions=createContextRecoverySessions({now:()=>100}); sessions.configure(true); return {sessions,shutdownAsync:()=>sessions.shutdownAsync()}; };`
  );
  fs.writeFileSync(storage, 'exports.neverUsed = true;');
  t.after(() => {
    for (const file of [ack, lifecycle, storage, service, opening, contract, inventory])
      delete require.cache[file];
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    ack,
    lifecycle,
    storage,
    service,
    opening,
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

test('publication queries sample the installed storage request captured before lifecycle imports and restore both exports', async (t) => {
  const f = fixture(t);
  const host = installN09HostAck(f.input);
  t.after(() => host.close());
  const storage = require(f.service),
    lifecycle = require(f.lifecycle);
  // This export was captured during the installed lifecycle module evaluation.
  assert.equal(lifecycle.capturedOpen, storage.openContextRecoveryStorage);
  assert.notEqual(storage.openContextRecoveryStorage, storage.originalOpen);
  const open = lifecycle.capturedOpen({
    directory: path.join(f.input.caseRoot, 'runtime/context-recovery-v1'),
  });
  assert.equal(open, storage.opening);
  const service = await open;
  assert.equal(service, storage.service);
  const request = (revision, publications = []) => ({
    operation: 'save-reference-state',
    scope: 'c'.repeat(64),
    expectedRevision: revision,
    reference: { metadata: { rootId: 'hbs_' + 'd'.repeat(32), expiresAt: 1000 }, publications },
  });
  await service.execute(request(0));
  let release;
  storage.next = new Promise((resolve) => {
    release = resolve;
  });
  const pending = service.execute(request(1, [{ snapshotId: 'snapshot', state: 'prepared' }]));
  assert.equal(pending, storage.next);
  const contract = createPublicationObservationContract({
    pid: f.input.pid,
    epoch: f.input.epoch,
    signingKey: f.input.signingKey,
  });
  const files = createPublicationObservationFiles({
    directory: path.join(f.input.caseRoot, `n09-publication-${f.input.pid}-${f.input.epoch}`),
    pid: f.input.pid,
    epoch: f.input.epoch,
  });
  t.after(() => {
    files.close();
    contract.close();
  });
  files.write(
    'query',
    1,
    JSON.stringify(
      contract.signQuery({
        version: 1,
        pid: f.input.pid,
        epoch: f.input.epoch,
        sequence: 1,
        challenge: 'e'.repeat(32),
      })
    )
  );
  let wire;
  for (let i = 0; i < 50 && wire == null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    wire = files.read('state', 1);
  }
  assert.notEqual(wire, null);
  const observed = contract.verifyState(wire);
  assert.equal(observed.transition, 'prepared');
  assert.equal(observed.status, 'pending');
  assert.equal(observed.expectedRevision, 1);
  assert.equal(observed.activeCount, 1);
  assert.equal(observed.expiresAt, 1000);
  release({ revision: 2 });
  await pending;
  host.close();
  assert.notEqual(storage.openContextRecoveryStorage, lifecycle.capturedOpen);
  assert.equal(storage.openContextRecoveryStorage, storage.originalOpen);
  assert.equal(require.cache[f.storage], undefined);
});

test('publication mailbox construction failure restores storage and lifecycle exports without opening product storage', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.input.caseRoot, `n09-publication-${f.input.pid}-${f.input.epoch}`));
  assert.throws(() => installN09HostAck(f.input), safe);
  const storage = require(f.service);
  assert.equal(storage.openContextRecoveryStorage, storage.originalOpen);
  assert.equal(storage.opening, undefined);
  assert.equal(require.cache[f.storage], undefined);
});

test('warm storage opening is refused before wrapping or constructing any observation mailbox', (t) => {
  const f = fixture(t);
  require(f.opening);
  assert.throws(() => installN09HostAck(f.input), safe);
  assert.equal(require.cache[f.service], undefined);
  assert.equal(
    fs.readdirSync(f.input.caseRoot).some((name) => name.startsWith('n09-publication-')),
    false
  );
});

test('ACK control directory conflict rejects and restores all exports without opening storage', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.input.caseRoot, `n09-publication-ack-${f.input.pid}-${f.input.epoch}`));
  assert.throws(() => installN09HostAck(f.input), safe);
  const storage = require(f.service);
  assert.equal(storage.openContextRecoveryStorage, storage.originalOpen);
  assert.equal(storage.opening, undefined);
  assert.equal(require.cache[f.storage], undefined);
});
