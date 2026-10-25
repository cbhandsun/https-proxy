'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const { createContextRecoveryRuntime } = require('../lib/proxy/context-recovery-runtime');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const {
  createContextRecoverySessions,
  attachContextRecoveryStorage,
  exportContextRecoveryRoot,
  acquireContextRecoveryRoot,
  adoptContextRecoveryRoots,
} = require('../lib/proxy/context-recovery-sessions');
const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
const {
  declareRecoveryScan,
  declareRecoveryReferenceScan,
  declareRecoveryReferenceStates,
  declareRecoverySourcePages,
  declareRecoveryReaderSettlement,
} = require('../lib/proxy/context-recovery-storage-contract');
const { discoverRecoveryStorage } = require('../lib/proxy/context-recovery-storage-discovery');
const { loadDurableRecoveryRoot } = require('./helpers/recovery-durable-state.cjs');
const {
  parseLongRecoveryProgress,
  createLongRecoveryProgress,
} = require('./helpers/recovery-long-progress.cjs');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');

const user = (content) => ({ role: 'user', content });
const original = '新建合成原文\r\nélève🙂';
const failed = (reply) => {
  assert.deepEqual(reply, { ok: false, code: 'context_recovery_storage_unavailable' });
};

test('root loading enables digest reuse only on its authorized immutable request before probing', async () => {
  const { createRecoveryRootLoading } = require('../lib/proxy/context-recovery-root-loading');
  const { isReusableRecoveryHistory } = require('../lib/proxy/context-recovery-history-request');
  const raw = { principal: 'owner', protocol: 'chat', target: 'target', history: [user('q')] };
  let captured,
    probes = 0,
    begins = 0;
  const loader = createRecoveryRootLoading({
    capture: () => () => 100,
    probe(input) {
      probes++;
      captured = input;
      assert.notEqual(input, raw);
      assert.equal(Object.isFrozen(input.history[0]), true);
      assert.equal(isReusableRecoveryHistory(input.history), true);
      return { ok: true };
    },
    execute: () => null,
    begin(input) {
      begins++;
      assert.equal(input, captured);
      assert.equal(isReusableRecoveryHistory(input.history), true);
      return { ok: true };
    },
  });
  assert.deepEqual(await loader.begin(raw, [], () => true, false), { ok: true });
  assert.equal(isReusableRecoveryHistory(raw.history), false);
  assert.equal(probes, 1);
  assert.equal(begins, 1);
  for (const authorize of [
    () => false,
    () => {
      throw Error('private');
    },
  ])
    failed(await loader.begin(raw, [], authorize, false));
  failed(await loader.begin(raw, [{ invalid: true }], () => true, false));
  assert.equal(probes, 1);
  assert.equal(begins, 1);
  await loader.drain();
});

test('async owner admission accepts bounded long history without changing per-item or policy limits', async (t) => {
  const sessions = createContextRecoverySessions();
  sessions.configure(true);
  t.after(() => sessions.shutdownAsync());
  const request = {
    principal: 'owner',
    protocol: 'responses',
    target: 'target',
    history: Array.from({ length: 3 }, () => ({ role: 'user', content: 'x'.repeat(900000) })),
  };
  const session = await sessions.beginAsync(request, [], () => true);
  assert.equal(session.ok, true);
  assert.equal(session.historyFormat, 3);
  session.abort();
  for (const input of [
    { ...request, history: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] },
    { ...request, policy: { instructions: 'x'.repeat(2 * 1024 * 1024) } },
    {
      ...request,
      history: Array.from({ length: 34 }, () => ({
        role: 'user',
        content: 'x'.repeat(1024 * 1024),
      })),
    },
  ])
    failed(await sessions.beginAsync(input, [], () => true));
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function store(databaseFile = ':memory:', now = () => 100) {
  const database = new DatabaseSync(databaseFile);
  const engine = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now,
  });
  return {
    engine,
    database,
    close() {
      engine.close();
      database.close();
    },
  };
}
async function seed(engine, question = 'question', policy, now = () => 100) {
  const sessions = createContextRecoverySessions({ now });
  sessions.configure(true);
  attachContextRecoveryStorage(sessions, engine);
  const binding = {
    principal: 'owner',
    protocol: 'chat',
    target: 'target',
    ...(policy === undefined ? {} : { policy }),
  };
  const history = [user(question)];
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
        [{ callId: 'external', toolName: 'lookup', arguments: {}, output: '', completed: true }]
      )
    ).ok,
    true
  );
  const captured = [
    ...history,
    external,
    { role: 'tool', tool_call_id: 'external', content: original },
  ];
  const child = sessions.begin({ ...binding, history: captured }, [
    { callId: 'external', output: original },
  ]);
  const index = JSON.parse((await child.replyAsync(LIST, {})).text);
  const output = [{ role: 'assistant', content: 'done' }];
  assert.equal((await child.completeObservedAsync(output)).ok, true);
  const state = await loadDurableRecoveryRoot(engine, root.snapshotId);
  await sessions.shutdownAsync();
  return {
    request: { ...binding, history: [...captured, ...output, user('continue')] },
    state,
    receipt: index.sources[0],
  };
}
function target(storage, now = () => 100) {
  const sessions = createContextRecoverySessions({ now });
  sessions.configure(true);
  if (storage) attachContextRecoveryStorage(sessions, storage);
  return sessions;
}

function metadata(sessions, rootId, capability) {
  const owner = acquireContextRecoveryRoot(sessions, rootId);
  try {
    return owner.metadata(capability).metadata;
  } finally {
    owner.release();
  }
}

function referenceAdapter(execute, omitted) {
  for (const declare of [
    declareRecoveryScan,
    declareRecoveryReferenceScan,
    declareRecoveryReferenceStates,
    declareRecoverySourcePages,
    declareRecoveryReaderSettlement,
  ])
    if (declare !== omitted) declare(execute);
  return { execute };
}

