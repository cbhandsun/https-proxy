'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { collectContextArtifactReferences } = require('../lib/proxy/context-artifact-references');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const { applyResponsesHistoryPolicy } = require('../lib/proxy/responses-history-policy');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { prepareWorkBuddyTaskStateContext } = require('../lib/proxy/workbuddy-task-state-planner');
const {
  selectHistoricalUserArchive,
  stageHistoricalUserArchive,
} = require('../lib/proxy/context-user-archive');
const {
  encodeTaskStateRoot,
  decodeTaskStateRoot,
} = require('../lib/proxy/context-task-state-root');
const {
  TASK_STATE_MARKER,
  MAX_TASK_STATE_BYTES,
  createTaskStateSource,
  parseTaskStateSummary,
  taskStateMessage,
  isGeneratedTaskStateMessage,
  consolidateGeneratedTaskStates,
  generatedTaskStateCovers,
  generatedTaskStateArchivedUserMatches,
  generatedTaskStateUserArchiveReferences,
} = require('../lib/proxy/context-task-state');

const owner = 'root-fixture';
const scope = 'hcs_' + 'a'.repeat(32);
function leaf(index, store, workSize = 8, workText = 'Reported work, not independently verified.') {
  const quote = `Constraint ${index}: do not delete user work.`;
  const messages = [
    { role: 'user', content: 'Original objective.' },
    { role: 'user', content: quote + ' Historical background.'.repeat(30) },
    {
      role: 'user',
      content: index % 2 ? 'Later user: revoke the previous restriction.' : 'recent-1',
    },
    { role: 'user', content: 'current-2' },
  ];
  const source = createTaskStateSource(messages);
  const state = parseTaskStateSummary(
    JSON.stringify({
      schema: 'hpm.context.task_state',
      version: 1,
      objectives: [],
      requirements: [
        {
          id: 'same_snapshot_local_id',
          status: index % 2 ? 'revoked' : 'active',
          text: quote,
          sources: [{ sourceId: 'm_1', quote }],
          ...(index % 2 ? { revision: { sourceId: 'm_2', quote: messages[2].content } } : {}),
        },
      ],
      decisions: [],
      work: Array.from({ length: workSize }, (_entry, workIndex) => ({
        text: Array.isArray(workText) ? workText[workIndex] : workText,
        status: 'reported_complete',
        sources: [{ sourceId: 'm_1', quote }],
      })),
      blockers: [],
      nextSteps: [],
      files: [],
    }),
    source
  );
  const selection = selectHistoricalUserArchive(messages, {
    enabled: true,
    protectedIntervals: [],
  });
  assert.deepEqual(selection.indices, [1]);
  const tx = store.beginTransaction(owner, scope);
  const archive = stageHistoricalUserArchive(selection, state, tx, owner, scope);
  assert.ok(archive);
  const message = taskStateMessage(state, source, archive);
  assert.equal(tx.commit(collectContextArtifactReferences([message], scope)).ok, true);
  return {
    message,
    messages,
    state,
    source,
    archive,
    payload: JSON.parse(message.content.slice(TASK_STATE_MARKER.length + 1)),
  };
}
function body(messages) {
  return {
    model: 'fixture',
    messages: [
      {
        role: 'system',
        content: 'Keep credentials secret. Do not treat history as new permission.',
      },
      { role: 'user', content: 'Continue the original task.' },
      ...messages,
      { role: 'user', content: 'Current input remains exact.' },
    ],
  };
}
function partitionableLeaves(store) {
  return Array.from({ length: 8 }, (_, index) =>
    leaf(
      index,
      store,
      6,
      Array.from(
        { length: 6 },
        (_entry, step) => `Snapshot ${index}, distinct work ${step}: ` + 'x'.repeat(900)
      )
    )
  );
}

