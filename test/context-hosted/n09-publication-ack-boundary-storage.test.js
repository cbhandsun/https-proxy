'use strict';

// Physical encrypted FULL/DELETE SQLite and real session/ACK composition.
// The constructor and waiting capabilities are test seams, not native/daemon proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ackExports = require('../../lib/proxy/context-recovery-durable-ack');
const { createContextRecoveryLifecycle } = require('../../lib/proxy/context-recovery-lifecycle');
const { createContextRecoverySessions } = require('../../lib/proxy/context-recovery-sessions');
const { createRecoverySqliteStore } = require('../../lib/proxy/context-recovery-storage-sqlite');
const contract = require('../../lib/proxy/context-recovery-storage-contract');
const inventory = require('../../lib/proxy/context-recovery-storage-inventory');
const { installN09RuntimeHooks } = require('../../scripts/context-hosted/n09-ack/runtime-hooks');
const {
  installPublicationStorageObserver,
} = require('../../scripts/context-hosted/n09-business/publication-storage-observer');
const {
  createPublicationAckBoundary,
} = require('../../scripts/context-hosted/n09-business/publication-ack-boundary');

test('physical COMMIT precedes the held original ACK; a later gate failure retains durable state and denies completion', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'n09-ack-sqlite-')
  );
  const file = path.join(directory, 'checkpoint.sqlite');
  const database = new DatabaseSync(file, { allowExtension: false });
  const engine = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  const sessions = createContextRecoverySessions({ now: () => 100 });
  const owned = {};
  let boundary;
  let wanted = 'prepared',
    completionReleased = false,
    failGate = false,
    time = 0,
    polls = 0;
  const held = [];
  let expectedRevision;
  t.after(async () => {
    try {
      await owned.lifecycle?.shutdownAsync();
    } catch (error) {
      assert.equal(error.message, 'n09_host_ack_rejected');
    } finally {
      try {
        owned.hooks?.close();
      } finally {
        try {
          owned.observer?.close();
        } finally {
          sessions.close();
          try {
            engine.close();
          } finally {
            database.close();
          }
          fs.rmSync(directory, { recursive: true });
        }
      }
    }
  });
  const service = {
    async execute(request) {
      if (
        request.operation === 'save-reference-state' &&
        request.reference.publications.some((item) => item.state === wanted)
      ) {
        const prior = observer.inspect();
        expectedRevision = request.expectedRevision + 1;
        polls = 0;
        boundary = createPublicationAckBoundary({
          inspect: () => observer.inspect(),
          publish(facts) {
            assert.equal(completionReleased, false);
            assert.equal(
              database
                .prepare('SELECT revision FROM recovery_state WHERE scope=?')
                .get(request.scope).revision,
              expectedRevision
            );
            assert.equal(facts.revision, expectedRevision);
            assert.equal(fs.existsSync(file + '-journal'), false);
            assert.equal(database.prepare('PRAGMA synchronous').get().synchronous, 2);
            assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
            assert.equal(database.prepare('PRAGMA secure_delete').get().secure_delete, 1);
            held.push(facts);
            if (failGate) throw Error('PRIVATE_ACK_GATE_ERROR');
          },
          released: () => ++polls === 3,
          sleep: (ms) => {
            time += ms;
          },
          now: () => time,
        });
        boundary.arm({
          generation: prior.generation,
          callOrdinal: prior.callOrdinal,
          rootId: request.reference.metadata.rootId,
          expiresAt: request.expiresAt,
          expectedRevision: request.expectedRevision,
          transition: wanted,
        });
      }
      return engine.execute(request);
    },
    close() {},
  };
  for (const suffix of [
    'Scan',
    'SourcePages',
    'ReaderSettlement',
    'ReferenceWrites',
    'ReferenceStates',
    'ReferenceAdmission',
    'ReferenceScan',
    'ReadSettlement',
  ]) {
    contract['declareRecovery' + suffix](service.execute);
  }
  const storageExports = { openContextRecoveryStorage: async () => service };
  const observer = installPublicationStorageObserver({
    storageExports,
    storageContract: contract,
    storageInventory: inventory,
    expectedDirectory: directory,
  });
  owned.observer = observer;
  const observed = await storageExports.openContextRecoveryStorage({ directory });
  const lifecycleExports = {
    createContextRecoveryLifecycle() {
      return createContextRecoveryLifecycle({ sessions, storage: observed });
    },
  };
  const hooks = installN09RuntimeHooks({
    ackExports,
    lifecycleExports,
    expectedDirectory: directory,
    pid: 123,
    epoch: 'a'.repeat(32),
    afterDurableAck: (facts) => {
      boundary?.afterDurableAck(facts);
    },
  });
  owned.hooks = hooks;
  const lifecycle = lifecycleExports.createContextRecoveryLifecycle({ directory });
  owned.lifecycle = lifecycle;
  assert.deepEqual(await lifecycle.configureAsync(true), { ok: true });
  const binding = { principal: 'synthetic-owner', protocol: 'chat', target: 'offline' };
  const question = { role: 'user', content: 'question' };
  const external = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'original', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ],
  };
  const root = sessions.begin({ ...binding, history: [question] });
  assert.deepEqual(
    await root.completeObservedAsync(
      [external],
      [{ callId: 'original', toolName: 'lookup', arguments: {}, output: '', completed: true }]
    ),
    { ok: true }
  );
  const original = 'synthetic original Unicode 中文🙂';
  const view = sessions.begin(
    {
      ...binding,
      history: [question, external, { role: 'tool', tool_call_id: 'original', content: original }],
    },
    [{ callId: 'original', output: original }]
  );
  assert.equal(view.ok, true);
  const completed = await view.completePublicAsync([
    { role: 'assistant', content: 'synthetic public answer' },
  ]);
  completionReleased = true;
  assert.deepEqual(completed, { ok: true });
  assert.equal(held.length, 1);
  assert.equal(boundary.inspect().state, 'released');
  const expiry = held[0].expiresAt;
  wanted = 'sending';
  failGate = true;
  completionReleased = false;
  const sending = await view.startPublicationAsync();
  assert.equal(sending.ok, false);
  assert.equal(held.length, 2);
  assert.equal(held[1].expiresAt, expiry);
  assert.equal(boundary.inspect().state, 'failed');
  assert.equal(
    database.prepare('SELECT revision FROM recovery_state').get().revision,
    expectedRevision
  );
  assert.equal(database.prepare('SELECT expires_at FROM recovery_state').get().expires_at, expiry);
  assert.equal(JSON.stringify(sending).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(held).includes(original), false);
});
