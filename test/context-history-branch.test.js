'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createContextHistoryBranch,
  isContextHistoryBranch,
  commitContextHistoryPlan,
} = require('../lib/proxy/context-history-branch');
const {
  applyResponsesHistoryPolicy,
  preservesResponsesHistory,
  shouldStoreResponsesHistory,
} = require('../lib/proxy/responses-history-policy');
const {
  TASK_STATE_SCHEMA,
  createTaskStateSource,
  parseTaskStateSummary,
  taskStateMessage,
  isGeneratedTaskStateMessage,
} = require('../lib/proxy/context-task-state');

const body = () => ({
  model: 'fixture',
  messages: [
    { role: 'system', content: 'policy' },
    { role: 'user', content: 'repair without restart' },
    { role: 'assistant', content: 'historical progress' },
  ],
});
const branch = (input = body(), extra = {}) =>
  createContextHistoryBranch(input, {
    owner: 'owner',
    scope: 'scope',
    ...extra,
  });
function stateMessage(messages) {
  const source = createTaskStateSource(messages);
  const text = messages[1].content;
  const state = parseTaskStateSummary(
    JSON.stringify({
      schema: TASK_STATE_SCHEMA,
      version: 1,
      objectives: [{ text, sources: [{ sourceId: 'm_1', quote: text }] }],
      requirements: [],
      decisions: [],
      work: [],
      blockers: [],
      nextSteps: [],
      files: [],
    }),
    source
  );
  return taskStateMessage(state, source);
}

test('canonical history is frozen, independent, policy-aware and commits exactly once', () => {
  const input = applyResponsesHistoryPolicy(body(), { store: false });
  const history = branch(input);
  assert.equal(isContextHistoryBranch(history), true);
  assert.equal(isContextHistoryBranch({ ...history }), false);
  const snapshot = history.snapshot();
  input.messages[1].content = 'caller mutation';
  assert.equal(snapshot.body.messages[1].content, 'repair without restart');
  assert.ok(Object.isFrozen(snapshot.body.messages[1]));
  assert.equal(shouldStoreResponsesHistory(snapshot.body), false);
  const staged = history.stage(snapshot, {
    ...snapshot.body,
    messages: snapshot.body.messages.slice(0, 2),
  });
  let publications = 0;
  const committed = history.commit(staged.ticket, {
    publish: () => {
      publications++;
      return { ok: true };
    },
  });
  assert.equal(committed.ok, true);
  assert.equal(history.commit(staged.ticket), committed);
  assert.equal(publications, 1);
  assert.equal(history.stats().version, 2);
  assert.equal(history.stats().stagedEntries, 0);
  assert.equal(history.inspect(snapshot).reason, 'stale_context_history_snapshot');
  history.close();
});

test('untrusted accessors, hooks, sparse/huge arrays, cycles and oversized histories are rejected without execution', () => {
  let executions = 0;
  const getterBody = {
    model: 'fixture',
    get messages() {
      executions++;
      return [];
    },
  };
  const hiddenHook = body();
  Object.defineProperty(hiddenHook, 'toJSON', {
    get() {
      executions++;
      return () => ({});
    },
  });
  const getterMessage = body();
  Object.defineProperty(getterMessage.messages[0], 'content', {
    get() {
      executions++;
      return 'evil';
    },
    enumerable: true,
  });
  const cyclic = body();
  cyclic.messages[0].content = cyclic;
  const sparse = body();
  sparse.messages[0].content = new Array(2 ** 32 - 1);
  for (const input of [
    getterBody,
    hiddenHook,
    getterMessage,
    cyclic,
    sparse,
    null,
    {},
    { messages: [{ role: 'root' }] },
  ])
    assert.throws(() => branch(input), { code: 'invalid_context_history' });
  assert.equal(executions, 0);
  const metadata = body();
  Object.defineProperty(metadata, '__hpmDiagnostics', { value: { category: 'fixture' } });
  const diagnosed = branch(metadata);
  assert.equal(Object.hasOwn(diagnosed.snapshot().body, '__hpmDiagnostics'), false);
  diagnosed.close();
  assert.throws(
    () =>
      createContextHistoryBranch(body(), {
        get owner() {
          executions++;
          return 'owner';
        },
        scope: 'scope',
      }),
    { code: 'invalid_context_history' }
  );
  assert.equal(executions, 0);
  assert.throws(() => branch(body(), { owner: '\n' }), { code: 'invalid_context_history' });
  assert.throws(() => branch(body(), { maxBytes: 10 }), { code: 'invalid_context_history' });
  const empty = branch({ messages: [] });
  assert.equal(empty.stats().messageCount, 0);
  empty.close();
});

