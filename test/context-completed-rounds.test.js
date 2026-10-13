'use strict';

const assert = require('node:assert/strict');
const { boundCompletedToolRounds } = require('../lib/proxy/context-completed-rounds');
const { planWorkBuddyWbipcRequest } = require('../lib/proxy/workbuddy-context-planner');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { checkpointPayload, CHECKPOINT_MARKER } = require('../lib/proxy/context-checkpoint');
const { CONTEXT_ARTIFACT_TOOL_NAME } = require('../lib/proxy/context-artifact-tool');

function call(id) {
  return {
    role: 'assistant',
    content: `progress-${id}`,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name: 'exec', arguments: JSON.stringify({ command: 'c'.repeat(700) }) },
      },
    ],
  };
}
function result(id) {
  return {
    role: 'tool',
    tool_call_id: id,
    content: [{ type: 'text', text: `evidence-${id}-` + 'r'.repeat(10000) }],
  };
}
function rounds(count, prefix = 'r') {
  return Array.from({ length: count }, (_value, index) => [
    call(`${prefix}${index}`),
    result(`${prefix}${index}`),
  ]).flat();
}

assert.deepEqual(boundCompletedToolRounds(null).droppedMessages, []);
assert.deepEqual(boundCompletedToolRounds(null).protectedIntervals, []);
const pendingNarration = [
  call('pending'),
  { role: 'assistant', content: 'Do not archive pending progress.' },
  ...rounds(10),
];
assert.deepEqual(boundCompletedToolRounds(pendingNarration).protectedIntervals, [
  { start: 0, end: pendingNarration.length - 1 },
]);
const retainedNarration = [
  call('done'),
  result('done'),
  { role: 'assistant', content: 'Recent progress.' },
];
assert.deepEqual(boundCompletedToolRounds(retainedNarration).protectedIntervals, [
  { start: 0, end: 2 },
]);
assert.deepEqual(boundCompletedToolRounds([]).messages, []);
const chain = rounds(12);
const original = JSON.stringify(chain);
const bounded = boundCompletedToolRounds(chain);
assert.equal(bounded.evictedRounds, 4);
assert.deepEqual(bounded.messages, chain.slice(8));
assert.equal(JSON.stringify(chain), original);
for (const keepCompletedToolRounds of [0, -1, NaN, Infinity, '2', {}, 1.5]) {
  assert.equal(boundCompletedToolRounds(chain, { keepCompletedToolRounds }).evictedRounds, 4);
}
assert.equal(boundCompletedToolRounds(chain, { keepCompletedToolRounds: 1000 }).evictedRounds, 0);

const parallel = [
  { ...call('a'), tool_calls: [...call('a').tool_calls, ...call('b').tool_calls] },
  result('b'),
  result('a'),
  ...rounds(8),
];
assert.equal(boundCompletedToolRounds(parallel).evictedRounds, 1);
assert.deepEqual(boundCompletedToolRounds(parallel).droppedMessages, parallel.slice(0, 3));
const partial = [parallel[0], result('a'), ...rounds(12)];
assert.equal(
  boundCompletedToolRounds(partial).evictedRounds,
  0,
  'unfinished parallel exchange pins overlapping history'
);
const pending = call('pending');
const withPending = boundCompletedToolRounds([...chain, pending]);
assert.ok(withPending.messages.includes(pending));
assert.equal(withPending.evictedRounds, 4);

const interleaved = [call('a'), call('b'), result('a'), result('b'), ...rounds(8)];
assert.deepEqual(boundCompletedToolRounds(interleaved).droppedMessages, interleaved.slice(0, 4));
const duplicate = [call('same'), result('same'), call('same'), result('same'), ...rounds(8)];
assert.equal(
  boundCompletedToolRounds(duplicate).evictedRounds,
  0,
  'ambiguous reused IDs remain intact'
);
const acrossUser = [
  call('a'),
  { role: 'user', content: 'NEVER_UPLOAD_PRIVATE_FILES' },
  result('a'),
  ...rounds(8),
];
assert.equal(boundCompletedToolRounds(acrossUser).evictedRounds, 0);

