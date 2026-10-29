'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeWorkBuddyToolHistory: normalize } = require('../lib/proxy/workbuddy-tool-history');

const call = (...ids) => ({
  role: 'assistant',
  content: null,
  tool_calls: ids.map((id) => ({
    id,
    type: 'function',
    function: { name: 'synthetic', arguments: '{}' },
  })),
});
const result = (id, content = 'synthetic output', extra = {}) => ({
  role: 'tool',
  tool_call_id: id,
  content,
  ...extra,
});
const progress = (content = 'synthetic progress') => ({ role: 'assistant', content });
const rejects = (messages, reason, options) =>
  assert.throws(
    () => normalize(messages, options),
    (error) => error.code === 'invalid_workbuddy_tool_history' && error.reason === reason
  );

test('late outputs across assistant progress become one paired result without changing originals', () => {
  const narration = progress();
  const messages = [call('one'), result('one', 'first'), narration, result('one', 'second')];
  const before = JSON.stringify(messages);
  const repaired = normalize(messages);
  assert.equal(repaired.changed, true);
  assert.deepEqual(
    repaired.messages.map((message) => message.role),
    ['assistant', 'tool', 'assistant']
  );
  assert.equal(repaired.messages[2], narration);
  const content = repaired.messages[1].content;
  assert.ok(content.some((part) => part.text === 'first'));
  assert.ok(content.some((part) => part.text === 'second'));
  assert.match(content[0].text, /original message indices 2 through 2/);
  assert.match(content[0].text, /not evidence of event order/);
  assert.ok(content.some((part) => /original message index 1/.test(part.text)));
  assert.ok(content.some((part) => /original message index 3/.test(part.text)));
  assert.equal(repaired.diagnostics.deferredAssistantMessages, 1);
  assert.equal(repaired.diagnostics.combinedResults, 1);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(normalize(repaired.messages).messages, repaired.messages);
  assert.equal(normalize(repaired.messages, { repair: false }).changed, false);
});

test('progress before the first result is retained after a complete batch', () => {
  const narration = progress('before output');
  const messages = [call('one'), narration, result('one')];
  const repaired = normalize(messages);
  assert.equal(repaired.changed, true);
  assert.equal(repaired.messages[1].role, 'tool');
  assert.equal(repaired.messages[2], narration);
  assert.equal(repaired.diagnostics.deferredAssistantMessages, 1);
  assert.equal(normalize(repaired.messages, { repair: false }).changed, false);
});

test('parallel calls retain every result and the exact narration order', () => {
  const first = progress('first narration');
  const second = progress('second narration');
  const tail = progress('tail narration');
  const nextUser = { role: 'user', content: 'next request' };
  const repaired = normalize([
    call('a', 'b'),
    first,
    result('b', 'b output'),
    second,
    result('a', 'a output'),
    tail,
    nextUser,
  ]);
  assert.deepEqual(
    repaired.messages.map((message) => message.role),
    ['assistant', 'tool', 'tool', 'assistant', 'assistant', 'assistant', 'user']
  );
  assert.deepEqual(
    repaired.messages.slice(1, 3).map((message) => message.tool_call_id),
    ['b', 'a']
  );
  assert.deepEqual(repaired.messages.slice(3), [first, second, tail, nextUser]);
  assert.equal(repaired.diagnostics.deferredAssistantMessages, 2);
  normalize(repaired.messages, { repair: false });
});

test('already canonical history, empty input and narration without calls remain unchanged', () => {
  for (const messages of [
    [],
    [progress('')],
    [call('one'), result('one'), progress(), progress(null)],
  ]) {
    const normalized = normalize(messages);
    assert.equal(normalized.messages, messages);
    assert.equal(normalized.changed, false);
    assert.equal(normalized.diagnostics.deferredAssistantMessages, 0);
  }
});

test('identical output records can be deduplicated across narration without losing it', () => {
  const narration = progress();
  const repaired = normalize([call('one'), result('one'), narration, result('one')]);
  assert.equal(repaired.messages.length, 3);
  assert.equal(repaired.messages[2], narration);
  assert.equal(repaired.diagnostics.deduplicatedResults, 1);
  assert.equal(repaired.diagnostics.combinedResults, 0);
  normalize(repaired.messages, { repair: false });
});