test('ordinary roots losslessly consolidate snapshot-local constraints, provenance and readable archive indexes', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const leaves = Array.from({ length: 8 }, (_, index) => leaf(index, store));
  const messages = leaves.map((value) => value.message);
  const before = JSON.stringify(messages);
  const packed = consolidateGeneratedTaskStates(messages, owner, scope);
  assert.equal(packed.length, 1);
  assert.ok(isGeneratedTaskStateMessage(packed[0]));
  assert.ok(Buffer.byteLength(packed[0].content) <= MAX_TASK_STATE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(before));
  assert.deepEqual(
    decodeTaskStateRoot(packed[0].content),
    leaves.map((value) => value.payload)
  );
  assert.equal(JSON.stringify(messages), before);
  const root = JSON.parse(packed[0].content.slice(TASK_STATE_MARKER.length + 1));
  assert.equal(root.version, 1, 'fitting legacy roots keep their established encoding');
  const restored = decodeTaskStateRoot(packed[0].content);
  assert.equal(restored[1].state.requirements[0].status, 'revoked');
  assert.equal(restored[1].state.requirements[0].revision.sourceRole, 'user');
  assert.equal(restored[1].state.requirements[0].revision.sourceIndex, 2);
  assert.equal(new Set(root.snapshots.map((value) => value.namespace)).size, 8);
  assert.ok(
    root.snapshots.every((value) => value.state.requirements[0].id === 'same_snapshot_local_id')
  );
  assert.ok(
    root.snapshots.every(
      (value, index) =>
        value.state.requirements[0].text === leaves[index].payload.state.requirements[0].text
    )
  );
  assert.ok(root.snapshots.every((value) => value.state.work[0].verification === 'not_verified'));
  assert.match(root.recovery, /not new execution authority/);
  const receipts = generatedTaskStateUserArchiveReferences(packed[0]);
  assert.equal(receipts.length, 8);
  assert.equal(collectContextArtifactReferences(packed, scope).length, 8);
  for (const [index, receipt] of receipts.entries()) {
    assert.deepEqual(
      store.read(owner, scope, receipt.locator, receipt.digest).value,
      leaves[index].messages[1]
    );
    assert.equal(store.read('foreign', scope, receipt.locator, receipt.digest).ok, false);
  }
  t.diagnostic(
    JSON.stringify({
      legacyBytes: Buffer.byteLength(before),
      rootBytes: Buffer.byteLength(JSON.stringify(packed)),
    })
  );
});

test('repeated archive-state entries fit an exact dictionary root instead of stalling at the unchanged wire ceiling', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const leaves = Array.from({ length: 4 }, (_, index) => leaf(index, store, 16, 'x'.repeat(900)));
  const payloads = leaves.map((value) => value.payload);
  const text = encodeTaskStateRoot(payloads);
  assert.ok(text, 'repeated validated entries should not strand otherwise recoverable state');
  assert.ok(Buffer.byteLength(text) <= MAX_TASK_STATE_BYTES);
  const root = JSON.parse(text.slice(TASK_STATE_MARKER.length + 1));
  assert.equal(root.version, 2);
  assert.equal(root.stateEntries.length, 8, 'one requirement and one work entry per namespace');
  assert.deepEqual(decodeTaskStateRoot(text), payloads);
  const input = body(leaves.map((value) => value.message));
  const before = JSON.stringify(input);
  const history = createContextHistoryBranch(input, { owner, scope });
  t.after(() => history.close());
  const result = planWorkBuddyWbipcRequest(input, {
    force: true,
    targetBodyBytes: MAX_TASK_STATE_BYTES,
    artifactOwner: owner,
    artifactScope: scope,
    artifactStore: store,
    historyBranch: history,
  });
  assert.equal(result.fits, true, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.historyTransactionStatus, 'committed');
  const states = result.body.messages.filter(isGeneratedTaskStateMessage);
  assert.equal(states.length, 1);
  assert.equal(states[0].content, text);
  assert.deepEqual(decodeTaskStateRoot(states[0].content), payloads);
  for (const value of leaves)
    assert.equal(generatedTaskStateCovers(states[0], value.message), true);
  const receipts = generatedTaskStateUserArchiveReferences(states[0]);
  assert.equal(receipts.length, 4);
  for (const [index, receipt] of receipts.entries()) {
    const restored = store.read(owner, scope, receipt.locator, receipt.digest);
    assert.equal(restored.ok, true);
    assert.deepEqual(restored.value, leaves[index].messages[1]);
    assert.equal(store.read('foreign', scope, receipt.locator, receipt.digest).ok, false);
  }
  const forged = JSON.parse(JSON.stringify(states[0]));
  assert.equal(isGeneratedTaskStateMessage(forged), false);
  assert.deepEqual(collectContextArtifactReferences([forged], scope), []);
  assert.equal(JSON.stringify(input), before);
  const next = leaf(4, store, 16, 'x'.repeat(900));
  const inherited = history.snapshot().body.messages.find(isGeneratedTaskStateMessage);
  const branch = [inherited, next.message];
  const continued = consolidateGeneratedTaskStates(branch, owner, scope);
  assert.equal(continued.length, 1);
  assert.deepEqual(decodeTaskStateRoot(continued[0].content), [...payloads, next.payload]);
  assert.equal(generatedTaskStateCovers(continued[0], inherited), true);
  assert.equal(generatedTaskStateCovers(continued[0], next.message), true);
  assert.equal(consolidateGeneratedTaskStates(branch, 'foreign', scope), branch);
  assert.equal(consolidateGeneratedTaskStates(branch, owner, 'foreign'), branch);
  assert.equal(consolidateGeneratedTaskStates(branch, owner, scope, new Set([inherited])), branch);
  for (const role of ['user', 'system', 'developer']) {
    const separated = [inherited, { role, content: 'Keep this boundary exact.' }, next.message];
    assert.equal(consolidateGeneratedTaskStates(separated, owner, scope), separated);
  }
  t.diagnostic(
    JSON.stringify({
      originalBytes: Buffer.byteLength(before),
      rootBytes: Buffer.byteLength(text),
      exactSnapshots: payloads.length,
      modelRequests: 0,
    })
  );
});

