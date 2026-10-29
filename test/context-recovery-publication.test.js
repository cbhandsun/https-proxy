'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const {
  createContextRecoverySessions,
  acquireContextRecoveryRoot,
  attachContextRecoveryStorage,
  exportContextRecoveryRoot,
  exportContextRecoveryRootMetadata,
} = require('../lib/proxy/context-recovery-sessions');
const { createRecoveryRootStorage } = require('../lib/proxy/context-recovery-root-storage');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { createRecoveryRootPublication } = require('../lib/proxy/context-recovery-root-publication');
const { createRootCheckpoint } = require('../lib/proxy/context-recovery-root-checkpoint');
const { createReferenceState } = require('../lib/proxy/context-recovery-reference-state');
const {
  declareRecoverySourcePages,
  declareRecoveryReaderSettlement,
  declareRecoveryReferenceStates,
  supportsRecoveryReferenceStates,
  declareRecoveryReferenceAdmission,
  supportsRecoveryReferenceAdmission,
} = require('../lib/proxy/context-recovery-storage-contract');
const { invokeRecoveryPublication } = require('../lib/proxy/context-recovery-publication');
const { tryHandleContextRecoveryHttp } = require('../lib/proxy/context-recovery-http-entry');
const { installContextRecoveryObserver } = require('../lib/proxy/context-recovery-observer');
const { READ_EVIDENCE_TOOL: READ } = require('../lib/proxy/context-evidence-tools');

