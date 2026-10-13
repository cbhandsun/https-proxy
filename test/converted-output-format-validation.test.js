'use strict';
const assert = require('node:assert/strict');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
let failure;
const validators = createRequestValidators({
  sendJsonError: (_res, status, body) => {
    failure = { status, body };
  },
});
function check(source, rejected, target, responses = false) {
  failure = undefined;
  const snapshot = JSON.stringify(source);
  const result = responses
    ? validators.rejectUnsupportedResponsesStructuredOutput({}, source, target)
    : validators.rejectUnsupportedOpenAIChatNonOpenAIConversion({}, source, target);
  assert.equal(result, rejected);
  assert.equal(JSON.stringify(source), snapshot);
  if (rejected) {
    assert.equal(failure.status, 400);
    assert.equal(failure.body.error.type, 'invalid_request_error');
    assert.ok(!JSON.stringify(failure).includes('SECRET'));
  } else assert.equal(failure, undefined);
}
for (const target of ['Claude', 'Gemini']) {
  for (const format of [undefined, null, { type: 'text' }]) {
    check({ messages: [], response_format: format }, false, target);
    check({ text: { format } }, false, target, true);
  }
  for (const format of [
    '',
    'SECRET',
    false,
    0,
    [],
    {},
    { type: null },
    { type: ['text'] },
    { type: 'SECRET' },
    { type: 'json_object' },
    { type: 'json_schema', schema: {} },
    { type: 'x'.repeat(100000) },
  ]) {
    const rejected = target !== 'Gemini' || format?.type !== 'json_object';
    check({ messages: [], response_format: format }, rejected, target);
    check({ text: { format } }, rejected, target, true);
    check({ response_format: format }, rejected, target, true);
    // A valid primary field must not conceal a malformed alias.
    check({ text: { format: { type: 'text' } }, response_format: format }, true, target, true);
  }
  for (const text of ['', 'SECRET', [], false, 0]) check({ text }, true, target, true);
}

for (const type of [
  'SECRET',
  'SECRET'.repeat(20000),
  {
    toString() {
      throw new Error('SECRET');
    },
  },
]) {
  for (const run of [
    () => validators.rejectUnsupportedResponsesTools({}, { tools: [{ type }] }),
    () => validators.rejectUnsupportedResponsesInput({}, { input: [{ type }] }, 'Claude'),
    () =>
      validators.rejectUnsupportedResponsesInput(
        {},
        { input: [{ type: 'message', content: [{ type }] }] },
        'Gemini'
      ),
    () =>
      validators.rejectUnsupportedOpenAIChatNonOpenAIConversion(
        {},
        { tools: [{ type }] },
        'Claude'
      ),
  ]) {
    failure = undefined;
    assert.equal(run(), true);
    assert.equal(failure.status, 400);
    assert.ok(!JSON.stringify(failure).includes('SECRET'));
    assert.ok(failure.body.error.message.length < 150);
  }
}
