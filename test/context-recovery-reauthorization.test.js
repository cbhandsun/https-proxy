'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
  attachContextRecoveryStorage,
} = require('../lib/proxy/context-recovery-sessions');
const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
const {
  projectPublishedRecoveryRoot,
} = require('../lib/proxy/context-recovery-restore-projection');
const { reauthorizeRecoveryStorage } = require('../lib/proxy/context-recovery-reauthorization');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const { createLongRecoveryProgress } = require('./helpers/recovery-long-progress.cjs');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');

const original = '原文\r\nélève🙂';
const copy = (value) => globalThis.structuredClone(value);
const user = (content) => ({ role: 'user', content });
const answer = [{ role: 'assistant', content: 'done' }];
const unavailable = 'context_recovery_storage_unavailable';
function safe(error) {
  assert.equal(error.code, unavailable);
  assert.equal(error.message, unavailable);
  assert.equal(error.statusCode, 503);
  assert.equal(error.cause, undefined);
  return true;
}
function generation(calls = []) {
  return {
    choices: [
      {
        finish_reason: calls.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: 'done',
          ...(calls.length
            ? {
                tool_calls: calls.map(({ name, args }) => ({
                  id: 'private-read',
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                })),
              }
            : {}),
        },
      },
    ],
  };
}
async function fixture({ storage, privateHistory = false } = {}) {
  const database = storage ? null : new DatabaseSync(':memory:');
  const engine =
    storage ??
    createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
      now: () => 100,
    });
  const now = storage ? Date.now : () => 100;
  const sessions = createContextRecoverySessions({ now });
  sessions.configure(true);
  attachContextRecoveryStorage(sessions, engine);
  const binding = { principal: 'owner', protocol: 'chat', target: 'target' };
  const history = [user('question')];
  const external = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'external', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ],
  };
  const root = sessions.begin({ ...binding, history });
  assert.equal(
    (
      await root.completeObservedAsync(
        [external],
        [{ callId: 'external', toolName: 'lookup', arguments: {}, output: '', completed: true }],
        'first-response'
      )
    ).ok,
    true
  );
  const capturedHistory = [
    ...history,
    external,
    { role: 'tool', tool_call_id: 'external', content: original },
  ];
  const child = sessions.begin({ ...binding, history: capturedHistory }, [
    { callId: 'external', output: original },
  ]);
  const index = JSON.parse((await child.replyAsync(LIST, {})).text);
  let output = answer;
  if (privateHistory) {
    const run = child.recovery({ model: 'synthetic', messages: capturedHistory });
    assert.equal(run.ok, true);
    assert.equal(
      (
        await run.acceptAsync(
          generation([
            {
              name: READ,
              args: { sourceId: index.sources[0].sourceId, digest: index.sources[0].digest },
            },
          ])
        )
      ).mode,
      'continue'
    );
    const released = await run.acceptAsync(generation());
    assert.equal(released.mode, 'release');
    output = released.output;
  }
  assert.equal((await child.completeObservedAsync(output, [], 'finished-response')).ok, true);
  const request = { ...binding, history: [...capturedHistory, ...output, user('continue')] };
  const scope = createHash('sha256')
    .update('hpm/recovery-root/v1\0' + root.snapshotId)
    .digest('hex');
  const record = await engine.execute({ operation: 'load', scope });
  const state = record.state.root;
  return {
    sessions,
    engine,
    database,
    binding,
    request,
    state,
    record,
    scope,
    receipt: index.sources[0],
    child,
    root,
    now,
    async close() {
      await sessions.shutdownAsync();
      if (database) {
        engine.close();
        database.close();
      }
    },
  };
}
function projected(f, states, staged = []) {
  return projectPublishedRecoveryRoot(
    createRootCheckpoint(f.state, staged, states),
    f.request,
    f.state.observedAt + 1
  );
}