const original = '原文\r\nélève🙂';
const copy = (value) => globalThis.structuredClone(value);
const user = (content) => ({ role: 'user', content });
const failure = 'context_recovery_storage_unavailable';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function removeSyntheticDirectory(directory) {
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('hpm-root-publication-')
  )
    throw new Error('Unsafe synthetic cleanup target');
  fs.rmSync(target, { recursive: true, force: true });
}
function completion(kind, calls = []) {
  if (kind === 'responses')
    return {
      id: 'final-response',
      status: 'completed',
      usage: { input_tokens: 2, output_tokens: 1 },
      output: calls.length
        ? calls.map(({ id, name, args }) => ({
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
      id: 'final-response',
      role: 'assistant',
      stop_reason: calls.length ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 2, output_tokens: 1 },
      content: calls.length
        ? calls.map(({ id, name, args }) => ({ type: 'tool_use', id, name, input: args }))
        : [{ type: 'text', text: 'done' }],
    };
  return {
    id: 'final-response',
    usage: { prompt_tokens: 2, completion_tokens: 1 },
    choices: [
      {
        index: 0,
        finish_reason: calls.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: 'done',
          ...(calls.length
            ? {
                tool_calls: calls.map(({ id, name, args }) => ({
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
async function fixture(kind = 'chat', worker = null) {
  let hook,
    time = 100;
  const records = new Map(),
    requests = [];
  const storage = {
    execute(request) {
      requests.push(copy(request));
      const next = () => {
        if (worker) return worker.execute(request);
        if (request.operation === 'load') return copy(records.get(request.scope) ?? null);
        assert.equal(request.operation, 'save');
        const prior = records.get(request.scope);
        assert.equal(request.expectedRevision, prior?.revision ?? 0);
        const revision = request.expectedRevision + 1;
        records.set(request.scope, {
          revision,
          createdAt: prior?.createdAt ?? time,
          expiresAt: request.expiresAt,
          state: copy(request.state),
        });
        return { revision };
      };
      return hook ? hook(request, next) : next();
    },
  };
  const runtime = createContextRecoverySessions({ now: worker ? Date.now : () => time });
  if (worker && supportsRecoveryReferenceStates(worker.execute)) {
    declareRecoverySourcePages(storage.execute);
    declareRecoveryReaderSettlement(storage.execute);
    declareRecoveryReferenceStates(storage.execute);
    if (supportsRecoveryReferenceAdmission(worker.execute))
      declareRecoveryReferenceAdmission(storage.execute);
  }
  runtime.configure(true);
  attachContextRecoveryStorage(runtime, storage);
  const binding = { principal: 'owner', protocol: kind, target: 'target' };
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
  const root = runtime.begin({ ...binding, history: [user('q')] });
  assert.equal(
    (
      await root.completeObservedAsync(
        [external],
        [{ callId: 'external', toolName: 'lookup', arguments: {}, output: '', completed: true }],
        'root-response'
      )
    ).ok,
    true
  );
  const result =
    kind === 'responses'
      ? { type: 'function_call_output', call_id: 'external', output: original }
      : kind === 'claude'
        ? {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'external', content: original }],
          }
        : { role: 'tool', tool_call_id: 'external', content: original };
  const history = [user('q'), external, result];
  const view = runtime.begin({ ...binding, history }, [{ callId: 'external', output: original }]);
  const owner = acquireContextRecoveryRoot(runtime, root.snapshotId);
  const checkpoint = owner.checkpoint(view);
  owner.release();
  const receipt = checkpoint.stagedSources[0];
  const id = view.snapshotId;
  const req = new EventEmitter(),
    res = new EventEmitter();
  const outcome = deferred();
  let allowed = true,
    rounds = 0;
  res.writeHead = (statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers;
    res.headersSent = true;
  };
  res.end = (wire) => {
    res.wire = wire;
    res.writableEnded = true;
    res.emit('finish');
    res.emit('close');
  };
  res.destroy = () => {
    res.destroyed = true;
    res.emit('close');
  };
  const body = { model: 'fixture', [kind === 'responses' ? 'input' : 'messages']: history };
  const args = { sourceId: receipt.sourceId, digest: receipt.digest };
  const options = {
    kind,
    session: view,
    observer: { detach: () => true },
    clientReq: req,
    clientRes: res,
    prepared: { buffer: Buffer.from(JSON.stringify(body)) },
    requestOptions: { headers: {} },
    authorized: () => allowed,
    stream: false,
    setActive() {},
    onOutcome: outcome.resolve,
    dispatch(request) {
      if (rounds === 1) {
        const page =
          kind === 'responses'
            ? JSON.parse(request.input.at(-1).output)
            : kind === 'claude'
              ? JSON.parse(request.messages.at(-1).content[0].content)
              : JSON.parse(request.messages.at(-1).content);
        assert.equal(page.page.text, original);
      }
      if (rounds === 2) {
        const history = request[kind === 'responses' ? 'input' : 'messages'];
        assert.ok(history.at(-1).content.includes(JSON.stringify(original).slice(1, -1)));
        assert.doesNotMatch(JSON.stringify(history), /read-original/);
        assert.deepEqual(request.tools ?? [], []);
      }
      const calls = rounds++ === 0 ? [{ id: 'read-original', name: READ, args }] : [];
      return {
        statusCode: 200,
        wire: Buffer.from(JSON.stringify(completion(kind, calls))),
        stream: false,
      };
    },
  };
  return {
    kind,
    runtime,
    root,
    view,
    id,
    binding,
    history,
    checkpoint,
    receipt,
    args,
    storage,
    records,
    requests,
    req,
    res,
    options,
    outcome: outcome.promise,
    hook: (fn) => {
      hook = fn;
    },
    advance: (value) => {
      time = value;
    },
    revoke: () => {
      allowed = false;
    },
    latest: () => [...records.values()][0],
    state: () =>
      [...records.values()][0].state.publications.find((entry) => entry.snapshotId === id)?.state,
    start: () => assert.equal(tryHandleContextRecoveryHttp(options), true),
    close: () => runtime.close(),
  };
}
function observedOutput(kind) {
  const response = completion(kind);
  return kind === 'responses'
    ? response.output
    : kind === 'claude'
      ? [{ role: 'assistant', content: response.content }]
      : [response.choices[0].message];
}

test('warm publication authenticates new source payloads inside its first durable write', async () => {
  for (const [kind, observed] of ['chat', 'responses', 'claude'].flatMap((kind) => [
    [kind, false],
    [kind, true],
  ])) {
    const database = new DatabaseSync(':memory:');
    const engine = createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
    });
    const f = await fixture(kind, engine);
    try {
      const result = observed
        ? await f.view.completeObservedAsync(observedOutput(kind))
        : await f.view.completeAsync(observedOutput(kind));
      assert.deepEqual(result, { ok: true });
      assert.equal(
        f.requests.filter((request) => request.operation === 'load-reference').length,
        1
      );
      const saves = f.requests.filter((request) => request.operation === 'save-reference-state');
      assert.equal(saves.length, 2);
      assert.equal(saves[0].admission, undefined);
      assert.ok(saves[1].admission);
      assert.equal(saves[1].payloads.length, 1);
      assert.equal(saves[1].payloads[0].output, original);
      if (!observed) {
        assert.equal((await f.view.startPublicationAsync()).ok, true);
        assert.equal((await f.view.finishPublicationAsync()).ok, true);
        const later = f.requests
          .filter((request) => request.operation === 'save-reference-state')
          .slice(2);
        assert.equal(later.length, 2);
        for (const request of later) {
          assert.equal(request.admission, undefined);
          assert.deepEqual(request.payloads, []);
        }
      }
      const durable = engine.execute({ operation: 'load', scope: saves[1].scope });
      assert.equal(durable.state.root.ledger.sources[0].output, original);
      assert.equal(
        durable.state.publications.find((entry) => entry.snapshotId === f.id).state,
        'transport-finished'
      );
      assert.equal(durable.state.root.budget.calls, 0);
    } finally {
      await f.runtime.shutdownAsync();
      engine.close();
      database.close();
    }
  }
});

test('unmarked reference storage retains the publication load before save', async () => {
  const database = new DatabaseSync(':memory:');
  const engine = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
  });
  const legacy = { execute: declareRecoveryReferenceStates((request) => engine.execute(request)) };
  const f = await fixture('chat', legacy);
  try {
    assert.equal((await f.view.completeObservedAsync(observedOutput('chat'))).ok, true);
    assert.equal(f.requests.filter((request) => request.operation === 'load-reference').length, 2);
    assert.equal(
      f.requests.some((request) => request.admission),
      false
    );
  } finally {
    await f.runtime.shutdownAsync();
    engine.close();
    database.close();
  }
});

test('combined publication failures deny acknowledgement without retrying or resending payloads', async () => {
  for (const fault of ['budget', 'publications', 'revision', 'ciphertext', 'payload', 'ack']) {
    const database = new DatabaseSync(':memory:');
    const engine = createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
    });
    const f = await fixture('chat', engine);
    let attempts = 0;
    f.hook((request, next) => {
      if (!request.admission) return next();
      attempts++;
      if (fault === 'budget') request.admission.metadata.budget.calls++;
      if (fault === 'publications') request.admission.publications[0].state = 'withdrawn';
      if (fault === 'revision') request.expectedRevision++;
      if (fault === 'ciphertext') {
        const row = database.prepare('SELECT envelope FROM recovery_state').get();
        const corrupt = Buffer.from(row.envelope);
        corrupt[corrupt.length - 1] ^= 1;
        database.prepare('UPDATE recovery_state SET envelope=?').run(corrupt);
      }
      if (fault === 'payload') request.payloads = [];
      const result = next();
      return fault === 'ack' ? { revision: result.revision + 1 } : result;
    });
    try {
      assert.deepEqual(await f.view.completeObservedAsync(observedOutput('chat')), {
        ok: false,
        code: failure,
      });
      assert.equal(attempts, 1);
      assert.equal(
        f.requests.filter((request) => request.operation === 'load-reference').length,
        1
      );
      assert.equal(f.requests.filter((request) => request.admission).length, 1);
    } finally {
      await f.runtime.shutdownAsync();
      engine.close();
      database.close();
    }
  }
});

test('combined publication waits for durable ACK and disabling while pending cannot revive it', async () => {
  for (const disable of [false, true]) {
    const database = new DatabaseSync(':memory:');
    const engine = createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
    });
    const f = await fixture('chat', engine);
    const entered = deferred(),
      release = deferred();
    let settled = false;
    f.hook(async (request, next) => {
      if (request.admission) {
        entered.resolve();
        await release.promise;
      }
      return next();
    });
    try {
      const pending = f.view.completeObservedAsync(observedOutput('chat'));
      void pending.then(() => {
        settled = true;
      });
      await entered.promise;
      assert.equal(settled, false);
      assert.throws(() => exportContextRecoveryRoot(f.runtime, f.root.snapshotId));
      if (disable) f.runtime.configure(false);
      release.resolve();
      assert.equal((await pending).ok, !disable);
    } finally {
      release.resolve();
      await f.runtime.shutdownAsync();
      engine.close();
      database.close();
    }
  }
});

function hold(f, phase, afterWrite = false) {
  const entered = deferred(),
    release = deferred();
  let held = false;
  f.hook((request, next) => {
    if (
      !held &&
      request.operation === 'save' &&
      request.state.publications.some((entry) => entry.snapshotId === f.id && entry.state === phase)
    ) {
      held = true;
      const result = afterWrite ? next() : null;
      entered.resolve();
      return release.promise.then(() => (afterWrite ? result : next()));
    }
    return next();
  });
  return { entered: entered.promise, release: release.resolve };
}

test('reference publication evicts only after durable prepare and stops root I/O on eviction failure', async () => {
  for (const inject of [false, true]) {
    const database = new DatabaseSync(':memory:');
    const engine = createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
    });
    const f = await fixture('chat', engine);
    const transactions = createRecoveryRootStorage(f.storage);
    let owner;
    const publication = createRecoveryRootPublication({
      transactions,
      acquire() {
        owner = acquireContextRecoveryRoot(f.runtime, f.root.snapshotId);
        return {
          ...owner,
          evictPersisted(session, ack) {
            if (inject) throw new Error('synthetic private artifact failure');
            return owner.evictPersisted(session, ack);
          },
        };
      },
      drop(session) {
        session.abort();
      },
    });
    try {
      const result = await publication.prepare(f.view, [{ role: 'assistant', content: 'done' }]);
      assert.equal(result.ok, !inject);
      const save = f.requests.findLast((request) => request.operation === 'save-reference-state');
      const durable = await engine.execute({ operation: 'load', scope: save.scope });
      assert.equal(durable.state.root.ledger.sources[0].output, original);
      assert.equal(
        durable.state.publications.find((entry) => entry.snapshotId === f.id).state,
        'prepared'
      );
      if (inject) {
        const calls = f.requests.length;
        const reference = await engine.execute({ operation: 'load-reference', scope: save.scope });
        await assert.rejects(
          transactions.begin(reference.reference, () => []),
          { code: failure }
        );
        assert.equal(f.requests.length, calls);
      } else {
        assert.throws(() => owner.checkpoint(f.view));
        assert.equal((await publication.sending(f.view)).ok, true);
        assert.equal((await publication.finished(f.view)).ok, true);
      }
    } finally {
      publication.close();
      owner?.release();
      await f.runtime.shutdownAsync();
      transactions.close();
      engine.close();
      database.close();
    }
  }
});