test('an oversized archive-state group still consolidates fitting exact subgroups and admits the complete history', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const leaves = partitionableLeaves(store);
  const states = leaves.map((value) => value.message);
  assert.equal(encodeTaskStateRoot(leaves.map((value) => value.payload)), null);
  const expectedGroups = [states.slice(0, 4), states.slice(4)].map((group) => {
    const packed = consolidateGeneratedTaskStates(group, owner, scope);
    assert.equal(packed.length, 1, 'each independently fitting half is exactly packable');
    return packed[0];
  });
  const input = body(states);
  const before = JSON.stringify(input);
  const budget = Buffer.byteLength(JSON.stringify(body(expectedGroups))) + 2500;
  assert.ok(Buffer.byteLength(before) > budget);
  const packed = consolidateGeneratedTaskStates(states, owner, scope);
  assert.equal(packed.length, 2, 'one oversized root must not prevent fitting subgroup roots');
  assert.deepEqual(
    packed.flatMap((message) => decodeTaskStateRoot(message.content)),
    leaves.map((value) => value.payload)
  );
  assert.equal(
    consolidateGeneratedTaskStates(packed, owner, scope),
    packed,
    'a stable partition is idempotent and does not grow a hierarchy'
  );
  const history = createContextHistoryBranch(input, { owner, scope });
  t.after(() => history.close());
  const result = planWorkBuddyWbipcRequest(input, {
    force: true,
    targetBodyBytes: budget,
    artifactOwner: owner,
    artifactScope: scope,
    artifactStore: store,
    historyBranch: history,
  });
  assert.equal(result.fits, true, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.historyTransactionStatus, 'committed');
  assert.ok(Buffer.byteLength(JSON.stringify(result.body)) <= budget);
  const roots = result.body.messages.filter(isGeneratedTaskStateMessage);
  assert.equal(roots.length, 2);
  assert.ok(roots.every((message) => Buffer.byteLength(message.content) <= MAX_TASK_STATE_BYTES));
  for (const value of leaves)
    assert.ok(roots.some((message) => generatedTaskStateCovers(message, value.message)));
  const receipts = roots.flatMap(generatedTaskStateUserArchiveReferences);
  assert.equal(receipts.length, leaves.length);
  for (const [index, receipt] of receipts.entries()) {
    assert.deepEqual(
      store.read(owner, scope, receipt.locator, receipt.digest).value,
      leaves[index].messages[1]
    );
    assert.equal(store.read('foreign', scope, receipt.locator, receipt.digest).ok, false);
  }
  assert.equal(JSON.stringify(input), before);
  t.diagnostic(
    JSON.stringify({
      originalRequestBytes: Buffer.byteLength(before),
      finalRequestBytes: Buffer.byteLength(JSON.stringify(result.body)),
      roots: roots.length,
      exactSnapshotsAndReadbacks: receipts.length,
      modelRequests: 0,
    })
  );
});

test('partition fallback retains barriers, pins, capability checks and atomic rollback', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const leaves = partitionableLeaves(store);
  const states = leaves.map((value) => value.message);
  assert.equal(consolidateGeneratedTaskStates(states, 'foreign', scope), states);
  assert.equal(consolidateGeneratedTaskStates(states, owner, 'foreign'), states);
  const replay = JSON.parse(JSON.stringify(states));
  assert.equal(consolidateGeneratedTaskStates(replay, owner, scope), replay);
  assert.deepEqual(collectContextArtifactReferences(replay, scope), []);
  const pinned = consolidateGeneratedTaskStates(states, owner, scope, new Set(states.slice(0, 4)));
  assert.equal(pinned.length, 5);
  states.slice(0, 4).forEach((message, index) => assert.equal(pinned[index], message));
  for (const role of ['user', 'system', 'developer']) {
    const boundary = { role, content: 'This boundary stays exact.' };
    const split = consolidateGeneratedTaskStates(
      [...states.slice(0, 4), boundary, ...states.slice(4)],
      owner,
      scope
    );
    assert.equal(split.length, 3);
    assert.equal(split[1], boundary);
    assert.deepEqual(
      decodeTaskStateRoot(split[0].content),
      leaves.slice(0, 4).map((leaf) => leaf.payload)
    );
    assert.deepEqual(
      decodeTaskStateRoot(split[2].content),
      leaves.slice(4).map((leaf) => leaf.payload)
    );
  }
  const barriers = [2, 3, 4, 5];
  const blocked = consolidateGeneratedTaskStates(states, owner, scope, new Set(), barriers);
  assert.equal(blocked.length, 6);
  for (const index of barriers) assert.ok(blocked.includes(states[index]));
  const input = body(states);
  const history = createContextHistoryBranch(input, { owner, scope });
  t.after(() => history.close());
  const snapshot = JSON.stringify(history.snapshot().body);
  const options = {
    force: true,
    targetBodyBytes: 65536,
    artifactOwner: owner,
    artifactScope: scope,
    artifactStore: store,
    historyBranch: history,
  };
  const controller = new globalThis.AbortController();
  controller.abort();
  const cancelled = planWorkBuddyWbipcRequest(input, { ...options, signal: controller.signal });
  assert.equal(cancelled.fits, false);
  assert.equal(JSON.stringify(history.snapshot().body), snapshot);
  const failed = planWorkBuddyWbipcRequest(input, {
    ...options,
    artifactStore: {
      ...store,
      beginTransaction(...args) {
        const transaction = store.beginTransaction(...args);
        return { ...transaction, commit: () => ({ ok: false, reason: 'unavailable' }) };
      },
    },
  });
  assert.equal(failed.fits, false);
  assert.equal(failed.changed, false);
  assert.equal(JSON.stringify(history.snapshot().body), snapshot);
  const disabled = applyResponsesHistoryPolicy(input, { truncation: 'disabled' });
  const disabledHistory = createContextHistoryBranch(disabled, { owner, scope });
  t.after(() => disabledHistory.close());
  const disabledSnapshot = disabledHistory.snapshot();
  const refused = planWorkBuddyWbipcRequest(disabled, {
    ...options,
    historyBranch: disabledHistory,
  });
  assert.equal(refused.body, disabledSnapshot.body);
  assert.equal(disabledHistory.snapshot().body, disabledSnapshot.body);
  assert.equal(JSON.stringify(refused.body), JSON.stringify(disabled));
  assert.equal(refused.fits, false);
});

