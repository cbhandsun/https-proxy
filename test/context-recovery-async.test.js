'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContextRecoveryCoordinator } = require('../lib/proxy/context-recovery-coordinator');
const { runContextRecovery } = require('../lib/proxy/context-recovery-runner');
const { parseRecoveryProgress } = require('../lib/proxy/context-recovery-progress');
const { createDurableEvidenceTools } = require('../lib/proxy/context-recovery-budget-reader');
const {
  createContextEvidenceTools,
  LIST_EVIDENCE_TOOL: LIST,
} = require('../lib/proxy/context-evidence-tools');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const exact = '原文\r\nélève🙂';
const reply = () => ({ ok: true, text: JSON.stringify({ exact }) });
function response(kind, calls = []) {
  const usage = { input_tokens: 7, output_tokens: 3 };
  if (kind === 'responses')
    return {
      id: 'response',
      status: 'completed',
      usage,
      output: calls.length
        ? calls.map(({ id, name }) => ({
            type: 'function_call',
            call_id: id,
            name,
            arguments: '{}',
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
      id: 'response',
      role: 'assistant',
      usage,
      stop_reason: calls.length ? 'tool_use' : 'end_turn',
      content: calls.length
        ? calls.map(({ id, name }) => ({ type: 'tool_use', id, name, input: {} }))
        : [{ type: 'text', text: 'done' }],
    };
  return {
    id: 'response',
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
                tool_calls: calls.map(({ id, name }) => ({
                  id,
                  type: 'function',
                  function: { name, arguments: '{}' },
                })),
              }
            : {}),
        },
      },
    ],
  };
}
function fixture(kind = 'chat') {
  let active = true;
  const readers = createContextEvidenceTools({
    list: () => ({ ok: true, sources: [] }),
    read: () => ({ ok: false }),
  });
  const tool =
    kind === 'chat'
      ? { type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }
      : kind === 'responses'
        ? { type: 'function', name: 'shell', parameters: { type: 'object' } }
        : { name: 'shell', input_schema: { type: 'object' } };
  const body = {
    model: 'fixture',
    tools: [tool],
    ...(kind === 'responses'
      ? { input: [{ role: 'user', content: 'continue' }] }
      : { messages: [{ role: 'user', content: 'continue' }] }),
  };
  const session = { definitions: readers.definitions, inspect: () => ({ active }), reply };
  return {
    body,
    session,
    revoke: () => {
      active = false;
    },
    create: () => createContextRecoveryCoordinator({ kind, body, session }),
  };
}
const lookup = [{ id: 'lookup', name: LIST }];

for (const kind of ['chat', 'responses', 'claude']) {
  for (const mixed of [false, true]) {
    test(`${kind}: async ${mixed ? 'mixed' : 'private'} reader waits, serializes acceptance and keeps exact data`, async () => {
      const f = fixture(kind),
        gate = deferred();
      let reads = 0;
      f.session.reply = () => {
        throw new Error('sync reader must not run');
      };
      f.session.replyAsync = (name) => {
        assert.equal(name, LIST);
        reads++;
        return gate.promise;
      };
      const c = f.create();
      const pending = c.acceptAsync(
        response(kind, mixed ? [...lookup, { id: 'external', name: 'shell' }] : lookup)
      );
      let settled = false;
      pending.then(() => {
        settled = true;
      });
      await tick();
      assert.equal(settled, false);
      assert.equal(c.accept(response(kind)).code, 'context_recovery_busy');
      assert.equal((await c.acceptAsync(response(kind))).code, 'context_recovery_busy');
      assert.equal(reads, 1);
      assert.equal(c.inspectProgress().rounds, 1);
      gate.resolve(reply());
      const next = await pending;
      assert.equal(next.mode, 'continue');
      const history = kind === 'responses' ? next.request.input : next.request.messages;
      const content =
        kind === 'responses'
          ? history.at(-1).output
          : kind === 'claude'
            ? history.at(-1).content[0].content
            : history.at(-1).content;
      assert.equal(JSON.parse(content).exact, exact);
      const released = await c.acceptAsync(response(kind));
      assert.equal(released.mode, 'release');
      assert.equal(released.deferredExternal, mixed);
      assert.equal(released.rounds, 2);
      assert.equal(released.calls, 1);
      assert.equal(released.usage.length, 2);
      assert.equal(reads, 1);
      assert.equal(JSON.stringify(released.response).includes('external'), mixed);
    });
  }

  test(`${kind}: cancellation and revocation during reader wait never release or append history`, async () => {
    for (const action of ['cancel', 'revoke']) {
      const f = fixture(kind),
        gate = deferred();
      f.session.replyAsync = () => gate.promise;
      const c = f.create(),
        pending = c.acceptAsync(response(kind, lookup));
      if (action === 'cancel') c.cancel();
      else f.revoke();
      gate.resolve(reply());
      const failed = await pending;
      assert.equal(failed.mode, 'failed');
      assert.equal(
        failed.code,
        action === 'cancel' ? 'context_recovery_cancelled' : 'context_recovery_unavailable'
      );
      assert.equal(failed.rounds, 1);
      assert.equal(failed.usage.length, 1);
      assert.equal(Object.hasOwn(failed, 'history'), false);
      assert.equal((await c.acceptAsync(response(kind))).code, 'context_recovery_terminal');
    }
  });
}

