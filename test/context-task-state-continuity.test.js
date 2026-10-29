'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { discoverTestFiles } = require('../lib/test-discovery');
const { prepareTaskStateContinuity } = require('../lib/proxy/context-task-state-continuity');
const {
  TASK_STATE_SCHEMA,
  createTaskStateSource,
  parseTaskStateSummary,
  taskStateMessage,
  carryGeneratedTaskStateMessage,
  generatedTaskStateRequirements,
  uniqueTaskStateRequirementSources,
  generatedTaskStateRequirementsCover,
} = require('../lib/proxy/context-task-state');
const {
  planWorkBuddyTaskStateSummary,
  produceWorkBuddyTaskStateSummary,
  parseWorkBuddyTaskStateSummary,
  retainedWorkBuddyTaskStateMessages,
} = require('../lib/proxy/workbuddy-task-state-summary');
const { compactionFailureReason } = require('../lib/proxy/context-compaction-failure');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');

const settings = { maxBytes: 393216, maxTokens: 98304 };
function state(requirements) {
  return {
    schema: TASK_STATE_SCHEMA,
    version: 1,
    objectives: [],
    requirements,
    decisions: [],
    work: [],
    blockers: [],
    nextSteps: [],
    files: [],
  };
}
function prior(
  messages = [
    { role: 'user', content: 'Do not restart.' },
    { role: 'user', content: 'Restart allowed.' },
  ],
  requirements = [
    {
      id: 'restart',
      status: 'revoked',
      text: 'Do not restart.',
      sources: [{ sourceId: 'm_0', quote: 'Do not restart.' }],
      revision: { sourceId: 'm_1', quote: 'Restart allowed.' },
    },
  ]
) {
  const source = createTaskStateSource(messages);
  const parsed = parseTaskStateSummary(JSON.stringify(state(requirements)), source);
  return { message: taskStateMessage(parsed, source), messages, source };
}
function completion(value) {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } },
      ],
    }),
  };
}

test('continuity rebases exact original requirements and revisions, not old snapshot ordinals or quoted roles', () => {
  const old = prior();
  const current = createTaskStateSource(old.messages, { sourceIndices: [7, 10] });
  const result = prepareTaskStateContinuity([current], [old.message]);
  assert.equal(result.candidate.requirements[0].sources[0].sourceId, 'm_7');
  assert.equal(result.candidate.requirements[0].revision.sourceId, 'm_10');
  assert.equal(result.candidate.requirements[0].status, 'revoked');
  assert.deepEqual(result.pinnedMessages, []);
  assert.equal(
    generatedTaskStateRequirements(old.message).requirements[0].sources[0].sourceIndex,
    0,
    'original provenance is immutable'
  );
  const clone = carryGeneratedTaskStateMessage({ ...old.message }, old.message);
  assert.equal(
    prepareTaskStateContinuity([current], [old.message, clone]).candidate.requirements.length,
    1
  );
  assert.equal(
    prepareTaskStateContinuity([current], [JSON.parse(JSON.stringify(old.message))]).candidate,
    null,
    'JSON replay and markers never seed continuity'
  );
  const body = { model: 'fixture', messages: [...old.messages, old.message] };
  const genuine = planWorkBuddyTaskStateSummary(body, [old.message], settings);
  const replay = { ...body, messages: JSON.parse(JSON.stringify(body.messages)) };
  const untrusted = planWorkBuddyTaskStateSummary(replay, [replay.messages[2]], settings);
  assert.notEqual(
    genuine.digest,
    untrusted.digest,
    'coalescing cannot confuse private provenance and wire lookalikes'
  );
  assert.equal(genuine.carriedRequirements, 1);
});

