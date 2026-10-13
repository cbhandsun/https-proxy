'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseWorkBuddySummaryCompletion: parse,
} = require('../lib/proxy/workbuddy-summary-completion');
const { WBIPC_MAX_FRAME_BYTES } = require('../lib/proxy/workbuddy-wbipc-frame-reader');

function sse(content = '中文🙂', delta = {}, finish_reason = 'stop') {
  return (
    'data: ' +
    JSON.stringify({
      choices: [{ index: 0, delta: { role: 'assistant', content, ...delta }, finish_reason }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }) +
    '\n\ndata: [DONE]\n\n'
  );
}

test('SSE framing uses the existing host wire cap, then the unchanged decoded budget', () => {
  const wire =
    ':' + 'x'.repeat(160 * 1024) + '\n\n' + sse('bounded summary', { function_call: {} });
  assert.ok(Buffer.byteLength(wire) > 128 * 1024);
  assert.ok(Buffer.byteLength(wire) < WBIPC_MAX_FRAME_BYTES);
  const result = parse(wire, 128 * 1024);
  assert.equal(result.choices[0].message.content, 'bounded summary');
  assert.equal(Object.hasOwn(result.choices[0].message, 'function_call'), false);
  assert.deepEqual(result.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  const decoded = Buffer.byteLength(JSON.stringify(result));
  assert.deepEqual(parse(wire, decoded), result);
  assert.equal(parse(wire, decoded - 1), null);
  const bytes = Buffer.byteLength(sse());
  const exact = ':' + 'x'.repeat(WBIPC_MAX_FRAME_BYTES - bytes - 3) + '\n\n' + sse();
  assert.equal(Buffer.byteLength(exact), WBIPC_MAX_FRAME_BYTES);
  assert.equal(parse(exact, 128 * 1024).choices[0].message.content, '中文🙂');
  assert.equal(parse(':' + exact, 128 * 1024), null);
});

test('decoded growth, malformed/empty/unterminated wire and invalid budgets fail explicitly', () => {
  assert.equal(parse(sse('x'.repeat(5000)), 4096), null);
  for (const body of [
    undefined,
    null,
    {},
    '',
    '[]',
    'data: {invalid}\n\n',
    'data: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
  ])
    assert.equal(parse(body, 4096), null);
  for (const limit of [0, -1, undefined, null, '4096', NaN, Infinity, WBIPC_MAX_FRAME_BYTES + 1])
    assert.equal(parse(sse(), limit), null);
});

test('normalization preserves tool/refusal/truncation signals and never fabricates usage', () => {
  for (const function_call of [{ name: 'read', arguments: '{}' }, { unknown: true }, false, []])
    assert.ok(
      Object.hasOwn(parse(sse('text', { function_call }), 4096).choices[0].message, 'function_call')
    );
  const refusal = parse(sse('', { refusal: 'refused' }, 'content_filter'), 4096);
  assert.equal(refusal.choices[0].message.refusal, 'refused');
  assert.equal(refusal.choices[0].finish_reason, 'content_filter');
  assert.equal(parse(sse('truncated', {}, 'length'), 4096).choices[0].finish_reason, 'length');
  const direct = {
    choices: [
      { finish_reason: 'stop', message: { role: 'assistant', content: 'text', function_call: {} } },
    ],
  };
  assert.deepEqual(parse(JSON.stringify(direct), 4096), direct);
  assert.equal(Object.hasOwn(parse(JSON.stringify(direct), 4096), 'usage'), false);
  const malformedUsage = { ...direct, usage: { prompt_tokens: '2' } };
  assert.deepEqual(parse(JSON.stringify(malformedUsage), 4096).usage, malformedUsage.usage);
});
