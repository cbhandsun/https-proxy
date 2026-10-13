'use strict';
const assert = require('node:assert/strict');
const { validateConvertedRequestScalars } = require('../lib/proxy/converted-request-scalars');
const { responsesTargetOptions } = require('../lib/proxy/responses-target-options');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
let failure;
const validators = createRequestValidators({
  sendJsonError: (_res, status, body) => {
    failure = { status, body };
  },
});
for (const target of ['Claude', 'Gemini']) {
  for (const source of [
    {},
    { stream: false },
    { stream: true },
    { max_output_tokens: 1, temperature: 0, top_p: 0 },
    { max_tokens: Number.MAX_SAFE_INTEGER, temperature: 1, top_p: 1 },
  ]) {
    const before = JSON.stringify(source);
    validateConvertedRequestScalars(source, target);
    responsesTargetOptions(source, 'model', target);
    assert.equal(JSON.stringify(source), before);
  }
  const invalid = [null, [], 'SECRET'];
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens'])
    for (const value of [
      0,
      -1,
      0.5,
      'SECRET',
      true,
      [],
      {},
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      invalid.push({ [key]: value });
  for (const key of ['temperature', 'top_p'])
    for (const value of [-1, 'SECRET', true, [], {}, NaN, Infinity, 3])
      invalid.push({ [key]: value });
  for (const value of [0, 1, 'SECRET', [], {}]) invalid.push({ stream: value });
  if (target === 'Claude') invalid.push({ temperature: 1.5 });
  else validateConvertedRequestScalars({ temperature: 2 }, target);
  for (const source of invalid) {
    assert.throws(
      () => validateConvertedRequestScalars(source, target),
      (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
    );
    assert.throws(
      () => responsesTargetOptions(source, 'model', target),
      (error) => error.code === 'invalid_request_error'
    );
    for (const check of [
      validators.rejectUnsupportedResponsesNonOpenAIConversion,
      validators.rejectUnsupportedOpenAIChatNonOpenAIConversion,
    ]) {
      failure = undefined;
      assert.equal(check({}, source, target), true);
      assert.equal(failure.status, 400);
      assert.ok(!JSON.stringify(failure).includes('SECRET'));
    }
  }
}