test('publication projection removes unsafe subtrees, staged sources and private history without refunding budgets or TTL', async () => {
  const f = await fixture({ privateHistory: true });
  try {
    assert.equal(f.state.history.entries.length, 1);
    for (const state of ['unobserved', 'prepared', 'sending', 'uncertain', 'withdrawn']) {
      const root = projected(f, [
        { snapshotId: f.state.rootId, state: 'transport-finished' },
        { snapshotId: f.child.snapshotId, state },
      ]);
      assert.deepEqual(
        root.snapshots.map((x) => x.id),
        [f.state.rootId]
      );
      assert.deepEqual(root.ledger.sources, []);
      assert.deepEqual(root.history.entries, []);
      assert.deepEqual(root.history.tips, []);
      assert.equal(root.version, 10);
      assert.equal(root.history.version, f.state.history.version);
      for (const field of ['budget', 'callCount', 'createdAt', 'expiresAt'])
        assert.deepEqual(root[field], f.state[field]);
      assert.equal(root.ledger.readCount, f.state.ledger.readCount);
      assert.equal(root.ledger.capturedCount, f.state.ledger.capturedCount);
      assert.equal(projected(f, [{ snapshotId: f.state.rootId, state }]), null);
    }
    assert.equal(projected(f, []), null);
    const all = projected(f, f.record.state.publications);
    assert.deepEqual(all, f.state);
    assert.equal(projectPublishedRecoveryRoot(f.record.state, f.request, f.state.expiresAt), null);
    assert.throws(
      () => projectPublishedRecoveryRoot(f.record.state, f.request, f.state.observedAt - 1),
      safe
    );
  } finally {
    await f.close();
  }
});

test('projection validates corrupt and executable data before pruning and cannot authorize a different current binding', async () => {
  const f = await fixture();
  try {
    const corrupt = copy(f.record.state);
    corrupt.root.snapshots[1].visible = ['hce_' + 'f'.repeat(32)];
    const envelope = createRootCheckpoint(
      corrupt.root,
      [],
      [
        { snapshotId: f.state.rootId, state: 'transport-finished' },
        { snapshotId: f.child.snapshotId, state: 'withdrawn' },
      ]
    );
    assert.throws(() => projectPublishedRecoveryRoot(envelope, f.request, 200), safe);
    for (const field of ['principal', 'target', 'protocol', 'policy'])
      assert.throws(
        () => projectPublishedRecoveryRoot(f.record.state, { ...f.request, [field]: 'other' }, 200),
        safe
      );
    let executed = 0;
    assert.throws(
      () =>
        projectPublishedRecoveryRoot(
          {
            get root() {
              executed++;
              return f.state;
            },
          },
          f.request,
          200
        ),
      safe
    );
    assert.equal(executed, 0);
  } finally {
    await f.close();
  }
});

test('finished descendants of an unsafe parent and staged-only sources never become visible', async () => {
  const f = await fixture({ privateHistory: true });
  try {
    const descendant = f.sessions.begin(f.request);
    assert.equal(descendant.reason, 'observed_continuation');
    assert.equal(
      (await descendant.completeObservedAsync(answer, [], 'descendant-response')).ok,
      true
    );
    const state = (await f.engine.execute({ operation: 'load', scope: f.scope })).state.root;
    const checkpoint = createRootCheckpoint(
      state,
      [],
      [
        { snapshotId: state.rootId, state: 'transport-finished' },
        { snapshotId: f.child.snapshotId, state: 'uncertain' },
        { snapshotId: descendant.snapshotId, state: 'transport-finished' },
      ]
    );
    const root = projectPublishedRecoveryRoot(checkpoint, f.request, 200);
    assert.deepEqual(
      root.snapshots.map((item) => item.id),
      [state.rootId]
    );
    assert.deepEqual(root.ledger.sources, []);
    assert.deepEqual(root.history.entries, []);
    assert.deepEqual(root.budget, state.budget);
    const staged = createRootCheckpoint(root, state.ledger.sources, [
      { snapshotId: state.rootId, state: 'transport-finished' },
    ]);
    assert.ok(staged.stagedSources.length > 0);
    assert.deepEqual(projectPublishedRecoveryRoot(staged, f.request, 200), root);
    // A safe parent remains usable when only its child is uncertain.
    const siblingProjection = projectPublishedRecoveryRoot(
      createRootCheckpoint(
        state,
        [],
        [
          { snapshotId: state.rootId, state: 'transport-finished' },
          { snapshotId: f.child.snapshotId, state: 'transport-finished' },
          { snapshotId: descendant.snapshotId, state: 'sending' },
        ]
      ),
      f.request,
      200
    );
    assert.deepEqual(
      siblingProjection.snapshots.map((item) => item.id),
      [state.rootId, f.child.snapshotId]
    );
    assert.deepEqual(siblingProjection.ledger.sources, state.ledger.sources);
    assert.deepEqual(siblingProjection.budget, state.budget);
  } finally {
    await f.close();
  }
});