test('async reader validates results without executing then/getter/toJSON or leaking errors', async () => {
  let invoked = 0;
  const promiseThen = Promise.resolve(reply());
  Object.defineProperty(promiseThen, 'then', {
    get() {
      invoked++;
      throw new Error('private marker');
    },
  });
  const f = fixture();
  f.session.replyAsync = () => promiseThen;
  assert.equal((await f.create().acceptAsync(response('chat', lookup))).mode, 'continue');
  const constructorGetter = Promise.resolve(reply());
  Object.defineProperty(constructorGetter, 'constructor', {
    get() {
      invoked++;
      throw new Error('private marker');
    },
  });
  class OtherPromise extends Promise {}
  for (const value of [
    null,
    {},
    { ok: true },
    { ok: true, text: '界'.repeat(5462) },
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
    {
      ok: true,
      get text() {
        invoked++;
        return exact;
      },
    },
    {
      ok: true,
      text: exact,
      toJSON() {
        invoked++;
        return {};
      },
    },
    constructorGetter,
    OtherPromise.resolve(reply()),
  ]) {
    const g = fixture();
    g.session.replyAsync = () => value;
    const result = await g.create().acceptAsync(response('chat', lookup));
    assert.equal(result.code, 'context_recovery_unavailable');
    assert.equal(JSON.stringify(result).includes('private marker'), false);
  }
  assert.equal(invoked, 0);
  const g = fixture();
  g.session.replyAsync = async () => {
    throw new Error('private marker');
  };
  assert.equal(
    (await g.create().acceptAsync(response('chat', lookup))).code,
    'context_recovery_unavailable'
  );
});

test('sync acceptance fails safely on async readers and consumes a late rejection', async () => {
  const f = fixture(),
    gate = deferred();
  f.session.reply = () => gate.promise;
  const c = f.create();
  assert.equal(c.accept(response('chat', lookup)).code, 'context_recovery_unavailable');
  gate.reject(new Error('private marker'));
  await tick();
  assert.equal(c.accept(response('chat')).code, 'context_recovery_terminal');
});

test('runner timeout and cancellation include charged upstream usage while waiting for a reader', async () => {
  for (const timed of [false, true]) {
    for (const lateFailure of [false, true]) {
      const f = fixture(),
        gate = deferred(),
        entered = deferred();
      const abort = new globalThis.AbortController();
      f.session.replyAsync = () => {
        entered.resolve();
        return gate.promise;
      };
      const c = f.create();
      let dispatches = 0;
      const pending = runContextRecovery({
        kind: 'chat',
        body: f.body,
        session: { recovery: () => c },
        signal: abort.signal,
        timeoutMs: timed ? 100 : 1000,
        dispatch() {
          dispatches++;
          return {
            statusCode: 200,
            wire: Buffer.from(JSON.stringify(response('chat', lookup))),
            stream: false,
          };
        },
      });
      await entered.promise;
      if (!timed) abort.abort();
      const failed = await pending;
      assert.equal(failed.code, timed ? 'context_recovery_timeout' : 'context_recovery_cancelled');
      assert.equal(failed.rounds, 1);
      assert.equal(failed.calls, 1);
      assert.equal(failed.usage[0].prompt_tokens, 7);
      assert.equal(failed.usage[0].completion_tokens, 3);
      if (lateFailure) gate.reject(new Error('private marker'));
      else gate.resolve(reply());
      await tick();
      assert.equal(dispatches, 1);
      assert.equal(c.accept(response('chat')).code, 'context_recovery_terminal');
    }
  }
});