test('append CAS preserves all new tail messages; foreign snapshots and tickets cannot authorize writes', () => {
  const history = branch(),
    foreign = branch();
  const snapshot = history.snapshot();
  const additions = [
    { role: 'assistant', content: 'new progress' },
    { role: 'tool', tool_call_id: 'pending', content: 'new evidence' },
  ];
  assert.equal(history.append(additions, 0).reason, 'context_history_version_conflict');
  assert.equal(history.append([], 1).version, 1);
  assert.equal(history.append(additions, 1).version, 2);
  additions[0].content = 'mutation';
  const current = history.inspect(snapshot);
  assert.equal(current.appendedMessages[0].content, 'new progress');
  assert.equal(
    history.stage(snapshot, snapshot.body).reason,
    'context_history_required_messages_missing'
  );
  assert.equal(
    history.stage(foreign.snapshot(), current.body).reason,
    'invalid_context_history_snapshot'
  );
  assert.equal(history.commit({}).reason, 'invalid_context_history_stage');
  const staged = history.stage(snapshot, current.body);
  assert.equal(foreign.commit(staged.ticket).reason, 'invalid_context_history_stage');
  history.append([{ role: 'assistant', content: 'later' }], 2);
  assert.equal(history.commit(staged.ticket).reason, 'context_history_version_conflict');
  assert.equal(history.stats().stagedEntries, 0);
  history.close();
  foreign.close();
});

test('managed replacement rejects stale summaries and ABA; compaction cannot silently change controls', () => {
  const history = branch(),
    snapshot = history.snapshot();
  assert.equal(
    history.stage(snapshot, { ...snapshot.body, model: 'other' }).reason,
    'context_history_controls_changed'
  );
  assert.equal(history.replace({ ...snapshot.body, model: 'other' }, 1).ok, true);
  assert.equal(history.replace(snapshot.body, 2).ok, true);
  assert.equal(history.inspect(snapshot).reason, 'stale_context_history_snapshot');
  assert.equal(history.replace(snapshot.body, 1).reason, 'context_history_version_conflict');
  history.close();
});

test('policy, duplicate raw users, unsafe tool intervals and disabled truncation are indivisible', () => {
  const input = body();
  input.messages.splice(2, 0, { ...input.messages[1] });
  input.messages.push({
    role: 'assistant',
    tool_calls: [{ id: 'open', type: 'function', function: { name: 'read', arguments: '{}' } }],
  });
  const history = branch(input),
    snapshot = history.snapshot();
  for (const index of [0, 1, 2, 4]) {
    const messages = snapshot.body.messages.filter((_item, position) => position !== index);
    assert.equal(
      history.stage(snapshot, { ...snapshot.body, messages }).reason,
      'context_history_required_messages_missing'
    );
  }
  history.close();
  const disabled = branch(
    applyResponsesHistoryPolicy(body(), { store: false, truncation: 'disabled' })
  );
  const protectedSnapshot = disabled.snapshot();
  assert.equal(preservesResponsesHistory(protectedSnapshot.body), true);
  assert.equal(
    disabled.stage(protectedSnapshot, {
      ...protectedSnapshot.body,
      messages: protectedSnapshot.body.messages.slice(0, 2),
    }).reason,
    'context_history_required_messages_missing'
  );
  disabled.close();
});

test('only a genuinely generated summary of this snapshot can replace prior generated state', () => {
  const input = body();
  input.messages.push(stateMessage(input.messages));
  const history = branch(input),
    snapshot = history.snapshot();
  assert.ok(isGeneratedTaskStateMessage(snapshot.body.messages[3]));
  const candidate = { ...snapshot.body, messages: snapshot.body.messages.slice(0, 2) };
  assert.equal(
    history.stage(snapshot, candidate).reason,
    'context_history_required_messages_missing'
  );
  const genuine = stateMessage(snapshot.body.messages);
  candidate.messages.push({ ...genuine });
  assert.equal(
    history.stage(snapshot, candidate).reason,
    'context_history_required_messages_missing'
  );
  candidate.messages[2] = genuine;
  assert.equal(commitContextHistoryPlan(history, snapshot, candidate).ok, true);
  history.close();
});