test('current request reconstructs fresh durable capabilities, exact evidence, private history and original accounting', async () => {
  const f = await fixture({ privateHistory: true });
  let restored;
  try {
    await f.sessions.shutdownAsync();
    restored = await reauthorizeRecoveryStorage({
      storage: f.engine,
      request: f.request,
      authorized: () => true,
      now: () => 200,
    });
    assert.ok(restored);
    assert.equal(restored.session.reason, 'observed_continuation');
    assert.equal(restored.session.reply(READ, f.receipt).code, 'context_recovery_async_required');
    assert.equal((await f.child.replyAsync(LIST, {})).ok, false);
    const run = restored.session.recovery({ model: 'synthetic', messages: f.request.history });
    assert.equal(run.ok, true);
    assert.ok(
      run.initialRequest.messages.some(
        (item) => item.role === 'tool' && item.content.includes(original)
      )
    );
    const before = exportContextRecoveryRoot(restored.sessions, f.state.rootId);
    assert.deepEqual(before.budget, f.state.budget);
    const result = await restored.session.replyAsync(READ, {
      sourceId: f.receipt.sourceId,
      digest: f.receipt.digest,
    });
    assert.equal(JSON.parse(result.text).page.text, original);
    const after = await f.engine.execute({ operation: 'load', scope: f.scope });
    assert.equal(after.state.root.budget.calls, f.state.budget.calls + 1);
    assert.equal(after.expiresAt, f.state.expiresAt);
  } finally {
    await restored?.sessions.shutdownAsync();
    await f.close();
  }
});

test('same account cannot import a different route, policy, chat or unseen response', async () => {
  const f = await fixture();
  try {
    for (const request of [
      { ...f.request, principal: 'other' },
      { ...f.request, target: 'other' },
      { ...f.request, policy: { tools: [] } },
      { ...f.request, history: [user('unrelated')] },
      { ...f.request, previousResponseId: 'unseen' },
    ])
      assert.equal(
        await reauthorizeRecoveryStorage({
          storage: f.engine,
          request,
          authorized: () => true,
          now: () => 200,
        }),
        null
      );
    const checkpoint = createRootCheckpoint(
      f.state,
      [],
      f.record.state.publications.map((x) => ({ ...x, state: 'prepared' }))
    );
    f.engine.execute({
      operation: 'save',
      scope: f.scope,
      expectedRevision: f.record.revision,
      expiresAt: f.state.expiresAt,
      state: checkpoint,
    });
    assert.equal(
      await reauthorizeRecoveryStorage({
        storage: f.engine,
        request: f.request,
        authorized: () => true,
        now: () => 200,
      }),
      null
    );
  } finally {
    await f.close();
  }
});

test('unmatched records must still pass checkpoint and metadata validation', async () => {
  const f = await fixture();
  try {
    for (const mode of ['digest', 'createdAt', 'principal', 'ttl']) {
      const storage = {
        execute(request) {
          const reply = copy(f.engine.execute(request));
          if (request.operation === 'load') {
            if (mode === 'digest') reply.state.digest = '0'.repeat(64);
            else {
              const root = reply.state.root;
              if (mode === 'createdAt') root.createdAt = -1;
              if (mode === 'principal') root.principal = 'invalid principal';
              if (mode === 'ttl') root.createdAt = root.expiresAt - 30 * 60 * 1000 - 1;
              reply.state = createRootCheckpoint(root, [], reply.state.publications);
            }
          }
          return reply;
        },
      };
      await assert.rejects(
        reauthorizeRecoveryStorage({
          storage,
          request: { ...f.request, principal: 'different-owner' },
          authorized: () => true,
          now: () => 200,
        }),
        safe,
        mode
      );
    }
  } finally {
    await f.close();
  }
});

