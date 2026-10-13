'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { selectLocalCompactionWindow } = require('../lib/proxy/context-compaction-retention');

const user = { type: 'message', role: 'user', content: '原始要求🙂', extension: { exact: true } };
function round(id, output = '原始结果🙂') {
  return [
    { type: 'function_call', call_id: id, name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: id, output, future: { intact: true } },
    { type: 'message', role: 'assistant', content: '回答-' + id + '🙂', future: 42 },
  ];
}
const comparable = (value) => JSON.parse(JSON.stringify(value));

test('recent complete rounds and narration remain exact while older history is removable', () => {
  const input = [user, ...round('old'), ...round('recent-1'), ...round('recent-2')];
  const before = JSON.stringify(input);
  const result = selectLocalCompactionWindow(input);
  assert.deepEqual(comparable(result.retained), [user, ...round('recent-1'), ...round('recent-2')]);
  assert.equal(result.removed, 3);
  assert.ok(result.recentBytes > 0 && result.recentBytes <= 16384);
  assert.ok(result.recentTokens > 0 && result.recentTokens <= 4096);
  assert.equal(JSON.stringify(input), before);
});

test('byte and token budgets omit whole optional exchanges without slicing mandatory data', () => {
  const policy = { role: 'developer', content: '不能截断🙂'.repeat(500) };
  const input = [policy, user, ...round('recent', '大结果🙂'.repeat(1000))];
  for (const options of [{ maxRecentBytes: 1 }, { maxRecentTokens: 1 }, { maxRecentBytes: 0 }]) {
    const result = selectLocalCompactionWindow(input, options);
    assert.deepEqual(comparable(result.retained), [policy, user]);
    assert.equal(result.recentBytes, 0);
    assert.equal(result.recentTokens, 0);
    assert.equal(result.removed, 3);
  }
});

test('parallel interleaved exchanges are retained or removed atomically', () => {
  const first = round('parallel-1');
  const second = round('parallel-2');
  const input = [user, first[0], second[0], second[1], first[1], second[2]];
  assert.deepEqual(comparable(selectLocalCompactionWindow(input).retained), input);
  assert.deepEqual(comparable(selectLocalCompactionWindow(input, { maxRecentBytes: 0 }).retained), [
    user,
  ]);
});

test('pending, ambiguous, orphaned, opaque and multimodal state cannot be removed by a tail budget', () => {
  const pending = round('pending')[0];
  const unknown = { type: 'future_provider_state', opaque: ['exact', 42] };
  const reasoning = { type: 'reasoning', summary: [], encrypted_content: 'opaque-state' };
  const input = [
    user,
    ...round('finished'),
    unknown,
    reasoning,
    pending,
    { type: 'message', role: 'assistant', content: '调用尚未完成🙂' },
  ];
  const result = selectLocalCompactionWindow(input, { maxRecentBytes: 0 });
  assert.deepEqual(comparable(result.retained), [user, unknown, reasoning, pending, input.at(-1)]);
  const duplicate = [user, ...round('duplicate'), round('duplicate')[0]];
  assert.deepEqual(
    comparable(selectLocalCompactionWindow(duplicate, { maxRecentBytes: 0 }).retained),
    duplicate
  );
  const orphan = [user, round('orphan')[1]];
  assert.deepEqual(
    comparable(selectLocalCompactionWindow(orphan, { maxRecentBytes: 0 }).retained),
    orphan
  );
  const image = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }],
  };
  assert.deepEqual(
    comparable(selectLocalCompactionWindow([user, image], { maxRecentBytes: 0 }).retained),
    [user, image]
  );
});

test('recent plain answers use a separate bounded count and unknown fields survive cloning', () => {
  const messages = [1, 2, 3].map((id) => ({
    role: 'assistant',
    content: '回答🙂-' + id,
    unknown: id,
  }));
  assert.deepEqual(comparable(selectLocalCompactionWindow([user, ...messages]).retained), [
    user,
    ...messages.slice(1),
  ]);
  assert.deepEqual(
    comparable(
      selectLocalCompactionWindow([user, ...messages], { keepAssistantMessages: 0 }).retained
    ),
    [user]
  );
  assert.deepEqual(
    comparable(
      selectLocalCompactionWindow([user, ...round('zero')], {
        keepCompletedToolRounds: 0,
        keepAssistantMessages: 0,
      }).retained
    ),
    [user]
  );
});

test('empty, invalid, extreme and cyclic input fails explicitly without running getters', () => {
  for (const input of [
    [],
    null,
    {},
    [null],
    [1],
    [[user]],
    Array(2049).fill(user),
    [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }],
  ])
    assert.throws(() => selectLocalCompactionWindow(input));
  for (const options of [
    null,
    [],
    'invalid',
    { extra: 1 },
    { keepAssistantMessages: -1 },
    { keepCompletedToolRounds: 65 },
    { maxRecentBytes: '1' },
    { maxRecentTokens: Infinity },
  ])
    assert.throws(() => selectLocalCompactionWindow([user], options));
  let hooks = 0;
  const getter = {
    role: 'user',
    get content() {
      hooks++;
      return 'must-not-run';
    },
  };
  assert.throws(() => selectLocalCompactionWindow([getter]));
  const settings = {
    get maxRecentBytes() {
      hooks++;
      return 1;
    },
  };
  assert.throws(() => selectLocalCompactionWindow([user], settings));
  const cyclic = { role: 'user', content: 'safe' };
  cyclic.extra = cyclic;
  assert.throws(() => selectLocalCompactionWindow([cyclic]));
  assert.equal(hooks, 0);
});
