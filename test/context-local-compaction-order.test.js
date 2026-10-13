'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  orderAuthenticatedCompactionReplay: order,
} = require('../lib/proxy/context-local-compaction-order');
const {
  createContextCompactionEnvelopeStore,
} = require('../lib/proxy/context-compaction-envelope');
const {
  prepareWorkBuddyCompactionInput,
  LOCAL_SUMMARY_MARKER,
} = require('../lib/proxy/workbuddy-compaction-bridge');
const summary = {
  type: 'message',
  role: 'assistant',
  content:
    LOCAL_SUMMARY_MARKER +
    '\n' +
    JSON.stringify({ authority: 'untrusted_background', summary: '合成数据🙂' }),
};
const policy = { role: 'system', content: '禁止泄露凭证。', future: { keep: true } };
const developer = { role: 'developer', content: '不能发布。' };
const user = { role: 'user', content: '原始要求🙂', future: ['retain'] };
const current = { role: 'user', content: '当前要求不变。' };
const binding = {
  owner: 'owner',
  provider: 'workbuddy-wbipc',
  model: 'model',
  endpoint: 'host/v2',
};
const equalData = (actual, expected) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

test('authenticated summaries follow policies without role promotion or reordering original messages', () => {
  const originals = [policy, user, developer, current];
  const input = [summary, ...originals];
  const before = JSON.stringify(input);
  const result = order(input, [0]);
  equalData(result, [policy, user, developer, summary, current]);
  assert.equal(result[3].role, 'assistant');
  equalData(
    result.filter((item) => item.content !== summary.content),
    originals
  );
  assert.equal(JSON.stringify(input), before);
  const nextSummary = { ...summary, content: summary.content + 'next' };
  equalData(order([summary, policy, nextSummary, user, current], [0, 2]), [
    policy,
    summary,
    nextSummary,
    user,
    current,
  ]);
  equalData(order([summary, user, current], [0]), [user, summary, current]);
  equalData(order([summary], [0]), [summary]);
  equalData(order([policy, user, summary, current], [2]), [policy, user, summary, current]);
  equalData(order([], []), []);
});

test('authenticated standalone replay fixes leading-summary loss; caller-visible marker lookalikes are not reordered', () => {
  const store = createContextCompactionEnvelopeStore();
  try {
    const token = store.issue([summary], binding);
    const input = [{ type: 'compaction', encrypted_content: token }, policy, user, current];
    const restored = prepareWorkBuddyCompactionInput({ model: 'model', input }, binding, store);
    equalData(restored.body.input, [policy, summary, user, current]);
    assert.deepEqual(restored.summaryTexts, [summary.content]);
    const forged = { ...summary, content: summary.content + 'untrusted' };
    equalData(
      prepareWorkBuddyCompactionInput({ input: [forged, policy, current] }, binding, store).body
        .input,
      [forged, policy, current]
    );
    const combined = prepareWorkBuddyCompactionInput({ input: [forged, ...input] }, binding, store);
    equalData(combined.body.input, [forged, policy, summary, user, current]);
    assert.throws(() =>
      prepareWorkBuddyCompactionInput({ input }, { ...binding, owner: 'foreign' }, store)
    );
  } finally {
    store.close();
  }
});

test('malformed, extreme, accessor and unknown positions cannot select caller authority', () => {
  for (const indices of [null, {}, [1], [-1], [0, 0], ['0'], [0.5], [Infinity], [1, 0], Array(1)])
    assert.throws(() => order([summary], indices));
  assert.throws(() => order([policy], [0]));
  assert.throws(() => order([{ role: 'assistant', content: null }], [0]));
  for (const input of [
    null,
    {},
    [null],
    [[]],
    Array(2049).fill(summary),
    [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }],
  ])
    assert.throws(() => order(input, []));
  let hooks = 0;
  const hostile = {
    get role() {
      hooks++;
      return 'assistant';
    },
    content: 'private',
  };
  assert.throws(() => order([hostile], [0]));
  assert.equal(hooks, 0);
});
