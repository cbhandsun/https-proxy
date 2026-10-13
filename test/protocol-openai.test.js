/**
 * Golden fixture tests for protocol-openai.js + stream-claude.js
 *
 * 不依赖任何外部 fixture 文件,所有 fixture 直接内嵌,便于 review 时
 * 一眼看出"输入 -> 输出"语义。覆盖:
 *   1. claudeToolToOpenAITool         工具 schema
 *   2. claudeToolChoiceToOpenAI      工具选择
 *   3. openAIContentToClaudeContent  文本/图片内容
 *   4. openAIToolCallToClaudeBlock   工具调用
 *   5. claudeMessagesToOpenAIChat    请求体
 *   6. claudeResponseToOpenAIChat    响应体 (含 thinking)
 *   7. processClaudeSseEventToOpenAI 流式 chunk
 *   8. processOpenAISseEventToClaude 反向流
 */

const assert = require('assert');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');

// --- minimal stubs (mirrors thinking-persistence.test.js) ---
const cleanToolArgs = (name, args) => args;
const fallbackId = (p) => p + '_mock';
const stableCreated = () => 1700000000;
const deltaPartialJson = (delta) => {
  if (delta && typeof delta.partial_json === 'string') return delta.partial_json;
  return '';
};
const isClaudeThinkingBlock = (block) => block && block.type === 'thinking';
const noopBlocks = (blocks) => blocks;
const passthroughText = (t) => t;
const parseClaudeSseEvent = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return { eventName: '', dataText: '', data: null };
  const lines = text.split('\n');
  let eventName = '';
  let dataText = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) eventName = line.substring(7).trim();
    else if (line.startsWith('data: ')) dataText += line.substring(6);
  }
  let data = null;
  if (dataText && dataText !== '[DONE]') {
    try {
      data = JSON.parse(dataText);
    } catch (e) {}
  }
  return { eventName, dataText, data };
};

function createTestProtocol(protocolOptions = {}) {
  return createOpenAIProtocol({
    cleanToolArgs,
    fallbackId,
    stableCreated,
    isClaudeThinkingBlock,
    filterClaudeCompatibleBlocks: noopBlocks,
    normalizeClaudeContent: (content) => {
      // Mirror real behavior: string -> [{type:text}], array -> pass through, null -> []
      if (content == null) return [];
      if (typeof content === 'string') return [{ type: 'text', text: content }];
      if (Array.isArray(content)) return content;
      return [{ type: 'text', text: String(content) }];
    },
    normalizeClaudeSystem: (sys) => {
      if (!sys) return null;
      if (typeof sys === 'string') return { parts: [{ type: 'text', text: sys }] };
      if (Array.isArray(sys))
        return {
          parts: sys.map((s) => ({ type: 'text', text: typeof s === 'string' ? s : s.text || '' })),
        };
      if (sys.parts) return sys;
      return { parts: [{ type: 'text', text: String(sys) }] };
    },
    geminiToolResponseText: passthroughText,
    parseClaudeSseEvent,
    deltaPartialJson,
    protocolOptions: { thinkingPolicy: 'passthrough', ...protocolOptions },
  });
}

const protocol = createTestProtocol();

let pass = 0,
  fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok -', name);
  } catch (err) {
    fail += 1;
    console.error('  FAIL -', name, '\n   ', err.message);
  }
}
function eq(actual, expected, msg) {
  assert.deepStrictEqual(
    actual,
    expected,
    msg || `expected ${JSON.stringify(actual)} === ${JSON.stringify(expected)}`
  );
}

console.log('protocol-openai golden fixture tests');

