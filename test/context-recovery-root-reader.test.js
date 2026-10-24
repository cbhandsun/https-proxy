'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createContextRecoverySessions,
  acquireContextRecoveryRoot,
  exportContextRecoveryRootMetadata,
  restoreContextRecoverySessions,
  attachContextRecoveryReaderStorage,
  attachContextRecoveryStorage,
} = require('../lib/proxy/context-recovery-sessions');
const { runContextRecovery } = require('../lib/proxy/context-recovery-runner');
const {
  createRootCheckpoint,
  parseRootCheckpoint,
} = require('../lib/proxy/context-recovery-root-checkpoint');
const { createRecoveryRootReader } = require('../lib/proxy/context-recovery-root-reader');
const { createRecoveryRootStorage } = require('../lib/proxy/context-recovery-root-storage');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const {
  createReferenceState,
  referenceStateFromCheckpoint,
} = require('../lib/proxy/context-recovery-reference-state');
const {
  assertRecoveryReferenceAdmission,
} = require('../lib/proxy/context-recovery-reference-admission');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const {
  declareRecoverySourcePages,
  supportsRecoverySourcePages,
  declareRecoveryReaderSettlement,
  supportsRecoveryReaderSettlement,
  declareRecoveryReferenceWrites,
  supportsRecoveryReferenceWrites,
  declareRecoveryReferenceStates,
  declareRecoveryReferenceAdmission,
} = require('../lib/proxy/context-recovery-storage-contract');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');

const exact = '原文\r\nélève🙂';
const copy = (value) => globalThis.structuredClone(value);
const user = (content) => ({ role: 'user', content });
const unavailable = 'context_recovery_storage_unavailable';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function removeSyntheticDirectory(directory) {
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('hpm-root-reader-')
  )
    throw new Error('Unsafe synthetic cleanup target');
  fs.rmSync(target, { recursive: true, force: true });
}
function response(kind, calls = []) {
  const usage = { input_tokens: 7, output_tokens: 3 };
  if (kind === 'responses')
    return {
      id: 'private-response',
      status: 'completed',
      usage,
      output: calls.length
        ? calls.map(({ id, name, args = {} }) => ({
            type: 'function_call',
            call_id: id,
            name,
            arguments: JSON.stringify(args),
          }))
        : [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'done' }],
            },
          ],
    };
  if (kind === 'claude')
    return {
      id: 'private-response',
      role: 'assistant',
      usage,
      stop_reason: calls.length ? 'tool_use' : 'end_turn',
      content: calls.length
        ? calls.map(({ id, name, args = {} }) => ({ type: 'tool_use', id, name, input: args }))
        : [{ type: 'text', text: 'done' }],
    };
  return {
    id: 'private-response',
    usage: { prompt_tokens: 7, completion_tokens: 3 },
    choices: [
      {
        index: 0,
        finish_reason: calls.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: 'done',
          ...(calls.length
            ? {
                tool_calls: calls.map(({ id, name, args = {} }) => ({
                  id,
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
function toolResult(kind, request) {
  if (kind === 'responses') return JSON.parse(request.input.at(-1).output);
  if (kind === 'claude') return JSON.parse(request.messages.at(-1).content[0].content);
  return JSON.parse(request.messages.at(-1).content);
}
function fixture({ kind = 'chat', output = exact, now } = {}) {
  let time = now ? now() : 100,
    behavior;
  const runtime = createContextRecoverySessions({ now: () => (now ? now() : time) });
  runtime.configure(true);
  const binding = { principal: 'owner', protocol: kind, target: 'target' };
  const history = [user('q')];
  const external =
    kind === 'responses'
      ? { type: 'function_call', call_id: 'external', name: 'lookup', arguments: '{}' }
      : kind === 'claude'
        ? {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'external', name: 'lookup', input: {} }],
          }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'external', type: 'function', function: { name: 'lookup', arguments: '{}' } },
            ],
          };
  const root = runtime.begin({ ...binding, history });
  assert.equal(
    root.complete(
      [external],
      [{ callId: 'external', toolName: 'lookup', arguments: {}, completed: true, output: '' }],
      'root-response'
    ).ok,
    true
  );
  const result =
    kind === 'responses'
      ? { type: 'function_call_output', call_id: 'external', output }
      : kind === 'claude'
        ? {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'external', content: output }],
          }
        : { role: 'tool', tool_call_id: 'external', content: output };
  const sourceHistory = [...history, external, result];
  const view = runtime.begin({ ...binding, history: sourceHistory }, [
    { callId: 'external', output },
  ]);
  const owner = acquireContextRecoveryRoot(runtime, root.snapshotId);
  const checkpoint = owner.checkpoint(view);
  owner.release();
  const receipt = checkpoint.stagedSources[0];
  const states = new Map(),
    calls = [];
  function execute(request) {
    for (const [scope, value] of states) if (value.expiresAt <= time) states.delete(scope);
    if (request.operation === 'load') return copy(states.get(request.scope) ?? null);
    assert.equal(request.operation, 'save');
    const prior = states.get(request.scope);
    if (!prior && states.size >= 4) throw new Error('synthetic root quota');
    if ((prior?.revision ?? 0) !== request.expectedRevision)
      throw new Error('synthetic CAS conflict');
    const revision = request.expectedRevision + 1;
    states.set(request.scope, {
      revision,
      createdAt: prior?.createdAt ?? time,
      expiresAt: request.expiresAt,
      state: copy(request.state),
    });
    return { revision };
  }
  const storage = {
    execute(request) {
      calls.push(copy(request));
      return behavior ? behavior(request, () => execute(request)) : execute(request);
    },
  };
  return {
    runtime,
    root,
    view,
    binding,
    sourceHistory,
    receipt,
    checkpoint,
    storage,
    calls,
    states,
    args: { sourceId: receipt.sourceId, digest: receipt.digest },
    attach: (other = storage) => attachContextRecoveryReaderStorage(runtime, other),
    hook: (fn) => {
      behavior = fn;
    },
    advance: (value) => {
      time = value;
    },
    budget: () => exportContextRecoveryRootMetadata(runtime, root.snapshotId).metadata.budget,
    latest: () => [...states.values()][0],
    close: () => runtime.close(),
  };
}

function pagedStorage(
  f,
  hook = (_request, next) => next(),
  incremental = false,
  references = false,
  referenceStates = false,
  admission = false,
  publication = false,
  combined = false,
  databaseFile = ':memory:',
  storageNow = () => 100
) {
  const database = new DatabaseSync(databaseFile);
  const store = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: storageNow,
  });
  const operations = [];
  const adapter = {
    execute: declareRecoverySourcePages((request) => {
      operations.push(copy(request));
      return hook(request, () => store.execute(request));
    }),
  };
  if (incremental) declareRecoveryReaderSettlement(adapter.execute);
  if (references) declareRecoveryReferenceWrites(adapter.execute);
  if (referenceStates) declareRecoveryReferenceStates(adapter.execute);
  if (admission) declareRecoveryReferenceAdmission(adapter.execute);
  if (combined)
    require('../lib/proxy/context-recovery-storage-contract').declareRecoveryReadSettlement(
      adapter.execute
    );
  if (publication) attachContextRecoveryStorage(f.runtime, adapter);
  else f.attach(adapter);
  return {
    operations,
    adapter,
    database,
    witness: () => store.snapshot(),
    load: () =>
      store.execute({
        operation: 'load',
        scope: operations.find((request) => request.scope).scope,
      }),
    close() {
      store.close();
      database.close();
    },
  };
}

test('N09 observed page contract reads the full synthetic original from real sessions and encrypted in-memory SQLite', async () => {
  const { parseObservedPage } = require('../scripts/context-hosted/n09-business/observed-page');
  const { parseStoredEvidencePage } = require('../lib/proxy/context-evidence-stored-page');
  const original = 'N09_PRIVATE_CONTENT synthetic ' + 'synthetic-evidence '.repeat(256);
  for (const durable of [false, true]) {
    const f = fixture({ kind: 'responses', output: original });
    const storage = durable ? pagedStorage(f, undefined, true, false, true) : undefined;
    try {
      const listed = JSON.parse((await f.view.replyAsync(LIST, { limit: 1 })).text);
      const source = listed.sources[0];
      const args = {
        sourceId: source.sourceId,
        digest: source.digest,
        offsetBytes: 0,
        limitBytes: 8192,
      };
      const reply = await f.view.replyAsync(READ, args);
      assert.equal(reply.ok, true);
      const value = JSON.parse(reply.text);
      assert.equal(value.observation, 'client_reported');
      assert.equal(value.verification, 'not_verified');
      assert.throws(
        () => parseStoredEvidencePage(value, source, args),
        /invalid_stored_evidence_page/
      );
      const read = parseObservedPage(value, source, {
        offsetBytes: args.offsetBytes,
        limitBytes: args.limitBytes,
      });
      assert.equal(read.page.text, original);
      assert.equal(read.page.endOffsetBytes, Buffer.byteLength(original));
      assert.equal(read.page.nextOffsetBytes, null);
      assert.deepEqual({ ...read.source }, source);
      if (storage)
        assert.equal(
          storage.operations.filter((item) => item.operation === 'read-source').length,
          1
        );
    } finally {
      f.close();
      storage?.close();
    }
  }
});

