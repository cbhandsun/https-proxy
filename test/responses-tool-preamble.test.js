'use strict';

const assert = require('node:assert/strict');
const {
  RESPONSES_PREAMBLE_SCAN_CHAR_BUDGET,
  inputContainsCjk,
  responsesInputNeedsToolPreamble,
  responsesToolPreambleText,
} = require('../lib/proxy/handlers/responses-tool-preamble');

// inputContainsCjk: normal / empty / invalid / extreme / bounded budget
assert.equal(inputContainsCjk('你好'), true);
assert.equal(inputContainsCjk('hello'), false);
assert.equal(inputContainsCjk(''), false);
assert.equal(inputContainsCjk(null), false);
assert.equal(inputContainsCjk(42), false);
assert.equal(inputContainsCjk({ input: [{ content: [{ text: '中文' }] }] }), true);
assert.equal(inputContainsCjk({ nested: { deeper: '中文' } }), true);

// Priority keys are inspected before arbitrary properties, and the scan budget
// prevents unbounded traversal / regex work on hostile payloads.
assert.equal(
  inputContainsCjk({ irrelevant: 'x'.repeat(50000), text: '中文' }),
  true,
  'priority keys must be scanned before arbitrary keys'
);
assert.equal(
  inputContainsCjk({ a: 'a'.repeat(RESPONSES_PREAMBLE_SCAN_CHAR_BUDGET), b: '中文' }),
  false,
  'CJK beyond the scan budget is ignored'
);
assert.equal(inputContainsCjk('中文', { remaining: 0 }), false, 'exhausted budget short-circuits');
assert.equal(inputContainsCjk('中文', null), false, 'missing budget short-circuits');

// responsesToolPreambleText: language selection only, never throws on garbage.
assert.equal(responsesToolPreambleText({ input: '你好' }), '我先看一下。');
assert.equal(responsesToolPreambleText({ input: 'hello' }), "I'll take a look.");
assert.equal(responsesToolPreambleText(null), "I'll take a look.");
assert.equal(responsesToolPreambleText({}), "I'll take a look.");

// responsesInputNeedsToolPreamble: skip when the latest turn is a tool result.
assert.equal(responsesInputNeedsToolPreamble('look this up'), true);
assert.equal(responsesInputNeedsToolPreamble('   '), false);
assert.equal(responsesInputNeedsToolPreamble(''), false);
assert.equal(responsesInputNeedsToolPreamble(undefined), false);
assert.equal(responsesInputNeedsToolPreamble(123), false);
assert.equal(responsesInputNeedsToolPreamble({ role: 'user' }), true);
assert.equal(responsesInputNeedsToolPreamble({ type: 'message' }), true);
assert.equal(responsesInputNeedsToolPreamble({ role: 'assistant' }), false);
assert.equal(
  responsesInputNeedsToolPreamble([
    { type: 'message', role: 'user' },
    { type: 'function_call_output', output: 'done' },
  ]),
  false,
  'a trailing tool output means no preamble is needed'
);
assert.equal(
  responsesInputNeedsToolPreamble([
    { type: 'function_call_output', output: 'done' },
    { type: 'message', role: 'user' },
  ]),
  true,
  'a trailing user message still needs a preamble'
);
assert.equal(responsesInputNeedsToolPreamble([{ type: 'custom_tool_call_output' }]), false);
assert.equal(responsesInputNeedsToolPreamble([null, 'x']), false, 'non-object items are skipped');

console.log('[responses-tool-preamble.test] ok');