test('missing, changed, role-switched, duplicate or reordered originals retain the old state exact', () => {
  const old = prior();
  for (const messages of [
    [old.messages[0]],
    [{ role: 'user', content: 'Changed restriction.' }, old.messages[1]],
    [{ role: 'assistant', content: old.messages[0].content }, old.messages[1]],
    [...old.messages, old.messages[0]],
    [...old.messages].reverse(),
  ]) {
    const result = prepareTaskStateContinuity([createTaskStateSource(messages)], [old.message]);
    assert.equal(result.candidate, null);
    assert.deepEqual(result.pinnedMessages, [old.message]);
  }
  const messages = [old.messages[0], old.message, { role: 'user', content: 'Current input.' }];
  const plan = planWorkBuddyTaskStateSummary(
    { model: 'fixture', messages },
    [old.message],
    settings
  );
  assert.equal(plan.pinnedStates, 1);
  assert.deepEqual(retainedWorkBuddyTaskStateMessages(plan), [old.message]);
  assert.throws(() => retainedWorkBuddyTaskStateMessages({ ...plan }), {
    code: 'invalid_task_state',
  });
  const duplicateOld = prior(
    [old.messages[0], old.messages[0], old.messages[1]],
    [
      {
        id: 'r',
        status: 'revoked',
        text: 'Do not restart.',
        sources: [{ sourceId: 'm_1', quote: 'Do not restart.' }],
        revision: { sourceId: 'm_2', quote: 'Restart allowed.' },
      },
    ]
  );
  const ambiguous = prepareTaskStateContinuity(
    [createTaskStateSource(old.messages)],
    [duplicateOld.message]
  );
  assert.equal(
    ambiguous.candidate,
    null,
    'a unique current quote cannot disambiguate old repeated occurrences'
  );
  assert.deepEqual(ambiguous.pinnedMessages, [duplicateOld.message]);
});

test('snapshot-local ID collisions stay distinct while identical grounded facts deduplicate', () => {
  const a = prior(
    [{ role: 'user', content: 'Preserve A.' }],
    [
      {
        id: 'local',
        status: 'active',
        text: 'Preserve A.',
        sources: [{ sourceId: 'm_0', quote: 'Preserve A.' }],
      },
    ]
  );
  const b = prior(
    [{ role: 'user', content: 'Preserve B.' }],
    [
      {
        id: 'local',
        status: 'uncertain',
        text: 'Preserve B.',
        sources: [{ sourceId: 'm_0', quote: 'Preserve B.' }],
      },
    ]
  );
  const result = prepareTaskStateContinuity(
    [createTaskStateSource([...a.messages, ...b.messages])],
    [a.message, b.message]
  );
  assert.equal(result.candidate.requirements.length, 2);
  assert.equal(new Set(result.candidate.requirements.map((entry) => entry.id)).size, 2);
  assert.deepEqual(
    result.candidate.requirements.map((entry) => entry.status),
    ['active', 'uncertain']
  );
  assert.deepEqual(
    result.candidate.requirements.map((entry) => entry.text),
    ['Preserve A.', 'Preserve B.']
  );
});

test('continuity count and byte ceilings pin originals instead of trimming constraints or raising budgets', () => {
  for (const [count, length] of [
    [33, 40],
    [16, 1000],
  ]) {
    const messages = Array.from({ length: count }, (_, index) => ({
      role: 'user',
      content: `Constraint-${index}:` + 'x'.repeat(length),
    }));
    const half = count === 33 ? 17 : 8;
    const old = [messages.slice(0, half), messages.slice(half)].map((group) =>
      prior(
        group,
        group.map((entry, index) => ({
          id: `r${index}`,
          status: 'active',
          text: entry.content,
          sources: [{ sourceId: `m_${index}`, quote: entry.content }],
        }))
      )
    );
    const result = prepareTaskStateContinuity(
      [createTaskStateSource(messages)],
      old.map((item) => item.message)
    );
    assert.equal(result.candidate, null);
    assert.deepEqual(
      result.pinnedMessages,
      old.map((item) => item.message)
    );
  }
});