for (const kind of ['chat', 'responses', 'claude']) {
  test(
    `${kind}: real HTTP runner waits for all publication ACKs and preserves private read history`,
    { timeout: 10000 },
    async () => {
      const f = await fixture(kind);
      try {
        const prepared = hold(f, 'prepared');
        f.start();
        await prepared.entered;
        assert.equal(f.res.headersSent, undefined);
        assert.throws(() => exportContextRecoveryRoot(f.runtime, f.root.snapshotId));
        assert.equal(f.view.complete([]).code, 'context_recovery_busy');
        prepared.release();
        const outcome = await f.outcome;
        assert.equal(outcome.ok, true);
        assert.equal(f.res.statusCode, 200);
        assert.equal(f.state(), 'transport-finished');
        const root = f.latest().state.root;
        assert.equal(root.ledger.sources[0].output, original);
        assert.equal(root.budget.calls, 1);
        assert.equal(root.snapshots.length, 2);
        const tail = root.history.entries.at(-1).tail;
        const retained =
          kind === 'responses'
            ? tail.find(
                (item) => item.type === 'function_call_output' && item.call_id === 'read-original'
              ).output
            : kind === 'claude'
              ? tail
                  .flatMap((item) => item.content ?? [])
                  .find(
                    (item) => item.type === 'tool_result' && item.tool_use_id === 'read-original'
                  ).content
              : tail.find((item) => item.role === 'tool' && item.tool_call_id === 'read-original')
                  .content;
        assert.equal(JSON.parse(retained).page.text, original);
        assert.equal(f.req.listenerCount('aborted'), 0);
        assert.equal(f.res.listenerCount('close'), 0);
        assert.equal(f.res.listenerCount('error'), 0);
      } finally {
        f.close();
      }
    }
  );
}

