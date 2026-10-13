'use strict';
const assert = require('node:assert/strict');
const { applyContextBudgetToMessages } = require('../lib/proxy/context-budget-manager');
const { applyResponsesHistoryPolicy } = require('../lib/proxy/responses-history-policy');
const { createMessageTokenEstimator } = require('../lib/proxy/context-message-estimator');
for (const mode of ['enabled', 'disabled', 'preserved']) {
  const messages = [
    { role: 'system', content: 'fixed' },
    { role: 'user', content: 'synthetic' },
  ];
  const counts = new Map();
  const estimate = (message) => {
    counts.set(message, (counts.get(message) || 0) + 1);
    return 10;
  };
  const body =
    mode === 'preserved' ? applyResponsesHistoryPolicy({}, { truncation: 'disabled' }) : {};
  const options =
    mode === 'disabled' ? { contextWindowPolicy: 'disabled' } : { maxContextTokens: 200000 };
  const before = JSON.stringify(messages);
  const result = applyContextBudgetToMessages(messages, body, 'gemini-2.5-pro', options, {
    estimateMessageTokens: estimate,
  });
  assert.equal(
    [...counts.values()].reduce((a, b) => a + b, 0),
    2
  );
  assert.equal(result.diagnostics.contextCache.stablePrefixTokens, 10);
  assert.equal(result.diagnostics.contextCache.dynamicTokens, 10);
  if (mode !== 'disabled') assert.equal(result.diagnostics.estimatedInputTokens, 20);
  assert.equal(JSON.stringify(messages), before);
  messages[1].content = 'changed';
  const next = applyContextBudgetToMessages(messages, body, 'gemini-2.5-pro', options, {
    estimateMessageTokens: (message) => message.content.length,
  });
  assert.equal(next.diagnostics.contextCache.dynamicTokens, 7);
}
{
  const messages = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'answer' },
    { role: 'tool', content: 'x'.repeat(10000) },
    { role: 'user', content: 'middle' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'latest' },
  ];
  const before = JSON.stringify(messages);
  const counts = new Map();
  const result = applyContextBudgetToMessages(
    messages,
    { max_tokens: 1024 },
    'gemini-2.5-pro',
    { maxContextTokens: 200000, contextKeepRecentTurns: 1, maxHistoricalToolChars: 100 },
    {
      estimateMessageTokens: (message) => {
        counts.set(message, (counts.get(message) || 0) + 1);
        return Math.ceil(message.content.length / 4);
      },
    }
  );
  assert.equal(counts.size, 6);
  assert.ok([...counts.values()].every((count) => count === 1));
  const changed = result.messages.find((message) => message.role === 'tool');
  assert.strictEqual(changed, messages[2]);
  assert.equal(changed.content.length, 10000);
  assert.equal(result.diagnostics.compactionTriggered, false);
  assert.equal(
    result.diagnostics.estimatedInputTokens,
    result.messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0)
  );
  assert.equal(JSON.stringify(messages), before);
}
assert.deepEqual(applyContextBudgetToMessages([], {}, 'gemini-2.5-pro').messages, []);
{
  let calls = 0;
  const message = {};
  const estimate = createMessageTokenEstimator(() => {
    calls++;
    return 0;
  });
  assert.equal(estimate(message), 0);
  assert.equal(estimate(message), 0);
  assert.equal(calls, 1);
  for (const primitive of [null, undefined, '', 0]) {
    estimate(primitive);
    estimate(primitive);
  }
  assert.equal(calls, 9);
  let reads = 0;
  const hostile = Object.defineProperty({}, 'content', {
    get() {
      reads++;
      throw new Error('PRIVATE');
    },
  });
  assert.equal(estimate(hostile), 0);
  assert.equal(reads, 0);
  assert.equal(
    createMessageTokenEstimator(() => Number.MAX_SAFE_INTEGER)({}),
    Number.MAX_SAFE_INTEGER
  );
}
for (const value of [NaN, Infinity, -1, undefined, 'PRIVATE']) {
  const estimate = createMessageTokenEstimator(() => value);
  assert.throws(
    () => estimate({}),
    (error) => error instanceof TypeError && !error.message.includes('PRIVATE')
  );
}
for (const invalid of [null, undefined, 'PRIVATE', {}])
  assert.throws(
    () => createMessageTokenEstimator(invalid),
    (error) => error instanceof TypeError && !error.message.includes('PRIVATE')
  );
{
  const failure = new Error('fixture failure');
  let attempts = 0;
  const estimate = createMessageTokenEstimator(() => {
    attempts++;
    throw failure;
  });
  const message = {};
  for (let i = 0; i < 2; i++)
    assert.throws(
      () => estimate(message),
      (error) => error === failure
    );
  assert.equal(attempts, 2);
}
console.log('context-estimator-reuse.test.js passed');
