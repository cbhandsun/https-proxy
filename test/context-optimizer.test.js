'use strict';

const assert = require('node:assert/strict');
const LF = String.fromCharCode(10);
const {
  optimizeContextMessages,
  truncateToolOutputText,
  isToolResponseMessage,
} = require('../lib/proxy/context-optimizer');

// 1. Truncate utility tests
{
  const shortText = 'hello world';
  assert.equal(truncateToolOutputText(shortText, 800), shortText);

  const longText = 'A'.repeat(500) + 'B'.repeat(500);
  const truncated = truncateToolOutputText(longText, 500, 100, 100);
  assert.ok(truncated.length < longText.length);
  assert.ok(truncated.startsWith('A'.repeat(100)));
  assert.ok(truncated.endsWith('B'.repeat(100)));
  assert.ok(truncated.includes('代理已折叠历史执行回显'));

  const jsonOutput = JSON.stringify({
    ok: true,
    rows: Array.from({ length: 20 }, (_, index) => ({ index, value: 'x'.repeat(40) })),
  });
  const jsonTruncated = truncateToolOutputText(jsonOutput, 260, 100, 100);
  assert.ok(jsonTruncated.includes('historical JSON tool output compacted'));
  assert.ok(jsonTruncated.includes('"keys"'));
  assert.ok(jsonTruncated.length <= 260);

  const errorOutput = [
    'line '.repeat(40),
    'Error: command failed',
    '    at main.js:12:5',
    'noise '.repeat(80),
  ].join('\n');
  const errorTruncated = truncateToolOutputText(errorOutput, 220, 100, 100);
  assert.ok(errorTruncated.includes('historical tool error summary'));
  assert.ok(errorTruncated.includes('Error: command failed'));
  assert.ok(errorTruncated.length <= 220);
}

// 2. isToolResponseMessage tests
{
  assert.equal(isToolResponseMessage(null), false);
  assert.equal(isToolResponseMessage({ role: 'user', content: 'hello' }), false);
  assert.equal(isToolResponseMessage({ role: 'tool', content: 'result' }), true);
  assert.equal(isToolResponseMessage({ role: 'function', content: 'result' }), true);
  assert.equal(
    isToolResponseMessage({ role: 'user', tool_call_id: 'call_1', content: 'res' }),
    true
  );
  assert.equal(
    isToolResponseMessage({ role: 'user', content: 'Command output:' + LF + 'file content...' }),
    true
  );
}

// 3. optimizeContextMessages tests
{
  assert.deepEqual(optimizeContextMessages(null).messages, null);
  assert.deepEqual(optimizeContextMessages([]).messages, []);

  const shortMsgs = [
    { role: 'system', content: 'You are an assistant.' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!' },
  ];
  const r1 = optimizeContextMessages(shortMsgs);
  assert.equal(r1.prunedCount, 0);
  assert.equal(r1.savedChars, 0);
  assert.deepEqual(r1.messages, shortMsgs);

  const bigToolOutput1 = 'LOG_LINE_'.repeat(200);
  const bigToolOutput2 = 'OUTPUT_'.repeat(300);
  const recentToolOutput = 'RECENT_TOOL_'.repeat(200);

  const messages = [
    { role: 'system', content: 'System instructions.' },
    { role: 'user', content: 'Run test 1' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' }] },
    { role: 'tool', tool_call_id: 'c1', content: bigToolOutput1 },
    { role: 'assistant', content: 'Test 1 done.' },
    { role: 'user', content: 'Run test 2' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function' }] },
    { role: 'user', content: 'Command output:' + LF + bigToolOutput2 },
    { role: 'assistant', content: 'Test 2 done.' },
    { role: 'user', content: 'Run test 3' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function' }] },
    { role: 'tool', tool_call_id: 'c3', content: recentToolOutput },
    { role: 'assistant', content: 'Test 3 done.' },
    { role: 'user', content: 'Current status?' },
  ];

  const optResult = optimizeContextMessages(messages, {
    keepRecentTurns: 2,
    maxHistoricalToolChars: 500,
    headChars: 100,
    tailChars: 100,
  });

  assert.equal(optResult.prunedCount, 2);
  assert.ok(optResult.savedChars > 2000);
  assert.ok(optResult.messages[3].content.includes('代理已折叠历史执行回显'));
  assert.ok(optResult.messages[7].content.includes('代理已折叠历史执行回显'));
  assert.equal(optResult.messages[11].content, recentToolOutput);
  assert.equal(optResult.messages[0].content, 'System instructions.');

  const disabledResult = optimizeContextMessages(messages, { enabled: false });
  assert.equal(disabledResult.prunedCount, 0);
  assert.equal(disabledResult.savedChars, 0);

  const longHistoryMessages = [
    { role: 'system', content: 'System instructions.' },
    { role: 'user', content: 'Old context ' + 'A'.repeat(2000) },
    { role: 'assistant', content: 'Old answer ' + 'B'.repeat(2000) },
    { role: 'user', content: 'Current status?' },
  ];
  const foldedMessages = optimizeContextMessages(longHistoryMessages, {
    keepRecentTurns: 1,
    maxHistoricalToolChars: 500,
    maxHistoricalMessageChars: 500,
    foldHistoricalMessages: true,
    headChars: 100,
    tailChars: 100,
  });
  assert.ok(foldedMessages.messages[1].content.includes('代理已折叠历史执行回显'));
  assert.ok(foldedMessages.messages[2].content.includes('代理已折叠历史执行回显'));
  assert.equal(foldedMessages.messages[3].content, 'Current status?');
}

console.log('[context-optimizer.test] ok');