test('N09 isolated generation completes actual retained reads before independently generating the public answer', async () => {
  const { parseObservedPage } = require('../scripts/context-hosted/n09-business/observed-page');
  const original = 'N09_PRIVATE_CONTENT synthetic ' + 'synthetic-evidence '.repeat(256);
  for (const durable of [false, true]) {
    const f = fixture({ kind: 'responses', output: original });
    const storage = durable
      ? pagedStorage(f, undefined, true, false, true, false, true)
      : undefined;
    let dispatches = 0;
    let source;
    try {
      const run = f.view.recovery(
        { model: 'fixture', input: f.sourceHistory },
        { publicGeneration: 'isolated' }
      );
      const result = await runContextRecovery({
        kind: 'responses',
        session: { recovery: () => run },
        dispatch(request) {
          let calls = [];
          if (dispatches === 0) calls = [{ id: 'index', name: LIST, args: { limit: 1 } }];
          else if (dispatches === 1) {
            const index = toolResult('responses', request);
            assert.equal(index.ok, true);
            assert.equal(index.sources.length, 1);
            source = index.sources[0];
            calls = [
              {
                id: 'page',
                name: READ,
                args: {
                  sourceId: source.sourceId,
                  digest: source.digest,
                  offsetBytes: 0,
                  limitBytes: 8192,
                },
              },
            ];
          } else if (dispatches === 2) {
            const page = parseObservedPage(toolResult('responses', request), source, {
              offsetBytes: 0,
              limitBytes: 8192,
            });
            assert.equal(page.page.text, original);
          } else {
            assert.equal(dispatches, 3);
            assert.ok(JSON.stringify(request).includes(original));
            assert.ok(!(request.tools ?? []).some((tool) => [LIST, READ].includes(tool.name)));
            assert.ok(
              !request.input.some((item) => item.call_id === 'index' || item.call_id === 'page')
            );
          }
          dispatches++;
          return {
            statusCode: 200,
            wire: Buffer.from(JSON.stringify(response('responses', calls))),
            stream: false,
          };
        },
      });
      assert.equal(
        result.ok,
        true,
        'generation failed: ' + result.code + '; dispatches=' + dispatches
      );
      assert.equal(result.mode, 'release');
      assert.equal(dispatches, 4);
      assert.equal(result.calls, 2);
      assert.equal(result.usage.length, 4);
      assert.ok(!JSON.stringify(result.response).includes(original));
      const {
        encodeContextRecoveryClientWire,
      } = require('../lib/proxy/context-recovery-client-wire');
      const { decodeContextRecoveryResponse } = require('../lib/proxy/context-recovery-protocol');
      const encoded = encodeContextRecoveryClientWire(
        'responses',
        result.response,
        result.usage,
        false
      );
      const decoded = decodeContextRecoveryResponse('responses', encoded.wire, false);
      assert.deepEqual(
        await f.view.completeAsync(decoded.output, decoded.calls, decoded.responseId),
        { ok: true }
      );
      assert.deepEqual(await f.view.startPublicationAsync(), { ok: true });
      assert.deepEqual(await f.view.finishPublicationAsync(), { ok: true });
    } finally {
      f.close();
      storage?.close();
    }
  }
});

test('default reference-state reader uses metadata loads and sends each original only once across protocols', async () => {
  for (const kind of ['chat', 'claude', 'responses']) {
    const f = fixture({ kind });
    const storage = pagedStorage(f, undefined, true, false, true);
    try {
      assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
      const cipher = storage.database.prepare('SELECT envelope FROM recovery_blob').get().envelope;
      assert.equal((await f.view.replyAsync(LIST, {})).ok, true);
      assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
      const saves = storage.operations.filter(
        (request) => request.operation === 'save-reference-state'
      );
      assert.equal(saves.length, 3);
      assert.equal(saves[0].payloads.length, 1);
      assert.equal(saves[0].payloads[0].output, exact);
      for (const request of saves.slice(1)) assert.deepEqual(request.payloads, []);
      assert.deepEqual(
        storage.operations.map((request) => request.operation),
        [
          'load-reference',
          'save-reference-state',
          'read-source',
          'settle-reader',
          'load-reference',
          'save-reference-state',
          'settle-reader',
          'load-reference',
          'save-reference-state',
          'read-source',
          'settle-reader',
        ]
      );
      assert.ok(
        Buffer.from(
          storage.database.prepare('SELECT envelope FROM recovery_blob').get().envelope
        ).equals(Buffer.from(cipher))
      );
      const loaded = storage.load();
      assert.equal(loaded.state.root.budget.calls, 3);
      assert.equal(loaded.state.root.ledger.readCount, 2);
      assert.equal(
        [...loaded.state.root.ledger.sources, ...loaded.state.stagedSources][0].output,
        exact
      );
      assert.equal(loaded.expiresAt, f.checkpoint.root.expiresAt);
    } finally {
      f.runtime.close();
      storage.close();
    }
  }
});

test('warm reference reader combines admission with durable budget reservation across protocols', async () => {
  for (const kind of ['chat', 'claude', 'responses']) {
    const f = fixture({ kind });
    const storage = pagedStorage(f, undefined, true, false, true, true);
    try {
      assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
      assert.equal((await f.view.replyAsync(LIST, {})).ok, true);
      assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
      assert.equal(storage.operations.filter((r) => r.operation === 'load-reference').length, 1);
      const saves = storage.operations.filter((r) => r.operation === 'save-reference-state');
      assert.equal(saves.length, 3);
      assert.equal(saves[0].admission, undefined);
      for (const request of saves.slice(1)) {
        assert.ok(request.admission);
        assert.deepEqual(request.payloads, []);
        assert.equal(
          request.reference.metadata.budget.calls,
          request.admission.metadata.budget.calls + 1
        );
      }
      assert.equal(storage.operations.filter((r) => r.operation === 'settle-reader').length, 3);
      const stored = storage.load();
      assert.equal(stored.state.root.budget.calls, 3);
      assert.equal(stored.state.root.ledger.readCount, 2);
      assert.equal(stored.state.root.expiresAt, f.checkpoint.root.expiresAt);
    } finally {
      f.close();
      storage.close();
    }
  }
});

test('combined admission failures deny source reads without retry or budget refund', async () => {
  for (const fault of ['budget', 'publications', 'revision', 'ciphertext', 'ack']) {
    const f = fixture();
    let injected = false;
    const storage = pagedStorage(
      f,
      (request, next) => {
        if (!request.admission) return next();
        injected = true;
        if (fault === 'budget') request.admission.metadata.budget.calls = 0;
        if (fault === 'publications') request.admission.publications[0].state = 'withdrawn';
        if (fault === 'revision')
          storage.database.prepare('UPDATE recovery_state SET revision=revision+1').run();
        if (fault === 'ciphertext') {
          const row = storage.database.prepare('SELECT envelope FROM recovery_state').get();
          const corrupt = Buffer.from(row.envelope);
          corrupt[corrupt.length - 1] ^= 1;
          storage.database.prepare('UPDATE recovery_state SET envelope=?').run(corrupt);
        }
        const result = next();
        return fault === 'ack' ? { revision: -1 } : result;
      },
      true,
      false,
      true,
      true
    );
    try {
      assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
      const before = storage.operations.length;
      assert.equal((await f.view.replyAsync(READ, f.args)).code, unavailable);
      assert.equal(injected, true);
      assert.deepEqual(
        storage.operations.slice(before).map((r) => r.operation),
        ['save-reference-state']
      );
      const after = storage.operations.length;
      assert.equal((await f.view.replyAsync(READ, f.args)).code, unavailable);
      assert.equal(storage.operations.length, after);
      if (fault === 'ack') assert.equal(storage.load().state.root.budget.calls, 2);
    } finally {
      f.close();
      storage.close();
    }
  }
});

test('admission guard rejects unsafe and mismatched input without executing accessors or proxies', () => {
  const f = fixture();
  try {
    const reference = referenceStateFromCheckpoint(f.checkpoint);
    const accepted = assertRecoveryReferenceAdmission(reference, reference);
    assert.deepEqual(accepted, reference);
    accepted.metadata.budget.calls++;
    assert.equal(reference.metadata.budget.calls, 0);
    let effects = 0;
    const getter = {
      get metadata() {
        effects++;
        return reference.metadata;
      },
    };
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          effects++;
          throw new Error('PRIVATE');
        },
      }
    );
    const cycle = {};
    cycle.self = cycle;
    let deep = null;
    for (let index = 0; index < 66; index++) deep = { child: deep };
    const changedBudget = copy(reference.metadata);
    changedBudget.budget.calls++;
    const publication = createReferenceState(reference.metadata, reference.stagedSources, [
      { snapshotId: reference.metadata.snapshots[0].id, state: 'withdrawn' },
    ]);
    for (const value of [
      null,
      {},
      [],
      '',
      getter,
      proxy,
      cycle,
      deep,
      { ...reference, metadata: proxy },
      { ...reference, extra: Array(65537).fill(null) },
      { ...reference, version: 99 },
      createReferenceState(changedBudget, reference.stagedSources),
      publication,
    ]) {
      for (const values of [
        [reference, value],
        [value, reference],
      ])
        assert.throws(() => assertRecoveryReferenceAdmission(...values), { code: unavailable });
    }
    assert.equal(effects, 0);
  } finally {
    f.close();
  }
});

test('revocation while combined admission is pending never releases a reader result', async () => {
  const f = fixture();
  const waiting = deferred();
  const blocked = deferred();
  const storage = pagedStorage(
    f,
    (request, next) => {
      if (!request.admission) return next();
      waiting.resolve();
      return blocked.promise.then(next);
    },
    true,
    false,
    true,
    true
  );
  try {
    assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
    const before = storage.operations.length;
    const pending = f.view.replyAsync(READ, f.args);
    await waiting.promise;
    f.runtime.revoke('owner');
    blocked.resolve();
    assert.equal((await pending).code, unavailable);
    assert.equal(
      storage.operations.slice(before).some((r) => r.operation === 'read-source'),
      false
    );
  } finally {
    blocked.resolve();
    f.close();
    storage.close();
  }
});

