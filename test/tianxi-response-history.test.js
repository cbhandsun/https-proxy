'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildTianxiContinuationInput,
  createTianxiResponseHistory,
} = require('../lib/proxy/tianxi-response-history');

test('Tianxi response history isolates owners and expires bounded records', () => {
  let current = 1000;
  const history = createTianxiResponseHistory({ now: () => current, ttlMs: 100, maxEntries: 2 });
  assert.equal(history.save('resp_1', 'owner-a', [{ user: 'first', assistant: 'one' }]), true);
  assert.equal(history.get('resp_1', 'owner-b'), null);
  assert.deepEqual(history.get('resp_1', 'owner-a'), [{ user: 'first', assistant: 'one' }]);
  history.save('resp_2', 'owner-a', [{ user: 'second', assistant: 'two' }]);
  history.save('resp_3', 'owner-a', [{ user: 'third', assistant: 'three' }]);
  assert.equal(history.get('resp_1', 'owner-a'), null);
  current += 101;
  assert.equal(history.get('resp_3', 'owner-a'), null);
});

test('Tianxi response history caps retained turns and returns detached copies', () => {
  const history = createTianxiResponseHistory();
  const turns = Array.from({ length: 8 }, (_, index) => ({
    user: String(index) + 'x'.repeat(5000),
    assistant: 'a'.repeat(5000),
  }));
  history.save('resp_1', 'owner', turns);
  const stored = history.get('resp_1', 'owner');
  assert.equal(stored.length, 4);
  assert.ok(stored.every((turn) => turn.user.length <= 4096 && turn.assistant.length <= 4096));
  stored[0].user = 'tampered';
  assert.notEqual(history.get('resp_1', 'owner')[0].user, 'tampered');
});

test('Tianxi continuation input serializes prior roles and rejects oversized context', () => {
  const input = buildTianxiContinuationInput(
    [{ user: 'remember ALPHA7382', assistant: 'remembered' }],
    'what was the code?'
  );
  const payload = JSON.parse(input.slice(input.indexOf('\n') + 1));
  assert.equal(payload.previous_turns[0].user, 'remember ALPHA7382');
  assert.equal(payload.current_user_message, 'what was the code?');
  assert.equal(buildTianxiContinuationInput([], 'x'.repeat(128000)), null);
});