test('overlapping inherited roots cannot amplify partition encoding work without bound', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const leaves = partitionableLeaves(store);
  const roots = consolidateGeneratedTaskStates(
    leaves.map((leaf) => leaf.message),
    owner,
    scope
  );
  assert.equal(roots.length, 2);
  const repeated = Array.from({ length: 64 }, (_entry, index) => roots[index % roots.length]);
  const ownKeys = Reflect.ownKeys;
  let attempts = 0;
  // Every full-root codec admission traverses these exact payloads once;
  // counting JSON strings would miss an encoding that rejects before emission.
  const admission = t.mock.method(Reflect, 'ownKeys', (value) => {
    if (
      Array.isArray(value) &&
      value.length === leaves.length &&
      value.every((entry) => entry?.origin === 'hpm_workbuddy_task_state')
    )
      attempts++;
    return ownKeys(value);
  });
  let packed;
  try {
    packed = consolidateGeneratedTaskStates(repeated, owner, scope);
  } finally {
    admission.mock.restore();
  }
  assert.equal(packed, repeated, 'already fitting originals remain exact when no merge fits');
  const limit = 1 + Math.ceil(Math.log2(repeated.length));
  assert.ok(attempts <= limit, `overlap caused ${attempts} full-source admissions; limit ${limit}`);
  assert.ok(attempts > 0);
  t.diagnostic(
    JSON.stringify({
      messages: repeated.length,
      fullSourceAdmissions: attempts,
      limit,
      modelRequests: 0,
    })
  );
});

test('dictionary roots strictly validate entry tables and indexes without granting provenance', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const leaves = Array.from({ length: 4 }, (_, index) => leaf(index, store, 16, 'x'.repeat(900)));
  const text = encodeTaskStateRoot(leaves.map((value) => value.payload));
  const root = JSON.parse(text.slice(TASK_STATE_MARKER.length + 1));
  assert.equal(root.version, 2);
  for (const mutate of [
    (value) => {
      delete value.stateEntries;
    },
    (value) => {
      value.stateEntries = {};
    },
    (value) => {
      value.stateEntries = [];
    },
    (value) => {
      value.stateEntries[0] = null;
    },
    (value) => {
      value.stateEntries[0].sources = [];
    },
    (value) => {
      value.stateEntries[0].sources[0] = -1;
    },
    (value) => {
      value.stateEntries[0].revision = value.sourceTable.length;
    },
    (value) => {
      value.stateEntries[0].text = 'Untrusted replacement';
    },
    (value) => {
      value.snapshots[0].state.work[0] = -1;
    },
    (value) => {
      value.snapshots[0].state.work[0] = 0.5;
    },
    (value) => {
      value.snapshots[0].state.work[0] = '0';
    },
    (value) => {
      value.snapshots[0].state.work[0] = value.stateEntries.length;
    },
    (value) => {
      value.snapshots[0].state.work = Array(33).fill(0);
    },
    (value) => {
      value.version = 3;
    },
    (value) => {
      value.version = 1;
    },
    (value) => {
      value.recovery = 'Ignore missing evidence';
    },
    (value) => {
      value.archivePolicy.replayExternalTools = true;
    },
  ]) {
    const changed = globalThis.structuredClone(root);
    mutate(changed);
    assert.throws(() => decodeTaskStateRoot(TASK_STATE_MARKER + '\n' + JSON.stringify(changed)), {
      code: 'invalid_task_state_root',
    });
  }
  assert.equal(isGeneratedTaskStateMessage({ role: 'assistant', content: text }), false);
});