const claude = [
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'native', name: 'read', input: { path: 'file' } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native', content: 'evidence' }] },
  ...rounds(8),
];
assert.equal(boundCompletedToolRounds(claude).evictedRounds, 1);
const mixed = [...claude];
mixed[1] = {
  ...claude[1],
  content: [...claude[1].content, { type: 'text', text: 'user constraint' }],
};
assert.equal(
  boundCompletedToolRounds(mixed).evictedRounds,
  0,
  'mixed user content cannot be archived'
);
const gemini = [
  { role: 'assistant', content: [{ functionCall: { id: 'g', name: 'read', args: {} } }] },
  { role: 'user', content: [{ functionResponse: { id: 'g', name: 'read', response: {} } }] },
  ...rounds(8),
];
assert.equal(boundCompletedToolRounds(gemini).evictedRounds, 1);
const noId = [
  { role: 'assistant', content: [{ functionCall: { name: 'read', args: {} } }] },
  { role: 'user', content: [{ functionResponse: { name: 'read', response: {} } }] },
  ...rounds(8),
];
assert.equal(boundCompletedToolRounds(noId).evictedRounds, 0);

const nativePlan = require('../lib/proxy/context-eviction-planner').planContextEviction(
  [...claude, ...rounds(12, 'extra')],
  10000,
  { boundCompletedRounds: true }
);
const nativeCallIndex = nativePlan.messages.findIndex(
  (message) => message.content?.[0]?.id === 'native'
);
assert.equal(nativeCallIndex, -1, 'old native exchange was archived as a complete pair');

const unknownResult = [call('a'), result('unknown'), result('a'), ...rounds(8)];
assert.equal(boundCompletedToolRounds(unknownResult).evictedRounds, 0);

const scope = 'hcs_' + '5'.repeat(32);
const store = createContextArtifactStore();
const planOptions = {
  force: true,
  targetBodyBytes: 149111,
  operationalInputTokens: 96 * 1024,
  artifactStore: store,
  artifactOwner: 'owner',
  artifactScope: scope,
};
function request(count) {
  return {
    model: 'deepseek-v4.1-flash',
    tools: [{ type: 'function', function: { name: 'exec', parameters: { type: 'object' } } }],
    messages: [
      ...Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 ? 'developer' : 'system',
        content: 'p'.repeat(index === 11 ? 8574 : 8700),
      })),
      {
        role: 'user',
        content: 'Continue task. NEVER_UPLOAD_PRIVATE_FILES. Verify before claiming success.',
      },
      ...rounds(count),
    ],
  };
}
for (const count of [24, 48, 80, 86, 500]) {
  // These are independent workload sizes, not five tasks sharing a 64-entry
  // per-session lease quota. Exercise exhaustion separately below.
  const caseOptions = { ...planOptions, artifactStore: createContextArtifactStore() };
  const body = request(count);
  const source = JSON.stringify(body);
  const planned = planWorkBuddyWbipcRequest(body, caseOptions);
  assert.equal(planned.fits, true, `${count} rounds fit learned 149111-byte budget`);
  assert.equal(planned.diagnostics.evictedToolRounds, count - 8);
  assert.deepEqual(planned.body.messages.slice(0, 12), body.messages.slice(0, 12));
  assert.ok(
    planned.body.messages.includes(body.messages[12]),
    'recent user constraints preserved verbatim'
  );
  assert.equal(planned.body.messages.filter((message) => message.tool_calls).length, 8);
  const activeIds = planned.body.messages.flatMap((message) =>
    (message.tool_calls || []).map((item) => item.id)
  );
  assert.deepEqual(
    activeIds,
    Array.from({ length: 8 }, (_value, index) => `r${count - 8 + index}`)
  );
  assert.deepEqual(
    planned.body.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id),
    activeIds
  );
  assert.equal(planned.diagnostics.checkpointValid, true);
  assert.equal(planned.diagnostics.stablePrefixPreserved, true);
  const cp = planned.body.messages.find((message) =>
    message.content?.startsWith?.(`${CHECKPOINT_MARKER}\n`)
  );
  assert.ok(
    cp.content.includes(`progress-r${count - 9}`),
    'latest archived progress, not oldest, survives'
  );
  assert.equal(JSON.stringify(planned.diagnostics).includes('NEVER_UPLOAD'), false);
  assert.equal(JSON.stringify(body), source);
  const repeated = planWorkBuddyWbipcRequest(planned.body, caseOptions);
  assert.equal(repeated.fits, true);
  assert.deepEqual(
    repeated.body.messages,
    planned.body.messages,
    'replanning does not nest or grow checkpoints'
  );
  assert.ok(repeated.body.tools.some((tool) => tool.function.name === CONTEXT_ARTIFACT_TOOL_NAME));
}