test('warm admission retains empty originals, invalid-call debit and exact expiry denial', async () => {
  const f = fixture({ output: '' });
  const storage = pagedStorage(f, undefined, true, false, true, true);
  try {
    for (let index = 0; index < 2; index++) {
      const reply = await f.view.replyAsync(READ, f.args);
      assert.equal(reply.ok, true);
      assert.equal(JSON.parse(reply.text).page.text, '');
    }
    assert.equal((await f.view.replyAsync(READ, { unknown: true })).ok, false);
    assert.equal(storage.load().state.root.budget.calls, 3);
    assert.equal(storage.operations.filter((r) => r.operation === 'load-reference').length, 1);
    const before = storage.operations.length;
    f.advance(f.checkpoint.root.expiresAt);
    assert.equal((await f.view.replyAsync(READ, f.args)).ok, false);
    assert.equal(
      storage.operations.slice(before).some((r) => r.operation === 'read-source'),
      false
    );
  } finally {
    f.close();
    storage.close();
  }
});

test('metadata LIST waits for maximum-debit ACK and uncertain writes never settle or refund', async () => {
  for (const mode of ['success', 'before', 'after', 'ack', 'disable']) {
    const f = fixture();
    let held = false;
    let enabled = false;
    let listCalls = 0;
    let finished = false;
    const entered = deferred(),
      resume = deferred();
    const storage = pagedStorage(
      f,
      async (request, next) => {
        if (!enabled || held || !request.admission) return next();
        held = true;
        const reply = mode === 'before' ? null : next();
        entered.resolve();
        await resume.promise;
        if (mode === 'before' || mode === 'after') throw new Error('synthetic lost ACK');
        return mode === 'ack' ? { revision: -1 } : reply;
      },
      true,
      false,
      true,
      true
    );
    const reader = createRecoveryRootReader(storage.adapter, () => {
      const owner = acquireContextRecoveryRoot(f.runtime, f.root.snapshotId);
      return {
        ...owner,
        replyReserved(...args) {
          if (args[2] === LIST) listCalls++;
          return owner.replyReserved(...args);
        },
        replyReservedAsync(...args) {
          if (args[2] === LIST) listCalls++;
          return owner.replyReservedAsync(...args);
        },
      };
    });
    try {
      assert.equal((await reader.reply(f.view, READ, f.args)).ok, true);
      const before = storage.load().state.root.budget;
      const operationStart = storage.operations.length;
      enabled = true;
      assert.equal(held, false);
      const pending = reader.reply(f.view, LIST, {});
      void pending.then(() => {
        finished = true;
      });
      await entered.promise;
      assert.equal(listCalls, 0);
      assert.equal(finished, false);
      assert.deepEqual(
        storage.operations.slice(operationStart).map((request) => request.operation),
        ['save-reference-state']
      );
      const debit = storage.operations.at(-1).reference.metadata.budget;
      assert.equal(debit.calls, before.calls + 1);
      assert.equal(debit.returnedBytes, before.returnedBytes + 16384);
      if (mode === 'disable') f.runtime.configure(false);
      resume.resolve();
      const result = await pending;
      assert.equal(result.ok, mode === 'success');
      assert.equal(listCalls, mode === 'success' ? 1 : 0);
      if (mode === 'disable') assert.equal(storage.load(), null);
      if (mode !== 'before' && mode !== 'disable') {
        const budget = storage.load().state.root.budget;
        assert.equal(budget.calls, before.calls + 1);
        if (mode !== 'success') assert.equal(budget.returnedBytes, before.returnedBytes + 16384);
        else assert.ok(budget.returnedBytes < before.returnedBytes + 16384);
      }
    } finally {
      resume.resolve();
      reader.close();
      f.close();
      storage.close();
    }
  }
});

test('deferred admission cannot read or settle before the first durable save', async () => {
  const f = fixture();
  const storage = pagedStorage(f, undefined, true, false, true, true);
  const service = createRecoveryRootStorage(storage.adapter);
  try {
    const reference = referenceStateFromCheckpoint(f.checkpoint);
    const all = [...f.checkpoint.root.ledger.sources, ...f.checkpoint.stagedSources];
    const payloads = (ids) =>
      all
        .filter((source) => ids.includes(source.sourceId))
        .map(({ sourceId, output }) => ({ sourceId, output }));
    const first = await service.begin(reference, payloads);
    await first.save(reference);
    const before = storage.operations.length;
    const deferred = await service.begin(reference, payloads, true);
    await assert.rejects(deferred.readSource(null, null, 0), { code: unavailable });
    await assert.rejects(deferred.settleReader({}), { code: unavailable });
    assert.equal(storage.operations.length, before);
    await deferred.save(reference);
    assert.equal(storage.operations.length, before + 1);
    assert.ok(storage.operations.at(-1).admission);
  } finally {
    service.close();
    f.close();
    storage.close();
  }
});

test('reference reader never invokes full checkpoint export and requests only missing payload IDs', async () => {
  const f = fixture();
  const storage = pagedStorage(f, undefined, true, false, true);
  const selections = [];
  let fullExports = 0;
  const reader = createRecoveryRootReader(storage.adapter, () => {
    const owner = acquireContextRecoveryRoot(f.runtime, f.root.snapshotId);
    return {
      ...owner,
      checkpoint() {
        fullExports++;
        throw Error('private full export forbidden');
      },
      payloads(session, ids) {
        selections.push([...ids]);
        return owner.payloads(session, ids);
      },
    };
  });
  try {
    assert.equal((await reader.reply(f.view, READ, f.args)).ok, true);
    assert.equal((await reader.reply(f.view, LIST, {})).ok, true);
    assert.equal((await reader.reply(f.view, READ, f.args)).ok, true);
    assert.equal(fullExports, 0);
    assert.deepEqual(selections, [[f.receipt.sourceId], [], []]);
  } finally {
    reader.close();
    f.close();
    storage.close();
  }
});

test('reference reader releases payloads only after a valid save ACK and current owner checks', async () => {
  for (const mode of [
    'success',
    'before',
    'ack',
    'rejected',
    'abort',
    'release',
    'revoke',
    'expiry',
  ]) {
    const f = fixture();
    const entered = deferred(),
      resume = deferred();
    let first = true,
      owner,
      evictions = 0;
    const storage = pagedStorage(
      f,
      async (request, next) => {
        if (request.operation !== 'save-reference-state' || !first) return next();
        first = false;
        const value = mode === 'before' ? null : next();
        entered.resolve();
        await resume.promise;
        if (mode === 'before' || mode === 'rejected') throw new Error('private failure');
        return mode === 'ack' ? { revision: 999 } : value;
      },
      true,
      false,
      true
    );
    const reader = createRecoveryRootReader(storage.adapter, () => {
      owner = acquireContextRecoveryRoot(f.runtime, f.root.snapshotId);
      return {
        ...owner,
        evictPersisted(session, ack) {
          evictions++;
          return owner.evictPersisted(session, ack);
        },
      };
    });
    try {
      const pending = reader.reply(f.view, LIST, {});
      await entered.promise;
      assert.equal(owner.checkpoint(f.view).stagedSources[0].output, exact);
      assert.equal(evictions, 0);
      if (mode === 'abort') f.view.abort();
      if (mode === 'release') owner.release();
      if (mode === 'revoke') f.runtime.revoke('owner');
      if (mode === 'expiry') f.advance(f.receipt.expiresAt);
      resume.resolve();
      const result = await pending;
      assert.equal(result.ok, mode === 'success');
      assert.equal(evictions, mode === 'success' ? 1 : 0);
      if (['before', 'ack', 'rejected', 'release'].includes(mode)) {
        const check = acquireContextRecoveryRoot(f.runtime, f.root.snapshotId);
        try {
          assert.equal(check.checkpoint(f.view).stagedSources[0].output, exact);
        } finally {
          check.release();
        }
      }
      if (mode === 'success') {
        const check = acquireContextRecoveryRoot(f.runtime, f.root.snapshotId);
        try {
          assert.throws(() => check.checkpoint(f.view));
        } finally {
          check.release();
        }
        assert.equal(JSON.parse((await reader.reply(f.view, READ, f.args)).text).page.text, exact);
      }
    } finally {
      resume.resolve();
      reader.close();
      await f.runtime.shutdownAsync();
      storage.close();
    }
  }
});