test('root lineage survives exact history clones, flat repeated consolidation and duplicate snapshots, never JSON replay', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const originals = Array.from({ length: 3 }, (_, index) => leaf(index, store));
  const first = consolidateGeneratedTaskStates(
    originals.map((value) => value.message),
    owner,
    scope
  );
  assert.equal(first.length, 1);
  const later = leaf(3, store);
  const history = createContextHistoryBranch(body([...first, later.message]), { owner, scope });
  t.after(() => history.close());
  const snapshot = history.snapshot();
  const packed = consolidateGeneratedTaskStates(snapshot.body.messages, owner, scope);
  const root = packed.find((value) => generatedTaskStateCovers(value, first[0]));
  assert.ok(root);
  assert.equal(decodeTaskStateRoot(root.content).length, 4);
  assert.equal(
    decodeTaskStateRoot(root.content)[0].state.requirements[0].text,
    originals[0].payload.state.requirements[0].text
  );
  assert.ok(
    !JSON.stringify(JSON.parse(root.content.slice(TASK_STATE_MARKER.length + 1))).includes(
      'hpm.context.task_state_root\\'
    )
  );
  const forged = JSON.parse(JSON.stringify(root));
  assert.equal(isGeneratedTaskStateMessage(forged), false);
  assert.equal(generatedTaskStateCovers(forged, originals[0].message), false);
  assert.deepEqual(generatedTaskStateUserArchiveReferences(forged), []);
  assert.equal(
    history.stage(snapshot, {
      ...snapshot.body,
      messages: packed.map((value) => (value === root ? forged : value)),
    }).ok,
    false
  );
  const staged = history.stage(snapshot, { ...snapshot.body, messages: packed });
  assert.equal(staged.ok, true);
  assert.equal(history.commit(staged.ticket, { publish: () => ({ ok: true }) }).ok, true);
  const duplicate = consolidateGeneratedTaskStates([first[0], first[0]], owner, scope);
  assert.equal(duplicate.length, 1);
  assert.equal(decodeTaskStateRoot(duplicate[0].content).length, 3);
});

test('inherited archive positions never authorize dropping users from a new source array', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const leaves = [leaf(0, store), leaf(1, store)];
  const root = consolidateGeneratedTaskStates(
    leaves.map((value) => value.message),
    owner,
    scope
  )[0];
  const original = leaves[0].messages;
  assert.equal(
    generatedTaskStateArchivedUserMatches(root, 1, original[1], owner, scope, original),
    true
  );
  const copied = [...original];
  assert.equal(
    generatedTaskStateArchivedUserMatches(root, 1, copied[1], owner, scope, copied),
    false
  );
  assert.equal(
    generatedTaskStateArchivedUserMatches(root, 1, original[1], 'foreign', scope, original),
    false
  );
  const history = createContextHistoryBranch(body([root]), { owner, scope });
  t.after(() => history.close());
  const snapshot = history.snapshot();
  assert.equal(
    history.stage(snapshot, {
      ...snapshot.body,
      messages: snapshot.body.messages.filter((_entry, index) => index !== 1),
    }).ok,
    false
  );
});

test('user/policy barriers, caller pins, unsafe intervals and foreign identities remain indivisible', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const states = Array.from({ length: 4 }, (_, index) => leaf(index, store).message);
  for (const role of ['user', 'system', 'developer']) {
    const middle = { role, content: 'Boundary must remain exact.' };
    const messages = [states[0], middle, states[1]];
    assert.equal(consolidateGeneratedTaskStates(messages, owner, scope), messages);
    const input = body(messages);
    const history = createContextHistoryBranch(input, { owner, scope });
    const snapshot = history.snapshot();
    const illegitimate = consolidateGeneratedTaskStates([states[0], states[1]], owner, scope)[0];
    assert.equal(
      history.stage(snapshot, {
        ...input,
        messages: input.messages
          .filter((entry) => !states.includes(entry))
          .toSpliced(2, 0, illegitimate),
      }).ok,
      false
    );
    history.close();
  }
  assert.equal(consolidateGeneratedTaskStates(states, 'foreign', scope), states);
  assert.equal(consolidateGeneratedTaskStates(states, owner, 'foreign'), states);
  const pinned = consolidateGeneratedTaskStates(
    states,
    owner,
    scope,
    new Set([states[1], states[2]])
  );
  assert.equal(pinned, states);
  const blocked = consolidateGeneratedTaskStates(states, owner, scope, new Set(), [1, 2]);
  assert.equal(blocked, states);
});