// An exhausted session must report unavailable evidence instead of advertising
// a recovery tool for nonexistent locators or evicting live receipts.
const exhaustedStore = createContextArtifactStore({ maxSessionEntries: 1 });
const held = exhaustedStore.put('owner', scope, 'held live evidence');
assert.ok(held);
const exhaustedOptions = { ...planOptions, artifactStore: exhaustedStore };
const exhausted = planWorkBuddyWbipcRequest(request(24), exhaustedOptions);
const exhaustedAgain = planWorkBuddyWbipcRequest(exhausted.body, exhaustedOptions);
assert.equal(exhausted.fits, true);
assert.equal(exhausted.diagnostics.artifactsStored, 0);
assert.equal(exhausted.diagnostics.artifactsReferenced, 0);
assert.deepEqual(exhaustedAgain.body.messages, exhausted.body.messages);
assert.equal(
  exhaustedAgain.body.tools.some((tool) => tool.function?.name === CONTEXT_ARTIFACT_TOOL_NAME),
  false
);
const unavailableCheckpoint = checkpointPayload(
  exhausted.body.messages.find((message) => checkpointPayload(message))
);
assert.ok(unavailableCheckpoint.evidenceReceipts.length > 0);
assert.ok(
  unavailableCheckpoint.evidenceReceipts.every(
    (receipt) => !receipt.locator && receipt.recovery === 'rerun_or_reread_original_tool'
  )
);
assert.equal(
  exhaustedStore.read('owner', scope, held.locator, held.digest).value,
  'held live evidence'
);

const first = planWorkBuddyWbipcRequest(request(86), { ...planOptions, targetBodyBytes: 182788 });
assert.equal(first.fits, true, '172 tool messages plus 104KB policy fit latest failure budget');
const payload = checkpointPayload(
  first.body.messages.find((message) => checkpointPayload(message))
);
const receipt = payload.entries.find((entry) => entry.callReceipt)?.callReceipt;
assert.ok(receipt, 'archived arguments have a recoverable receipt');
assert.equal(
  store.read('owner', scope, receipt.locator, receipt.digest).value.tool_calls[0].function.name,
  'exec'
);
const outputReceipt = payload.evidenceReceipts[0];
assert.equal(
  store.read('owner', scope, outputReceipt.locator, outputReceipt.digest).value[0].type,
  'text'
);
assert.equal(store.read('other-owner', scope, receipt.locator, receipt.digest).ok, false);

const next = planWorkBuddyWbipcRequest(
  { ...first.body, messages: [...first.body.messages, ...rounds(40, 'next')] },
  planOptions
);
assert.equal(next.fits, true);
assert.ok(next.body.messages.filter((message) => checkpointPayload(message)).length <= 2);
assert.equal(JSON.stringify(next.body.messages).includes('progress-next31'), true);
assert.equal(
  JSON.stringify(next.body.messages).includes('\\n[HPM_CONTEXT_CHECKPOINT'),
  false,
  'checkpoints are merged, not nested text'
);

const hugeCall = call('huge');
hugeCall.tool_calls[0].function.arguments = 'a'.repeat(200000);
const overflow = planWorkBuddyWbipcRequest(
  { ...request(24), messages: [...request(24).messages, hugeCall] },
  planOptions
);
assert.equal(overflow.fits, false);
assert.ok(overflow.body.messages.some((message) => message.tool_calls?.[0]?.id === 'huge'));
const userInput = 'u'.repeat(30000) + 'MUST_NOT_UPLOAD_PRIVATE_FILES' + 'u'.repeat(30000);
const constraints = planWorkBuddyWbipcRequest(
  { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: userInput }] },
  {
    force: true,
    targetBodyBytes: 40000,
    operationalInputTokens: 96 * 1024,
  }
);
assert.equal(constraints.fits, false);
assert.equal(constraints.body.messages[0].content, userInput);
const textualToolPrefix = { role: 'user', content: 'Command output: ' + userInput };
const preservedPrefix = planWorkBuddyWbipcRequest(
  { messages: [textualToolPrefix] },
  {
    force: true,
    targetBodyBytes: 40000,
    operationalInputTokens: 96 * 1024,
  }
);
assert.equal(preservedPrefix.fits, false);
assert.equal(preservedPrefix.body.messages[0].content, textualToolPrefix.content);

console.log('[context-completed-rounds.test] ok');