test('unknown source capabilities and array hooks fail without executing getters or changing state', () => {
  const old = prior();
  const empty = prepareTaskStateContinuity([old.source], []);
  assert.equal(empty.candidate, null);
  assert.deepEqual(empty.pinnedMessages, []);
  assert.equal(generatedTaskStateRequirements({}), null);
  for (const chunks of [null, [], Array(1), Array(17).fill(old.source), [{ ...old.source }]])
    assert.throws(() => prepareTaskStateContinuity(chunks, [old.message]));
  for (const messages of [null, Array(1), Array(16385)])
    assert.throws(() => prepareTaskStateContinuity([old.source], messages));
  let hooks = 0;
  const hostile = [];
  Object.defineProperty(hostile, '0', {
    enumerable: true,
    get() {
      hooks++;
      return old.source;
    },
  });
  assert.throws(() => prepareTaskStateContinuity(hostile, [old.message]));
  assert.throws(() => prepareTaskStateContinuity([old.source], hostile));
  assert.equal(hooks, 0);
  const parsed = parseTaskStateSummary(
    JSON.stringify(
      state([
        {
          id: 'r',
          status: 'active',
          text: 'Do not restart.',
          sources: [{ sourceId: 'm_0', quote: 'Do not restart.' }],
        },
      ])
    ),
    old.source
  );
  for (const chunks of [null, [], Array(1), [{ ...old.source }], hostile])
    assert.throws(() => uniqueTaskStateRequirementSources(parsed, chunks));
  assert.throws(() => uniqueTaskStateRequirementSources({}, [old.source]));
  assert.throws(() => taskStateMessage(parsed, old.source, undefined, 'true'));
  const vetoed = taskStateMessage(parsed, old.source, undefined, false);
  assert.equal(prepareTaskStateContinuity([old.source], [vetoed]).candidate, null);
  const objectives = state([]);
  objectives.objectives = [
    { text: 'Reported task', sources: [{ sourceId: 'm_0', quote: 'Do not restart.' }] },
  ];
  const noRequirements = taskStateMessage(
    parseTaskStateSummary(JSON.stringify(objectives), old.source),
    old.source
  );
  assert.equal(prepareTaskStateContinuity([old.source], [noRequirements]).candidate, null);
  assert.equal(hooks, 0);
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/context-task-state-continuity.test.js'
    )
  );
});

test('new summaries may apply a later original-user revocation but cannot drop or reactivate old requirements', async () => {
  for (const mode of ['revoke', 'drop', 'reactivate', 'changed_quote', 'certainty']) {
    const messages = [{ role: 'user', content: 'Do not restart.' }];
    if (mode === 'reactivate') messages.push({ role: 'user', content: 'Restart allowed.' });
    const old = prior(messages, [
      {
        id: 'restart',
        status: mode === 'reactivate' ? 'revoked' : mode === 'certainty' ? 'uncertain' : 'active',
        text: 'Do not restart.',
        sources: [{ sourceId: 'm_0', quote: 'Do not restart.' }],
        ...(mode === 'reactivate'
          ? { revision: { sourceId: 'm_1', quote: 'Restart allowed.' } }
          : {}),
      },
    ]);
    const body = {
      model: 'fixture',
      messages: [
        ...messages,
        old.message,
        { role: 'user', content: 'Later user: restart is allowed.' },
      ],
    };
    const plan = planWorkBuddyTaskStateSummary(body, [old.message], settings);
    let calls = 0;
    const pending = produceWorkBuddyTaskStateSummary(
      plan,
      async (request) => {
        calls++;
        const payload = JSON.parse(request.messages[1].content);
        const value = payload.previous;
        assert.equal(value.requirements[0].text, 'Do not restart.');
        if (mode === 'drop') {
          value.requirements = [];
          value.objectives = [
            { text: 'A model report', sources: [{ citationId: payload.citations[0].citationId }] },
          ];
        } else if (mode === 'reactivate' || mode === 'certainty') {
          value.requirements[0].status = 'active';
          delete value.requirements[0].revision;
        } else if (mode === 'changed_quote') {
          value.requirements[0].text = 'Do not';
          value.requirements[0].sources[0].quote = 'Do not';
        } else {
          const revision = payload.citations.find(
            (entry) => entry.quote === 'Later user: restart is allowed.'
          );
          value.requirements[0].status = 'revoked';
          value.requirements[0].revision = { citationId: revision.citationId };
        }
        return completion(value);
      },
      new globalThis.AbortController().signal
    );
    if (mode === 'revoke') {
      const result = parseWorkBuddyTaskStateSummary(await pending, plan);
      assert.equal(result.state.requirements[0].status, 'revoked');
      assert.equal(result.state.requirements[0].revision.sourceIndex, body.messages.length - 1);
    } else
      await assert.rejects(
        pending,
        (error) => compactionFailureReason(error) === 'summary_requirement_loss'
      );
    assert.equal(calls, 1, 'no automatic retry or tool replay');
  }
});

