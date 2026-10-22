'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { claudeAcceptanceTarget } = require('../scripts/lib/claude-acceptance-target');

test('Claude acceptance forwards configured Anthropic prefix exactly once', () => {
  for (const base of [
    'https://api.deepseek.com',
    'https://api.deepseek.com/',
    'https://api.deepseek.com/anthropic',
    'https://api.deepseek.com/anthropic/',
  ]) {
    for (const inbound of ['/v1/messages', '/anthropic/v1/messages']) {
      assert.equal(
        claudeAcceptanceTarget(base, inbound).href,
        'https://api.deepseek.com/anthropic/v1/messages'
      );
      assert.equal(
        claudeAcceptanceTarget(base, inbound + '?beta=true').href,
        'https://api.deepseek.com/anthropic/v1/messages?beta=true'
      );
    }
  }
});

test('Claude acceptance rejects empty, malformed, extreme and unsafe URL boundaries with fixed error', () => {
  const base = 'https://api.deepseek.com/anthropic';
  const cases = [
    [undefined, '/v1/messages'],
    ['', '/v1/messages'],
    [base, null],
    [base, ''],
    ['http://api.deepseek.com/anthropic', '/v1/messages'],
    ['https://other.example/anthropic', '/v1/messages'],
    ['https://secret@api.deepseek.com/anthropic', '/v1/messages'],
    [base + '?secret=value', '/v1/messages'],
    [base + '#fragment', '/v1/messages'],
    [base, '//other.example/v1/messages'],
    [base, '/anthropic/anthropic/v1/messages'],
    [base, '/anthropic/../v1/messages'],
    [base, '/v1/messages?secret=value'],
    [base, '/v1/messages#fragment'],
    [base, '/v1/messages?beta=true&secret=value'],
    [base, '/v1/messages/' + 'x'.repeat(4096)],
    [base, '/v1/messages\n'],
    [
      {
        toString() {
          throw new Error('secret');
        },
      },
      '/v1/messages',
    ],
  ];
  for (const [target, inbound] of cases)
    assert.throws(() => claudeAcceptanceTarget(target, inbound), {
      message: 'claude_acceptance_target_refused',
    });
});
