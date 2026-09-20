const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { createProxyHandlers } = require('../lib/proxy/handlers');
const { DATA_DIR } = require('../lib/proxy/config');

// Helper to mock functions
const cleanToolArgs = (name, args) => args;
const fallbackId = (prefix) => prefix + '_mock';
const stableCreated = () => 123456789;
const deltaPartialJson = (delta) => delta.text;
const parseClaudeSseEvent = (event) => {
  const trimmed = event.trim();
  if (trimmed.includes('message_start')) {
    return { eventName: 'message_start', dataText: '{}', data: {} };
  }
  if (trimmed.includes('content_block_start')) {
    const isThinking = trimmed.includes('"type":"thinking"');
    return {
      eventName: 'content_block_start',
      dataText: '{}',
      data: { content_block: { type: isThinking ? 'thinking' : 'text' } },
    };
  }
  if (trimmed.includes('content_block_delta')) {
    let thinking = '';
    let text = '';
    try {
      const dataStr = trimmed.substring(trimmed.indexOf('{'));
      const parsed = JSON.parse(dataStr);
      if (parsed.delta) {
        thinking = parsed.delta.thinking || '';
        text = parsed.delta.text || '';
      }
    } catch (e) {}
    return {
      eventName: 'content_block_delta',
      dataText: '{}',
      data: { delta: { thinking, text } },
    };
  }
  if (trimmed.includes('content_block_stop')) {
    return { eventName: 'content_block_stop', dataText: '{}', data: {} };
  }
  if (trimmed.includes('message_stop')) {
    return { eventName: 'message_stop', dataText: '[DONE]', data: {} };
  }
  return { eventName: '', dataText: '', data: null };
};

