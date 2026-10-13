'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeNativeCodexEntryPath: normalize,
  isAllowedEntryPath,
} = require('../lib/proxy/entry-routing');

const entry = { protocol: 'openai-responses' };
const alias = '/backend-api/codex/responses';

test('native backend shape maps only the exact Responses POST and preserves query bytes', () => {
  for (const suffix of ['', '?', '?x=%E4%B8%AD&x=2', '?' + 'x'.repeat(65536)]) {
    const value = normalize(entry, 'POST', alias + suffix);
    assert.equal(value, '/v1/responses' + suffix);
    assert.equal(isAllowedEntryPath(entry, 'POST', value), true);
  }
});

test('empty, illegal, near-match and foreign paths cannot become backend aliases', () => {
  for (const value of [
    undefined,
    null,
    42,
    {},
    [],
    '',
    '/v1/responses',
    alias + '/',
    alias + 'evil',
    alias + '/compact',
    '/backend-api/codex/models',
    alias + '#fragment',
    alias + '\0',
    '/backend-api/codex/../codex/responses',
    '/backend-api/codex/%72esponses',
    '/BACKEND-API/codex/responses',
    'https://host.invalid' + alias,
  ]) {
    assert.equal(normalize(entry, 'POST', value), value);
  }
});

test('no GET health acknowledgement, method widening or other-entry widening', () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', undefined, 'post'])
    assert.equal(normalize(entry, method, alias), alias);
  for (const other of [
    null,
    {},
    { protocol: 'claude' },
    { protocol: 'claude-desktop' },
    { protocol: 'openai-chat' },
    { protocol: 'workbuddy' },
  ])
    assert.equal(normalize(other, 'POST', alias), alias);
});
