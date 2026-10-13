'use strict';
const assert = require('node:assert/strict');
const {
  convertedOutputFormat,
  applyConvertedOutputFormat,
  geminiJsonMode,
} = require('../lib/proxy/converted-output-format');
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const chat = {
  response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } },
};
const responses = {
  text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } },
};
for (const [source, shape] of [
  [chat, 'chat'],
  [responses, 'responses'],
]) {
  assert.throws(
    () =>
      convertedOutputFormat(source, shape, 'Gemini', 'gemini-3.8-flash-tiered', {
        codeAssist: true,
      }),
    (error) => error.code === 'invalid_request_error'
  );
  assert.equal(
    convertedOutputFormat(source, shape, 'Gemini', 'gemini-3.8-flash-tiered', { codeAssist: false })
      .type,
    'json_schema'
  );
}
assert.throws(
  () =>
    convertedOutputFormat(
      { text: { format: { type: 'json_object' } } },
      'responses',
      'Gemini',
      'gemini-3.8-flash-tiered',
      { codeAssist: true }
    ),
  (error) => error.code === 'invalid_request_error'
);
assert.equal(
  convertedOutputFormat(
    { text: { format: { type: 'text' } } },
    'responses',
    'Gemini',
    'gemini-3.8-flash-tiered',
    { codeAssist: true }
  ),
  null
);
for (const [source, shape] of [
  [chat, 'chat'],
  [responses, 'responses'],
]) {
  for (const strict of [false, true]) {
    const body = JSON.parse(JSON.stringify(source));
    if (shape === 'chat') body.response_format.json_schema.strict = strict;
    else body.text.format.strict = strict;
    assert.throws(
      () => convertedOutputFormat(body, shape, 'Claude', 'deepseek-v4-flash'),
      (error) => error.code === 'invalid_request_error'
    );
    assert.equal(
      convertedOutputFormat(body, shape, 'Chat', 'deepseek-v4-flash').type,
      'json_schema'
    );
    assert.equal(
      convertedOutputFormat(body, shape, 'Claude', 'claude-sonnet-4-6').type,
      'json_schema'
    );
  }
}
assert.equal(convertedOutputFormat({}, 'responses', 'Claude', 'deepseek-v4-flash'), null);
assert.equal(
  convertedOutputFormat(
    { text: { format: { type: 'text' } } },
    'responses',
    'Claude',
    'deepseek-v4-flash'
  ),
  null
);
for (const target of ['Claude', 'Gemini']) {
  for (const [source, shape] of [
    [chat, 'chat'],
    [responses, 'responses'],
    [chat, 'responses'],
  ]) {
    const snapshot = JSON.stringify(source);
    assert.deepEqual(convertedOutputFormat(source, shape, target), {
      type: 'json_schema',
      schema,
      strict: true,
    });
    assert.deepEqual(applyConvertedOutputFormat({}, source, shape, target).output_config, {
      format: { type: 'json_schema', schema },
    });
    assert.equal(JSON.stringify(source), snapshot);
  }
  assert.equal(convertedOutputFormat({}, 'chat', target), null);
  assert.equal(convertedOutputFormat({ response_format: { type: 'text' } }, 'chat', target), null);
  assert.equal(convertedOutputFormat({ text: { format: null } }, 'responses', target), null);
  for (const value of [
    '',
    'SECRET',
    false,
    0,
    [],
    {},
    { type: ['text'] },
    { type: 'SECRET' },
    { type: 'json_schema', json_schema: {} },
    { type: 'text', schema: {} },
  ]) {
    for (const source of [{ response_format: value }, { text: { format: value } }])
      assert.throws(
        () => convertedOutputFormat(source, 'responses', target),
        (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
      );
  }
  for (const update of [
    { name: 'SECRET SPACE' },
    { name: 'x'.repeat(65) },
    { strict: 'SECRET' },
    { schema: [] },
    { schema: { x: Infinity } },
    { description: [] },
  ])
    assert.throws(() =>
      convertedOutputFormat(
        {
          response_format: {
            type: 'json_schema',
            json_schema: { ...chat.response_format.json_schema, ...update },
          },
        },
        'chat',
        target
      )
    );
  assert.throws(() =>
    convertedOutputFormat({ ...responses, response_format: { type: 'text' } }, 'responses', target)
  );
  const cycle = {};
  cycle.cycle = cycle;
  assert.throws(() =>
    convertedOutputFormat(
      { response_format: { type: 'json_schema', json_schema: { name: 'cycle', schema: cycle } } },
      'chat',
      target
    )
  );
}
const jsonMode = { response_format: { type: 'json_object' } };
assert.throws(() =>
  convertedOutputFormat(
    {
      ...responses,
      response_format: {
        ...chat.response_format,
        json_schema: { ...chat.response_format.json_schema, strict: false },
      },
    },
    'responses',
    'Gemini'
  )
);
let deep = {};
for (let i = 0; i < 66; i++) deep = { properties: { child: deep } };
for (const schema of [deep, { enum: Array(10001).fill('x') }, new Date()])
  assert.throws(() =>
    convertedOutputFormat(
      { response_format: { type: 'json_schema', json_schema: { name: 'bounded', schema } } },
      'chat',
      'Gemini'
    )
  );
assert.throws(() => convertedOutputFormat(jsonMode, 'chat', 'Claude'));
assert.deepEqual(convertedOutputFormat(jsonMode, 'chat', 'Gemini'), { type: 'json_object' });
assert.equal(applyConvertedOutputFormat({}, jsonMode, 'chat', 'Gemini')[geminiJsonMode], true);
for (const source of [chat, jsonMode])
  assert.throws(() => convertedOutputFormat(source, 'chat', 'Gemini', 'gemini-3.1-flash-image'));
for (const keyword of ['oneOf', '$ref', 'allOf', 'pattern']) {
  const source = {
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'unsupported', schema: { [keyword]: [] } },
    },
  };
  assert.throws(() => convertedOutputFormat(source, 'chat', 'Gemini'));
}