// 1. claudeToolToOpenAITool
t('claudeToolToOpenAITool maps name + input_schema', () => {
  const out = protocol.claudeToolToOpenAITool({
    name: 'GetWeather',
    description: 'Get current weather',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  });
  eq(out, {
    type: 'function',
    function: {
      name: 'GetWeather',
      description: 'Get current weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  });
});

t('claudeToolToOpenAITool fills missing description / parameters', () => {
  const out = protocol.claudeToolToOpenAITool({ name: 'Bash' });
  eq(out.function.description, '');
  eq(out.function.parameters, { type: 'object', properties: {} });
});

// 2. claudeToolChoiceToOpenAI
t('claudeToolChoiceToOpenAI auto -> undefined', () => {
  assert.strictEqual(protocol.claudeToolChoiceToOpenAI({ type: 'auto' }), undefined);
  assert.strictEqual(protocol.claudeToolChoiceToOpenAI(null), undefined);
});
t('claudeToolChoiceToOpenAI none -> "none"', () => {
  assert.strictEqual(protocol.claudeToolChoiceToOpenAI({ type: 'none' }), 'none');
});
t('claudeToolChoiceToOpenAI any -> "required"', () => {
  assert.strictEqual(protocol.claudeToolChoiceToOpenAI({ type: 'any' }), 'required');
});
t('claudeToolChoiceToOpenAI tool -> {type:function, function:{name}}', () => {
  eq(protocol.claudeToolChoiceToOpenAI({ type: 'tool', name: 'Bash' }), {
    type: 'function',
    function: { name: 'Bash' },
  });
});

// 3. openAIContentToClaudeContent
t('openAIContentToClaudeContent null -> empty string', () => {
  assert.strictEqual(protocol.openAIContentToClaudeContent(null), '');
});
t('openAIContentToClaudeContent string passthrough', () => {
  assert.strictEqual(protocol.openAIContentToClaudeContent('hi'), 'hi');
});
t('openAIContentToClaudeContent text block', () => {
  eq(protocol.openAIContentToClaudeContent([{ type: 'text', text: 'hello' }]), [
    { type: 'text', text: 'hello' },
  ]);
});
t('openAIContentToClaudeContent data URL image -> base64 source', () => {
  eq(
    protocol.openAIContentToClaudeContent([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,ABCD' } },
    ]),
    [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ABCD' } }]
  );
});
t('openAIContentToClaudeContent audio and video -> base64 sources', () => {
  eq(
    protocol.openAIContentToClaudeContent([
      { type: 'input_audio', input_audio: { data: 'c291bmQ=', format: 'wav' } },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
    ]),
    [
      { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: 'c291bmQ=' } },
      { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'dmlkZW8=' } },
    ]
  );
});
t('openAIContentToClaudeContent rejects remote media instead of degrading it to text', () => {
  assert.throws(
    () =>
      protocol.openAIContentToClaudeContent([
        { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
      ]),
    /base64 data URL|matching MIME type/
  );
});

// 4. openAIToolCallToClaudeBlock
t('openAIToolCallToClaudeBlock parses JSON arguments', () => {
  const block = protocol.openAIToolCallToClaudeBlock({
    id: 'call_1',
    type: 'function',
    function: { name: 'Bash', arguments: '{"command":"ls"}' },
  });
  eq(block, { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } });
});
t('openAIToolCallToClaudeBlock falls back to {arguments} on bad JSON', () => {
  const block = protocol.openAIToolCallToClaudeBlock({
    id: 'call_2',
    function: { name: 'Bash', arguments: 'not-json' },
  });
  eq(block, { type: 'tool_use', id: 'call_2', name: 'Bash', input: { arguments: 'not-json' } });
});

// 5. claudeMessagesToOpenAIChat
t('claudeMessagesToOpenAIChat basic text request', () => {
  const out = protocol.claudeMessagesToOpenAIChat(
    {
      model: 'gpt-4',
      system: 'You are helpful',
      max_tokens: 1024,
      temperature: 0.5,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
    },
    'gpt-4'
  );
  eq(out.messages, [
    { role: 'system', content: 'You are helpful' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!' },
  ]);
  assert.strictEqual(out.max_tokens, 1024);
  assert.strictEqual(out.temperature, 0.5);
});

t('claudeMessagesToOpenAIChat user tool_result -> tool message', () => {
  const out = protocol.claudeMessagesToOpenAIChat(
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' }],
        },
      ],
    },
    'gpt-4'
  );
  eq(out.messages, [{ role: 'tool', content: 'sunny', tool_call_id: 'call_1' }]);
});

// 6. claudeResponseToOpenAIChat with thinking
t('claudeResponseToOpenAIChat maps text + thinking', () => {
  const out = protocol.claudeResponseToOpenAIChat(
    {
      id: 'msg_1',
      content: [
        { type: 'thinking', thinking: 'reasoning...' },
        { type: 'text', text: 'final' },
      ],
    },
    'gpt-4'
  );
  assert.strictEqual(out.choices[0].message.content, 'final');
  assert.strictEqual(out.choices[0].message.reasoning_content, 'reasoning...');
});

t('claudeResponseToOpenAIChat tool_use -> tool_calls', () => {
  const out = protocol.claudeResponseToOpenAIChat(
    {
      id: 'msg_2',
      content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
    },
    'gpt-4'
  );
  const tc = out.choices[0].message.tool_calls[0];
  assert.strictEqual(tc.id, 'call_1');
  assert.strictEqual(tc.function.name, 'Bash');
  assert.deepStrictEqual(JSON.parse(tc.function.arguments), { command: 'ls' });
});