function runThinkingTests() {
  console.log('Running Thinking/Reasoning conversion tests...');

  // Test Case 1: passthrough policy
  {
    const filters = createClaudeFilters({
      protocolOptions: { thinkingPolicy: 'passthrough' },
      makeSafeClaudeToolUseContentBlock: () => {},
    });
    const protocol = createOpenAIProtocol({
      cleanToolArgs,
      fallbackId,
      stableCreated,
      isClaudeThinkingBlock: filters.isClaudeThinkingBlock,
      filterClaudeCompatibleBlocks: filters.filterClaudeCompatibleBlocks,
      normalizeClaudeContent: filters.normalizeClaudeContent,
      normalizeClaudeSystem: (sys) => sys,
      geminiToolResponseText: (text) => text,
      parseClaudeSseEvent,
      deltaPartialJson,
      protocolOptions: { thinkingPolicy: 'passthrough' },
    });

    // Test non-stream
    const payload = {
      content: [
        { type: 'thinking', thinking: 'I am reasoning...' },
        { type: 'text', text: 'Hello!' },
      ],
    };
    const openAI = protocol.claudeResponseToOpenAIChat(payload, 'gpt-4');
    assert.strictEqual(openAI.choices[0].message.reasoning_content, 'I am reasoning...');
    assert.strictEqual(openAI.choices[0].message.content, 'Hello!');

    // Test stream
    const chunks = [];
    const clientRes = {
      write: (data) => chunks.push(data),
    };
    const state = {
      buffer: '',
      inThinking: false,
      toolCallIndex: 0,
      hasToolCalls: false,
      stopReason: 'stop',
      done: false,
    };

    protocol.processClaudeSseChunkToOpenAI(
      clientRes,
      'event: content_block_start\ndata: {"content_block":{"type":"thinking"}}\n\n',
      state
    );
    protocol.processClaudeSseChunkToOpenAI(
      clientRes,
      'event: content_block_delta\ndata: {"delta":{"thinking":"Thinking step 1"}}\n\n',
      state
    );
    protocol.processClaudeSseChunkToOpenAI(
      clientRes,
      'event: content_block_stop\ndata: {}\n\n',
      state
    );
    protocol.processClaudeSseChunkToOpenAI(
      clientRes,
      'event: message_stop\ndata: [DONE]\n\n',
      state
    );

    const sseOutput = chunks.join('');
    assert.ok(sseOutput.includes('reasoning_content'));
    assert.ok(sseOutput.includes('Thinking step 1'));
    assert.ok(!sseOutput.includes('<think>'));
    console.log('  [PASS] Passthrough mode preserves reasoning_content');
  }

  // Test Case 2: inject policy
  {
    const filters = createClaudeFilters({
      protocolOptions: { thinkingPolicy: 'inject' },
      makeSafeClaudeToolUseContentBlock: () => {},
    });
    const protocol = createOpenAIProtocol({
      cleanToolArgs,
      fallbackId,
      stableCreated,
      isClaudeThinkingBlock: filters.isClaudeThinkingBlock,
      filterClaudeCompatibleBlocks: filters.filterClaudeCompatibleBlocks,
      normalizeClaudeContent: filters.normalizeClaudeContent,
      normalizeClaudeSystem: (sys) => sys,
      geminiToolResponseText: (text) => text,
      parseClaudeSseEvent,
      deltaPartialJson,
      protocolOptions: { thinkingPolicy: 'inject' },
    });

    // Test non-stream
    const payload = {
      content: [
        { type: 'thinking', thinking: 'I am reasoning...' },
        { type: 'text', text: 'Hello!' },
      ],
    };
    const openAI = protocol.claudeResponseToOpenAIChat(payload, 'gpt-4');
    assert.strictEqual(openAI.choices[0].message.reasoning_content, undefined);
    assert.strictEqual(
      openAI.choices[0].message.content,
      '<think>\nI am reasoning...\n</think>\nHello!'
    );

    // Test stream
    const chunks = [];
    const clientRes = {
      write: (data) => chunks.push(data),
    };
    const state = {
      buffer: '',
      inThinking: false,
      toolCallIndex: 0,
      hasToolCalls: false,
      stopReason: 'stop',
      done: false,
    };

    protocol.processClaudeSseChunkToOpenAI(
      clientRes,
      'event: content_block_start\ndata: {"content_block":{"type":"thinking"}}\n\n',
      state
    );
    protocol.processClaudeSseChunkToOpenAI(
      clientRes,
      'event: content_block_delta\ndata: {"delta":{"thinking":"Thinking step 1"}}\n\n',
      state
    );
    protocol.processClaudeSseChunkToOpenAI(
      clientRes,
      'event: content_block_stop\ndata: {}\n\n',
      state
    );
    protocol.processClaudeSseChunkToOpenAI(
      clientRes,
      'event: message_stop\ndata: [DONE]\n\n',
      state
    );

    const sseOutput = chunks.join('');
    assert.ok(sseOutput.includes('<think>'));
    assert.ok(sseOutput.includes('Thinking step 1'));
    assert.ok(sseOutput.includes('</think>'));
    assert.ok(!sseOutput.includes('reasoning_content'));
    console.log('  [PASS] Inject mode wraps thinking in <think> tags');
  }

  // Test Case 3: drop policy
  {
    const filters = createClaudeFilters({
      protocolOptions: { thinkingPolicy: 'drop' },
      makeSafeClaudeToolUseContentBlock: () => {},
    });
    const protocol = createOpenAIProtocol({
      cleanToolArgs,
      fallbackId,
      stableCreated,
      isClaudeThinkingBlock: filters.isClaudeThinkingBlock,
      filterClaudeCompatibleBlocks: filters.filterClaudeCompatibleBlocks,
      normalizeClaudeContent: filters.normalizeClaudeContent,
      normalizeClaudeSystem: (sys) => sys,
      geminiToolResponseText: (text) => text,
      parseClaudeSseEvent,
      deltaPartialJson,
      protocolOptions: { thinkingPolicy: 'drop' },
    });

    // Test non-stream
    const payload = {
      content: [
        { type: 'thinking', thinking: 'I am reasoning...' },
        { type: 'text', text: 'Hello!' },
      ],
    };
    const openAI = protocol.claudeResponseToOpenAIChat(payload, 'gpt-4');
    assert.strictEqual(openAI.choices[0].message.reasoning_content, undefined);
    assert.strictEqual(openAI.choices[0].message.content, 'Hello!');
    console.log('  [PASS] Drop mode drops thinking blocks');
  }
}