test('progress is bounded data, rejects executable and invalid accounting without invoking it', () => {
  const plain = {
    rounds: 1,
    calls: 1,
    usage: [{ input_tokens: 7, details: { cached_tokens: 0 }, absent: null }],
  };
  assert.equal(parseRecoveryProgress(plain).usage[0].details.cached_tokens, 0);
  assert.equal(parseRecoveryProgress({ rounds: 0, calls: 0, usage: [] }).rounds, 0);
  let invoked = 0;
  for (const bad of [
    null,
    [],
    {},
    { ...plain, rounds: -1 },
    { ...plain, rounds: 9 },
    { ...plain, calls: 65 },
    { ...plain, calls: 0.5 },
    { ...plain, usage: [{ tokens: -1 }] },
    { ...plain, usage: [{ tokens: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...plain, rounds: 0 },
    { ...plain, extra: 1 },
    { ...plain, usage: [{ tokens: '7' }] },
    {
      ...plain,
      get calls() {
        invoked++;
        return 1;
      },
    },
    {
      ...plain,
      usage: [
        {
          toJSON() {
            invoked++;
            return {};
          },
        },
      ],
    },
    { ...plain, usage: [{ a: { b: { c: { d: {} } } } }] },
  ])
    assert.throws(() => parseRecoveryProgress(bad));
  assert.equal(invoked, 0);
});

test('runner rejects unsafe progress on interruption without leaking callbacks or data', async () => {
  let invoked = 0;
  const c = fixture().create();
  c.inspectProgress = () => ({
    rounds: 1,
    calls: 0,
    get usage() {
      invoked++;
      throw new Error('private marker');
    },
  });
  const abort = new globalThis.AbortController();
  abort.abort();
  const result = await runContextRecovery({
    kind: 'chat',
    session: { recovery: () => c },
    signal: abort.signal,
    dispatch() {
      throw new Error('must not dispatch');
    },
  });
  assert.equal(result.code, 'context_recovery_invalid_progress');
  assert.equal(invoked, 0);
  assert.equal(JSON.stringify(result).includes('private marker'), false);
});

test('coordinator and runner wait for durable reservation and settlement before continuing upstream', async () => {
  let saved = null,
    phase = 0,
    ledgerReads = 0,
    dispatches = 0;
  const reservation = deferred(),
    settlement = deferred(),
    reserved = deferred(),
    settling = deferred();
  const storage = {
    async execute(input) {
      if (input.operation === 'load') return saved;
      assert.equal(input.expectedRevision, saved?.revision ?? 0);
      phase++;
      if (phase === 2) {
        reserved.resolve();
        await reservation.promise;
      }
      if (phase === 3) {
        settling.resolve();
        await settlement.promise;
      }
      const revision = (saved?.revision ?? 0) + 1;
      saved = { revision, createdAt: 100, expiresAt: input.expiresAt, state: input.state };
      return { revision };
    },
  };
  const readers = await createDurableEvidenceTools({
    storage,
    scope: 'a'.repeat(64),
    expiresAt: 100000,
    ledger: {
      list() {
        ledgerReads++;
        return { ok: true, sources: [], nextAfterSourceId: null };
      },
      read: () => ({ ok: false }),
    },
  });
  const f = fixture();
  f.session.replyAsync = readers.reply;
  const c = f.create();
  const pending = runContextRecovery({
    kind: 'chat',
    session: { recovery: () => c },
    dispatch(request) {
      if (dispatches) assert.match(JSON.stringify(request), /nextAfterSourceId/);
      return {
        statusCode: 200,
        stream: false,
        wire: Buffer.from(JSON.stringify(response('chat', dispatches++ ? [] : lookup))),
      };
    },
  });
  await reserved.promise;
  assert.equal(ledgerReads, 0);
  assert.equal(dispatches, 1);
  reservation.resolve();
  await settling.promise;
  assert.equal(ledgerReads, 1);
  assert.equal(saved.state.budget.calls, 1);
  assert.equal(saved.state.budget.returnedBytes, 16384);
  assert.equal(dispatches, 1);
  settlement.resolve();
  const result = await pending;
  assert.equal(result.mode, 'release');
  assert.equal(dispatches, 2);
  assert.ok(saved.state.budget.returnedBytes < 16384);
  readers.close();
});