test('declared reference-path failures stop the root without retries or legacy fallback', async () => {
  for (const mode of ['budget', 'policy', 'outer', 'ack', 'rejected']) {
    const f = fixture();
    let armed = false;
    const storage = pagedStorage(
      f,
      (request, next) => {
        if (!armed) return next();
        if (request.operation === 'save-reference-state' && mode === 'ack') {
          next();
          return { revision: 999 };
        }
        const result = next();
        if (request.operation !== 'load-reference' || mode === 'ack') return result;
        if (mode === 'rejected') throw Error('private');
        if (mode === 'outer') return { ...result, extra: true };
        const { metadata, stagedSources, publications } = result.reference;
        return {
          ...result,
          reference: createReferenceState(
            {
              ...metadata,
              ...(mode === 'budget'
                ? {
                    budget: {
                      ...metadata.budget,
                      returnedBytes: metadata.budget.returnedBytes + 1,
                    },
                  }
                : {
                    ledger: {
                      ...metadata.ledger,
                      policy: {
                        ...metadata.ledger.policy,
                        maxEntries: metadata.ledger.policy.maxEntries + 1,
                      },
                    },
                  }),
            },
            stagedSources,
            publications
          ),
        };
      },
      true,
      false,
      true
    );
    try {
      assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
      armed = true;
      assert.equal((await f.view.replyAsync(LIST, {})).code, unavailable);
      const count = storage.operations.length;
      assert.equal((await f.view.replyAsync(READ, f.args)).code, unavailable);
      assert.equal(storage.operations.length, count);
      assert.equal(
        storage.operations.filter((request) => request.operation === 'read-source').length,
        1
      );
      assert.equal(
        storage.operations.some((request) =>
          ['load', 'save', 'save-reference'].includes(request.operation)
        ),
        false
      );
    } finally {
      f.close();
      storage.close();
    }
  }
});

test('a payload eviction failure stops later root I/O while retaining the authenticated durable original', async () => {
  const f = fixture();
  const storage = pagedStorage(f, undefined, true, false, true);
  const reader = createRecoveryRootReader(storage.adapter, () => ({
    ...acquireContextRecoveryRoot(f.runtime, f.root.snapshotId),
    evictPersisted() {
      throw new Error('synthetic private artifact failure');
    },
  }));
  try {
    assert.equal((await reader.reply(f.view, LIST, {})).code, unavailable);
    const count = storage.operations.length;
    assert.equal((await reader.reply(f.view, READ, f.args)).code, unavailable);
    assert.equal(storage.operations.length, count);
    assert.equal(storage.load().state.stagedSources[0].output, exact);
    const owner = acquireContextRecoveryRoot(f.runtime, f.root.snapshotId);
    try {
      assert.equal(owner.checkpoint(f.view).stagedSources[0].output, exact);
    } finally {
      owner.release();
    }
  } finally {
    reader.close();
    await f.runtime.shutdownAsync();
    storage.close();
  }
});

test('reference pre-debits transmit an original once and reuse its encrypted payload for all protocol sessions', async () => {
  for (const kind of ['chat', 'claude', 'responses']) {
    const f = fixture({ kind, output: exact.repeat(4000) });
    const storage = pagedStorage(f, undefined, true, true);
    try {
      assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
      const original = Buffer.from(
        storage.database.prepare('SELECT envelope FROM recovery_blob').get().envelope
      );
      assert.equal((await f.view.replyAsync(LIST, {})).ok, true);
      assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
      const saves = storage.operations.filter((request) => request.operation === 'save-reference');
      assert.equal(saves.length, 3);
      assert.equal(saves[0].payloads.length, 1);
      assert.equal(saves[0].payloads[0].output, exact.repeat(4000));
      for (const request of saves.slice(1)) {
        assert.deepEqual(request.payloads, []);
        assert.equal(JSON.stringify(request).includes(exact.repeat(4000)), false);
        assert.ok(Buffer.byteLength(JSON.stringify(request)) < 16384);
      }
      assert.deepEqual(
        Buffer.from(storage.database.prepare('SELECT envelope FROM recovery_blob').get().envelope),
        original
      );
      assert.equal(storage.load().state.root.budget.calls, 3);
      assert.equal(storage.load().expiresAt, f.checkpoint.root.expiresAt);
    } finally {
      f.close();
      storage.close();
    }
  }
});

test('reference pre-debits attach only the newly captured source while retaining the earlier original', async () => {
  const f = fixture();
  const storage = pagedStorage(f, undefined, true, true);
  const second = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'external-2', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ],
  };
  const output = 'second-original🙂';
  try {
    assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
    assert.equal(
      f.view.complete(
        [second],
        [{ callId: 'external-2', toolName: 'lookup', arguments: {}, completed: true, output: '' }],
        'second-response'
      ).ok,
      true
    );
    const next = f.runtime.begin(
      {
        ...f.binding,
        previousResponseId: 'second-response',
        history: [
          ...f.sourceHistory,
          second,
          { role: 'tool', tool_call_id: 'external-2', content: output },
        ],
      },
      [{ callId: 'external-2', output }]
    );
    assert.equal(next.ok, true);
    const reply = await next.replyAsync(LIST, {});
    assert.equal(reply.ok, true);
    const index = JSON.parse(reply.text);
    const source = index.sources.find((item) => item.sourceId !== f.args.sourceId);
    assert.ok(source);
    const saves = storage.operations.filter((request) => request.operation === 'save-reference');
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[1].payloads, [{ sourceId: source.sourceId, output }]);
    assert.equal(
      saves[1].reference.metadata.ledger.sources.length + saves[1].reference.stagedSources.length,
      2
    );
    assert.equal(JSON.parse((await next.replyAsync(READ, f.args)).text).page.text, exact);
    assert.equal(
      JSON.parse(
        (await next.replyAsync(READ, { sourceId: source.sourceId, digest: source.digest })).text
      ).page.text,
      output
    );
  } finally {
    f.close();
    storage.close();
  }
});

test('reference pre-debit corruption and acknowledgement failures retain spend without retry or raw fallback', async () => {
  for (const failure of ['before', 'after', 'payload', 'stale', 'ack']) {
    const f = fixture();
    const storage = pagedStorage(
      f,
      (request, next) => {
        if (request.operation !== 'save-reference') return next();
        if (failure === 'before') throw new Error('private pre-debit failure');
        if (failure === 'payload') request.payloads[0].output = 'forged';
        if (failure === 'stale') request.expectedRevision++;
        const result = next();
        if (failure === 'after') throw new Error('private late acknowledgement');
        if (failure === 'ack') return { revision: 100 };
        return result;
      },
      true,
      true
    );
    try {
      assert.deepEqual(await f.view.replyAsync(READ, f.args), { ok: false, code: unavailable });
      assert.equal(f.budget().returnedBytes, 16384);
      assert.equal(f.budget().successfulReads, 0);
      const saved = storage.load();
      assert.equal(saved?.revision ?? 0, ['after', 'ack'].includes(failure) ? 1 : 0);
      const count = storage.operations.length;
      assert.deepEqual(await f.view.replyAsync(READ, f.args), { ok: false, code: unavailable });
      assert.equal(storage.operations.length, count);
      assert.equal(
        storage.operations.some((request) => request.operation === 'read-source'),
        false
      );
    } finally {
      f.close();
      storage.close();
    }
  }
});

test('incremental settlement omits original payloads and preserves exact large and empty sources', async () => {
  for (const output of [exact.repeat(4000), '']) {
    const f = fixture({ output });
    const storage = pagedStorage(f, undefined, true);
    try {
      const reply = await f.view.replyAsync(READ, f.args);
      assert.equal(reply.ok, true);
      const request = storage.operations.at(-1);
      assert.deepEqual(
        storage.operations.map((item) => item.operation),
        ['load', 'save', 'read-source', 'settle-reader']
      );
      assert.equal(request.expectedRevision, 1);
      assert.deepEqual(Object.keys(request).sort(), [
        'expectedRevision',
        'operation',
        'scope',
        'settlement',
      ]);
      assert.equal(Object.hasOwn(request, 'state'), false);
      assert.equal(request.settlement.version, 2);
      assert.equal(request.settlement.ledger.sources.length, 1);
      assert.ok(Buffer.byteLength(JSON.stringify(request)) < 16384);
      if (output) assert.equal(JSON.stringify(request).includes(output), false);
      const saved = storage.load();
      assert.equal(saved.revision, 2);
      assert.equal(saved.state.stagedSources[0].output, output);
      assert.equal(
        saved.state.stagedSources[0].coveredThrough,
        JSON.parse(reply.text).page.endOffsetBytes
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(saved.state.root.budget)),
        JSON.parse(JSON.stringify(f.budget()))
      );
      assert.equal(saved.expiresAt, f.checkpoint.root.expiresAt);
    } finally {
      f.close();
      storage.close();
    }
  }
});

test('sparse live settlements omit unchanged progress for LIST, repeated reads and denied sources', async () => {
  for (const referenceStates of [false, true]) {
    const f = fixture();
    const storage = pagedStorage(f, undefined, true, false, referenceStates);
    try {
      for (const [name, args, expectedSources, expectedOk] of [
        [LIST, {}, 0, true],
        [READ, f.args, 1, true],
        [READ, f.args, 0, true],
        [READ, { ...f.args, sourceId: 'hce_' + 'f'.repeat(32) }, 0, false],
      ]) {
        const result = await f.view.replyAsync(name, args);
        assert.equal(result.ok, expectedOk);
        const delta = storage.operations.at(-1).settlement;
        assert.equal(delta.version, 2);
        assert.equal(delta.ledger.sources.length, expectedSources);
        assert.ok(Buffer.byteLength(JSON.stringify(delta)) < 512);
      }
      const saved = storage.load();
      assert.equal(saved.state.stagedSources[0].readComplete, true);
      assert.equal(saved.state.root.budget.calls, 4);
      assert.equal(saved.state.root.budget.successfulReads, 2);
      assert.equal(saved.expiresAt, f.checkpoint.root.expiresAt);
    } finally {
      f.close();
      storage.close();
    }
  }
});

