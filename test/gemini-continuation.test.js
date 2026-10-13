'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  GEMINI_CONTINUATION_TEXT,
  normalizeGeminiContinuationHistory,
} = require('../lib/proxy/gemini-continuation');

const convert = (message) => message.wire;
const user = { wire: { role: 'user', parts: [{ text: 'hello' }] } };
const model = { wire: { role: 'model', parts: [{ text: 'partial' }] } };

test('normal user turns and empty or malformed history do not add continuation', () => {
  for (const history of [undefined, null, {}, [], [null, 1, 'bad', []], [user]]) {
    const result = normalizeGeminiContinuationHistory(history, convert);
    assert.equal(result.appended, false);
    assert.deepEqual(result.messages, history?.[0] === user ? [user] : []);
  }
});

test('partial model history remains intact and input is not mutated', () => {
  const history = Object.freeze([Object.freeze(user), Object.freeze(model)]);
  const result = normalizeGeminiContinuationHistory(history, convert);
  assert.deepEqual(result.messages, [
    user,
    model,
    { role: 'user', content: GEMINI_CONTINUATION_TEXT },
  ]);
  assert.equal(result.appended, true);
  assert.equal(history.length, 2);
});

test('invalid and empty converted turns do not hide the last model', () => {
  for (const wire of [
    null,
    {},
    { role: 'system', parts: [{ text: 'invalid' }] },
    { role: 'user', parts: [] },
    { role: 'user', parts: [null, { text: '   ' }] },
  ]) {
    assert.equal(normalizeGeminiContinuationHistory([model, { wire }], convert).appended, true);
  }
});

test('tools and media remain intact without fabricated tool results', () => {
  for (const part of [
    { functionCall: { name: 'read', args: {} } },
    { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
  ]) {
    const message = { wire: { role: 'model', parts: [part] } };
    const result = normalizeGeminiContinuationHistory([user, message], convert);
    assert.equal(result.messages[1], message);
    assert.deepEqual(result.messages[2], { role: 'user', content: GEMINI_CONTINUATION_TEXT });
  }
  const toolResult = {
    wire: { role: 'user', parts: [{ functionResponse: { name: 'read', response: {} } }] },
  };
  assert.equal(normalizeGeminiContinuationHistory([model, toolResult], convert).appended, false);
});

test('large history appends only one bounded continuation', () => {
  const history = [...Array(10000).fill(user), model];
  const result = normalizeGeminiContinuationHistory(history, convert);
  assert.equal(result.messages.length, history.length + 1);
  assert.ok(GEMINI_CONTINUATION_TEXT.length < 128);
});

test('conversion failures propagate without manufacturing a successful request', () => {
  assert.throws(
    () =>
      normalizeGeminiContinuationHistory([user], () => {
        throw new Error('conversion failed');
      }),
    /conversion failed/
  );
});