test(
  'sending ACK gates bytes; finish ACK holds ownership despite normal finish then close',
  { timeout: 10000 },
  async () => {
    for (const phase of ['sending', 'transport-finished']) {
      const f = await fixture();
      try {
        const blocked = hold(f, phase);
        let outcomes = 0;
        f.options.onOutcome = (value) => {
          outcomes++;
          f.options.result = value;
        };
        f.start();
        await blocked.entered;
        assert.equal(outcomes, 0);
        assert.equal(f.res.statusCode, phase === 'sending' ? undefined : 200);
        assert.throws(() => acquireContextRecoveryRoot(f.runtime, f.root.snapshotId));
        blocked.release();
        await flush();
        assert.equal(outcomes, 1);
        assert.equal(f.options.result.ok, true);
        assert.equal(f.state(), 'transport-finished');
      } finally {
        f.close();
      }
    }
  }
);

test(
  'cancel or revoke at each durable publication boundary never produces a late success',
  { timeout: 10000 },
  async () => {
    for (const phase of ['prepared', 'sending', 'transport-finished']) {
      for (const invalidation of ['cancel', 'revoke']) {
        const f = await fixture();
        try {
          const blocked = hold(f, phase, true);
          f.start();
          await blocked.entered;
          if (invalidation === 'cancel') f.req.emit('aborted');
          else f.revoke();
          blocked.release();
          const result = await f.outcome;
          assert.equal(result.ok, false, `${phase}/${invalidation}`);
          assert.equal(f.state(), phase === 'sending' ? 'uncertain' : 'withdrawn');
          assert.equal(f.view.inspect().active, false);
          assert.equal((await f.view.finishPublicationAsync()).ok, false);
          if (phase !== 'transport-finished') assert.notEqual(f.res.statusCode, 200);
        } finally {
          f.close();
        }
      }
    }
  }
);

test(
  'write error, partial close and ACK failure have no replay or memory fallback',
  { timeout: 10000 },
  async () => {
    for (const mode of ['write-error', 'partial-close', 'save-failure', 'invalid-ack']) {
      const f = await fixture();
      try {
        if (mode === 'write-error')
          f.res.end = () => {
            throw new Error('private wire content');
          };
        if (mode === 'partial-close')
          f.res.end = () => {
            f.res.emit('close');
          };
        if (['save-failure', 'invalid-ack'].includes(mode))
          f.hook((request, next) => {
            const result = next();
            if (
              request.operation === 'save' &&
              request.state.publications.some(
                (entry) => entry.snapshotId === f.id && entry.state === 'prepared'
              )
            ) {
              if (mode === 'save-failure') throw new Error('private storage content');
              return { revision: result.revision + 1 };
            }
            return result;
          });
        let dispatches = 0;
        const dispatch = f.options.dispatch;
        f.options.dispatch = (...args) => {
          dispatches++;
          return dispatch(...args);
        };
        f.start();
        const outcome = await f.outcome;
        assert.equal(outcome.ok, false);
        assert.equal(dispatches, 3);
        assert.equal(f.view.inspect().active, false);
        assert.equal((await f.view.replyAsync(READ, f.args)).ok, false);
        assert.doesNotMatch(JSON.stringify(outcome), /private/);
        if (mode === 'write-error' || mode === 'partial-close')
          assert.equal(f.state(), 'uncertain');
        else assert.notEqual(f.res.statusCode, 200);
      } finally {
        f.close();
      }
    }
  }
);

test('immediate withdrawal during finish persistence records withdrawn after the final ACK', async () => {
  const f = await fixture();
  try {
    const blocked = hold(f, 'transport-finished');
    f.start();
    await blocked.entered;
    const cleanup = f.view.withdrawAsync();
    blocked.release();
    assert.equal((await cleanup).ok, true);
    assert.equal((await f.outcome).ok, false);
    assert.equal(f.state(), 'withdrawn');
    assert.equal(f.view.inspect().active, false);
  } finally {
    f.close();
  }
});

test('completed journal survives later durable reads and withdrawal persists current accounting', async () => {
  const f = await fixture();
  try {
    f.start();
    assert.equal((await f.outcome).ok, true);
    const result = await f.view.replyAsync(READ, f.args);
    assert.equal(result.ok, true);
    assert.equal(f.state(), 'transport-finished');
    assert.equal(f.latest().state.root.budget.calls, 2);
    assert.equal((await f.view.withdrawAsync()).ok, true);
    assert.equal(f.state(), 'withdrawn');
    assert.equal(f.latest().state.root.budget.calls, 2);
    assert.equal((await f.view.completeAsync([])).ok, false);
  } finally {
    f.close();
  }
});