test('incremental settlement acknowledgement blocks publication and cancellation cannot restore authority', async () => {
  for (const action of ['success', 'abort', 'revoke', 'disable', 'close', 'expire']) {
    const f = fixture(),
      gate = deferred(),
      entered = deferred();
    let returned = false;
    const storage = pagedStorage(
      f,
      (request, next) => {
        if (request.operation !== 'settle-reader') return next();
        const result = next();
        entered.resolve();
        return gate.promise.then(() => result);
      },
      true
    );
    try {
      const pending = f.view.replyAsync(READ, f.args).then((result) => {
        returned = true;
        return result;
      });
      await entered.promise;
      assert.equal(returned, false);
      assert.equal(f.view.inspect().readers.returnedBytes, 16384);
      assert.equal(storage.load().state.root.budget.successfulReads, 1);
      assert.equal(f.view.reply(READ, f.args).code, 'context_recovery_busy');
      if (action === 'abort') f.view.abort();
      if (action === 'revoke') f.runtime.revoke('owner');
      if (action === 'disable') f.runtime.configure(false);
      if (action === 'close') f.close();
      if (action === 'expire') f.advance(86400100);
      gate.resolve();
      const reply = await pending;
      if (action === 'success') assert.equal(JSON.parse(reply.text).page.text, exact);
      else assert.deepEqual(reply, { ok: false, code: unavailable });
      if (['success', 'abort'].includes(action)) {
        const saved = storage.load().state.root.budget;
        assert.equal(f.budget().returnedBytes, saved.returnedBytes);
        assert.equal(f.budget().successfulReads, 1);
      }
    } finally {
      gate.resolve();
      f.close();
      storage.close();
    }
  }
});

test('incremental settlement faults retain conservative spend and never retry or fall back', async () => {
  for (const written of [false, true]) {
    const f = fixture();
    const storage = pagedStorage(
      f,
      (request, next) => {
        if (request.operation !== 'settle-reader') return next();
        if (written) next();
        throw new Error('private storage acknowledgement');
      },
      true
    );
    try {
      assert.deepEqual(await f.view.replyAsync(READ, f.args), { ok: false, code: unavailable });
      assert.equal(f.budget().returnedBytes, 16384);
      assert.equal(f.budget().successfulReads, 0);
      assert.equal(storage.load().revision, written ? 2 : 1);
      const count = storage.operations.length;
      assert.deepEqual(await f.view.replyAsync(READ, f.args), { ok: false, code: unavailable });
      assert.equal(storage.operations.length, count);
    } finally {
      f.close();
      storage.close();
    }
  }
});

test('all protocol sessions retain LIST and invalid-range semantics with the stored-page capability', async () => {
  for (const kind of ['chat', 'claude', 'responses']) {
    const f = fixture({ kind });
    const storage = pagedStorage(f);
    try {
      assert.equal((await f.view.replyAsync(LIST, {})).ok, true);
      assert.equal(
        storage.operations.filter((request) => request.operation === 'read-source').length,
        0
      );
      assert.equal((await f.view.replyAsync(READ, {})).code, 'invalid_evidence_arguments');
      assert.equal(
        storage.operations.filter((request) => request.operation === 'read-source').length,
        0
      );
      const invalidRange = await f.view.replyAsync(READ, { ...f.args, offsetBytes: 1 });
      assert.equal(invalidRange.ok, false);
      assert.equal(JSON.parse(invalidRange.text).error, 'context_evidence_unavailable');
      const valid = await f.view.replyAsync(READ, f.args);
      assert.equal(JSON.parse(valid.text).page.text, exact);
      assert.equal(f.budget().calls, 4);
      assert.equal(f.budget().successfulReads, 1);
    } finally {
      f.close();
      storage.close();
    }
  }
});

test('encrypted source pages wait for pre-debit, selected payload and durable settlement', async () => {
  const f = fixture();
  const gates = [deferred(), deferred(), deferred()];
  const entered = gates.map(() => deferred());
  let phase = 0;
  const storage = pagedStorage(f, (request, next) => {
    if (!['save', 'read-source'].includes(request.operation)) return next();
    const index = phase++;
    entered[index].resolve();
    return gates[index].promise.then(next);
  });
  let returned = false;
  try {
    const pending = f.view.replyAsync(READ, f.args).then((result) => {
      returned = true;
      return result;
    });
    for (let index = 0; index < 3; index++) {
      await entered[index].promise;
      assert.equal(returned, false);
      assert.equal(storage.operations.at(-1).operation, index === 1 ? 'read-source' : 'save');
      assert.equal(f.view.reply(READ, f.args).code, 'context_recovery_busy');
      assert.equal((await f.view.replyAsync(READ, f.args)).code, unavailable);
      if (index < 2) assert.equal(f.view.inspect().readers.successfulReads, 0);
      gates[index].resolve();
    }
    assert.equal(JSON.parse((await pending).text).page.text, exact);
    assert.equal(f.budget().successfulReads, 1);
    assert.ok(f.budget().returnedBytes < 16384);
  } finally {
    for (const gate of gates) gate.resolve();
    f.close();
    storage.close();
  }
});

test('authority invalidation while an encrypted source page is pending cannot release content', async () => {
  for (const action of ['abort', 'revoke', 'disable', 'close', 'expire']) {
    const f = fixture(),
      gate = deferred(),
      entered = deferred();
    const storage = pagedStorage(f, (request, next) => {
      if (request.operation !== 'read-source') return next();
      // Read the real encrypted page before delaying its acknowledgement.
      const page = next();
      entered.resolve();
      return gate.promise.then(() => page);
    });
    try {
      const pending = f.view.replyAsync(READ, f.args);
      await entered.promise;
      if (action === 'abort') f.view.abort();
      if (action === 'revoke') f.runtime.revoke('owner');
      if (action === 'disable') f.runtime.configure(false);
      if (action === 'close') f.close();
      if (action === 'expire') f.advance(86400100);
      gate.resolve();
      assert.deepEqual(await pending, { ok: false, code: unavailable }, action);
      assert.equal(storage.operations.filter((request) => request.operation === 'save').length, 1);
      assert.equal(f.view.inspect().active, false);
      if (action === 'abort') {
        assert.equal(f.budget().returnedBytes, 16384);
        assert.equal(f.budget().successfulReads, 0);
        const row = storage.database.prepare('SELECT revision FROM recovery_state').get();
        assert.equal(row.revision, 1);
      }
    } finally {
      gate.resolve();
      f.close();
      storage.close();
    }
  }
});

test('declared page adapter failures and hostile replies never fall back to resident originals', async () => {
  let invoked = 0;
  for (const failure of ['throw', 'reject', 'tamper', 'thenable', 'constructor', 'missing']) {
    const f = fixture();
    const storage = pagedStorage(f, (request, next) => {
      if (request.operation !== 'read-source') return next();
      if (failure === 'throw') throw new Error('private storage detail');
      if (failure === 'reject') return Promise.reject(new Error('private storage detail'));
      if (failure === 'thenable')
        return {
          get then() {
            invoked++;
            throw new Error('private');
          },
        };
      if (failure === 'missing') return null;
      const page = next();
      if (failure === 'tamper') {
        page.page.text = 'forged';
        return page;
      }
      const pending = Promise.resolve(page);
      Object.defineProperty(pending, 'constructor', {
        get() {
          invoked++;
          return Promise;
        },
      });
      return pending;
    });
    try {
      assert.deepEqual(
        await f.view.replyAsync(READ, f.args),
        { ok: false, code: unavailable },
        failure
      );
      assert.equal(f.budget().successfulReads, 0);
      assert.equal(f.budget().returnedBytes, 16384);
      assert.equal(storage.operations.filter((request) => request.operation === 'save').length, 1);
      assert.equal(
        storage.operations.filter((request) => request.operation === 'read-source').length,
        1
      );
    } finally {
      f.close();
      storage.close();
    }
  }
  assert.equal(invoked, 0);
});

test('persistent page reads use encrypted SQLite after pre-debit and settle before returning', async () => {
  const f = fixture({ output: exact.repeat(4000) });
  const database = new DatabaseSync(':memory:');
  const storage = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  const operations = [];
  const proxy = {
    execute: declareRecoverySourcePages((request) => {
      operations.push(copy(request));
      return storage.execute(request);
    }),
  };
  try {
    assert.equal(supportsRecoverySourcePages(storage.execute), true);
    f.attach(proxy);
    let text = '',
      offsetBytes = 0;
    do {
      const reply = await f.view.replyAsync(READ, { ...f.args, offsetBytes });
      assert.equal(reply.ok, true);
      const value = JSON.parse(reply.text);
      text += value.page.text;
      offsetBytes = value.page.nextOffsetBytes;
    } while (offsetBytes !== null);
    assert.equal(text, exact.repeat(4000));
    assert.ok(operations.some((item) => item.operation === 'read-source'));
    const sequence = operations.map((item) => item.operation);
    assert.deepEqual(sequence.slice(0, 4), ['load', 'save', 'read-source', 'save']);
    const request = operations.find((item) => item.operation === 'read-source');
    assert.equal(request.expectedRevision, 1);
    assert.equal(request.source.sourceId, f.receipt.sourceId);
    assert.equal(request.arguments.digest, f.receipt.digest);
    assert.equal(
      f.budget().calls,
      operations.filter((item) => item.operation === 'read-source').length
    );
  } finally {
    f.close();
    storage.close();
    database.close();
  }
});