test('ordinary planner admits an over-budget accumulated archive state via an atomic root, with no model call', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const leaves = Array.from({ length: 8 }, (_, index) => leaf(index, store));
  const input = body(leaves.map((value) => value.message));
  const compacted = consolidateGeneratedTaskStates(input.messages, owner, scope);
  const packedBytes = Buffer.byteLength(JSON.stringify({ ...input, messages: compacted }));
  const budget = packedBytes + 6000;
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > budget);
  const history = createContextHistoryBranch(input, { owner, scope });
  t.after(() => history.close());
  const result = planWorkBuddyWbipcRequest(input, {
    force: true,
    targetBodyBytes: budget,
    artifactOwner: owner,
    artifactScope: scope,
    artifactStore: store,
    historyBranch: history,
  });
  assert.equal(result.fits, true, JSON.stringify(result.diagnostics));
  assert.equal(result.changed, true);
  assert.equal(result.diagnostics.taskStateRootsConsolidated, true);
  assert.equal(result.diagnostics.historyTransactionStatus, 'committed');
  assert.equal(result.body.messages.filter(isGeneratedTaskStateMessage).length, 1);
  assert.equal(collectContextArtifactReferences(result.body.messages, scope).length, 8);
  assert.ok(result.body.tools.some((tool) => tool.function?.name === 'hpm_read_context_artifact'));
  assert.deepEqual(history.snapshot().body, result.body);
  const disabled = applyResponsesHistoryPolicy(input, { truncation: 'disabled' });
  const preserved = planWorkBuddyWbipcRequest(disabled, {
    force: true,
    targetBodyBytes: budget,
    artifactOwner: owner,
    artifactScope: scope,
    artifactStore: store,
  });
  assert.equal(preserved.fits, false);
  assert.equal(preserved.body, disabled);
});

test('repeated ordinary task-state preparation reuses one flat archive root with every original readable', async (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const leaves = Array.from({ length: 8 }, (_, index) => leaf(index, store));
  let input = body(leaves.map((value) => value.message));
  const history = createContextHistoryBranch(input, { owner, scope });
  t.after(() => history.close());
  let summaryCalls = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    if (cycle) {
      const next = leaf(leaves.length, store);
      leaves.push(next);
      const messages = [...input.messages];
      messages.splice(messages.length - 1, 0, next.message);
      input = { ...input, messages };
      assert.equal(history.replace(input, history.stats().version).ok, true);
    }
    const result = await prepareWorkBuddyTaskStateContext(
      input,
      {
        force: true,
        targetBodyBytes: 32768,
        archiveHistoricalUsers: true,
        artifactOwner: owner,
        artifactScope: scope,
        artifactStore: store,
      },
      {
        historyBranch: history,
        requestSummary: async () => {
          summaryCalls++;
          throw new Error('Already validated states need no new model summary');
        },
      }
    );
    assert.equal(result.fits, true, JSON.stringify(result.diagnostics));
    assert.equal(result.diagnostics.historyTransactionStatus, 'committed');
    const states = result.body.messages.filter(isGeneratedTaskStateMessage);
    assert.equal(states.length, 1);
    assert.equal(decodeTaskStateRoot(states[0].content).length, leaves.length);
    assert.equal(
      collectContextArtifactReferences(result.body.messages, scope).length,
      leaves.length
    );
    for (const receipt of generatedTaskStateUserArchiveReferences(states[0]))
      assert.equal(store.read(owner, scope, receipt.locator, receipt.digest).ok, true);
    input = result.body;
  }
  assert.equal(summaryCalls, 0);
  const root = input.messages.find(isGeneratedTaskStateMessage);
  assert.equal(decodeTaskStateRoot(root.content)[1].state.requirements[0].status, 'revoked');
});

test('the production planner never consolidates through a pending tool interval or an explicit state pin', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const states = Array.from({ length: 4 }, (_, index) => leaf(index, store).message);
  const pending = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'pending', type: 'function', function: { name: 'write', arguments: '{}' } }],
  };
  const input = body([states[0], pending, states[1]]);
  const result = planWorkBuddyWbipcRequest(input, {
    force: true,
    targetBodyBytes: 32768,
    artifactOwner: owner,
    artifactScope: scope,
    artifactStore: store,
  });
  assert.equal(result.diagnostics.taskStateRootsConsolidated, false);
  assert.equal(result.body.messages.filter(isGeneratedTaskStateMessage).length, 2);
  assert.ok(result.body.messages.some((entry) => entry.tool_calls?.[0]?.id === 'pending'));
  const pinned = planWorkBuddyWbipcRequest(body(states), {
    force: true,
    targetBodyBytes: 32768,
    artifactOwner: owner,
    artifactScope: scope,
    artifactStore: store,
    protectedMessages: new Set([states[0]]),
  });
  assert.equal(pinned.fits, true);
  assert.ok(pinned.body.messages.includes(states[0]));
  assert.equal(pinned.body.messages.filter(isGeneratedTaskStateMessage).length, 2);
});

