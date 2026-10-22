'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createToolHistoryNote: note,
  isToolHistoryNote: isNote,
  carryToolHistoryNotes: carry,
} = require('../lib/proxy/workbuddy-tool-history-notes');
const { createContextHistoryBranch } = require('../lib/proxy/context-history-branch');
const { compactWorkBuddyWbipcBody } = require('../lib/proxy/workbuddy-wbipc-payload');

test('only locally generated, unchanged text notes have non-wire provenance', () => {
  const created = note('synthetic qualification');
  assert.equal(isNote(created), true);
  assert.equal(isNote(JSON.parse(JSON.stringify(created))), false);
  assert.deepEqual(Object.keys(created), ['type', 'text']);
  created.text = 'changed';
  assert.equal(isNote(created), false);
  for (const value of [null, undefined, {}, 'synthetic qualification', new Date()])
    assert.equal(isNote(value), false);
  for (const text of ['', 'x'.repeat(1025), null, 42, {}])
    assert.throws(() => note(text), /Invalid tool-history note/);
});

test('note checks reject mutated accessors without invoking them', () => {
  let invoked = false;
  const created = note('synthetic');
  Object.defineProperty(created, 'text', {
    get() {
      invoked = true;
      return 'synthetic';
    },
  });
  assert.equal(isNote(created), false);
  assert.equal(invoked, false);
});

test('exact clones retain notes across the checked context-history transaction', () => {
  const generated = note('Do not infer success or original chronology.');
  const input = {
    model: 'fixture',
    messages: [
      { role: 'user', content: 'synthetic' },
      {
        role: 'tool',
        tool_call_id: 'synthetic',
        content: [generated, { type: 'text', text: 'synthetic output' }],
      },
    ],
  };
  const history = createContextHistoryBranch(input, { owner: 'owner', scope: 'scope' });
  const cloned = history.snapshot().body.messages[1].content[0];
  assert.notEqual(cloned, generated);
  assert.equal(isNote(cloned), true);
  assert.ok(!JSON.stringify(history.snapshot().body).includes('provenance'));
});

test('changed, untrusted, invalid and sparse clones cannot manufacture provenance', () => {
  const created = note('synthetic');
  const source = { content: [created] };
  const exact = { content: [{ ...created }] };
  assert.equal(carry(exact, source), exact);
  assert.equal(isNote(exact.content[0]), true);
  for (const target of [
    null,
    {},
    { content: [] },
    { content: [{ type: 'text', text: 'changed' }] },
    { content: [{ type: 'image_url', text: 'synthetic' }] },
    { content: Array(1) },
  ]) {
    carry(target, source);
    if (Array.isArray(target?.content) && target.content[0])
      assert.equal(isNote(target.content[0]), false);
  }
  for (const original of [{}, null, new Date(), { content: Array(262145) }])
    carry({ content: Array(262145) }, original);
  const untrusted = { content: [{ ...created }] };
  const untrustedClone = { content: [{ ...created }] };
  carry(untrustedClone, untrusted);
  assert.equal(isNote(untrustedClone.content[0]), false);
});

test('clone transfer does not invoke content or array-entry getters', () => {
  let invoked = false;
  const source = Object.defineProperty({}, 'content', {
    get() {
      invoked = true;
      return [note('synthetic')];
    },
  });
  carry({ content: [] }, source);
  const array = Array(1);
  Object.defineProperty(array, '0', {
    get() {
      invoked = true;
      return note('synthetic');
    },
  });
  carry({ content: [{ type: 'text', text: 'synthetic' }] }, { content: array });
  assert.equal(invoked, false);
});

test('fallback folding preserves notes exactly and charges their bytes to hard admission', () => {
  const qualification = note('Do not infer success or original chronology.');
  const call = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'synthetic', type: 'function', function: { name: 'synthetic', arguments: '{}' } },
    ],
  };
  const body = {
    model: 'fixture',
    messages: [
      { role: 'user', content: 'synthetic' },
      call,
      {
        role: 'tool',
        tool_call_id: 'synthetic',
        content: [qualification, { type: 'text', text: 'x'.repeat(10000) }],
      },
    ],
  };
  const compacted = compactWorkBuddyWbipcBody(body, 2048, 256);
  assert.equal(compacted.fits, true);
  assert.ok(compacted.bodyBytes <= 2048);
  assert.ok(
    compacted.body.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((part) => part.text === qualification.text)
    )
  );
  assert.equal(qualification.text, 'Do not infer success or original chronology.');
  const tooManyNotes = {
    model: 'fixture',
    messages: [
      { role: 'user', content: 'synthetic' },
      call,
      {
        role: 'tool',
        tool_call_id: 'synthetic',
        content: [
          ...Array.from({ length: 4 }, () => note('x'.repeat(1000))),
          { type: 'text', text: 'x'.repeat(10000) },
        ],
      },
    ],
  };
  const refused = compactWorkBuddyWbipcBody(tooManyNotes, 1024, 256);
  assert.equal(refused.fits, false);
  assert.ok(refused.bodyBytes > 1024);
});