for (const kind of ['chat', 'responses', 'claude']) {
  test(`${kind}: actual async session persists pending original and accounting before model continuation`, async () => {
    const f = fixture({ kind });
    try {
      f.attach();
      const run = f.view.recovery({
        model: 'fixture',
        [kind === 'responses' ? 'input' : 'messages']: f.sourceHistory,
      });
      let dispatches = 0;
      const result = await runContextRecovery({
        kind,
        session: { recovery: () => run },
        dispatch(request) {
          let calls;
          if (dispatches === 0) calls = [{ id: 'index', name: LIST }];
          else if (dispatches === 1) {
            const index = toolResult(kind, request);
            assert.equal(index.sources[0].sourceId, f.receipt.sourceId);
            assert.equal(f.latest().revision, 2);
            calls = [
              {
                id: 'page',
                name: READ,
                args: { sourceId: index.sources[0].sourceId, digest: index.sources[0].digest },
              },
            ];
          } else {
            assert.equal(toolResult(kind, request).page.text, exact);
            assert.equal(f.latest().revision, 4);
            calls = [];
          }
          dispatches++;
          return {
            statusCode: 200,
            wire: Buffer.from(JSON.stringify(response(kind, calls))),
            stream: false,
          };
        },
      });
      assert.equal(result.mode, 'release');
      assert.equal(dispatches, 3);
      assert.equal(result.usage.length, 3);
      assert.equal(f.states.size, 1);
      const saved = f.latest().state;
      assert.equal(saved.kind, 'recovery-write-ahead');
      assert.equal(saved.root.snapshots.length, 1);
      assert.equal(saved.root.ledger.sources.length, 0);
      assert.equal(saved.stagedSources[0].output, exact);
      assert.equal(saved.root.budget.calls, 2);
      assert.equal(saved.root.budget.successfulReads, 1);
      assert.equal(JSON.stringify(f.budget()), JSON.stringify(saved.root.budget));
      assert.throws(
        () =>
          restoreContextRecoverySessions({ now: () => 200 }, [
            { binding: { ...f.binding, history: [] }, state: saved },
          ]),
        { code: 'invalid_context_recovery_root_state' }
      );
    } finally {
      f.close();
    }
  });
}

test('pre-debit and settlement acknowledgements gate ledger access and hide the result while owned', async () => {
  const f = fixture(),
    pre = deferred(),
    settle = deferred(),
    atPre = deferred(),
    atSettle = deferred();
  let saves = 0,
    released = false;
  try {
    f.hook((request, next) => {
      if (request.operation !== 'save') return next();
      if (++saves === 1) {
        atPre.resolve();
        return pre.promise.then(next);
      }
      atSettle.resolve();
      return settle.promise.then(next);
    });
    f.attach();
    const pending = f.view.replyAsync(READ, f.args).then((value) => {
      released = true;
      return value;
    });
    await atPre.promise;
    assert.equal(released, false);
    assert.equal(f.view.inspect().readers.returnedBytes, 16384);
    assert.equal(f.calls.at(-1).state.root.ledger.readCount, 0);
    assert.equal(f.view.reply(READ, f.args).code, 'context_recovery_busy');
    const beforeParallel = f.calls.length;
    assert.equal((await f.view.replyAsync(READ, f.args)).code, unavailable);
    assert.equal(f.calls.length, beforeParallel);
    assert.equal(
      f.runtime.begin({
        ...f.binding,
        history: [user('other')],
        previousResponseId: 'root-response',
      }).code,
      'context_recovery_busy'
    );
    pre.resolve();
    await atSettle.promise;
    assert.equal(released, false);
    assert.equal(f.calls.at(-1).state.root.ledger.readCount, 1);
    assert.equal(f.calls.at(-1).state.stagedSources[0].readComplete, true);
    settle.resolve();
    assert.equal(JSON.parse((await pending).text).page.text, exact);
    assert.ok(f.budget().returnedBytes < 16384);
  } finally {
    pre.resolve();
    settle.resolve();
    f.close();
  }
});

test('cancellation at each storage boundary cannot publish and confirmed settlement only changes counters', async () => {
  for (const phase of ['load', 'reserve', 'settle']) {
    const f = fixture(),
      gate = deferred(),
      entered = deferred();
    let saves = 0;
    try {
      f.hook((request, next) => {
        const current =
          request.operation === 'load' ? 'load' : ++saves === 1 ? 'reserve' : 'settle';
        if (current !== phase) return next();
        entered.resolve();
        return gate.promise.then(next);
      });
      f.attach();
      const pending = f.view.replyAsync(READ, f.args);
      await entered.promise;
      f.view.abort();
      gate.resolve();
      const result = await pending;
      assert.equal(result.code, unavailable);
      assert.equal(Object.hasOwn(result, 'text'), false);
      assert.equal(f.view.inspect().active, false);
      const budget = f.budget();
      assert.equal(budget.calls, phase === 'load' ? 0 : 1);
      if (phase === 'reserve') assert.equal(budget.returnedBytes, 16384);
      if (phase === 'settle') {
        assert.equal(budget.successfulReads, 1);
        assert.equal(budget.returnedBytes, f.latest().state.root.budget.returnedBytes);
      }
      const sibling = f.runtime.begin({
        ...f.binding,
        history: [user('sibling')],
        previousResponseId: 'root-response',
      });
      const index = JSON.parse((await sibling.replyAsync(LIST, {})).text);
      assert.equal(index.sources.length, 0);
    } finally {
      gate.resolve();
      f.close();
    }
  }
});

test('revoke, disable and close during a pending acknowledgement cannot revive a session', async () => {
  for (const action of ['revoke', 'disable', 'close', 'expire']) {
    const f = fixture(),
      gate = deferred(),
      entered = deferred();
    try {
      f.hook((request, next) => {
        if (request.operation !== 'save') return next();
        entered.resolve();
        return gate.promise.then(next);
      });
      f.attach();
      const pending = f.view.replyAsync(READ, f.args);
      await entered.promise;
      if (action === 'revoke') f.runtime.revoke('owner');
      if (action === 'disable') f.runtime.configure(false);
      if (action === 'close') f.runtime.close();
      if (action === 'expire') f.advance(100 + 24 * 60 * 60 * 1000);
      gate.resolve();
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(Object.hasOwn(result, 'text'), false);
      assert.equal(f.view.inspect().active, false);
      assert.equal(f.runtime.inspect().roots, 0);
    } finally {
      gate.resolve();
      f.close();
    }
  }
});

test('storage exceptions before or after a write retain debit, poison retries and never use sync fallback', async () => {
  for (const phase of ['load', 'reserve', 'settle']) {
    for (const written of [false, true]) {
      const f = fixture();
      let saves = 0;
      try {
        f.hook((request, next) => {
          const current =
            request.operation === 'load' ? 'load' : ++saves === 1 ? 'reserve' : 'settle';
          if (current !== phase) return next();
          if (written) next();
          throw new Error('private storage marker');
        });
        f.attach();
        const result = await f.view.replyAsync(READ, f.args);
        assert.deepEqual(result, { ok: false, code: unavailable });
        assert.equal(f.view.reply(READ, f.args).code, 'context_recovery_async_required');
        const count = f.calls.length;
        assert.equal((await f.view.replyAsync(READ, f.args)).code, unavailable);
        assert.equal(f.calls.length, count);
        assert.equal(f.budget().calls, phase === 'load' ? 0 : 1);
        if (phase !== 'load') assert.equal(f.budget().returnedBytes, 16384);
      } finally {
        f.close();
      }
    }
  }
});

test('malformed save acknowledgements and executable thenables never release bytes or execute getters', async () => {
  let invoked = 0;
  for (const bad of [
    null,
    {},
    { revision: '1' },
    { revision: 0 },
    { revision: 99 },
    { revision: 1, extra: true },
    {
      get revision() {
        invoked++;
        return 1;
      },
    },
    {
      get then() {
        invoked++;
        return () => {};
      },
    },
    {
      then() {
        invoked++;
      },
    },
  ]) {
    for (const settlement of [false, true]) {
      const f = fixture();
      let saves = 0;
      try {
        f.hook((request, next) => {
          if (request.operation !== 'save' || ++saves !== (settlement ? 2 : 1)) return next();
          next();
          return bad;
        });
        f.attach();
        assert.equal((await f.view.replyAsync(READ, f.args)).code, unavailable);
        assert.equal(f.budget().returnedBytes, 16384);
        const calls = f.calls.length;
        await f.view.replyAsync(READ, f.args);
        assert.equal(f.calls.length, calls);
      } finally {
        f.close();
      }
    }
  }
  assert.equal(invoked, 0);
});

test('loaded checkpoint metadata, content checksum, scope and accounting cannot override current authority', async () => {
  const changes = [
    (value) => {
      value.revision = 0;
    },
    (value) => {
      value.createdAt = -1;
    },
    (value) => {
      value.createdAt = 101;
    },
    (value) => {
      value.expiresAt++;
    },
    (value) => {
      value.extra = true;
    },
    (value) => {
      value.state.digest = 'a'.repeat(64);
    },
    (value) => {
      value.state.kind = 'recovery-root';
    },
    (value) => {
      value.state.root.principal = 'foreign';
      value.state = createRootCheckpoint(value.state.root, value.state.stagedSources);
    },
    (value) => {
      value.state.root.budget.calls++;
      value.state = createRootCheckpoint(value.state.root, value.state.stagedSources);
    },
    (value) => {
      value.state.stagedSources[0].output = 'changed';
      value.state = createRootCheckpoint(value.state.root, value.state.stagedSources);
    },
    (value) => {
      value.state.root.callCount = -1;
      value.state = createRootCheckpoint(value.state.root, value.state.stagedSources);
    },
    (value) => {
      value.state.root.binding.snapshots[0].committed = false;
      value.state = createRootCheckpoint(value.state.root, value.state.stagedSources);
    },
    (value) => {
      value.state.root.snapshots[0].id = 'hbs_' + 'a'.repeat(32);
      value.state = createRootCheckpoint(value.state.root, value.state.stagedSources);
    },
    (value) => {
      const source = value.state.stagedSources[0];
      source.output = 'Bearer abcdefghijklmnop';
      source.bytes = Buffer.byteLength(source.output);
      source.digest = createHash('sha256').update(source.output).digest('hex');
      source.coveredThrough = source.bytes;
      value.state = createRootCheckpoint(value.state.root, value.state.stagedSources);
    },
  ];
  for (const change of changes) {
    const f = fixture();
    try {
      f.attach();
      assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
      f.hook((request, next) => {
        const result = next();
        if (request.operation === 'load') change(result);
        return result;
      });
      assert.equal((await f.view.replyAsync(READ, f.args)).code, unavailable);
      assert.equal(f.budget().calls, 1);
      const calls = f.calls.length;
      await f.view.replyAsync(READ, f.args);
      assert.equal(f.calls.length, calls);
    } finally {
      f.close();
    }
  }
});

