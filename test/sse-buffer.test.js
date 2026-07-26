'use strict';

const assert = require('node:assert/strict');
const { createSseBufferAppender, parseBoundedInteger } = require('../lib/proxy/sse-buffer');

assert.equal(parseBoundedInteger('128', 64, 1, 256), 128);
assert.equal(parseBoundedInteger('', 64, 1, 256), 64);
assert.equal(parseBoundedInteger('not-a-number', 64, 1, 256), 64);
assert.equal(parseBoundedInteger(0, 64, 1, 256), 1);
assert.equal(parseBoundedInteger(Number.MAX_SAFE_INTEGER, 64, 1, 256), 256);

assert.throws(() => createSseBufferAppender(0), /positive safe integer/);
assert.throws(() => createSseBufferAppender(Number.MAX_VALUE), /positive safe integer/);

const append = createSseBufferAppender(5);
const state = {};
append(state, 'abc', 'Test');
append(state, 'de', 'Test');
assert.equal(state.buffer, 'abcde');
assert.throws(() => append(state, 'f', 'Test'), /Test SSE event too large; max 5 chars/);
assert.equal(state.buffer, '', 'overflow clears retained content before failing');

console.log('[sse-buffer.test] ok');