test('two independently observed roots with the same continuation remain ambiguous', async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    assert.notEqual(first.state.rootId, second.state.rootId);
    const entries = [first, second]
      .map((f) => ({
        scope: f.scope,
        revision: f.record.revision,
        createdAt: f.record.createdAt,
        expiresAt: f.record.expiresAt,
      }))
      .sort((a, b) => a.scope.localeCompare(b.scope));
    const storage = {
      execute(request) {
        if (request.operation === 'catalog') return copy(entries);
        assert.equal(request.operation, 'load');
        const f = [first, second].find((item) => item.scope === request.scope);
        assert.ok(f);
        return copy(f.record);
      },
    };
    assert.equal(
      await reauthorizeRecoveryStorage({
        storage,
        request: first.request,
        authorized: () => true,
        now: () => 200,
      }),
      null
    );
    // An unrelated denial must not revoke either committed root.
    assert.ok(first.engine.execute({ operation: 'load', scope: first.scope }));
    assert.ok(second.engine.execute({ operation: 'load', scope: second.scope }));
  } finally {
    await first.close();
    await second.close();
  }
});

test('authorization is checked before and after storage ACKs and remains sticky for restored capabilities', async () => {
  const f = await fixture();
  let restored;
  try {
    let allowed = true;
    restored = await reauthorizeRecoveryStorage({
      storage: f.engine,
      request: f.request,
      authorized: () => allowed,
      now: () => 200,
    });
    allowed = false;
    assert.equal((await restored.session.replyAsync(LIST, {})).ok, false);
    assert.equal(
      restored.session.recovery({ model: 'synthetic', messages: f.request.history }).ok,
      false
    );
    allowed = true;
    assert.equal(
      (
        await restored.session.replyAsync(READ, {
          sourceId: f.receipt.sourceId,
          digest: f.receipt.digest,
        })
      ).ok,
      false
    );
    for (const phase of ['before', 'after']) {
      let calls = 0,
        valid = phase !== 'before';
      const storage = {
        async execute(request) {
          calls++;
          const result = f.engine.execute(request);
          valid = false;
          return result;
        },
      };
      await assert.rejects(
        reauthorizeRecoveryStorage({
          storage,
          request: f.request,
          authorized: () => valid,
          now: () => 200,
        }),
        safe
      );
      assert.equal(calls, phase === 'before' ? 0 : 1);
    }
  } finally {
    await restored?.sessions.shutdownAsync();
    await f.close();
  }
});

test('authorization loss during durable reader save suppresses content and cannot be reversed', async () => {
  const f = await fixture();
  let restored;
  try {
    let allowed = true;
    let interrupt = false;
    let interrupted = 0;
    const storage = {
      async execute(request) {
        const reply = f.engine.execute(request);
        if (interrupt && request.operation === 'save') {
          interrupted++;
          allowed = false;
        }
        return reply;
      },
    };
    restored = await reauthorizeRecoveryStorage({
      storage,
      request: f.request,
      authorized: () => allowed,
      now: () => 200,
    });
    assert.ok(restored);
    interrupt = true;
    const read = await restored.session.replyAsync(READ, {
      sourceId: f.receipt.sourceId,
      digest: f.receipt.digest,
    });
    assert.equal(interrupted, 1);
    assert.equal(read.ok, false);
    assert.equal(JSON.stringify(read).includes(original), false);
    allowed = true;
    assert.equal((await restored.session.replyAsync(LIST, {})).ok, false);
    const record = f.engine.execute({ operation: 'load', scope: f.scope });
    assert.equal(record.state.root.budget.calls, f.state.budget.calls + 1);
    assert.equal(record.expiresAt, f.state.expiresAt);
  } finally {
    await restored?.sessions.shutdownAsync();
    await f.close();
  }
});