test('full attachment disables sync commit, pins private identity and holds the lease through cancelled saves', async () => {
  const f = await fixture();
  try {
    assert.equal(f.view.complete([]).code, 'context_recovery_async_required');
    assert.equal(f.view.completeCompaction({}).code, 'context_recovery_async_required');
    f.view.snapshotId = 'hbs_' + 'f'.repeat(32);
    const blocked = hold(f, 'prepared');
    const pending = f.view.completeAsync([{ role: 'assistant', content: 'done' }]);
    await blocked.entered;
    const withdrawal = f.view.withdrawAsync();
    assert.equal(f.view.inspect().active, false);
    assert.throws(() => acquireContextRecoveryRoot(f.runtime, f.root.snapshotId));
    blocked.release();
    assert.equal((await pending).ok, false);
    assert.equal((await withdrawal).ok, true);
    assert.equal(f.state(), 'withdrawn');
    assert.equal(
      f.latest().state.publications.some((entry) => entry.snapshotId === f.view.snapshotId),
      false
    );
  } finally {
    f.close();
  }
});

test('close, expiry, disable and root revocation during prepare cannot revive publication', async () => {
  for (const invalidate of [
    (f) => f.close(),
    (f) => {
      assert.equal(f.latest().state.root.expiresAt, 86400100);
      f.advance(86400100);
    },
    (f) => f.runtime.configure(false),
    (f) => f.runtime.revoke('owner'),
  ]) {
    const f = await fixture();
    try {
      const blocked = hold(f, 'prepared', true);
      const pending = f.view.completeAsync([{ role: 'assistant', content: 'done' }]);
      await blocked.entered;
      invalidate(f);
      blocked.release();
      assert.equal((await pending).ok, false);
      assert.equal((await f.view.startPublicationAsync()).ok, false);
      assert.equal(f.view.inspect().active, false);
    } finally {
      f.close();
    }
  }
});

test('ordinary observer records capture after local finish and consumes failed durable capture', async () => {
  for (const failing of [false, true]) {
    const f = await fixture();
    try {
      const blocked = hold(f, 'transport-finished');
      if (failing)
        f.hook((request) => {
          assert.equal(f.res.writableEnded, true);
          if (request.operation === 'load') throw new Error('private capture detail');
          throw new Error('unexpected save');
        });
      f.res.statusCode = 200;
      f.res.getHeader = (name) => (name === 'content-type' ? 'application/json' : undefined);
      f.res.write = () => true;
      installContextRecoveryObserver(f.res, 'chat', f.view);
      f.res.end(Buffer.from(JSON.stringify(completion('chat'))));
      assert.equal(f.res.writableEnded, true);
      if (failing) {
        await flush();
        assert.equal(f.view.inspect().active, false);
      } else {
        await blocked.entered;
        assert.throws(() => acquireContextRecoveryRoot(f.runtime, f.root.snapshotId));
        blocked.release();
        await flush();
        assert.equal(f.state(), 'transport-finished');
      }
    } finally {
      f.close();
    }
  }
});

test('publication boundary rejects getters, non-native thenables and inherited action names without execution', async () => {
  let executed = 0;
  const getter = () => {
    executed++;
    throw new Error('private getter');
  };
  for (const session of [
    Object.defineProperty({}, 'completeAsync', { get: getter }),
    { completeAsync: () => Object.defineProperty({}, 'ok', { get: getter }) },
    { completeAsync: () => ({ then: getter }) },
    { completeAsync: () => ({ ok: false }) },
    { completeAsync: () => Promise.resolve({ ok: false }) },
    {
      completeAsync: () => {
        throw new Error('private method');
      },
    },
  ])
    await assert.rejects(invokeRecoveryPublication(session, 'prepare'), {
      message: 'Recovery publication unavailable',
    });
  for (const action of ['toString', '__proto__', 'constructor', 'missing'])
    await assert.rejects(invokeRecoveryPublication({}, action), {
      message: 'Recovery publication unavailable',
    });
  assert.equal(executed, 0);
  assert.deepEqual(await invokeRecoveryPublication({ complete: () => ({ ok: true }) }, 'prepare'), {
    ok: true,
  });
  assert.deepEqual(await invokeRecoveryPublication({ withdraw() {} }, 'withdraw'), { ok: true });
  assert.deepEqual(await invokeRecoveryPublication({}, 'sending'), { ok: true });
  const promise = Promise.resolve({ ok: true });
  Object.defineProperty(promise, 'then', { get: getter });
  assert.deepEqual(await invokeRecoveryPublication({ completeAsync: () => promise }, 'prepare'), {
    ok: true,
  });
  assert.equal(executed, 0);
});

test('journal rejects phase rollback, terminal revival, identity changes and tampered loaded state', async () => {
  const f = await fixture();
  const service = createRecoveryRootStorage(f.storage);
  try {
    const checkpoint = createRootCheckpoint(f.checkpoint.root, []);
    const transaction = await service.begin(checkpoint);
    for (const malformed of [null, [], {}, { root: {} }]) {
      await assert.rejects(service.begin(malformed), { code: failure });
      await assert.rejects(transaction.save(malformed), { code: failure });
    }
    const id = f.root.snapshotId;
    // The existing root was observed as transport-finished before this service opened.
    for (const state of ['prepared', 'sending', 'uncertain'])
      await assert.rejects(transaction.save(checkpoint, { snapshotId: id, state }), {
        code: failure,
      });
    await transaction.save(checkpoint, { snapshotId: id, state: 'withdrawn' });
    for (const state of ['prepared', 'sending', 'transport-finished', 'uncertain'])
      await assert.rejects(transaction.save(checkpoint, { snapshotId: id, state }), {
        code: failure,
      });
    const changed = copy(checkpoint);
    changed.root.principal = 'other-owner';
    const candidate = createRootCheckpoint(changed.root, changed.stagedSources);
    await assert.rejects(transaction.save(candidate), { code: failure });
    f.hook((request, next) => {
      const result = next();
      if (request.operation === 'load') result.state.publications[0].state = 'prepared';
      return result;
    });
    await assert.rejects(service.begin(checkpoint), { code: failure });
  } finally {
    service.close();
    f.close();
  }
});

