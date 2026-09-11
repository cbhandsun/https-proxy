const test = require('node:test');
const assert = require('node:assert');
const {
  formatToolsPrompt,
  extractToolCallsFromText,
  buildTraeBridgePromptFromOpenAIChat,
  buildTraeBridgeOpenAIChatCompletion,
} = require('../lib/proxy/trae-official');

test('formatToolsPrompt formats tools correctly', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    },
  ];
  const prompt = formatToolsPrompt(tools);
  assert.ok(prompt.includes('# Available Tools:'));
  assert.ok(prompt.includes('web_search'));
  assert.ok(prompt.includes('```tool_call'));
});

test('buildTraeBridgePromptFromOpenAIChat injects tools and handles tool calls', () => {
  const body = {
    messages: [
      { role: 'user', content: 'What is the weather in Beijing?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'web_search',
              arguments: JSON.stringify({ query: 'Beijing weather' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_123',
        content: 'Sunny, 25C',
      },
      {
        role: 'user',
        content: 'Thanks, how about tomorrow?',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ],
  };

  const { prompt } = buildTraeBridgePromptFromOpenAIChat(body);
  assert.ok(prompt.includes('# Available Tools:'));
  assert.ok(prompt.includes('Assistant [Tool Call call_123]:'));
  assert.ok(prompt.includes('Tool Response [call_123]:\nSunny, 25C'));
  assert.ok(prompt.includes('Thanks, how about tomorrow?'));
});

test('extractToolCallsFromText extracts single tool call', () => {
  const text =
    'I will search for the weather.\n```tool_call\n{\n  "name": "web_search",\n  "arguments": {\n    "query": "Beijing weather"\n  }\n}\n```';
  const { text: cleanText, toolCalls } = extractToolCallsFromText(text);
  assert.strictEqual(cleanText, 'I will search for the weather.');
  assert.strictEqual(toolCalls.length, 1);
  assert.strictEqual(toolCalls[0].function.name, 'web_search');
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.strictEqual(args.query, 'Beijing weather');
});

test('extractToolCallsFromText extracts multiple tool calls in json array', () => {
  const text =
    '```tool_call\n[\n  {"name": "fetch", "arguments": {"url": "https://a.com"}},\n  {"name": "search", "arguments": {"q": "news"}}\n]\n```';
  const { text: cleanText, toolCalls } = extractToolCallsFromText(text);
  assert.strictEqual(cleanText, '');
  assert.strictEqual(toolCalls.length, 2);
  assert.strictEqual(toolCalls[0].function.name, 'fetch');
  assert.strictEqual(toolCalls[1].function.name, 'search');
});

test('buildTraeBridgeOpenAIChatCompletion constructs tool_calls response', () => {
  const rawText =
    'Let me look that up.\n```tool_call\n{"name": "get_stock", "arguments": {"symbol": "AAPL"}}\n```';
  const completion = buildTraeBridgeOpenAIChatCompletion(
    { model: 'trae-official' },
    rawText,
    'trae-official'
  );
  assert.strictEqual(completion.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(completion.choices[0].message.content, 'Let me look that up.');
  assert.strictEqual(completion.choices[0].message.tool_calls.length, 1);
  assert.strictEqual(completion.choices[0].message.tool_calls[0].function.name, 'get_stock');
});