test('malformed options, replies, catalogs and failed storage never execute input getters or expose content', async () => {
  const f = await fixture();
  try {
    let executed = 0;
    const base = { storage: f.engine, request: f.request, authorized: () => true, now: () => 200 };
    for (const options of [
      null,
      [],
      { ...base, extra: true },
      { ...base, authorized: null },
      { ...base, now: 1 },
      { ...base, request: { ...f.request, rootId: f.state.rootId } },
      {
        ...base,
        get request() {
          executed++;
          return f.request;
        },
      },
      {
        ...base,
        storage: {
          get execute() {
            executed++;
            return () => {};
          },
        },
      },
    ])
      await assert.rejects(reauthorizeRecoveryStorage(options), safe);
    for (const reply of [
      null,
      {},
      [{ scope: f.scope }],
      {
        get then() {
          executed++;
          return () => {};
        },
      },
    ])
      await assert.rejects(
        reauthorizeRecoveryStorage({ ...base, storage: { execute: () => reply } }),
        safe
      );
    await assert.rejects(
      reauthorizeRecoveryStorage({
        ...base,
        authorized: () => Promise.reject(new Error('PRIVATE_DATA')),
      }),
      safe
    );
    await assert.rejects(
      reauthorizeRecoveryStorage({
        ...base,
        storage: {
          execute() {
            throw new Error('PRIVATE_DATA');
          },
        },
      }),
      safe
    );
    assert.equal(executed, 0);
  } finally {
    await f.close();
  }
});

test('changed catalog generations and malformed or rolled-back loads cannot create a capability', async () => {
  const f = await fixture();
  try {
    for (const mode of ['catalog', 'revision', 'createdAt', 'scope', 'missing']) {
      let catalogs = 0;
      const storage = {
        execute(request) {
          const reply = copy(f.engine.execute(request));
          if (request.operation === 'catalog' && ++catalogs === 2 && mode === 'catalog') return [];
          if (request.operation === 'load') {
            if (mode === 'missing') return null;
            if (mode === 'scope') reply.state.root.rootId = 'hbs_' + 'a'.repeat(32);
            if (['revision', 'createdAt'].includes(mode)) reply[mode]--;
          }
          return reply;
        },
      };
      await assert.rejects(
        reauthorizeRecoveryStorage({
          storage,
          request: f.request,
          authorized: () => true,
          now: () => 200,
        }),
        safe
      );
    }
  } finally {
    await f.close();
  }
});

test(
  'real encrypted worker reopen reconstructs only current authorized continuation and retains exact TTL and reader debits',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-reauthorization-'));
    let storage, f, restored;
    const mark = createLongRecoveryProgress((line) => process.stderr.write(line));
    try {
      const store = path.join(directory, 'store');
      mark('store_open_started');
      storage = await openContextRecoveryStorage({ directory: store });
      mark('store_open_finished');
      mark('seed_started');
      f = await fixture({ storage });
      mark('seed_finished');
      mark('shutdown_started');
      await f.sessions.shutdownAsync();
      mark('shutdown_finished');
      mark('store_close_started');
      await storage.close();
      mark('store_close_finished');
      storage = undefined;
      assert.equal(
        fs.readFileSync(path.join(store, 'checkpoint.sqlite')).includes(Buffer.from(original)),
        false
      );
      mark('store_reopen_started');
      storage = await openContextRecoveryStorage({ directory: store });
      mark('store_reopen_finished');
      mark('reauthorize_started');
      restored = await reauthorizeRecoveryStorage({
        storage,
        request: f.request,
        authorized: () => true,
      });
      mark('reauthorize_finished');
      assert.ok(restored);
      mark('read_started');
      const result = await restored.session.replyAsync(READ, {
        sourceId: f.receipt.sourceId,
        digest: f.receipt.digest,
      });
      mark('read_finished');
      assert.equal(JSON.parse(result.text).page.text, original);
      mark('record_load_started');
      const record = await storage.execute({ operation: 'load', scope: f.scope });
      mark('record_load_finished');
      assert.equal(record.expiresAt, f.state.expiresAt);
      assert.equal(record.state.root.budget.calls, f.state.budget.calls + 1);
      assert.equal(record.state.root.budget.successfulReads, f.state.budget.successfulReads + 1);
    } finally {
      mark('shutdown_started');
      await restored?.sessions.shutdownAsync();
      await f?.sessions.shutdownAsync();
      mark('shutdown_finished');
      mark('store_close_started');
      await storage?.close();
      mark('store_close_finished');
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.ok(path.basename(target).startsWith('hpm-reauthorization-'));
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
);