function runPersistenceTests() {
  console.log('Running Responses Persistence tests...');

  const mockDeps = {
    claudeMessagesToOpenAIChat: () => {},
    openAIResponseToClaudeMessage: () => {},
    openAIChatToClaudeMessages: () => {},
    claudeResponseToOpenAIChat: () => {},
    openAIResponsesToChat: () => {},
    openAIChatToResponses: () => {},
    processOpenAIChatSseChunkToResponses: () => {},
    flushOpenAIChatSseToResponses: () => {},
    claudeMessagesToGemini: () => {},
    geminiGeneratePath: () => {},
    geminiResponseToClaude: () => {},
    parseGeminiError: () => {},
    getGeminiCooldown: () => {},
    setGeminiCooldown: () => {},
    sendGeminiRateLimit: () => {},
    sendUpstreamError: () => {},
    sendJsonError: () => {},
    writeClaudeSseEvent: () => {},
    processOpenAISseChunkToClaude: () => {},
    flushOpenAISseToClaude: () => {},
    processClaudeSseChunkToOpenAI: () => {},
    flushClaudeSseToOpenAI: () => {},
    processGeminiSseEvent: () => {},
    flushPendingGeminiToolCall: () => {},
    sampleResponseChunk: () => {},
    logProxyEvent: () => {},
    logRequestEnd: () => {},
    fallbackId: (prefix) => prefix + '_mock',
    stableCreated: () => 1234567,
    extractSseDataPayloads: () => [],
  };

  const cachePath = path.join(DATA_DIR, '.responses_history.cache.json');
  if (fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
  }

  // 1. Initial creation (empty cache)
  const handlers = createProxyHandlers(mockDeps);
  assert.strictEqual(handlers._responsesHistory.size, 0);

  // 2. Add history and verify it gets persisted
  const testId = 'resp_test_id';
  const testMessages = [{ role: 'user', content: 'hello cache' }];

  handlers._rememberResponsesHistory(testId, testMessages);
  assert.strictEqual(handlers._responsesHistory.size, 1);
  assert.deepStrictEqual(handlers._responsesHistory.get(testId), testMessages);

  // Trigger write and wait for debounce write to disk (1.5s to be safe since it debounces 1s)
  console.log('  Waiting for async cache save (1.5s)...');
  setTimeout(() => {
    try {
      assert.ok(fs.existsSync(cachePath), 'Cache file should be created');
      const raw = fs.readFileSync(cachePath, 'utf8');
      const loaded = JSON.parse(raw);
      assert.strictEqual(loaded[0][0], testId);
      assert.deepStrictEqual(loaded[0][1].messages, testMessages);
      assert.strictEqual(loaded[0][1].summary.messageCount, 1);
      assert.match(loaded[0][1].summary.sourceHash, /^[a-f0-9]{16}$/);
      console.log('  [PASS] Responses history persisted to disk cache successfully');

      // 3. Load from disk simulation
      const newHandlers = createProxyHandlers(mockDeps);
      assert.strictEqual(newHandlers._responsesHistory.size, 1);
      assert.deepStrictEqual(newHandlers._responsesHistory.get(testId), testMessages);
      console.log('  [PASS] Responses history loaded from disk cache successfully');

      // Cleanup
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
      }
      console.log('\nAll tests completed successfully!');
    } catch (err) {
      console.error('Persistence validation failed:', err);
      process.exit(1);
    }
  }, 1500);
}

runThinkingTests();
runPersistenceTests();