test('publication failures cannot bypass error reporting when asynchronous withdrawal also fails', async () => {
  const { contextRecoveryDiagnostics } = require('../lib/proxy/context-recovery-diagnostics');
  const f = await fixture();
  try {
    contextRecoveryDiagnostics.configure(true);
    const before = contextRecoveryDiagnostics.inspect({}).counters.chat.publicationCleanupFailed;
    f.view.withdrawAsync = async () => {
      throw new Error('private cleanup content');
    };
    f.res.end = () => {
      throw new Error('private send content');
    };
    f.start();
    assert.equal((await f.outcome).ok, false);
    assert.equal(
      contextRecoveryDiagnostics.inspect({}).counters.chat.publicationCleanupFailed,
      before + 1
    );
    assert.equal(f.req.listenerCount('aborted'), 0);
    assert.equal(f.res.listenerCount('error'), 0);
  } finally {
    f.close();
  }
});

test('publication state transitions reject every skipped phase and all terminal revival', async () => {
  const allowed = {
    unobserved: ['prepared', 'transport-finished', 'uncertain', 'withdrawn'],
    prepared: ['prepared', 'sending', 'uncertain', 'withdrawn'],
    sending: ['sending', 'transport-finished', 'uncertain', 'withdrawn'],
    'transport-finished': ['transport-finished', 'withdrawn'],
    uncertain: ['uncertain', 'withdrawn'],
    withdrawn: ['withdrawn'],
  };
  for (const [prior, nextStates] of Object.entries(allowed)) {
    for (const nextState of [
      'prepared',
      'sending',
      'transport-finished',
      'uncertain',
      'withdrawn',
    ]) {
      const f = await fixture();
      const service = createRecoveryRootStorage(f.storage);
      try {
        const saved = f.latest();
        saved.state = createRootCheckpoint(saved.state.root, saved.state.stagedSources, [
          { snapshotId: f.root.snapshotId, state: prior },
        ]);
        const checkpoint = createRootCheckpoint(f.checkpoint.root, []);
        const transaction = await service.begin(checkpoint);
        const update = transaction.save(checkpoint, {
          snapshotId: f.root.snapshotId,
          state: nextState,
        });
        if (nextStates.includes(nextState)) {
          await update;
          assert.equal(f.latest().state.publications[0].state, nextState);
        } else await assert.rejects(update, { code: failure });
      } finally {
        service.close();
        f.close();
      }
    }
  }
});

test('unknown, malformed, accessor and mutated publication arguments never grant commit authority', async () => {
  let executed = 0;
  const accessor = Object.defineProperty({}, 'content', {
    get() {
      executed++;
      return original;
    },
  });
  for (const output of [
    accessor,
    {
      toJSON() {
        executed++;
        return {};
      },
    },
    'x'.repeat(2 * 1024 * 1024 + 1),
  ]) {
    const f = await fixture();
    try {
      assert.equal((await f.view.completeAsync(output)).ok, false);
      assert.equal(f.state(), undefined);
      assert.equal(f.view.inspect().completed, false);
    } finally {
      f.close();
    }
  }
  await assert.rejects(
    invokeRecoveryPublication(
      {},
      {
        toString() {
          executed++;
          return 'prepare';
        },
      }
    ),
    { message: 'Recovery publication unavailable' }
  );
  assert.equal(executed, 0);
  const f = await fixture();
  try {
    const output = [{ role: 'assistant', content: 'done' }];
    const blocked = hold(f, 'prepared');
    const pending = f.view.completeAsync(output);
    await blocked.entered;
    output[0].content = 'mutated';
    blocked.release();
    assert.equal((await pending).ok, true);
    assert.equal((await f.view.startPublicationAsync()).ok, true);
    assert.equal((await f.view.finishPublicationAsync()).ok, true);
    assert.equal((await f.view.completeAsync(output)).ok, false);
    assert.throws(() => attachContextRecoveryStorage({}, f.storage), { code: failure });
    assert.throws(() => attachContextRecoveryStorage(f.runtime, f.storage), { code: failure });
  } finally {
    f.close();
  }
});

test('valid-checksum journal rewrites cannot roll back the private revision cache', async () => {
  const f = await fixture();
  try {
    f.start();
    assert.equal((await f.outcome).ok, true);
    f.hook((request, next) => {
      const value = next();
      if (request.operation === 'load') {
        const journal = value.state.publications.map((entry) => ({
          ...entry,
          state: entry.snapshotId === f.id ? 'prepared' : entry.state,
        }));
        value.state = createRootCheckpoint(value.state.root, value.state.stagedSources, journal);
      }
      return value;
    });
    assert.equal((await f.view.replyAsync(READ, f.args)).code, failure);
    const count = f.requests.length;
    assert.equal((await f.view.replyAsync(READ, f.args)).code, failure);
    assert.equal(f.requests.length, count);
  } finally {
    f.close();
  }
});

