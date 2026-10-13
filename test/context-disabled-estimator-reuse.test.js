'use strict';
const assert = require('node:assert/strict');
const media = require('../lib/proxy/inline-media');
const originalEstimate = media.estimateTokensForValue;
const calls = [];
let fail = false;
const countedEstimate = (value) => {
  calls.push(value);
  if (fail) throw new Error('Estimator failed');
  return originalEstimate(value);
};
media.estimateTokensForValue = countedEstimate;
const { applyContextBudgetToMessages } = require('../lib/proxy/context-budget-manager');
try {
  const messages = Object.freeze([
    Object.freeze({ role: 'system', content: 'synthetic system' }),
    Object.freeze({ role: 'user', content: 'synthetic 中文 😀' }),
  ]);
  for (const options of [{}, { estimateMessageTokens: countedEstimate }]) {
    calls.length = 0;
    const result = applyContextBudgetToMessages(
      messages,
      {},
      'synthetic',
      { contextWindowPolicy: 'disabled' },
      options
    );
    assert.equal(
      calls.includes(messages),
      false,
      'Default aggregate estimate must reuse per-message estimates'
    );
    assert.equal(calls.length, 2);
    assert.ok(messages.every((message) => calls.filter((value) => value === message).length === 1));
    assert.equal(result.messages, messages);
    assert.equal(result.diagnostics.estimatedInputTokens, originalEstimate(messages));
    assert.equal(result.diagnostics.contextCache.dynamicTokens, originalEstimate(messages[1]));
  }
  calls.length = 0;
  const customCalls = [];
  const custom = applyContextBudgetToMessages(
    messages,
    {},
    'synthetic',
    { contextWindowPolicy: 'disabled' },
    {
      estimateMessageTokens: (message) => {
        customCalls.push(message);
        return 77;
      },
    }
  );
  assert.equal(custom.diagnostics.estimatedInputTokens, originalEstimate(messages));
  assert.equal(custom.diagnostics.contextCache.dynamicTokens, 77);
  assert.equal(customCalls.length, 2);
  assert.deepEqual(calls, [messages], 'Custom estimator retains separate aggregate semantics');
  calls.length = 0;
  const noCache = applyContextBudgetToMessages(
    messages,
    {},
    'synthetic',
    { contextWindowPolicy: 'disabled' },
    { includeCacheDiagnostics: false }
  );
  assert.deepEqual(calls, [messages]);
  assert.equal(noCache.diagnostics.contextCache, undefined);
  for (const input of [[], null, undefined, {}, 'invalid']) {
    const result = applyContextBudgetToMessages(input, {}, 'synthetic', {
      contextWindowPolicy: 'disabled',
    });
    assert.equal(result.messages, input);
    assert.equal(result.diagnostics.estimatedInputTokens, 0);
  }
  const large = [{ role: 'user', content: 'x'.repeat(1024 * 1024) }];
  assert.equal(
    applyContextBudgetToMessages(large, {}, 'synthetic', { contextWindowPolicy: 'disabled' })
      .diagnostics.estimatedInputTokens,
    originalEstimate(large)
  );
  const marker = [
    { role: 'user', content: 'synthetic', __hpm: { includeCacheDiagnostics: false } },
  ];
  assert.ok(
    applyContextBudgetToMessages(marker, {}, 'synthetic', { contextWindowPolicy: 'disabled' })
      .diagnostics.contextCache
  );
  fail = true;
  assert.throws(
    () =>
      applyContextBudgetToMessages(messages, {}, 'synthetic', { contextWindowPolicy: 'disabled' }),
    /Estimator failed/
  );
  fail = false;
  assert.equal(
    applyContextBudgetToMessages(messages, {}, 'synthetic', { contextWindowPolicy: 'disabled' })
      .diagnostics.estimatedInputTokens,
    originalEstimate(messages)
  );
  const hostile = Object.defineProperty({}, 'content', {
    enumerable: true,
    get() {
      throw new Error('Getter failed');
    },
  });
  assert.throws(
    () =>
      applyContextBudgetToMessages([hostile], {}, 'synthetic', { contextWindowPolicy: 'disabled' }),
    /Getter failed/
  );
} finally {
  media.estimateTokensForValue = originalEstimate;
}