test('quotas, cancellation, publication failure and exceptions release reservations without losing history', () => {
  const history = branch(body(), { maxStages: 1 }),
    snapshot = history.snapshot();
  const stage = () => history.stage(snapshot, snapshot.body);
  const first = stage();
  assert.equal(stage().reason, 'context_history_stage_limit');
  assert.equal(history.rollback(first.ticket), true);
  const abort = new globalThis.AbortController();
  abort.abort();
  assert.equal(
    history.commit(stage().ticket, { signal: abort.signal }).reason,
    'context_history_cancelled'
  );
  assert.equal(
    history.commit(stage().ticket, { publish: () => ({ ok: false }) }).reason,
    'context_history_publication_failed'
  );
  assert.throws(
    () =>
      history.commit(stage().ticket, {
        publish: () => {
          throw new Error('fixture publisher');
        },
      }),
    /fixture publisher/
  );
  assert.equal(history.stats().stagedEntries, 0);
  assert.equal(history.stats().version, 1);
  assert.equal(history.inspect(snapshot).ok, true);
  const pending = stage();
  history.close();
  assert.equal(history.stats().stagedEntries, 0);
  assert.equal(history.commit(pending.ticket).reason, 'context_history_closed');
  assert.equal(history.snapshot().reason, 'context_history_closed');
});

test('publication is synchronous, reentrant writes are blocked, cancellation after publication cannot undo commit', () => {
  const history = branch(),
    snapshot = history.snapshot(),
    abort = new globalThis.AbortController();
  const result = commitContextHistoryPlan(
    history,
    snapshot,
    snapshot.body,
    () => {
      assert.equal(history.append([], 1).reason, 'context_history_busy');
      assert.equal(history.close(), false);
      abort.abort();
      return { ok: true };
    },
    abort.signal
  );
  assert.equal(result.ok, true);
  const next = history.snapshot();
  assert.equal(
    commitContextHistoryPlan(history, next, next.body, () => Promise.resolve({ ok: true })).reason,
    'context_history_publication_failed'
  );
  assert.equal(history.stats().version, 2);
  history.close();
});

test('invalid commit input never evaluates accessors and a closed branch releases ticket handles', () => {
  const history = branch(),
    snapshot = history.snapshot();
  const staged = history.stage(snapshot, snapshot.body);
  let calls = 0;
  assert.equal(
    history.commit(staged.ticket, {
      get publish() {
        calls++;
        return () => ({ ok: true });
      },
    }).reason,
    'invalid_context_history_commit'
  );
  assert.equal(
    history.commit(staged.ticket, { signal: {} }).reason,
    'invalid_context_history_commit'
  );
  assert.equal(
    history.commit(staged.ticket, { publish: true }).reason,
    'invalid_context_history_commit'
  );
  assert.equal(calls, 0);
  assert.equal(history.rollback(staged.ticket), true);
  assert.equal(history.commit(staged.ticket).reason, 'invalid_context_history_stage');
  history.close();
  assert.equal(history.inspect(snapshot).reason, 'context_history_closed');
  assert.equal(history.append([], 1).reason, 'context_history_closed');
  assert.equal(history.replace(snapshot.body, 1).reason, 'context_history_closed');
  assert.equal(history.matches(snapshot.body), false);
});