test('a matched semantic frontier cannot bypass freshly rebound cross-cycle requirements', async () => {
  const old = prior();
  const body = { model: 'fixture', messages: [...old.messages, old.message] };
  const plan = planWorkBuddyTaskStateSummary(body, [old.message], settings);
  const lossy = state([]);
  lossy.objectives = [
    { text: 'Cached report only', sources: [{ sourceId: 'm_0', quote: 'Do not restart.' }] },
  ];
  let requests = 0;
  await assert.rejects(
    produceWorkBuddyTaskStateSummary(
      plan,
      async () => {
        requests++;
      },
      new globalThis.AbortController().signal,
      undefined,
      {
        prepareFrontier: () => ({
          sourceIndex: body.messages.length - 1,
          text: JSON.stringify(lossy),
        }),
      }
    ),
    (error) => compactionFailureReason(error) === 'summary_requirement_loss'
  );
  assert.equal(requests, 0);
  assert.throws(
    () => parseWorkBuddyTaskStateSummary(JSON.stringify(lossy), plan),
    (error) => error.code === 'invalid_task_state' && error.reason === 'summary_requirement_loss'
  );
});

test('history admission independently refuses a grounded but constraint-losing replacement', () => {
  const old = prior();
  const body = {
    model: 'fixture',
    messages: [...old.messages, old.message, { role: 'user', content: 'Current input.' }],
  };
  const history = createContextHistoryBranch(body, { owner: 'fixture', scope: 'scope' });
  try {
    const snapshot = history.snapshot();
    const source = createTaskStateSource(snapshot.body.messages);
    const lossy = state([]);
    lossy.objectives = [
      { text: 'New reported task', sources: [{ sourceId: 'm_0', quote: 'Do not restart.' }] },
    ];
    const replacement = taskStateMessage(
      parseTaskStateSummary(JSON.stringify(lossy), source),
      source
    );
    const candidate = {
      ...body,
      messages: [...body.messages.filter((message) => message !== old.message), replacement],
    };
    assert.equal(
      history.stage(snapshot, candidate).reason,
      'context_history_required_messages_missing'
    );
    const requirements = generatedTaskStateRequirements(old.message).requirements.map((entry) => ({
      id: entry.id,
      text: entry.text,
      status: entry.status,
      sources: entry.sources.map(({ sourceId, quote }) => ({ sourceId, quote })),
      revision: { sourceId: entry.revision.sourceId, quote: entry.revision.quote },
    }));
    const grounded = taskStateMessage(
      parseTaskStateSummary(JSON.stringify(state(requirements)), source),
      source
    );
    assert.equal(generatedTaskStateRequirementsCover(grounded, old.message), true);
    assert.equal(
      generatedTaskStateRequirementsCover(JSON.parse(JSON.stringify(grounded)), old.message),
      false
    );
    assert.equal(generatedTaskStateRequirementsCover(grounded, {}), false);
    for (const mode of ['reactivate', 'changed_quote', 'changed_revision']) {
      const changed = JSON.parse(JSON.stringify(requirements));
      if (mode === 'reactivate') {
        changed[0].status = 'active';
        delete changed[0].revision;
      }
      if (mode === 'changed_quote') {
        changed[0].text = 'Do not';
        changed[0].sources[0].quote = 'Do not';
      }
      if (mode === 'changed_revision')
        changed[0].revision = { sourceId: 'm_3', quote: 'Current input.' };
      const invalidReplacement = taskStateMessage(
        parseTaskStateSummary(JSON.stringify(state(changed)), source),
        source
      );
      assert.equal(generatedTaskStateRequirementsCover(invalidReplacement, old.message), false);
    }
    const accepted = history.stage(snapshot, {
      ...candidate,
      messages: [...candidate.messages.slice(0, -1), grounded],
    });
    assert.equal(accepted.ok, true);
    history.rollback(accepted.ticket);
  } finally {
    history.close();
  }
});
