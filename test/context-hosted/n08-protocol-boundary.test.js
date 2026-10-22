'use strict';
// Pure wire parser and argument tests. No networking or product module imports.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseReply,
  createBusinessScenario,
} = require('../../scripts/context-hosted/n08/business-scenario.js');
const {
  startObservedContinuation,
} = require('../../scripts/context-hosted/n08/observed-client.js');
test('completed standard Responses reply parses without changing bytes', () => {
  const body = { object: 'response', status: 'completed', output: [] };
  assert.deepEqual(parseReply({ status: 200, bytes: Buffer.from(JSON.stringify(body)) }), body);
});
test('empty invalid oversized incomplete and failed protocol replies reject', () => {
  for (const reply of [
    { status: 503, bytes: Buffer.from('{}') },
    { status: 200, bytes: Buffer.alloc(0) },
    { status: 200, bytes: Buffer.from([255]) },
    { status: 200, bytes: Buffer.from('{bad') },
    { status: 200, bytes: Buffer.alloc(262145) },
    { status: 200, bytes: Buffer.from('{"object":"response","status":"in_progress","output":[]}') },
    { status: 200, bytes: Buffer.from('{"object":"response","status":"completed","output":null}') },
  ])
    assert.throws(() => parseReply(reply));
});
test('invalid scenario and observed-client boundaries reject before any I/O', () => {
  for (const input of [null, [], {}, { ownedRoot: 'relative' }])
    assert.throws(() => createBusinessScenario(input));
  for (const input of [
    null,
    {},
    { entryPort: 443, entryKey: 'a'.repeat(48), body: Buffer.from('{}') },
    { entryPort: 18081, entryKey: 'invalid', body: Buffer.from('{}') },
    { entryPort: 18081, entryKey: 'a'.repeat(48), body: Buffer.alloc(262145) },
  ]) {
    assert.throws(() => startObservedContinuation(input));
  }
});