test('revision rollback and a competing CAS writer stop before reading and are never retried', async () => {
  for (const conflict of [false, true]) {
    const f = fixture();
    try {
      f.attach();
      await f.view.replyAsync(READ, f.args);
      f.hook((request, next) => {
        const result = next();
        if (request.operation === 'load') {
          if (conflict) f.latest().revision++;
          else result.revision--;
        }
        return result;
      });
      assert.equal((await f.view.replyAsync(READ, f.args)).code, unavailable);
      assert.equal(f.budget().calls, conflict ? 2 : 1);
      assert.equal(f.latest().state.root.ledger.readCount, 1);
    } finally {
      f.close();
    }
  }
});

test('invalid and mutable arguments retain parser errors and consume durable calls without getters', async () => {
  const f = fixture();
  let invoked = 0;
  try {
    f.attach();
    const invalid = await f.view.replyAsync(LIST, { limit: 0 });
    assert.equal(invalid.code, 'invalid_evidence_arguments');
    assert.equal(JSON.parse(invalid.text).field, 'limit');
    const unsafe = await f.view.replyAsync(LIST, {
      get limit() {
        invoked++;
        return 1;
      },
    });
    assert.equal(unsafe.code, 'invalid_evidence_arguments');
    const gate = deferred(),
      entered = deferred();
    f.hook((request, next) => {
      if (request.operation !== 'load') return next();
      entered.resolve();
      return gate.promise.then(next);
    });
    const args = { ...f.args };
    const pending = f.view.replyAsync(READ, args);
    await entered.promise;
    args.digest = 'b'.repeat(64);
    gate.resolve();
    assert.equal(JSON.parse((await pending).text).page.text, exact);
    assert.equal(f.budget().calls, 3);
    assert.equal(invoked, 0);
  } finally {
    f.close();
  }
});

test('durable task accounting spans independent rounds without resetting cumulative spend', async () => {
  const f = fixture();
  try {
    assert.equal(
      f.view.complete([{ role: 'assistant', content: 'done' }], [], 'budget-parent').ok,
      true
    );
    f.attach();
    for (let round = 0; round < 35; round++) {
      const view = f.runtime.begin({
        ...f.binding,
        history: [user('round-' + round)],
        previousResponseId: 'budget-parent',
      });
      assert.equal((await view.replyAsync(LIST, {})).ok, true);
      assert.equal(JSON.parse((await view.replyAsync(READ, f.args)).text).page.text, exact);
    }
    const budget = f.budget();
    assert.equal(budget.version, 2);
    assert.equal(budget.calls, 70);
    assert.equal(budget.successfulReads, 35);
    assert.deepEqual(
      JSON.parse(JSON.stringify(f.latest().state.root.budget)),
      JSON.parse(JSON.stringify(budget))
    );
    assert.equal(f.latest().expiresAt, f.checkpoint.root.expiresAt);
  } finally {
    f.close();
  }
});

test('empty originals and exhausted budgets keep their exact bounded semantics', async () => {
  const f = fixture({ output: '' });
  try {
    f.attach();
    assert.equal(JSON.parse((await f.view.replyAsync(READ, f.args)).text).page.text, '');
    for (let index = 1; index < 64; index++)
      assert.equal((await f.view.replyAsync(LIST, {})).ok, true);
    assert.equal((await f.view.replyAsync(LIST, {})).code, unavailable);
    assert.equal(f.budget().calls, 65);
    assert.equal(f.states.size, 1);
    assert.equal(await f.view.replyAsync('foreign-tool', {}), null);
  } finally {
    f.close();
  }
});

test('write-ahead staged bytes cannot be imported as a root or enumerated by a restored committed projection', async () => {
  const f = fixture();
  let restored;
  try {
    f.attach();
    assert.equal((await f.view.replyAsync(READ, f.args)).ok, true);
    const record = f.latest().state;
    assert.equal(parseRootCheckpoint(record, record.root).stagedSources[0].output, exact);
    assert.throws(() =>
      restoreContextRecoverySessions({ now: () => 200 }, [
        { binding: { ...f.binding, history: [] }, state: record },
      ])
    );
    restored = restoreContextRecoverySessions({ now: () => 200 }, [
      { binding: { ...f.binding, history: [] }, state: record.root },
    ]);
    const view = restored.begin({
      ...f.binding,
      history: [user('next')],
      previousResponseId: 'root-response',
    });
    assert.equal(JSON.parse(view.reply(LIST, {}).text).sources.length, 0);
    assert.equal(view.reply(READ, f.args).ok, false);
  } finally {
    restored?.close();
    f.close();
  }
});

test('trusted storage attachment rejects unknown, accessor, duplicate and closed capabilities safely', () => {
  const f = fixture();
  let invoked = 0;
  try {
    for (const storage of [
      null,
      {},
      { execute: 1 },
      {
        get execute() {
          invoked++;
          return () => {};
        },
      },
    ])
      assert.throws(() => attachContextRecoveryReaderStorage(f.runtime, storage), {
        code: unavailable,
      });
    assert.throws(() => attachContextRecoveryReaderStorage({}, f.storage), { code: unavailable });
    f.attach();
    assert.throws(f.attach, { code: unavailable });
    f.close();
    assert.throws(f.attach, { code: unavailable });
    assert.equal(invoked, 0);
  } finally {
    f.close();
  }
});

test('actual encrypted SQLite accepts the async session write-ahead record in one root and reopens exact staged data', async () => {
  const f = fixture(),
    database = new DatabaseSync(':memory:');
  const dataKey = randomBytes(32).toString('base64');
  let storage = createRecoverySqliteStore({ database, dataKey, now: () => 100 });
  let scope;
  try {
    f.attach({
      execute(request) {
        scope = request.scope;
        return storage.execute(request);
      },
    });
    assert.equal(JSON.parse((await f.view.replyAsync(READ, f.args)).text).page.text, exact);
    assert.equal(storage.execute({ operation: 'inspect' }).records, 1);
    f.close();
    storage.close();
    storage = createRecoverySqliteStore({ database, dataKey, now: () => 200 });
    const saved = storage.execute({ operation: 'load', scope });
    assert.equal(saved.state.stagedSources[0].output, exact);
    assert.equal(saved.state.root.budget.calls, 1);
    assert.equal(saved.state.root.budget.successfulReads, 1);
    assert.equal(saved.state.root.expiresAt, 100 + 24 * 60 * 60 * 1000);
  } finally {
    f.close();
    storage.close();
    database.close();
  }
});

test('root transactions retain four-scope capacity and reclaim only absolute-expired tracking', async () => {
  const f = fixture();
  try {
    f.attach();
    assert.equal((await f.view.replyAsync(LIST, {})).ok, true);
    for (let index = 1; index < 4; index++) {
      const root = f.runtime.begin({ ...f.binding, history: [user('isolated-' + index)] });
      assert.equal(
        root.complete([{ role: 'assistant', content: 'ready' }], [], 'response-' + index).ok,
        true
      );
      assert.equal((await root.replyAsync(LIST, {})).ok, true);
    }
    assert.equal(f.states.size, 4);
    f.root.withdraw();
    const fifth = f.runtime.begin({ ...f.binding, history: [user('fifth')] });
    fifth.complete([{ role: 'assistant', content: 'ready' }], [], 'response-fifth');
    const before = f.calls.length;
    assert.equal((await fifth.replyAsync(LIST, {})).code, unavailable);
    assert.equal(fifth.inspect().readers.calls, 0);
    assert.equal(f.calls.length, before);
    f.advance(100 + 24 * 60 * 60 * 1000);
    f.runtime.inspect();
    const fresh = f.runtime.begin({ ...f.binding, history: [user('after-expiry')] });
    fresh.complete([{ role: 'assistant', content: 'ready' }], [], 'response-fresh');
    assert.equal((await fresh.replyAsync(LIST, {})).ok, true);
    assert.equal(f.states.size, 1);
    assert.equal(fresh.inspect().readers.calls, 1);
  } finally {
    f.close();
  }
});

test('native storage promises ignore own then getters and reject constructor accessors safely', async () => {
  let invoked = 0;
  for (const badConstructor of [false, true]) {
    const f = fixture();
    try {
      f.hook((_request, next) => {
        const pending = Promise.resolve(next());
        Object.defineProperty(pending, badConstructor ? 'constructor' : 'then', {
          get() {
            invoked++;
            throw new Error('private promise marker');
          },
        });
        return pending;
      });
      f.attach();
      const result = await f.view.replyAsync(READ, f.args);
      if (badConstructor) assert.deepEqual(result, { ok: false, code: unavailable });
      else assert.equal(JSON.parse(result.text).page.text, exact);
    } finally {
      f.close();
    }
  }
  assert.equal(invoked, 0);
});