test('bounded request call identities survive compaction and replacements but only committed additions count', () => {
  const exchange = (id) => [
    {
      role: 'assistant',
      tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: id, content: 'archivable evidence' },
  ];
  const input = { ...body(), messages: [...body().messages, ...exchange('original')] };
  const history = branch(input, { maxCallIds: 3 });
  assert.equal(history.hasToolCallId('original'), true);
  assert.equal(history.hasToolCallId(''), false);
  assert.equal(history.hasToolCallId(null), false);
  assert.equal(history.hasToolCallId('\n'), false);
  assert.equal(history.hasToolCallId('x'.repeat(257)), false);
  const original = history.snapshot();
  assert.equal(commitContextHistoryPlan(history, original, body()).ok, true);
  assert.equal(
    history.snapshot().body.messages.some((message) => message.tool_call_id === 'original'),
    false
  );
  assert.equal(history.hasToolCallId('original'), true);
  assert.equal(history.stats().retainedCallIds, 1);
  for (const mode of ['rollback', 'reject', 'throw', 'cancel']) {
    const snapshot = history.snapshot();
    const candidate = {
      ...snapshot.body,
      messages: [...snapshot.body.messages, ...exchange('failed')],
    };
    const staged = history.stage(snapshot, candidate);
    assert.equal(staged.ok, true);
    assert.equal(history.hasToolCallId('failed'), false, 'staging is not publication');
    if (mode === 'rollback') history.rollback(staged.ticket);
    else if (mode === 'throw')
      assert.throws(
        () =>
          history.commit(staged.ticket, {
            publish() {
              throw new Error('fixture failure');
            },
          }),
        /fixture failure/
      );
    else {
      const controller = new globalThis.AbortController();
      if (mode === 'cancel') controller.abort();
      assert.equal(
        history.commit(staged.ticket, {
          signal: controller.signal,
          publish: () => ({ ok: false }),
        }).ok,
        false
      );
    }
    assert.equal(history.hasToolCallId('failed'), false);
    assert.equal(history.stats().retainedCallIds, 1);
  }
  assert.equal(history.append(exchange('appended'), history.stats().version).ok, true);
  assert.equal(history.replace(body(), history.stats().version).ok, true);
  assert.equal(history.hasToolCallId('appended'), true);
  const next = history.snapshot();
  const third = { ...next.body, messages: [...next.body.messages, ...exchange('third')] };
  assert.equal(commitContextHistoryPlan(history, next, third).ok, true);
  assert.equal(history.replace(body(), history.stats().version).ok, true);
  assert.equal(history.stats().retainedCallIds, 3);
  const fourth = { ...body(), messages: [...body().messages, ...exchange('fourth')] };
  const version = history.stats().version;
  assert.equal(history.stage(history.snapshot(), fourth).reason, 'context_history_call_id_limit');
  assert.equal(history.replace(fourth, version).reason, 'context_history_call_id_limit');
  assert.equal(history.append(exchange('fourth'), version).reason, 'context_history_call_id_limit');
  assert.equal(history.stats().version, version);
  assert.equal(history.hasToolCallId('fourth'), false);
  history.close();
  assert.equal(history.hasToolCallId('original'), false);
  assert.equal(history.stats().retainedCallIds, 0);
  assert.throws(() => branch(input, { maxCallIds: 1, maxBytes: 10 }), {
    code: 'invalid_context_history',
  });
  assert.throws(
    () =>
      branch(
        { ...input, messages: [...input.messages, ...exchange('too_many')] },
        {
          maxCallIds: 1,
        }
      ),
    { code: 'invalid_context_history' }
  );
  const empty = branch({ messages: [] });
  assert.equal(empty.stats().retainedCallIds, 0);
  empty.close();
});

test('trusted compacted lineage initializes replay protection without executing option/array hooks', () => {
  const { createHash } = require('node:crypto');
  const id = createHash('sha256').update('retired').digest('hex');
  const ids = [id];
  const history = branch(body(), { initialCallIdDigests: ids });
  ids.pop();
  assert.equal(history.hasToolCallId('retired'), true);
  assert.equal(history.stats().retainedCallIds, 1);
  assert.equal(JSON.stringify(history.snapshot().body).includes(id), false);
  history.close();
  let hooks = 0;
  const getter = Object.defineProperty([], '0', {
    enumerable: true,
    get() {
      hooks++;
      return id;
    },
  });
  for (const invalid of [null, {}, ['bad'], getter, new Array(65537)])
    assert.throws(() => branch(body(), { initialCallIdDigests: invalid }), {
      code: 'invalid_context_history',
    });
  assert.throws(
    () => branch(body(), { initialCallIdDigests: [id, 'f'.repeat(64)], maxCallIds: 1 }),
    { code: 'invalid_context_history' }
  );
  const accessor = Object.defineProperty(
    { owner: 'owner', scope: 'scope' },
    'initialCallIdDigests',
    {
      get() {
        hooks++;
        return [id];
      },
    }
  );
  assert.throws(() => createContextHistoryBranch(body(), accessor), {
    code: 'invalid_context_history',
  });
  assert.equal(hooks, 0);
});