test('media, null output and failure markers survive interleaving repair', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } };
  const narration = progress([{ type: 'text', text: 'progress' }]);
  const repaired = normalize([
    call('one'),
    result('one', null),
    narration,
    result('one', [image], { status: 'error' }),
  ]);
  assert.equal(repaired.messages[1].is_error, true);
  assert.equal(repaired.messages[1].status, undefined);
  assert.ok(repaired.messages[1].content.includes(image));
  assert.ok(repaired.messages[1].content.some((part) => /null content/.test(part.text)));
  assert.equal(repaired.messages[2], narration);
  normalize(repaired.messages, { repair: false });
  for (const content of ['', null, []]) {
    const single = normalize([call('one'), progress(), result('one', content, { is_error: true })]);
    assert.equal(single.messages[1].is_error, true);
    normalize(single.messages, { repair: false });
  }
});

test('strict outgoing admission still rejects unnormalized interleaved histories', () => {
  rejects([call('one'), progress(), result('one')], 'missing_result', { repair: false });
  rejects([call('one'), result('one'), progress(), result('one')], 'orphan_result', {
    repair: false,
  });
});

test('assistant narration cannot supply a missing result or authorize an unrelated one', () => {
  rejects([call('one'), progress()], 'missing_result');
  rejects([call('a', 'b'), result('a'), progress()], 'missing_result');
  rejects([call('one'), progress(), result('other')], 'orphan_result');
  rejects([progress(), result('one')], 'orphan_result');
});

test('repair never crosses user, system or developer boundaries', () => {
  for (const role of ['user', 'system', 'developer']) {
    const boundary = { role, content: 'boundary' };
    rejects([call('one'), progress(), boundary, result('one')], 'missing_result');
    rejects([call('one'), result('one'), progress(), boundary, result('one')], 'orphan_result');
  }
});

test('new tool-call batches cannot repair missing results or reused identifiers', () => {
  rejects([call('a'), progress(), call('b'), result('a'), result('b')], 'missing_result');
  const repaired = normalize([
    call('a'),
    result('a'),
    progress(),
    call('b'),
    result('a'),
    result('b'),
  ]);
  assert.equal(repaired.diagnostics.lateResultsAcrossCallBatches, 1);
  normalize(repaired.messages, { repair: false });
  rejects([call('a'), result('a'), progress(), call('a'), result('a')], 'duplicate_call');
  rejects(
    [call('a'), progress(), { ...progress(), tool_calls: [] }, result('a')],
    'missing_result'
  );
});

test('result count bounds apply across every progress separator', () => {
  const make = (count) => [
    call('one'),
    ...Array.from({ length: count }, () => [progress(), result('one')]).flat(),
  ];
  const accepted = normalize(make(64));
  assert.equal(accepted.diagnostics.deduplicatedResults, 63);
  assert.equal(accepted.diagnostics.deferredAssistantMessages, 64);
  normalize(accepted.messages, { repair: false });
  rejects(make(65), 'result_limit');
});

test('deferred progress does not bypass malformed content, hooks or traversal bounds', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, 'text', {
    enumerable: true,
    get() {
      invoked = true;
      return 'SECRET';
    },
  });
  const hook = {
    toJSON() {
      invoked = true;
      return 'SECRET';
    },
  };
  const cyclic = {};
  cyclic.child = cyclic;
  let deep = {};
  for (let index = 0; index < 66; index++) deep = { child: deep };
  for (const content of [undefined, 42, {}, new Date(), [getter], [hook], [cyclic], [deep]]) {
    rejects([call('one'), { role: 'assistant', content }, result('one')], 'invalid_shape');
  }
  rejects([call('one'), { ...progress(), toJSON: hook.toJSON }, result('one')], 'invalid_shape');
  assert.equal(invoked, false);
});

test('maximum-sized histories retain narration within the existing message ceiling', () => {
  const messages = [
    call('one'),
    ...Array.from({ length: 16382 }, () => progress('')),
    result('one'),
  ];
  const normalized = normalize(messages);
  assert.equal(normalized.messages.length, 16384);
  assert.equal(normalized.diagnostics.deferredAssistantMessages, 16382);
  assert.ok(
    JSON.stringify(normalized.messages[1]).length < 1024,
    'chronology annotation stays bounded'
  );
  normalize(normalized.messages, { repair: false });
  rejects([...messages, progress('')], 'invalid_shape');
});

test('progress contents share the existing aggregate traversal budget', () => {
  const wide = Array.from({ length: 262145 }, () => null);
  rejects([call('one'), progress(wide), result('one')], 'invalid_shape');
});

test('progress contents cannot exceed the existing aggregate byte budget', () => {
  const large = 'x'.repeat(33 * 1024 * 1024);
  rejects([call('one'), progress(large), progress(large), result('one')], 'invalid_shape');
});