test(
  'actual encrypted worker reopens final publication journal, exact original and settled accounting',
  { timeout: 120000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-root-publication-'));
    let storage, f;
    try {
      if (process.platform !== 'win32') {
        await assert.rejects(
          openContextRecoveryStorage({ directory: path.join(directory, 'store') }),
          { code: failure }
        );
        return;
      }
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'store') });
      f = await fixture('responses', storage);
      f.start();
      assert.equal((await f.outcome).ok, true);
      assert.equal(
        f.requests.some((request) =>
          ['load', 'save', 'save-reference'].includes(request.operation)
        ),
        false
      );
      const saves = f.requests.filter((request) => request.operation === 'save-reference-state');
      assert.ok(saves.length >= 4);
      assert.equal(saves.flatMap((request) => request.payloads).length, 1);
      const before = await storage.execute({ operation: 'load-reference', scope: saves[0].scope });
      assert.equal(before.reference.kind, 'recovery-reference-state');
      const budget = exportContextRecoveryRootMetadata(f.runtime, f.root.snapshotId).metadata
        .budget;
      const scope = f.requests.at(-1).scope;
      assert.equal((await f.runtime.shutdownAsync()).ok, true);
      await storage.close();
      storage = undefined;
      assert.equal(
        fs
          .readFileSync(path.join(directory, 'store', 'checkpoint.sqlite'))
          .includes(Buffer.from(original)),
        false
      );
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'store') });
      const loaded = await storage.execute({ operation: 'load', scope });
      assert.equal(
        loaded.state.publications.find((entry) => entry.snapshotId === f.id).state,
        'transport-finished'
      );
      assert.equal(loaded.state.root.ledger.sources[0].output, original);
      assert.deepEqual(loaded.state.root.budget, budget);
      assert.equal(loaded.state.root.expiresAt, f.checkpoint.root.expiresAt);
      assert.equal((await storage.execute({ operation: 'inspect' })).records, 1);
    } finally {
      f?.close();
      try {
        await storage?.close();
      } finally {
        removeSyntheticDirectory(directory);
      }
    }
  }
);

const capacityRoot = (root, version) => {
  const value = copy(root);
  value.version = version;
  value.binding.format = version >= 8 ? 3 : 2;
  value.ledger.policy.maxEntries = version >= 8 ? 512 : 64;
  value.ledger.policy.maxBytes = (version >= 9 ? 16 : 4) * 1024 * 1024;
  return value;
};
function capacityJournal(rootId, count) {
  return [
    { snapshotId: rootId, state: 'transport-finished' },
    ...Array.from({ length: count - 1 }, (_, index) => ({
      snapshotId: 'hbs_' + (index + 1).toString(16).padStart(32, '0'),
      state: 'withdrawn',
    })),
  ];
}

test('version 8 actual session publication persists 512 snapshots and exact evidence through SQLite', async () => {
  const database = new DatabaseSync(':memory:');
  const engine = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  const runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  const input = { principal: 'owner', protocol: 'chat', target: 'target', history: [user('q')] };
  const first = runtime.begin(input);
  const tool = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'source', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  };
  try {
    assert.equal(
      first.complete(
        [tool],
        [{ callId: 'source', toolName: 'lookup', arguments: {}, output: '', completed: true }],
        'first'
      ).ok,
      true
    );
    const captured = runtime.begin(
      {
        ...input,
        history: [
          ...input.history,
          tool,
          { role: 'tool', tool_call_id: 'source', content: original },
        ],
      },
      [{ callId: 'source', output: original }]
    );
    assert.equal(
      captured.complete([{ role: 'assistant', content: 'saved' }], [], 'captured').ok,
      true
    );
    for (let index = 0; index < 509; index++) {
      const child = runtime.begin({
        ...input,
        history: [user('branch-' + index)],
        previousResponseId: 'captured',
      });
      assert.equal(
        child.complete([{ role: 'assistant', content: 'done' }], [], 'branch-' + index).ok,
        true
      );
    }
    attachContextRecoveryStorage(runtime, engine);
    const final = runtime.begin({
      ...input,
      history: [user('final')],
      previousResponseId: 'captured',
    });
    assert.equal(
      (
        await final.completeObservedAsync(
          [{ role: 'assistant', content: 'published' }],
          [],
          'final'
        )
      ).ok,
      true
    );
    const metadata = exportContextRecoveryRootMetadata(runtime, first.snapshotId);
    assert.equal(metadata.metadata.snapshots.length, 512);
    const source = metadata.metadata.ledger.sources[0];
    const reply = await final.replyAsync(READ, {
      sourceId: source.sourceId,
      digest: source.digest,
    });
    assert.equal(reply.ok, true);
    assert.equal(JSON.parse(reply.text).page.text, original);
    const scope = engine.execute({ operation: 'catalog' })[0].scope;
    const stored = engine.execute({ operation: 'load-reference', scope });
    assert.equal(stored.reference.publications.length, 512);
    assert.equal(stored.expiresAt, metadata.metadata.expiresAt);
    const service = createRecoveryRootStorage(engine);
    try {
      const current = exportContextRecoveryRootMetadata(runtime, first.snapshotId);
      const checkpoint = createReferenceState(current.metadata, current.stagedSources);
      const transaction = await service.begin(checkpoint, () => []);
      await transaction.save(checkpoint);
      assert.equal(
        engine.execute({ operation: 'load-reference', scope }).reference.publications.length,
        512
      );
    } finally {
      service.close();
    }
  } finally {
    runtime.close();
    engine.close();
    database.close();
  }
});

