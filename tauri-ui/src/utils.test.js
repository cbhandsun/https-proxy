// Smoke test for the ESM utils module. Run with: `node tauri-ui/src/utils.test.js`.
// Uses a tiny in-process assertion harness so it does not require a test runner.

import assert from 'node:assert/strict';
import { greet, formatTimestamp } from './utils.js';

assert.equal(greet('world'), 'hello from Vite, world', 'greet() basic');
assert.equal(greet(''), 'hello from Vite, ', 'greet() empty');
assert.equal(
  typeof formatTimestamp('2026-01-02T03:04:05.000Z'),
  'string',
  'formatTimestamp() returns string'
);
assert.equal(formatTimestamp('not-a-date'), '', 'formatTimestamp() invalid');
assert.equal(formatTimestamp().length > 0, true, 'formatTimestamp() default');

console.log('utils.test.js ok (2 modules, 5 assertions)');