test('reader closure while storage is pending stops ledger work and subsequent calls', async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred();
  let reader;
  try {
    f.hook((request, next) => {
      if (request.operation !== 'save') return next();
      entered.resolve();
      return gate.promise.then(next);
    });
    reader = createRecoveryRootReader(f.storage, () =>
      acquireContextRecoveryRoot(f.runtime, f.root.snapshotId)
    );
    const pending = reader.reply(f.view, READ, f.args);
    await entered.promise;
    reader.close();
    gate.resolve();
    assert.deepEqual(await pending, { ok: false, code: unavailable });
    assert.equal(f.budget().returnedBytes, 16384);
    assert.equal(f.latest().state.root.ledger.readCount, 0);
    const calls = f.calls.length;
    assert.equal((await reader.reply(f.view, READ, f.args)).code, unavailable);
    assert.equal(f.calls.length, calls);
  } finally {
    gate.resolve();
    reader?.close();
    f.close();
  }
});

test('checkpoint validation rejects unsafe, duplicated and forged source data without executing hooks', () => {
  const f = fixture();
  let invoked = 0;
  try {
    for (const bad of [
      null,
      {},
      {
        ...f.checkpoint,
        get root() {
          invoked++;
          return {};
        },
      },
      {
        ...f.checkpoint,
        toJSON() {
          invoked++;
          return {};
        },
      },
      createRootCheckpoint(f.checkpoint.root, [
        ...f.checkpoint.stagedSources,
        ...f.checkpoint.stagedSources,
      ]),
      createRootCheckpoint({ ...f.checkpoint.root, snapshots: [] }, f.checkpoint.stagedSources),
      createRootCheckpoint({ ...f.checkpoint.root, kind: 'other' }, f.checkpoint.stagedSources),
    ])
      assert.throws(() => parseRootCheckpoint(bad, f.checkpoint.root));
    assert.throws(() =>
      createRootCheckpoint(
        {
          get rootId() {
            invoked++;
            return 'bad';
          },
        },
        []
      )
    );
    assert.equal(invoked, 0);
  } finally {
    f.close();
  }
});

test(
  'actual storage worker writes the session transaction and reopens the encrypted unpublished checkpoint',
  { timeout: 120000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-root-reader-'));
    const f = fixture({ now: Date.now });
    let storage, scope;
    try {
      if (process.platform !== 'win32') {
        await assert.rejects(
          openContextRecoveryStorage({ directory: path.join(directory, 'store') }),
          { code: unavailable }
        );
        return;
      }
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'store') });
      const operations = [];
      assert.equal(supportsRecoverySourcePages(storage.execute), true);
      assert.equal(supportsRecoveryReaderSettlement(storage.execute), true);
      assert.equal(supportsRecoveryReferenceWrites(storage.execute), true);
      f.attach({
        execute: declareRecoveryReferenceWrites(
          declareRecoveryReaderSettlement(
            declareRecoverySourcePages((request) => {
              operations.push(request.operation);
              scope = request.scope;
              return storage.execute(request);
            })
          )
        ),
      });
      const value = await f.view.replyAsync(READ, f.args);
      assert.equal(JSON.parse(value.text).page.text, exact);
      assert.deepEqual(operations.slice(0, 4), [
        'load',
        'save-reference',
        'read-source',
        'settle-reader',
      ]);
      const savedBudget = f.budget();
      assert.equal((await f.runtime.shutdownAsync()).ok, true);
      await storage.close();
      storage = undefined;
      assert.equal(
        fs
          .readFileSync(path.join(directory, 'store', 'checkpoint.sqlite'))
          .includes(Buffer.from(exact)),
        false
      );
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'store') });
      const loaded = await storage.execute({ operation: 'load', scope });
      assert.equal(loaded.state.kind, 'recovery-write-ahead');
      assert.equal(loaded.state.stagedSources[0].output, exact);
      assert.equal(JSON.stringify(loaded.state.root.budget), JSON.stringify(savedBudget));
      assert.equal(loaded.state.root.expiresAt, f.checkpoint.root.expiresAt);
      assert.equal((await storage.execute({ operation: 'inspect' })).records, 1);
    } finally {
      f.close();
      try {
        await storage?.close();
      } finally {
        removeSyntheticDirectory(directory);
      }
    }
  }
);

test('combined durable READ keeps exact budgets and progress with one fewer real SQLite COMMIT', async (t) => {
  let prior;
  for (const combined of [false, true]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-combined-reader-'));
    let time = 100;
    const f = fixture({ now: () => time });
    const storage = pagedStorage(
      f,
      undefined,
      true,
      false,
      true,
      true,
      false,
      combined,
      path.join(directory, 'checkpoint.sqlite'),
      () => ++time
    );
    try {
      assert.equal((await f.view.replyAsync(LIST, {})).ok, true);
      let commits = 0;
      const exec = storage.database.exec.bind(storage.database);
      t.mock.method(storage.database, 'exec', (sql) => {
        if (sql === 'COMMIT') {
          assert.ok(
            fs.statSync(path.join(directory, 'checkpoint.sqlite-journal')).size > 512,
            'every counted commit has a real DELETE rollback journal'
          );
          commits++;
        }
        return exec(sql);
      });
      const start = storage.operations.length;
      const result = await f.view.replyAsync(READ, f.args);
      assert.equal(result.ok, true);
      assert.equal(commits, combined ? 2 : 3);
      assert.deepEqual(
        storage.operations.slice(start).map((request) => request.operation),
        combined
          ? ['save-reference-state', 'read-source-and-settle']
          : ['save-reference-state', 'read-source', 'settle-reader']
      );
      t.mock.restoreAll();
      assert.equal(storage.witness().maxTime, time);
      const stored = storage.load();
      const evidence = {
        text: JSON.parse(result.text).page.text,
        budget: stored.state.root.budget,
        progress: stored.state.root.ledger.sources.map(({ coveredThrough, readComplete }) => ({
          coveredThrough,
          readComplete,
        })),
        revision: stored.revision,
        expiresAt: stored.expiresAt,
      };
      if (prior) assert.deepEqual(evidence, prior);
      prior = evidence;
    } finally {
      f.close();
      storage.close();
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('hpm-combined-reader-'));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('combined READ cannot run before debit ACK or expose a cancelled, corrupt or uncertain settlement', async () => {
  for (const mode of [
    'success',
    'predebit',
    'cancel',
    'revision',
    'budget',
    'progress',
    'lost-ack',
    'expired',
    'future-time',
    'rewind-time',
  ]) {
    const f = fixture();
    const gate = deferred(),
      entered = deferred();
    let armed = false,
      blocked = false,
      finished = false;
    const storage = pagedStorage(
      f,
      async (request, next) => {
        if (!armed) return next();
        if (request.operation === 'save-reference-state' && !blocked) {
          blocked = true;
          const result = mode === 'predebit' ? null : next();
          entered.resolve();
          await gate.promise;
          if (mode === 'predebit') throw new Error('synthetic missing debit ACK');
          return result;
        }
        const result = next();
        if (request.operation === 'read-source-and-settle') {
          if (mode === 'cancel') f.runtime.configure(false);
          if (mode === 'expired') f.advance(100 + 24 * 60 * 60 * 1000);
          if (mode === 'future-time' || mode === 'rewind-time')
            return {
              ...result,
              settlement: { ...result.settlement, observedAt: mode === 'future-time' ? 101 : 99 },
            };
          if (mode === 'revision') return { ...result, revision: result.revision + 1 };
          if (mode === 'budget')
            return {
              ...result,
              settlement: {
                ...result.settlement,
                budget: {
                  ...result.settlement.budget,
                  returnedBytes: result.settlement.budget.returnedBytes + 1,
                },
              },
            };
          if (mode === 'progress')
            return {
              ...result,
              settlement: {
                ...result.settlement,
                ledger: {
                  ...result.settlement.ledger,
                  readCount: result.settlement.ledger.readCount + 1,
                },
              },
            };
          if (mode === 'lost-ack') throw new Error('synthetic missing settlement ACK');
        }
        return result;
      },
      true,
      false,
      true,
      true,
      false,
      true
    );
    try {
      assert.equal((await f.view.replyAsync(LIST, {})).ok, true);
      const before = storage.operations.length;
      armed = true;
      const pending = f.view.replyAsync(READ, f.args);
      void pending.then(() => {
        finished = true;
      });
      await entered.promise;
      assert.equal(finished, false);
      assert.deepEqual(
        storage.operations.slice(before).map((request) => request.operation),
        ['save-reference-state']
      );
      gate.resolve();
      const result = await pending;
      assert.equal(result.ok, mode === 'success');
      if (mode !== 'success') assert.equal(result.text, undefined);
      assert.equal(
        storage.operations
          .slice(before)
          .filter((request) => request.operation === 'read-source-and-settle').length,
        mode === 'predebit' ? 0 : 1
      );
      assert.equal(
        storage.operations
          .slice(before)
          .some(
            (request) =>
              request.operation === 'read-source' || request.operation === 'settle-reader'
          ),
        false,
        'a failed compound operation is never retried with the old protocol'
      );
    } finally {
      gate.resolve();
      f.close();
      storage.close();
    }
  }
});