t('claudeResponseToOpenAIChat renders generated image blocks as data-image markdown', () => {
  const out = protocol.claudeResponseToOpenAIChat(
    {
      id: 'msg_image',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
        },
      ],
      stop_reason: 'end_turn',
      usage: {},
    },
    'gemini-3.1-flash-image'
  );
  assert.strictEqual(
    out.choices[0].message.content,
    '![generated image](data:image/png;base64,aW1hZ2U=)'
  );
});

// 7. processClaudeSseEventToOpenAI
t('processClaudeSseEventToOpenAI message_start -> role chunk', () => {
  const events = [];
  const fakeRes = { write: (chunk) => events.push(chunk) };
  const state = { id: 'x', created: 1, model: 'gpt-4', toolCallIndex: 0 };
  protocol.processClaudeSseEventToOpenAI(
    fakeRes,
    'event: message_start\ndata: {"type":"message_start"}',
    state
  );
  assert.strictEqual(events.length, 1);
  const data = JSON.parse(events[0].replace('data: ', '').trim());
  assert.strictEqual(data.choices[0].delta.role, 'assistant');
});

t('processClaudeSseEventToOpenAI text delta -> content chunk', () => {
  const events = [];
  const fakeRes = { write: (chunk) => events.push(chunk) };
  const state = { id: 'x', created: 1, model: 'gpt-4', toolCallIndex: 0 };
  protocol.processClaudeSseEventToOpenAI(
    fakeRes,
    'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"hi"}}',
    state
  );
  const data = JSON.parse(events[0].replace('data: ', '').trim());
  assert.strictEqual(data.choices[0].delta.content, 'hi');
});

t('processClaudeSseEventToOpenAI thinking delta -> reasoning_content chunk', () => {
  const events = [];
  const fakeRes = { write: (chunk) => events.push(chunk) };
  const state = { id: 'x', created: 1, model: 'gpt-4', toolCallIndex: 0 };
  protocol.processClaudeSseEventToOpenAI(
    fakeRes,
    'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"think..."}}',
    state
  );
  const data = JSON.parse(events[0].replace('data: ', '').trim());
  assert.strictEqual(data.choices[0].delta.reasoning_content, 'think...');
});

t('processClaudeSseEventToOpenAI [DONE] is a no-op', () => {
  const events = [];
  const fakeRes = { write: (chunk) => events.push(chunk) };
  const state = { id: 'x', created: 1, model: 'gpt-4', toolCallIndex: 0 };
  protocol.processClaudeSseEventToOpenAI(fakeRes, 'data: [DONE]', state);
  assert.strictEqual(events.length, 0);
});

// 8. processOpenAISseEventToClaude
t('processOpenAISseEventToClaude is in stream-claude.js (skipped here)', () => {
  // Stream-claude.js covers the OpenAI -> Claude SSE path. See test/stream-claude.test.js.
  assert.strictEqual(typeof protocol.processOpenAISseEventToClaude, 'undefined');
});

t('SSE chunk processors reject oversized incomplete events', () => {
  const capped = createTestProtocol({ maxSseBufferChars: 8 });
  const fakeRes = { write: () => {} };

  const claudeState = { buffer: '', id: 'x', created: 1, model: 'gpt-4', toolCallIndex: 0 };
  assert.doesNotThrow(() =>
    capped.processClaudeSseChunkToOpenAI(fakeRes, 'event: content_block_delta', claudeState)
  );
  assert.strictEqual(claudeState.failed, true);
  assert.strictEqual(claudeState.failureCode, 'upstream_stream_event_too_large');
  assert.strictEqual(claudeState.buffer, '');

  const chatToResponsesState = {
    buffer: '',
    pendingToolCalls: [],
    completedOutputItems: [],
  };
  capped.processOpenAIChatSseChunkToResponses(fakeRes, 'data: {"choices":[', chatToResponsesState);
  assert.strictEqual(chatToResponsesState.buffer, '');
  assert.strictEqual(chatToResponsesState.failed, true);
  assert.strictEqual(chatToResponsesState.failure.code, 'upstream_stream_event_too_large');

  const responsesToChatState = { buffer: '', toolCalls: [] };
  assert.doesNotThrow(() =>
    capped.processOpenAIResponsesSseChunkToChat(fakeRes, 'event: response.', responsesToChatState)
  );
  assert.strictEqual(responsesToChatState.failed, true);
  assert.strictEqual(responsesToChatState.failure.code, 'upstream_stream_event_too_large');
  assert.strictEqual(responsesToChatState.buffer, '');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('protocol-openai tests ok');
