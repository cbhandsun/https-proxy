'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { createChatMessage, parseStreamChunk, calculateGenerationStats, estimateTokenCount } =
    await import('../../tauri-ui/src/app/models/playground.js');

  // Test createChatMessage
  const msg = createChatMessage('user', 'Hello world');
  assert.equal(msg.role, 'user');
  assert.equal(msg.content, 'Hello world');
  assert.ok(msg.id.startsWith('msg-'));

  // Test parseStreamChunk with OpenAI Chat format
  const chunk1 =
    'data: {"choices":[{"delta":{"content":"Hello ","reasoning_content":"Thinking..."}}]}\n\n';
  const parsed1 = parseStreamChunk(chunk1);
  assert.equal(parsed1.textDelta, 'Hello ');
  assert.equal(parsed1.thinkingDelta, 'Thinking...');
  assert.equal(parsed1.isDone, false);

  // Test parseStreamChunk with [DONE]
  const doneChunk = 'data: [DONE]\n\n';
  const parsedDone = parseStreamChunk(doneChunk);
  assert.equal(parsedDone.isDone, true);

  // Test parseStreamChunk with Claude format
  const claudeTextChunk =
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude text"}}\n\n';
  const parsedClaude = parseStreamChunk(claudeTextChunk);
  assert.equal(parsedClaude.textDelta, 'Claude text');

  // Test calculateGenerationStats
  const start = Date.now() - 2000;
  const firstToken = start + 300;
  const stats = calculateGenerationStats(start, firstToken, 100);
  assert.equal(stats.ttftMs, 300);
  assert.ok(Number(stats.tokensPerSec) > 0);

  // Test estimateTokenCount
  assert.ok(estimateTokenCount('你好，世界！') > 0);
  assert.ok(estimateTokenCount('Hello world!') > 0);

  console.log('[playground.test] ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