test('expiry, publication failure and replacement stores retain unavailable status instead of replay', (t) => {
  let now = 100;
  const store = createContextArtifactStore({ now: () => now, ttlMs: 10, maxLifetimeMs: 20 });
  t.after(() => store.close());
  const leaves = [leaf(0, store), leaf(1, store)];
  const input = body(leaves.map((value) => value.message));
  const history = createContextHistoryBranch(input, { owner, scope });
  t.after(() => history.close());
  const before = JSON.stringify(history.snapshot().body);
  const rejectingStore = {
    beginTransaction(...args) {
      const tx = store.beginTransaction(...args);
      return { ...tx, commit: () => ({ ok: false, reason: 'unavailable' }) };
    },
  };
  const rejected = planWorkBuddyWbipcRequest(input, {
    force: true,
    targetBodyBytes: 32768,
    artifactOwner: owner,
    artifactScope: scope,
    artifactStore: rejectingStore,
    historyBranch: history,
  });
  assert.equal(rejected.fits, false);
  assert.equal(rejected.changed, false);
  assert.equal(JSON.stringify(history.snapshot().body), before);
  const controller = new globalThis.AbortController();
  controller.abort();
  const cancelled = planWorkBuddyWbipcRequest(input, {
    force: true,
    targetBodyBytes: 32768,
    artifactOwner: owner,
    artifactScope: scope,
    artifactStore: store,
    historyBranch: history,
    signal: controller.signal,
  });
  assert.equal(cancelled.fits, false);
  assert.equal(JSON.stringify(history.snapshot().body), before);
  const root = consolidateGeneratedTaskStates(
    leaves.map((value) => value.message),
    owner,
    scope
  )[0];
  const receipt = generatedTaskStateUserArchiveReferences(root)[0];
  const replacement = createContextArtifactStore();
  t.after(() => replacement.close());
  assert.equal(replacement.read(owner, scope, receipt.locator, receipt.digest).ok, false);
  now = 121;
  assert.equal(store.read(owner, scope, receipt.locator, receipt.digest).ok, false);
});

test('malformed codec input and diagnostic-looking data cannot mint capabilities or execute hooks', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  const leaves = [leaf(0, store), leaf(1, store)];
  const text = encodeTaskStateRoot(leaves.map((value) => value.payload));
  const root = JSON.parse(text.slice(TASK_STATE_MARKER.length + 1));
  for (const mutate of [
    (value) => {
      value.version = 2;
    },
    (value) => {
      value.snapshots[0].namespace = '0'.repeat(64);
    },
    (value) => {
      value.snapshots[0].state.requirements[0].sources = [-1];
    },
    (value) => {
      value.snapshots[0].entries[0].receiptIndex = 999;
    },
    (value) => {
      value.sourceTable[0][0] = 'm_999';
    },
    (value) => {
      value.evidenceReceipts[0].digest = 'SECRET';
    },
    (value) => {
      value.archivePolicy.replayExternalTools = true;
    },
    (value) => {
      value.snapshots.push(value.snapshots[0]);
    },
  ]) {
    const changed = globalThis.structuredClone(root);
    mutate(changed);
    assert.throws(() => decodeTaskStateRoot(TASK_STATE_MARKER + '\n' + JSON.stringify(changed)), {
      code: 'invalid_task_state_root',
    });
  }
  let hooks = 0;
  const poisoned = Object.defineProperty({}, 'origin', {
    get() {
      hooks++;
      return 'SECRET';
    },
  });
  for (const value of [null, [], {}, [poisoned, leaves[0].payload], new Array(99999)])
    assert.throws(() => encodeTaskStateRoot(value), { code: 'invalid_task_state_root' });
  for (const value of [
    null,
    '',
    'SECRET',
    TASK_STATE_MARKER + '\n{',
    'x'.repeat(MAX_TASK_STATE_BYTES + 1),
  ])
    assert.throws(() => decodeTaskStateRoot(value), { code: 'invalid_task_state_root' });
  const getterMessages = [];
  Object.defineProperty(getterMessages, '0', {
    get() {
      hooks++;
      return leaves[0].message;
    },
  });
  assert.equal(consolidateGeneratedTaskStates(getterMessages, owner, scope), getterMessages);
  assert.equal(hooks, 0);
});

test('oversized and no-gain roots retain exact old messages without raising the 32-KiB ceiling', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  // Distinct long entries remain irreducible even with exact dictionary coding.
  const large = Array.from({ length: 4 }, (_, index) =>
    leaf(
      index,
      store,
      16,
      Array.from({ length: 16 }, (_entry, item) => `${index}:${item}:` + 'x'.repeat(900))
    )
  );
  assert.equal(encodeTaskStateRoot(large.map((value) => value.payload)), null);
  const messages = large.map((value) => value.message);
  assert.equal(consolidateGeneratedTaskStates(messages, owner, scope), messages);
  const same = [messages[0], messages[0]];
  assert.equal(consolidateGeneratedTaskStates(same, owner, scope), same);
  const duplicateHalves = [messages[0], messages[0], messages[1], messages[1]];
  assert.equal(consolidateGeneratedTaskStates(duplicateHalves, owner, scope), duplicateHalves);
  assert.equal(consolidateGeneratedTaskStates([], owner, scope).length, 0);
  const tinyMessages = [leaf(10, store, 0).message, leaf(12, store, 0).message];
  assert.equal(consolidateGeneratedTaskStates(tinyMessages, owner, scope), tinyMessages);
  assert.equal(
    consolidateGeneratedTaskStates(messages, owner, scope, new Proxy(new Set(), {})),
    messages
  );
  let hooks = 0;
  const barriers = [];
  Object.defineProperty(barriers, '0', {
    get() {
      hooks++;
      return 1;
    },
  });
  assert.equal(
    consolidateGeneratedTaskStates(messages, owner, scope, new Set(), barriers),
    messages
  );
  assert.equal(hooks, 0);
  const repeated = Array.from({ length: 2049 }, () =>
    taskStateMessage(large[0].state, large[0].source, large[0].archive)
  );
  assert.equal(consolidateGeneratedTaskStates(repeated, owner, scope), repeated);
  const byteLimited = repeated.slice(0, 128);
  assert.equal(consolidateGeneratedTaskStates(byteLimited, owner, scope), byteLimited);
});