test('version 8 journals admit four roots of 512 on both authenticated load and save', async () => {
  const fixtures = [];
  let service;
  try {
    for (let index = 0; index < 4; index++) fixtures.push(await fixture());
    const first = fixtures[0];
    service = createRecoveryRootStorage(first.storage);
    for (const current of fixtures) {
      const checkpoint = createRootCheckpoint(
        current.checkpoint.root,
        [],
        capacityJournal(current.root.snapshotId, 512)
      );
      first.records.set(current.requests[0].scope, {
        ...copy(current.latest()),
        state: checkpoint,
      });
      const transaction = await service.begin(checkpoint);
      await transaction.save(checkpoint);
      assert.equal(transaction.checkpoint().publications.length, 512);
    }
    assert.equal(
      [...first.records.values()].reduce(
        (sum, record) => sum + record.state.publications.length,
        0
      ),
      2048
    );
  } finally {
    service?.close();
    fixtures.forEach((current) => current.close());
  }
});

test('concurrent legacy saves reserve capacity before I/O and retain uncertain writes', async () => {
  const fixtures = [];
  const entered = deferred(),
    release = deferred();
  let service, saving;
  try {
    for (let index = 0; index < 3; index++) fixtures.push(await fixture());
    const [first] = fixtures;
    service = createRecoveryRootStorage(first.storage);
    const checkpoints = fixtures.map((current) =>
      createRootCheckpoint(capacityRoot(current.checkpoint.root, 6), [])
    );
    first.latest().state = createRootCheckpoint(
      checkpoints[0].root,
      [],
      capacityJournal(first.root.snapshotId, 255)
    );
    await service.begin(checkpoints[0]);
    const a = await service.begin(checkpoints[1]);
    const b = await service.begin(checkpoints[2]);
    first.hook((request, next) => {
      if (request.operation !== 'save') return next();
      entered.resolve();
      return release.promise.then(() => {
        throw Error('synthetic uncertain commit');
      });
    });
    saving = a.save(checkpoints[1]);
    const failed = assert.rejects(saving, { code: failure });
    await entered.promise;
    await assert.rejects(b.save(checkpoints[2]), { code: failure });
    release.resolve();
    await failed;
    // The failed call might have committed; no slot is released on uncertainty.
    first.hook(null);
    await assert.rejects(b.save(checkpoints[2]), { code: failure });
    assert.equal(first.requests.filter((request) => request.operation === 'save').length, 2);
  } finally {
    release.resolve();
    await saving?.catch(() => {});
    service?.close();
    fixtures.forEach((current) => current.close());
  }
});

test('legacy publication journal capacity stays shared across roots on load as well as save', async () => {
  const first = await fixture(),
    second = await fixture();
  const service = createRecoveryRootStorage(first.storage);
  try {
    const stored = first.latest();
    const legacy = (root) => {
      const value = copy(root);
      value.version = 6;
      value.binding.format = 2;
      value.ledger.policy.maxEntries = 64;
      value.ledger.policy.maxBytes = 4 * 1024 * 1024;
      return value;
    };
    const journal = [{ snapshotId: first.root.snapshotId, state: 'transport-finished' }];
    for (let i = 1; i < 256; i++)
      journal.push({ snapshotId: 'hbs_' + i.toString(16).padStart(32, '0'), state: 'withdrawn' });
    stored.state = createRootCheckpoint(legacy(stored.state.root), [], journal);
    const checkpoint = createRootCheckpoint(legacy(first.checkpoint.root), []);
    const transaction = await service.begin(checkpoint);
    await transaction.save(checkpoint);
    const secondCheckpoint = createRootCheckpoint(legacy(second.checkpoint.root), []);
    const other = await service.begin(secondCheckpoint);
    await assert.rejects(other.save(secondCheckpoint), { code: failure });
    const loadedService = createRecoveryRootStorage(first.storage);
    try {
      await loadedService.begin(checkpoint);
      first.hook((request, next) =>
        request.operation === 'load' && request.scope !== first.requests[0].scope
          ? {
              ...copy(stored),
              state: createRootCheckpoint(
                secondCheckpoint.root,
                [],
                [{ snapshotId: second.root.snapshotId, state: 'transport-finished' }]
              ),
            }
          : next()
      );
      await assert.rejects(loadedService.begin(secondCheckpoint), { code: failure });
    } finally {
      loadedService.close();
    }
  } finally {
    service.close();
    first.close();
    second.close();
  }
});

test('reference publication cancellation persists terminal state after invalidating its session', async () => {
  for (const phase of ['prepared', 'sending', 'transport-finished']) {
    const database = new DatabaseSync(':memory:');
    const engine = createRecoverySqliteStore({
      database,
      dataKey: randomBytes(32).toString('base64'),
    });
    const f = await fixture('chat', engine);
    try {
      assert.deepEqual(await f.view.completePublicAsync(observedOutput('chat')), { ok: true });
      if (phase !== 'prepared')
        assert.deepEqual(await f.view.startPublicationAsync(), { ok: true });
      if (phase === 'transport-finished')
        assert.deepEqual(await f.view.finishPublicationAsync(), { ok: true });
      assert.deepEqual(await f.view.withdrawAsync(), { ok: true });
      const save = f.requests.findLast((request) => request.operation === 'save-reference-state');
      const record = engine.execute({ operation: 'load', scope: save.scope });
      assert.equal(
        record.state.publications.find((item) => item.snapshotId === f.id).state,
        phase === 'sending' ? 'uncertain' : 'withdrawn'
      );
      assert.equal(record.state.root.ledger.sources[0].output, original);
      assert.equal(f.view.inspect().active, false);
    } finally {
      await f.runtime.shutdownAsync();
      engine.close();
      database.close();
    }
  }
});