test('independent processes reopen encrypted long histories and recover exact evidence without renewing expiry', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-long-cold-'));
  const databasePath = path.join(directory, 'checkpoint.sqlite');
  const dataKey = randomBytes(32).toString('base64');
  try {
    const reports = [];
    for (const phase of ['seed', 'resume']) {
      const child = spawnSync(
        process.execPath,
        [path.join(__dirname, 'helpers/recovery-long-process.cjs')],
        {
          input: JSON.stringify({ databasePath, dataKey, phase }),
          encoding: 'utf8',
          timeout: 20000,
          windowsHide: true,
          maxBuffer: 65536,
        }
      );
      t.diagnostic(
        JSON.stringify({
          longHistoryPhase: phase,
          progress: parseLongRecoveryProgress(child.stderr),
        })
      );
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, 'isolated long-history recovery failed');
      const report = JSON.parse(child.stdout);
      assert.equal(report.ok, true);
      assert.equal(report.exact, true);
      assert.equal(report.historyFormat, 3);
      assert.ok(report.historyBytes > 2 * 1024 * 1024);
      assert.equal(child.stdout.includes(dataKey), false);
      reports.push(report);
    }
    assert.equal(reports[0].expiresAt, reports[1].expiresAt);
    const persisted = fs.readFileSync(databasePath);
    assert.equal(persisted.includes(Buffer.from('encrypted-process-original')), false);
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.equal(path.basename(resolved).startsWith('hpm-long-cold-'), true);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('cold admission scans metadata without payload hydration and continues exact reads and publication', async () => {
  const disk = store();
  const f = await seed(disk.engine);
  await seed(disk.engine, 'unrelated');
  const operations = [],
    queries = [];
  const prepare = disk.database.prepare.bind(disk.database);
  disk.database.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  const sessions = target(
    referenceAdapter((command) => {
      operations.push(command.operation);
      return disk.engine.execute(command);
    })
  );
  try {
    const result = await sessions.beginAsync(f.request, [], () => true);
    assert.equal(result.ok, true);
    assert.deepEqual(operations, ['scan-reference', 'scan-reference']);
    assert.equal(
      queries.some((sql) => sql.startsWith('SELECT * FROM recovery_blob')),
      false
    );
    assert.throws(() => exportContextRecoveryRoot(sessions, f.state.rootId));
    const root = metadata(sessions, f.state.rootId, result);
    assert.equal(root.kind, 'recovery-root-metadata');
    assert.equal(
      root.ledger.sources.some((source) => Object.hasOwn(source, 'output')),
      false
    );
    assert.deepEqual(root.budget, f.state.budget);
    assert.equal(root.expiresAt, f.state.expiresAt);
    queries.length = 0;
    const reply = await result.replyAsync(READ, {
      sourceId: f.receipt.sourceId,
      digest: f.receipt.digest,
    });
    assert.equal(reply.ok, true);
    assert.equal(JSON.parse(reply.text).page.text, original);
    assert.equal(operations.includes('load'), false);
    assert.deepEqual(
      queries.filter((sql) => sql.startsWith('SELECT * FROM recovery_blob')),
      Array(2).fill('SELECT * FROM recovery_blob WHERE scope=? AND blob_id=?')
    );
    assert.equal(
      (await result.completeObservedAsync([{ role: 'assistant', content: 'continued' }])).ok,
      true
    );
    assert.equal(operations.includes('save'), false);
    assert.equal(operations.includes('save-reference-state'), true);
  } finally {
    await sessions.shutdownAsync();
    disk.close();
  }
});

test('cold continuation after interrupted publication retains quarantined sources and can persist again', async () => {
  for (const state of ['prepared', 'sending', 'uncertain', 'withdrawn']) {
    const disk = store();
    const f = await seed(disk.engine);
    const scope = createHash('sha256')
      .update('hpm/recovery-root/v1\0' + f.state.rootId)
      .digest('hex');
    const previous = disk.engine.execute({ operation: 'load', scope });
    const checkpoint = createRootCheckpoint(
      previous.state.root,
      previous.state.stagedSources,
      previous.state.publications.map((entry) => ({
        ...entry,
        state: entry.snapshotId === f.state.rootId ? 'transport-finished' : state,
      }))
    );
    disk.engine.execute({
      operation: 'save',
      scope,
      expectedRevision: previous.revision,
      expiresAt: f.state.expiresAt,
      state: checkpoint,
    });
    const operations = [];
    const sessions = target(
      referenceAdapter((command) => {
        operations.push(command.operation);
        return disk.engine.execute(command);
      })
    );
    try {
      const result = await sessions.beginAsync(
        { ...f.request, history: [...f.request.history.slice(0, 2), user('retry')] },
        [],
        () => true
      );
      assert.equal(result.ok, true, state);
      const listed = await result.replyAsync(LIST, {});
      assert.equal(listed.ok, true, state);
      assert.deepEqual(JSON.parse(listed.text).sources, []);
      const denied = await result.replyAsync(READ, {
        sourceId: f.receipt.sourceId,
        digest: f.receipt.digest,
      });
      assert.equal(denied.ok, false);
      assert.equal(operations.includes('read-source'), false);
      assert.equal(
        (await result.completeObservedAsync([{ role: 'assistant', content: 'retried' }])).ok,
        true,
        state
      );
      const saved = disk.engine.execute({ operation: 'load', scope });
      assert.deepEqual(saved.state.root.ledger.sources, []);
      assert.deepEqual(saved.state.stagedSources, previous.state.root.ledger.sources);
      assert.equal(saved.expiresAt, previous.expiresAt);
      assert.equal(saved.state.root.callCount, previous.state.root.callCount);
      assert.equal(saved.state.root.ledger.capturedCount, previous.state.root.ledger.capturedCount);
      assert.ok(saved.revision > previous.revision + 1);
      assert.equal(operations.includes('load'), false);
      assert.equal(operations.includes('save-reference-state'), true);
      await sessions.shutdownAsync();
      const reopened = target(referenceAdapter((command) => disk.engine.execute(command)));
      try {
        const resumed = await reopened.beginAsync(
          {
            ...f.request,
            history: [
              ...f.request.history.slice(0, 2),
              user('retry'),
              { role: 'assistant', content: 'retried' },
              user('again'),
            ],
          },
          [],
          () => true
        );
        assert.equal(resumed.ok, true);
        assert.equal(resumed.reason, 'observed_continuation');
        const next = await resumed.replyAsync(LIST, {});
        assert.equal(next.ok, true);
        assert.deepEqual(JSON.parse(next.text).sources, []);
        assert.equal(
          (await resumed.completeObservedAsync([{ role: 'assistant', content: 'again' }])).ok,
          true
        );
        assert.deepEqual(
          disk.engine.execute({ operation: 'load', scope }).state.stagedSources,
          previous.state.root.ledger.sources
        );
      } finally {
        await reopened.shutdownAsync();
      }
    } finally {
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test(
  'encrypted worker reopen continues writing after an uncertain publication without exposing its source',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-root-loading-'));
    let storage, sessions;
    const mark = createLongRecoveryProgress((line) => process.stderr.write(line));
    try {
      mark('store_open_started');
      storage = await openContextRecoveryStorage({ directory });
      mark('store_open_finished');
      mark('seed_started');
      const f = await seed(storage, 'question', undefined, Date.now);
      mark('seed_finished');
      const scope = createHash('sha256')
        .update('hpm/recovery-root/v1\0' + f.state.rootId)
        .digest('hex');
      mark('record_load_started');
      const previous = await storage.execute({ operation: 'load', scope });
      mark('record_load_finished');
      mark('uncertain_save_started');
      await storage.execute({
        operation: 'save',
        scope,
        expectedRevision: previous.revision,
        expiresAt: previous.expiresAt,
        state: createRootCheckpoint(
          previous.state.root,
          previous.state.stagedSources,
          previous.state.publications.map((entry) => ({
            ...entry,
            state: entry.snapshotId === f.state.rootId ? 'transport-finished' : 'uncertain',
          }))
        ),
      });
      mark('uncertain_save_finished');
      mark('store_close_started');
      await storage.close();
      mark('store_close_finished');
      mark('store_reopen_started');
      storage = await openContextRecoveryStorage({ directory });
      mark('store_reopen_finished');
      sessions = target(storage, Date.now);
      mark('continuation_begin_started');
      const result = await sessions.beginAsync(
        { ...f.request, history: [...f.request.history.slice(0, 2), user('retry')] },
        [],
        () => true
      );
      mark('continuation_begin_finished');
      assert.equal(result.ok, true);
      mark('list_started');
      const listed = await result.replyAsync(LIST, {});
      mark('list_finished');
      assert.equal(listed.ok, true);
      assert.deepEqual(JSON.parse(listed.text).sources, []);
      mark('read_started');
      assert.equal(
        (await result.replyAsync(READ, { sourceId: f.receipt.sourceId, digest: f.receipt.digest }))
          .ok,
        false
      );
      mark('read_finished');
      mark('complete_started');
      assert.equal(
        (await result.completeObservedAsync([{ role: 'assistant', content: 'retried' }])).ok,
        true
      );
      mark('complete_finished');
      mark('record_load_started');
      const saved = await storage.execute({ operation: 'load', scope });
      mark('record_load_finished');
      assert.deepEqual(saved.state.root.ledger.sources, []);
      assert.deepEqual(saved.state.stagedSources, previous.state.root.ledger.sources);
      assert.equal(saved.expiresAt, previous.expiresAt);
      assert.equal(
        fs.readFileSync(path.join(directory, 'checkpoint.sqlite')).includes(Buffer.from(original)),
        false
      );
    } finally {
      mark('shutdown_started');
      await sessions?.shutdownAsync();
      mark('shutdown_finished');
      mark('store_close_started');
      await storage?.close();
      mark('store_close_finished');
      const targetPath = path.resolve(directory);
      assert.equal(path.dirname(targetPath), path.resolve(os.tmpdir()));
      assert.ok(path.basename(targetPath).startsWith('hpm-root-loading-'));
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  }
);

test('cold loading requires every explicit persistence capability and never infers support', async () => {
  for (const omitted of [
    declareRecoveryReferenceScan,
    declareRecoveryReferenceStates,
    declareRecoverySourcePages,
    declareRecoveryReaderSettlement,
  ]) {
    const disk = store();
    const f = await seed(disk.engine);
    const calls = [];
    const sessions = target(
      referenceAdapter((command) => {
        calls.push(command.operation);
        return disk.engine.execute(command);
      }, omitted)
    );
    try {
      const result = await sessions.beginAsync(f.request, [], () => true);
      assert.equal(result.ok, true);
      assert.deepEqual(calls, ['scan']);
      assert.equal(
        exportContextRecoveryRoot(sessions, f.state.rootId).ledger.sources[0].output,
        original
      );
    } finally {
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test('empty and four-root cold catalogs stay bounded and adopt only the selected request', async () => {
  for (const count of [0, 4]) {
    const disk = store();
    let f;
    for (let i = 0; i < count; i++) f = await seed(disk.engine, 'question-' + i);
    const calls = [];
    const sessions = target(
      referenceAdapter((command) => {
        calls.push(command.operation);
        return disk.engine.execute(command);
      })
    );
    try {
      const result = await sessions.beginAsync(
        f?.request ?? {
          principal: 'owner',
          protocol: 'chat',
          target: 'target',
          history: [user('new')],
        },
        [],
        () => true
      );
      assert.equal(result.ok, true);
      assert.deepEqual(calls, Array(Math.max(1, count)).fill('scan-reference'));
      assert.equal(sessions.inspect().roots, 1);
      assert.equal(result.inspect().visibleSources, count ? 1 : 0);
    } finally {
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test('cold metadata admission does not authenticate payload bytes; selected corrupt reads fail closed', async () => {
  const disk = store();
  const good = await seed(disk.engine, 'good');
  const bad = await seed(disk.engine, 'bad');
  const entry = disk.engine.execute({ operation: 'scan-reference', after: null });
  const catalog = entry.catalog;
  const badScope = catalog.find((item) => {
    const record = disk.engine.execute({ operation: 'load-reference', scope: item.scope });
    return record.reference.metadata.rootId === bad.state.rootId;
  }).scope;
  disk.database
    .prepare('UPDATE recovery_blob SET envelope=zeroblob(length(envelope)) WHERE scope=?')
    .run(badScope);
  const sessions = target(disk.engine);
  try {
    const selected = await sessions.beginAsync(good.request, [], () => true);
    assert.equal(selected.ok, true);
    const read = await selected.replyAsync(READ, {
      sourceId: good.receipt.sourceId,
      digest: good.receipt.digest,
    });
    assert.equal(read.ok, true);
    assert.equal(JSON.parse(read.text).page.text, original);
    const corrupted = await sessions.beginAsync(bad.request, [], () => true);
    assert.equal(corrupted.ok, true);
    assert.equal(
      (
        await corrupted.replyAsync(READ, {
          sourceId: bad.receipt.sourceId,
          digest: bad.receipt.digest,
        })
      ).ok,
      false
    );
    assert.equal((await corrupted.replyAsync(LIST, {})).ok, false);
  } finally {
    await sessions.shutdownAsync();
    disk.close();
  }
});

test('declared cold scan errors and unsafe replies stop admission without legacy retry', async () => {
  for (const mode of ['throw', 'digest', 'revision', 'scope', 'getter', 'generation']) {
    const disk = store();
    const f = await seed(disk.engine);
    await seed(disk.engine, 'unrelated');
    const calls = [];
    let effects = 0;
    const sessions = target(
      referenceAdapter((command) => {
        calls.push(command.operation);
        const page = disk.engine.execute(command);
        if (command.operation !== 'scan-reference') return page;
        if (mode === 'throw') throw new Error('private failure');
        if (mode === 'digest') page.record.reference.digest = '0'.repeat(64);
        if (mode === 'revision') page.record.revision++;
        if (mode === 'scope') page.scope = '0'.repeat(64);
        if (mode === 'getter')
          return {
            get catalog() {
              effects++;
              return page.catalog;
            },
          };
        if (mode === 'generation' && calls.length === 2) page.catalog[0].revision++;
        return page;
      })
    );
    try {
      failed(await sessions.beginAsync(f.request, [], () => true));
      assert.equal(sessions.inspect().roots, 0);
      assert.ok(calls.length >= 1 && calls.length <= 2);
      assert.ok(calls.every((operation) => operation === 'scan-reference'));
      assert.equal(effects, 0);
    } finally {
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test('cold scan ACK cannot restore authority after request denial, revoke, disable, shutdown or expiry', async () => {
  for (const mode of ['authorization', 'revoke', 'disable', 'shutdown', 'expiry']) {
    const disk = store();
    const f = await seed(disk.engine);
    const entered = deferred(),
      resume = deferred();
    const calls = [];
    let allowed = true,
      time = 100,
      first = true,
      shutdown;
    const sessions = target(
      referenceAdapter(async (command) => {
        calls.push(command.operation);
        const result = disk.engine.execute(command);
        if (command.operation === 'scan-reference' && first) {
          first = false;
          entered.resolve();
          await resume.promise;
        }
        return result;
      }),
      () => time
    );
    try {
      const pending = sessions.beginAsync(f.request, [], () => allowed);
      await entered.promise;
      if (mode === 'authorization') allowed = false;
      if (mode === 'revoke') sessions.revoke('owner');
      if (mode === 'disable') sessions.configure(false);
      if (mode === 'shutdown') shutdown = sessions.shutdownAsync();
      if (mode === 'expiry') time = f.state.expiresAt;
      resume.resolve();
      const result = await pending;
      if (mode === 'expiry') {
        assert.equal(result.ok, true);
        assert.equal(result.reason, 'isolated_request');
        assert.equal(result.inspect().visibleSources, 0);
      } else {
        failed(result);
        assert.equal(sessions.inspect().roots, 0);
      }
      await shutdown;
      assert.deepEqual(
        calls,
        mode === 'disable' ? ['scan-reference', 'revoke-all'] : ['scan-reference']
      );
    } finally {
      resume.resolve();
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test('explicit scan capability reduces empty, single and four-root admissions to bounded page calls', async () => {
  for (const count of [0, 1, 4]) {
    const disk = store();
    let first;
    for (let i = 0; i < count; i++) {
      const seeded = await seed(disk.engine, 'question-' + i);
      first ??= seeded;
    }
    const calls = [];
    const storage = {
      execute: declareRecoveryScan(function (command) {
        calls.push(command.operation);
        return disk.engine.execute(command);
      }),
    };
    const sessions = target(storage);
    try {
      const result = await sessions.beginAsync(
        first?.request ?? {
          principal: 'owner',
          protocol: 'chat',
          target: 'target',
          history: [user('new')],
        },
        [],
        () => true
      );
      assert.equal(result.ok, true);
      assert.deepEqual(calls, Array(Math.max(1, count)).fill('scan'));
      if (first) {
        const reply = await result.replyAsync(READ, {
          sourceId: first.receipt.sourceId,
          digest: first.receipt.digest,
        });
        assert.equal(JSON.parse(reply.text).page.text, original);
      }
    } finally {
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test('startup discovery uses the declared scan and validates every root before returning its denial index', async () => {
  const disk = store();
  const f = await seed(disk.engine);
  const other = await seed(disk.engine, 'unrelated');
  const calls = [];
  const storage = {
    execute: declareRecoveryScan(function (command) {
      calls.push(command.operation);
      return disk.engine.execute(command);
    }),
  };
  try {
    const roots = await discoverRecoveryStorage(storage);
    assert.deepEqual(calls, ['scan', 'scan']);
    assert.deepEqual(
      roots.map((item) => item.rootId).sort(),
      [f.state.rootId, other.state.rootId].sort()
    );
    assert.ok(
      roots.every(
        (item) => Object.keys(item).sort().join(',') === 'createdAt,expiresAt,principal,rootId'
      )
    );
  } finally {
    disk.close();
  }
});

test('scan failures, changed generations and malformed unrelated records never import or retry legacy reads', async () => {
  for (const mode of ['error', 'thenable', 'record', 'generation', 'skip', 'empty']) {
    const disk = store();
    const f = await seed(disk.engine);
    await seed(disk.engine, 'unrelated');
    const calls = [];
    let effects = 0;
    const storage = {
      execute: declareRecoveryScan(function (command) {
        calls.push(command.operation);
        const result = disk.engine.execute(command);
        if (command.operation !== 'scan') return result;
        if (mode === 'error') throw new Error('private failure');
        if (mode === 'thenable')
          return {
            then() {
              effects++;
            },
          };
        if (mode === 'empty') return { catalog: result.catalog, scope: null, record: null };
        if (mode === 'skip') return { ...result, scope: result.catalog.at(-1).scope };
        if (mode === 'record' && calls.length === 2) result.record.state.root.principal = 'other';
        if (mode === 'generation' && calls.length === 2) {
          result.catalog[0].revision++;
          if (result.scope === result.catalog[0].scope) result.record.revision++;
        }
        return result;
      }),
    };
    const sessions = target(storage);
    try {
      failed(await sessions.beginAsync(f.request, [], () => true));
      assert.equal(sessions.inspect().roots, 0);
      assert.ok(calls.length >= 1 && calls.length <= 2);
      assert.ok(calls.every((operation) => operation === 'scan'));
      assert.equal(effects, 0);
    } finally {
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test('authorization loss while a scan page is pending prevents both adoption and subsequent pages', async () => {
  const disk = store();
  const f = await seed(disk.engine);
  await seed(disk.engine, 'unrelated');
  const entered = deferred(),
    release = deferred();
  const calls = [];
  let authorized = true;
  const storage = {
    execute: declareRecoveryScan(async function (command) {
      calls.push(command.operation);
      const result = disk.engine.execute(command);
      if (command.operation === 'scan') {
        entered.resolve();
        await release.promise;
      }
      return result;
    }),
  };
  const sessions = target(storage);
  try {
    const result = sessions.beginAsync(f.request, [], () => authorized);
    await entered.promise;
    authorized = false;
    release.resolve();
    failed(await result);
    assert.deepEqual(calls, ['scan']);
    assert.equal(sessions.inspect().roots, 0);
  } finally {
    release.resolve();
    await sessions.shutdownAsync();
    disk.close();
  }
});

test('a corrupt tombstone found on the final scan page prevents startup enrollment and request adoption', async () => {
  for (const mode of ['discovery', 'admission']) {
    const disk = store();
    const f = await seed(disk.engine);
    await seed(disk.engine, 'unrelated');
    const terminalScope = 'f'.repeat(64);
    disk.engine.execute({
      operation: 'save',
      scope: terminalScope,
      expectedRevision: 0,
      expiresAt: 1000,
      state: {},
    });
    disk.engine.execute({ operation: 'revoke', scope: terminalScope, expectedRevision: 1 });
    const calls = [];
    const storage = {
      execute: declareRecoveryScan(function (command) {
        calls.push(command.operation);
        const result = disk.engine.execute(command);
        if (command.operation === 'scan' && calls.length === 1) {
          const envelope = disk.database
            .prepare('SELECT envelope FROM recovery_state WHERE scope=?')
            .get(terminalScope).envelope;
          const corrupt = Buffer.from(envelope);
          corrupt[corrupt.length - 1] ^= 1;
          disk.database
            .prepare('UPDATE recovery_state SET envelope=? WHERE scope=?')
            .run(corrupt, terminalScope);
        }
        return result;
      }),
    };
    const sessions = target(storage);
    try {
      if (mode === 'discovery')
        await assert.rejects(discoverRecoveryStorage(storage), {
          code: 'context_recovery_storage_unavailable',
        });
      else failed(await sessions.beginAsync(f.request, [], () => true));
      assert.deepEqual(calls, ['scan', 'scan']);
      assert.equal(sessions.inspect().roots, 0);
    } finally {
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test('async owner loads only the selected offline root; live/pending capabilities and exact bytes survive', async () => {
  const disk = store();
  const f = await seed(disk.engine);
  const unrelated = await seed(disk.engine, 'unrelated');
  const sessions = target(disk.engine);
  try {
    const pending = sessions.begin({ ...f.request, history: [user('online')] });
    const result = await sessions.beginAsync(f.request, [], () => true);
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'observed_continuation');
    assert.equal(sessions.inspect().roots, 2);
    assert.throws(() => exportContextRecoveryRoot(sessions, unrelated.state.rootId));
    assert.throws(() => exportContextRecoveryRoot(sessions, f.state.rootId));
    const restored = metadata(sessions, f.state.rootId, result);
    assert.deepEqual(restored.budget, f.state.budget);
    assert.equal(restored.expiresAt, f.state.expiresAt);
    assert.equal(
      (await result.replyAsync(READ, { sourceId: f.receipt.sourceId, digest: f.receipt.digest }))
        .ok,
      true
    );
    const read = await result.replyAsync(READ, {
      sourceId: f.receipt.sourceId,
      digest: f.receipt.digest,
    });
    assert.equal(JSON.parse(read.text).page.text, original);
    assert.equal(
      (await pending.completeObservedAsync([{ role: 'assistant', content: 'online done' }])).ok,
      true
    );
  } finally {
    await sessions.shutdownAsync();
    disk.close();
  }
});

test('offline/offline and online/offline ambiguity never falls back to an online-only continuation', async () => {
  const disk = store();
  const f = await seed(disk.engine);
  await seed(disk.engine);
  const sessions = target(disk.engine);
  try {
    const result = await sessions.beginAsync(f.request, [], () => true);
    assert.deepEqual(result, { ok: false, code: 'context_recovery_ambiguous' });
    assert.equal(sessions.inspect().roots, 0);
    adoptContextRecoveryRoots(sessions, [{ binding: f.request, state: f.state }]);
    assert.deepEqual(await sessions.beginAsync(f.request, [], () => true), {
      ok: false,
      code: 'context_recovery_ambiguous',
    });
    assert.equal(sessions.inspect().roots, 1);
  } finally {
    await sessions.shutdownAsync();
    disk.close();
  }
});

test('same-owner concurrent loads serialize and reuse one root without resetting its shared budget', async () => {
  const disk = store();
  const f = await seed(disk.engine);
  const sessions = target(disk.engine);
  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => sessions.beginAsync(f.request, [], () => true))
    );
    assert.equal(
      results.every((x) => x.ok),
      true
    );
    assert.equal(sessions.inspect().roots, 1);
    assert.deepEqual(metadata(sessions, f.state.rootId, results[0]).budget, f.state.budget);
    await results[0].replyAsync(LIST, {});
    assert.equal(
      metadata(sessions, f.state.rootId, results[0]).budget.calls,
      f.state.budget.calls + 1
    );
  } finally {
    await sessions.shutdownAsync();
    disk.close();
  }
});

test('request denial stays local and sticky after return; it never becomes the shared session clock', async () => {
  const disk = store();
  const f = await seed(disk.engine);
  const sessions = target(disk.engine);
  let allowed = true;
  try {
    const first = await sessions.beginAsync(f.request, [], () => allowed);
    const other = await sessions.beginAsync(f.request, [], () => true);
    assert.equal(first.ok && other.ok, true);
    allowed = false;
    assert.equal((await first.replyAsync(LIST, {})).ok, false);
    allowed = true;
    assert.equal((await first.replyAsync(LIST, {})).ok, false);
    assert.equal((await other.replyAsync(LIST, {})).ok, true);
    assert.equal(sessions.inspect().enabled, true);
  } finally {
    await sessions.shutdownAsync();
    disk.close();
  }
});

test('revoke or disable during a load ACK blocks adoption; shutdown waits for in-flight loading', async () => {
  for (const operation of ['revoke', 'configure', 'shutdown']) {
    const disk = store();
    const f = await seed(disk.engine);
    const entered = deferred(),
      resume = deferred();
    let first = true;
    const sessions = target({
      async execute(command) {
        const reply = disk.engine.execute(command);
        if (command.operation === 'load' && first) {
          first = false;
          entered.resolve();
          await resume.promise;
        }
        return reply;
      },
    });
    try {
      const pending = sessions.beginAsync(f.request, [], () => true);
      await entered.promise;
      let shutdown,
        drained = false;
      if (operation === 'revoke') sessions.revoke('owner');
      else if (operation === 'configure') sessions.configure(false);
      else
        shutdown = sessions.shutdownAsync().then(() => {
          drained = true;
        });
      await Promise.resolve();
      assert.equal(drained, false);
      resume.resolve();
      failed(await pending);
      await shutdown;
      assert.equal(sessions.inspect().roots, 0);
    } finally {
      resume.resolve();
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test('loading queue is bounded, captures input snapshots, and rejects async authorization without executing thenables', async () => {
  const disk = store();
  const f = await seed(disk.engine);
  const entered = deferred(),
    resume = deferred();
  let first = true,
    ran = 0;
  const sessions = target({
    async execute(command) {
      const result = disk.engine.execute(command);
      if (first) {
        first = false;
        entered.resolve();
        await resume.promise;
      }
      return result;
    },
  });
  try {
    failed(await sessions.beginAsync(f.request, [], () => Promise.reject(new Error('private'))));
    failed(
      await sessions.beginAsync(f.request, [], () => ({
        get then() {
          ran++;
          return () => {};
        },
      }))
    );
    const input = globalThis.structuredClone(f.request);
    const jobs = [sessions.beginAsync(input, [], () => true)];
    input.principal = 'different';
    await entered.promise;
    for (let i = 1; i < 8; i++) jobs.push(sessions.beginAsync(f.request, [], () => true));
    assert.deepEqual(await sessions.beginAsync(f.request, [], () => true), {
      ok: false,
      code: 'context_recovery_busy',
    });
    resume.resolve();
    assert.equal(
      (await Promise.all(jobs)).every((result) => result.ok),
      true
    );
    assert.equal(ran, 0);
  } finally {
    resume.resolve();
    await sessions.shutdownAsync();
    disk.close();
  }
});

test('malformed input and results do not invoke getters or perform storage I/O', async () => {
  let calls = 0,
    ran = 0;
  const sessions = target({
    execute() {
      calls++;
      throw new Error('private');
    },
  });
  const request = {
    principal: 'owner',
    protocol: 'chat',
    target: 'target',
    history: [user('question')],
  };
  try {
    const getter = {
      get history() {
        ran++;
        return [];
      },
    };
    for (const input of [
      null,
      [],
      {},
      getter,
      { ...request, principal: '' },
      { ...request, history: [] },
    ]) {
      // Empty history is valid, but storage is deliberately unavailable.
      failed(await sessions.beginAsync(input, [], () => true));
    }
    const before = calls;
    for (const results of [
      null,
      {},
      new Array(129),
      [{ callId: 'bad id', output: '' }],
      [{ callId: 'ok' }],
    ])
      failed(await sessions.beginAsync(request, results, () => true));
    assert.equal(calls, before);
    assert.equal(ran, 0);
    assert.equal(sessions.inspect().roots, 0);
  } finally {
    await sessions.shutdownAsync();
  }
});

test('corrupt mismatched records and catalog changes reject safely without importing any root', async () => {
  for (const changed of ['record', 'catalog', 'error', 'thenable']) {
    const disk = store();
    const f = await seed(disk.engine);
    let catalogs = 0,
      ran = 0;
    const sessions = target({
      execute(command) {
        const result = disk.engine.execute(command);
        if (changed === 'error') throw new Error('private-content');
        if (changed === 'thenable')
          return {
            get then() {
              ran++;
              return () => {};
            },
          };
        if (command.operation === 'catalog' && ++catalogs === 2 && changed === 'catalog')
          result[0].revision++;
        if (command.operation === 'load' && changed === 'record')
          result.state.root.principal = 'different';
        return result;
      },
    });
    try {
      failed(await sessions.beginAsync(f.request, [], () => true));
      assert.equal(sessions.inspect().roots, 0);
      assert.equal(ran, 0);
    } finally {
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test('unpublished roots, expired evidence and different policy never acquire old read authority', async () => {
  const disk = store();
  const f = await seed(disk.engine);
  for (const mode of ['unpublished', 'expired', 'policy']) {
    const sessions = target(
      {
        execute(command) {
          const result = disk.engine.execute(command);
          if (mode === 'unpublished' && command.operation === 'load')
            result.state = createRootCheckpoint(result.state.root, [], []);
          return result;
        },
      },
      () => (mode === 'expired' ? f.state.expiresAt : 100)
    );
    try {
      const request = mode === 'policy' ? { ...f.request, policy: { changed: true } } : f.request;
      const result = await sessions.beginAsync(request, [], () => true);
      assert.equal(result.ok, true);
      assert.equal(result.reason, 'isolated_request');
      assert.equal(result.inspect().visibleSources, 0);
      assert.throws(() => exportContextRecoveryRoot(sessions, f.state.rootId));
    } finally {
      await sessions.shutdownAsync();
    }
  }
  disk.close();
});

test('memory-mode async admission enforces local authorization without changing synchronous begin', async () => {
  const sessions = target();
  const request = {
    principal: 'owner',
    protocol: 'chat',
    target: 'target',
    history: [user('question')],
  };
  try {
    failed(await sessions.beginAsync(request, [], () => false));
    const result = await sessions.beginAsync(request, [], () => true);
    assert.equal(result.ok, true);
    assert.equal(result.complete([{ role: 'assistant', content: 'done' }]).ok, true);
    assert.equal(sessions.begin(request).ok, true);
  } finally {
    await sessions.shutdownAsync();
  }
});

test(
  'real encrypted worker reopen uses the actual runtime owner for automatic admission and exact readback',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-root-loading-'));
    let storage, runtime;
    try {
      const storePath = path.join(directory, 'context-recovery-v1');
      storage = await openContextRecoveryStorage({ directory: storePath });
      const f = await seed(storage, 'question', undefined, Date.now);
      await storage.close();
      storage = undefined;
      assert.equal(
        fs.readFileSync(path.join(storePath, 'checkpoint.sqlite')).includes(Buffer.from(original)),
        false
      );
      runtime = createContextRecoveryRuntime({ dataDirectory: directory });
      runtime.configureSettings({
        appSettings: { contextRecoveryEnabled: true, contextRecoveryPersistenceEnabled: true },
      });
      assert.deepEqual(await runtime.ready(), { ok: true });
      assert.equal(runtime.sessions.inspect().roots, 0);
      const result = await runtime.sessions.beginAsync(f.request, [], () => true);
      assert.equal(result.ok, true);
      assert.equal(result.reason, 'observed_continuation');
      assert.throws(() => exportContextRecoveryRoot(runtime.sessions, f.state.rootId));
      const state = metadata(runtime.sessions, f.state.rootId, result);
      assert.equal(state.expiresAt, f.state.expiresAt);
      assert.deepEqual(state.budget, f.state.budget);
      const read = await result.replyAsync(READ, {
        sourceId: f.receipt.sourceId,
        digest: f.receipt.digest,
      });
      assert.equal(read.ok, true);
      assert.equal(JSON.parse(read.text).page.text, original);
      assert.equal(
        metadata(runtime.sessions, f.state.rootId, result).budget.calls,
        f.state.budget.calls + 1
      );
    } finally {
      await runtime?.shutdownAsync();
      await storage?.close();
      const targetPath = path.resolve(directory);
      assert.equal(path.dirname(targetPath), path.resolve(os.tmpdir()));
      assert.ok(path.basename(targetPath).startsWith('hpm-root-loading-'));
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  }
);

test('authorized cold reference admission reuses its scanned CAS facts without a second load or weakening LIST debit', async () => {
  for (const warmAdmission of [false, true]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-cold-cas-'));
    const file = path.join(directory, 'checkpoint.sqlite');
    let time = 100;
    const disk = store(file, () => ++time);
    const f = await seed(disk.engine, 'question', undefined, () => time);
    const commands = [];
    const adapter = referenceAdapter((command) => {
      commands.push(command);
      return disk.engine.execute(command);
    });
    if (warmAdmission)
      require('../lib/proxy/context-recovery-storage-contract').declareRecoveryReferenceAdmission(
        adapter.execute
      );
    const sessions = target(adapter, () => time);
    try {
      const result = await sessions.beginAsync(f.request, [], () => true);
      assert.equal(result.ok, true);
      assert.deepEqual(
        commands.map(({ operation }) => operation),
        ['scan-reference']
      );
      commands.length = 0;
      let commits = 0;
      const exec = disk.database.exec.bind(disk.database);
      disk.database.exec = (sql) => {
        if (sql === 'COMMIT') {
          assert.ok(fs.statSync(file + '-journal').size > 512);
          commits++;
        }
        return exec(sql);
      };
      const reply = await result.replyAsync(LIST, {});
      disk.database.exec = exec;
      assert.equal(commits, warmAdmission ? 2 : 3);
      assert.equal(reply.ok, true);
      assert.deepEqual(
        commands.map(({ operation }) => operation),
        warmAdmission
          ? ['save-reference-state', 'settle-reader']
          : ['load-reference', 'save-reference-state', 'settle-reader']
      );
      const debit = commands.find(({ operation }) => operation === 'save-reference-state');
      assert.equal(Boolean(debit.admission), warmAdmission);
      assert.equal(debit.reference.metadata.budget.calls, f.state.budget.calls + 1);
      assert.equal(
        debit.reference.metadata.budget.returnedBytes,
        f.state.budget.returnedBytes + 16384
      );
      const stored = await loadDurableRecoveryRoot(disk.engine, f.state.rootId);
      assert.equal(stored.expiresAt, f.state.expiresAt);
      assert.equal(stored.budget.calls, f.state.budget.calls + 1);
      assert.equal(stored.budget.successfulReads, f.state.budget.successfulReads);
      assert.equal(stored.budget.returnedBytes > f.state.budget.returnedBytes, true);
      assert.deepEqual(stored.budget, metadata(sessions, f.state.rootId, result).budget);
    } finally {
      await sessions.shutdownAsync();
      disk.close();
      assert.equal(fs.readFileSync(file).includes(Buffer.from(original)), false);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('cold admission facts accept only exact authenticated record association without executing input hooks', async () => {
  const { parseRecoveryColdAdmission } = require('../lib/proxy/context-recovery-cold-admission');
  const disk = store();
  await seed(disk.engine);
  const page = disk.engine.execute({ operation: 'scan-reference', after: null });
  const input = { entry: page.catalog[0], record: page.record };
  try {
    const facts = parseRecoveryColdAdmission(input);
    assert.equal(facts.revision, page.record.revision);
    assert.equal(facts.scope, page.scope);
    assert.equal(facts.root.expiresAt, page.record.expiresAt);
    assert.equal(JSON.stringify(facts).includes(original), false);
    let invoked = 0;
    for (const invalid of [
      null,
      {},
      [],
      { ...input, extra: true },
      { ...input, entry: { ...input.entry, scope: '0'.repeat(64) } },
      { ...input, entry: { ...input.entry, revision: Number.MAX_SAFE_INTEGER + 1 } },
      { ...input, record: { ...input.record, revision: input.record.revision + 1 } },
      { ...input, record: { ...input.record, expiresAt: input.record.expiresAt + 1 } },
      { ...input, record: { ...input.record, reference: null } },
      {
        get entry() {
          invoked++;
          return input.entry;
        },
        record: input.record,
      },
      new Proxy(
        {},
        {
          get() {
            invoked++;
            return input.entry;
          },
        }
      ),
    ])
      assert.throws(() => parseRecoveryColdAdmission(invalid));
    assert.equal(invoked, 0);
  } finally {
    disk.close();
  }
});

test('cold admission still rejects competing revisions, corrupt associations and uncertain debit ACKs without LIST settlement or retry', async () => {
  for (const mode of ['stale', 'budget', 'expiry', 'before', 'after', 'low-ack', 'high-ack']) {
    const disk = store();
    const f = await seed(disk.engine);
    const commands = [];
    const adapter = referenceAdapter((command) => {
      commands.push(command.operation);
      if (command.operation !== 'save-reference-state' || !command.admission)
        return disk.engine.execute(command);
      if (mode === 'before') throw new Error('synthetic lost ACK');
      if (mode === 'stale') {
        const competing = { ...command };
        delete competing.admission;
        disk.engine.execute(competing);
      }
      if (mode === 'budget' || mode === 'expiry') {
        const { createReferenceState } = require('../lib/proxy/context-recovery-reference-state');
        const metadata = { ...command.admission.metadata };
        if (mode === 'budget')
          metadata.budget = { ...metadata.budget, calls: metadata.budget.calls + 1 };
        else metadata.expiresAt++;
        command = {
          ...command,
          admission: createReferenceState(
            metadata,
            command.admission.stagedSources,
            command.admission.publications
          ),
        };
      }
      const reply = disk.engine.execute(command);
      if (mode === 'after') throw new Error('synthetic lost ACK');
      return { revision: reply.revision + (mode === 'low-ack' ? -1 : 1) };
    });
    require('../lib/proxy/context-recovery-storage-contract').declareRecoveryReferenceAdmission(
      adapter.execute
    );
    const sessions = target(adapter);
    try {
      const view = await sessions.beginAsync(f.request, [], () => true);
      assert.equal(view.ok, true);
      commands.length = 0;
      failed(await view.replyAsync(LIST, {}));
      assert.deepEqual(commands, ['save-reference-state'], mode);
      failed(await view.replyAsync(LIST, {}));
      assert.deepEqual(
        commands,
        ['save-reference-state'],
        'no fallback or retry after uncertain admission'
      );
      const stored = await loadDurableRecoveryRoot(disk.engine, f.state.rootId);
      const committed = ['stale', 'after', 'low-ack', 'high-ack'].includes(mode);
      assert.equal(stored.expiresAt, f.state.expiresAt);
      assert.equal(stored.budget.calls, f.state.budget.calls + (committed ? 1 : 0));
      assert.equal(
        stored.budget.returnedBytes,
        f.state.budget.returnedBytes + (committed ? 16384 : 0)
      );
    } finally {
      await sessions.shutdownAsync();
      disk.close();
    }
  }
});

test('remembered cold facts require an already adopted live denial entry and never perform I/O or grant startup authority', async () => {
  const { createRecoveryRootStorage } = require('../lib/proxy/context-recovery-root-storage');
  const disk = store();
  const f = await seed(disk.engine);
  const page = disk.engine.execute({ operation: 'scan-reference', after: null });
  const facts = { entry: page.catalog[0], record: page.record };
  try {
    for (const mode of ['absent', 'closed', 'foreign', 'duplicate', 'success']) {
      let calls = 0;
      const adapter = referenceAdapter(() => {
        calls++;
        throw new Error('unexpected I/O');
      });
      require('../lib/proxy/context-recovery-storage-contract').declareRecoveryReferenceAdmission(
        adapter.execute
      );
      const service = createRecoveryRootStorage(adapter);
      if (mode !== 'absent')
        service.admitRoot({
          rootId: f.state.rootId,
          principal: mode === 'foreign' ? 'other' : f.state.principal,
          createdAt: f.state.createdAt,
          expiresAt: f.state.expiresAt,
        });
      if (mode === 'closed') service.close();
      if (mode === 'success' || mode === 'duplicate')
        assert.equal(service.observeReference(facts), true);
      if (mode !== 'success') assert.throws(() => service.observeReference(facts));
      assert.equal(calls, 0);
      service.close();
    }
  } finally {
    disk.close();
  }
});