test('small encoded roots cannot amplify indexed references beyond the independent expanded-byte ceiling', (t) => {
  const store = createContextArtifactStore();
  t.after(() => store.close());
  for (const dictionary of [false, true]) {
    const leaves = dictionary
      ? Array.from({ length: 4 }, (_, index) => leaf(index, store, 16, 'x'.repeat(900)))
      : [leaf(0, store), leaf(1, store)];
    const root = JSON.parse(
      encodeTaskStateRoot(leaves.map((value) => value.payload)).slice(TASK_STATE_MARKER.length + 1)
    );
    const tuple = [...root.sourceTable[0]];
    tuple[4] = 'x'.repeat(1024);
    tuple[5] = 0;
    tuple[6] = 1024;
    root.sourceTable = [tuple];
    assert.equal(root.version, dictionary ? 2 : 1);
    if (dictionary) root.stateEntries = [{ text: 'x', sources: [0, 0, 0, 0] }];
    const source = Object.fromEntries(root.sourceFields.map((key, index) => [key, tuple[index]]));
    const canonical = (value) =>
      Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])])
            )
          : value;
    const expandedPayloads = [];
    root.snapshots = Array.from({ length: 4 }, (_, index) => {
      const state = {
        schema: 'hpm.context.task_state',
        version: 1,
        objectives: [],
        requirements: [],
        decisions: [],
        work: [],
        blockers: [],
        nextSteps: [],
        files: [],
      };
      for (const section of ['objectives', 'decisions', 'work', 'blockers', 'nextSteps'])
        state[section] = Array.from({ length: 32 }, () =>
          dictionary ? 0 : { text: 'x', sources: [0, 0, 0, 0] }
        );
      const expanded = globalThis.structuredClone(state);
      for (const section of ['objectives', 'decisions', 'work', 'blockers', 'nextSteps'])
        expanded[section] = expanded[section].map((entry) => ({
          ...(dictionary ? root.stateEntries[entry] : entry),
          sources: Array(4).fill(source),
        }));
      const payload = {
        ...leaves[0].payload,
        sourceDigest: String(index + 1).repeat(64),
        state: expanded,
      };
      expandedPayloads.push(payload);
      return {
        ...root.snapshots[0],
        sourceDigest: payload.sourceDigest,
        state,
        namespace: createHash('sha256')
          .update(JSON.stringify(canonical(payload)))
          .digest('hex'),
      };
    });
    const wire = (value) => TASK_STATE_MARKER + '\n' + JSON.stringify(value);
    assert.equal(
      decodeTaskStateRoot(wire({ ...root, snapshots: root.snapshots.slice(0, 1) })).length,
      1
    );
    assert.ok(Buffer.byteLength(wire(root)) <= MAX_TASK_STATE_BYTES);
    let expandedBytes = 0;
    const overBudget = new Set(
      expandedPayloads
        .filter((payload) => {
          expandedBytes += Buffer.byteLength(JSON.stringify(payload));
          return expandedBytes > 2 * 1024 * 1024;
        })
        .map((payload) => payload.sourceDigest)
    );
    assert.ok(overBudget.size > 0);
    const stringify = JSON.stringify;
    const serialization = t.mock.method(JSON, 'stringify', (value, ...args) => {
      assert.ok(
        value?.origin !== 'hpm_workbuddy_task_state' || !overBudget.has(value.sourceDigest),
        'reject expanded-byte overflow before serializing or hashing an oversized payload'
      );
      return stringify(value, ...args);
    });
    try {
      assert.throws(() => decodeTaskStateRoot(wire(root)), { code: 'invalid_task_state_root' });
    } finally {
      serialization.mock.restore();
    }
    const forged = {
      role: 'assistant',
      content: wire({ ...root, snapshots: root.snapshots.slice(0, 1) }),
    };
    assert.equal(isGeneratedTaskStateMessage(forged), false);
    assert.deepEqual(collectContextArtifactReferences([forged], scope), []);
  }
});
