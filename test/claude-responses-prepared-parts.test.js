'use strict';
const assert = require('node:assert/strict');
const options = require('../lib/proxy/responses-request-options');
const original = options.chatContentPartToResponses;
let calls = 0;
options.chatContentPartToResponses = (...args) => {
  calls++;
  return original(...args);
};
const { createClaudeResponsesRequestConverter } = require('../lib/proxy/claude-responses-request');
const create = (protocolOptions = { contextWindowPolicy: 'disabled' }) =>
  createClaudeResponsesRequestConverter({
    cleanToolArgs: (_name, input) => input,
    fallbackId: (prefix) => prefix + '_synthetic',
    protocolOptions,
  });
const image = Object.freeze({
  type: 'image',
  source: Object.freeze({ type: 'base64', media_type: 'image/png', data: 'YWJj' }),
});
try {
  const convert = create();
  const source = Object.freeze({
    messages: Object.freeze([Object.freeze({ role: 'user', content: Object.freeze([image]) })]),
  });
  const first = convert(source, 'synthetic', { codex: false });
  assert.equal(calls, 1, 'Image parts must be validated/converted exactly once');
  assert.equal(first.input[0].content[0].image_url, 'data:image/png;base64,YWJj');
  first.input[0].content[0].image_url = 'https://synthetic.invalid/changed';
  const second = convert(source, 'synthetic', { codex: false });
  assert.equal(calls, 2, 'Prepared parts must not survive across requests');
  assert.equal(second.input[0].content[0].image_url, 'data:image/png;base64,YWJj');
  assert.equal(source.messages[0].content[0], image);
  const roleText = { type: 'text', text: 'synthetic' };
  const roles = convert(
    {
      messages: [
        { role: 'user', content: [roleText] },
        { role: 'assistant', content: [roleText] },
      ],
    },
    'synthetic',
    { codex: false }
  );
  assert.equal(roles.input[0].content[0].type, 'input_text');
  assert.equal(roles.input[1].content[0].type, 'output_text');
  assert.deepEqual(convert({ messages: [] }, 'synthetic', { codex: false }).input, []);
  assert.deepEqual(
    convert({ messages: [{ role: 'user', content: '   ' }] }, 'synthetic', { codex: false })
      .input[0].content,
    []
  );
  for (const block of [
    { ...image, source: { ...image.source, data: 'SECRET!' } },
    { ...image, source: { type: 'url', url: 'javascript:SECRET' } },
    { ...image, source: { type: 'url', url: 'https://example.com/\nSECRET' } },
    { ...image, source: { ...image.source, media_type: 'text/plain' } },
    { type: 'text', text: {} },
    { type: 'unknown', __preparedParts: [{ type: 'input_text', text: 'SECRET' }] },
  ])
    assert.throws(
      () =>
        convert({ messages: [{ role: 'user', content: [block] }] }, 'synthetic', { codex: false }),
      (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
    );
  assert.throws(() =>
    convert({ messages: [{ role: 'assistant', content: [image] }] }, 'synthetic', { codex: false })
  );
  const hostile = Object.defineProperty({}, 'type', {
    get() {
      throw new Error('SECRET');
    },
  });
  assert.throws(
    () =>
      convert({ messages: [{ role: 'user', content: [hostile] }] }, 'synthetic', { codex: false }),
    (error) => !error.message.includes('SECRET')
  );
  const fold = create({
    maxContextTokens: 300,
    outputReserveTokens: 1,
    safetyMarginTokens: 1,
    contextKeepRecentTurns: 1,
    maxHistoricalMessageChars: 80,
  });
  const long = 'synthetic text '.repeat(1000);
  const folded = fold(
    {
      messages: [
        { role: 'user', content: long },
        { role: 'assistant', content: 'ack' },
        { role: 'user', content: 'next' },
        { role: 'assistant', content: 'again' },
        { role: 'user', content: 'latest' },
      ],
    },
    'synthetic',
    { codex: false }
  );
  assert.ok(folded.__hpmDiagnostics.contextBudget.optimizedCount > 0);
  assert.ok(
    folded.input.every((item) => !item.content?.some((part) => part.text === long)),
    'Changed budget messages must not replay stale prepared text'
  );
  assert.equal(folded.input.at(-1).content[0].text, 'latest');
} finally {
  options.chatContentPartToResponses = original;
}
