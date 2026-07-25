const assert = require('assert');
const {
  claudeMessagesToGemini,
  geminiResponseToClaude,
  geminiUsageToClaude,
  claudeStopReasonFromGemini,
  parseTargetUrl,
  processGeminiSseEvent,
  processClaudeSseChunk,
  flushClaudeSseFilter,
  prepareRequestBufferWithResolver,
  openAIChatToClaudeMessages,
  openAIResponsesToChat,
} = require('../openai-proxy');
const { applyToolLoopGuardToOpenAIChat } = require('../lib/proxy/tool-loop-guard');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('converts Claude text request to Gemini generateContent body', () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    system: 'You are concise.',
    max_tokens: 128,
    temperature: 0.2,
    stop_sequences: ['END'],
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ],
  };

  const result = claudeMessagesToGemini(body, 'gemini-2.5-pro');
  assert.deepStrictEqual(result.systemInstruction, { parts: [{ text: 'You are concise.' }] });
  assert.deepStrictEqual(result.generationConfig, {
    maxOutputTokens: 128,
    temperature: 0.2,
    stopSequences: ['END'],
  });
  assert.deepStrictEqual(result.contents, [
    { role: 'user', parts: [{ text: 'hello' }] },
    { role: 'model', parts: [{ text: 'hi' }] },
    { role: 'user', parts: [{ text: 'continue' }] },
  ]);
});

test('removes deprecated sampling parameters for Gemini 3.6+', () => {
  const body = {
    max_tokens: 256,
    temperature: 0.2,
    top_p: 0.9,
    top_k: 20,
    messages: [{ role: 'user', content: 'hello' }],
  };

  const current = claudeMessagesToGemini(body, 'gemini-3.6-flash');
  assert.deepStrictEqual(current.generationConfig, { maxOutputTokens: 256 });

  const future = claudeMessagesToGemini(body, 'models/gemini-4.0-flash');
  assert.deepStrictEqual(future.generationConfig, { maxOutputTokens: 256 });

  const legacy = claudeMessagesToGemini(body, 'gemini-3.5-flash');
  assert.deepStrictEqual(legacy.generationConfig, {
    maxOutputTokens: 256,
    temperature: 0.2,
    topP: 0.9,
    topK: 20,
  });
});

test('converts images and tool declarations', () => {
  const result = claudeMessagesToGemini(
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          ],
        },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'lookup data',
          input_schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              q: { type: 'string' },
              maybe: { type: ['string', 'null'] },
              count: { type: 'integer', minimum: 1, exclusiveMinimum: 0 },
              formatted: {
                type: 'string',
                format: 'date-time',
                minLength: 3,
                maxLength: 30,
                pattern: '^x',
              },
              choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              nested: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { v: { type: 'string' } },
                },
              },
            },
            required: ['q'],
            propertyOrdering: ['q', 'count'],
            additionalProperties: false,
            propertyNames: { pattern: '^[a-z]+$' },
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'lookup' },
    },
    'gemini-2.5-pro'
  );

  assert.strictEqual(result.contents[0].parts[0].text, 'describe');
  assert.deepStrictEqual(result.contents[0].parts[1], {
    inlineData: { mimeType: 'image/png', data: 'abc123' },
  });
  assert.strictEqual(result.tools[0].functionDeclarations[0].name, 'lookup');
  assert.strictEqual(result.tools[0].functionDeclarations[0].parameters.$schema, undefined);
  assert.strictEqual(
    result.tools[0].functionDeclarations[0].parameters.additionalProperties,
    undefined
  );
  assert.strictEqual(result.tools[0].functionDeclarations[0].parameters.propertyNames, undefined);
  assert.strictEqual(result.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
  assert.deepStrictEqual(result.tools[0].functionDeclarations[0].parameters.properties.q, {
    type: 'STRING',
  });
  assert.deepStrictEqual(result.tools[0].functionDeclarations[0].parameters.properties.maybe, {
    type: 'STRING',
    nullable: true,
  });
  assert.strictEqual(
    result.tools[0].functionDeclarations[0].parameters.properties.count.exclusiveMinimum,
    undefined
  );
  assert.deepStrictEqual(result.tools[0].functionDeclarations[0].parameters.properties.formatted, {
    type: 'STRING',
    format: 'date-time',
    minLength: 3,
    maxLength: 30,
    pattern: '^x',
  });
  assert.deepStrictEqual(result.tools[0].functionDeclarations[0].parameters.propertyOrdering, [
    'q',
    'count',
  ]);
  assert.strictEqual(
    result.tools[0].functionDeclarations[0].parameters.properties.choice.oneOf,
    undefined
  );
  assert.strictEqual(
    result.tools[0].functionDeclarations[0].parameters.properties.nested.items.additionalProperties,
    undefined
  );
  assert.deepStrictEqual(result.toolConfig, {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] },
  });
});

test('omits Claude tool history when Gemini tools are present', () => {
  const result = claudeMessagesToGemini(
    {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'price' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', name: 'lookup', content: '42' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'nested' },
            {
              type: 'server_tool_use',
              payload: { functionCall: { name: 'Grep', args: { pattern: 'x' } } },
            },
          ],
        },
        { role: 'user', content: 'continue' },
      ],
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    },
    'gemini-2.5-pro'
  );

  assert.strictEqual(result.contents.length, 3);
  assert.deepStrictEqual(result.contents[0], {
    role: 'model',
    parts: [
      {
        functionCall: { name: 'lookup', args: { q: 'price' } },
        thoughtSignature: 'context_engineering_is_the_way_to_go',
      },
    ],
  });
  assert.deepStrictEqual(result.contents[1], {
    role: 'user',
    parts: [{ functionResponse: { name: 'lookup', response: { content: '42' } } }],
  });
  assert.deepStrictEqual(result.contents[2], { role: 'user', parts: [{ text: 'continue' }] });
});

test('restores Gemini thought signatures for tool history', () => {
  const response = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'sig-1' },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview'
  );

  const result = claudeMessagesToGemini(
    {
      messages: [
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: response.content[0].id, content: '42' }],
        },
      ],
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    },
    'gemini-3-flash-preview'
  );

  assert.deepStrictEqual(result.contents[0], {
    role: 'model',
    parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'sig-1' }],
  });
  assert.deepStrictEqual(result.contents[1], {
    role: 'user',
    parts: [{ functionResponse: { name: 'lookup', response: { content: '42' } } }],
  });
});

test('forces final Gemini answer after bounded OpenAI tool results', () => {
  const body = {
    model: 'gemini-3.5-flash',
    messages: [
      { role: 'user', content: '北京天气' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"北京天气"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '北京今天有雷阵雨。' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"北京今日天气预警"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_2', content: '北京今日最高温 31°C，出门建议带伞。' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      },
    ],
  };

  const guarded = applyToolLoopGuardToOpenAIChat(body).body;
  const claudeBody = openAIChatToClaudeMessages(guarded, 'gemini-3.5-flash');
  const geminiBody = claudeMessagesToGemini(claudeBody, 'gemini-3.5-flash');

  assert.strictEqual(geminiBody.toolConfig, undefined);
  assert.strictEqual(geminiBody.tools, undefined);
  const serializedContents = JSON.stringify(geminiBody.contents);
  assert.ok(!serializedContents.includes('functionResponse'));
  assert.ok(serializedContents.includes('Tool results are already available'));
  assert.ok(serializedContents.includes('北京今日最高温'));
});

test('maps OpenAI Responses native web search to Gemini Google Search grounding', () => {
  const chatBody = openAIResponsesToChat({
    model: 'gemini-3.5-flash',
    input: '今天美股和A股有什么重要新闻？',
    tools: [
      { type: 'web_search_preview' },
      {
        type: 'function',
        name: 'lookup',
        description: 'Lookup private data',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ],
  });

  assert.strictEqual(chatBody.__nativeWebSearch, 'gemini-google-search');
  assert.strictEqual(chatBody.tools.length, 1);
  assert.strictEqual(chatBody.tools[0].function.name, 'lookup');

  const claudeBody = openAIChatToClaudeMessages(chatBody, 'gemini-3.5-flash');
  const geminiBody = claudeMessagesToGemini(claudeBody, 'gemini-3.5-flash');

  assert.ok(geminiBody.tools.some((tool) => tool.googleSearch));
  assert.strictEqual(geminiBody.toolConfig.includeServerSideToolInvocations, true);
  const functionDeclarations = geminiBody.tools
    .flatMap((tool) => tool.functionDeclarations || [])
    .map((tool) => tool.name);
  assert.deepStrictEqual(functionDeclarations, ['lookup']);
});

test('promotes OpenClaw search function tools to Gemini Google Search grounding', () => {
  const chatBody = openAIResponsesToChat({
    model: 'gemini-3.5-flash',
    input: '搜索今天A股要闻',
    tools: [
      {
        type: 'function',
        name: 'web_search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
  });

  assert.strictEqual(chatBody.__nativeWebSearch, 'gemini-google-search');
  assert.strictEqual(chatBody.tools, undefined);

  const claudeBody = openAIChatToClaudeMessages(chatBody, 'gemini-3.5-flash');
  const geminiBody = claudeMessagesToGemini(claudeBody, 'gemini-3.5-flash');

  assert.deepStrictEqual(geminiBody.tools, [{ googleSearch: {} }]);
});

test('keeps OpenClaw tool catalog search separate from Gemini Google Search grounding', () => {
  const chatBody = openAIResponsesToChat({
    model: 'gemini-3.5-flash',
    input: '搜索今天A股要闻',
    tools: [
      {
        type: 'function',
        name: 'tool_search',
        description: 'Search tools',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        type: 'function',
        name: 'tool_call',
        description: 'Call a tool',
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
      },
    ],
  });

  assert.strictEqual(chatBody.__nativeWebSearch, undefined);
  assert.strictEqual(chatBody.tools.length, 2);
  assert.deepStrictEqual(
    chatBody.tools.map((tool) => tool.function.name),
    ['tool_search', 'tool_call']
  );
});

test('keeps a generic search function separate from Gemini Google Search grounding', () => {
  const chatBody = openAIResponsesToChat({
    model: 'gemini-3.5-flash',
    input: '搜索内部知识库',
    tools: [
      {
        type: 'function',
        name: 'search',
        description: 'Search a private knowledge base',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
  });

  assert.strictEqual(chatBody.__nativeWebSearch, undefined);
  assert.strictEqual(chatBody.tools.length, 1);
  assert.strictEqual(chatBody.tools[0].function.name, 'search');
});

test('keeps Gemini tool result names when thought signature is absent', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    tools: [{ name: 'Read', input_schema: { type: 'object', required: ['file_path'] } }],
    pendingToolCall: null,
  };

  processGeminiSseEvent(
    clientRes,
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Read","args":{"file_path":"D:\\\\DEV\\\\WorkSapce\\\\Efficiency\\\\https-proxy\\\\electron-main.js"},"id":"read-abc"}}]}}]}\r\n',
    state,
    'gemini-3-flash-preview'
  );
  const { flushPendingGeminiToolCall } = require('../openai-proxy');
  flushPendingGeminiToolCall(clientRes, state, state.tools);
  const next = claudeMessagesToGemini(
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_read_abc', content: 'file contents' },
          ],
        },
      ],
      tools: [{ name: 'Read', input_schema: { type: 'object', required: ['file_path'] } }],
    },
    'gemini-3-flash-preview'
  );
  assert.strictEqual(next.contents[0].parts[0].functionResponse.name, 'Read');
});

test('accepts Gemini Read tool path aliases when schema requires file_path', () => {
  const result = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'Read', args: { path: 'D:/tmp/screenshot.png' } },
                thoughtSignature: 'sig-read-path',
              },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    [{ name: 'Read', input_schema: { type: 'object', required: ['file_path'] } }]
  );

  assert.strictEqual(result.content[0].type, 'tool_use');
  assert.strictEqual(result.content[0].name, 'Read');
  assert.deepStrictEqual(result.content[0].input, {
    path: 'D:/tmp/screenshot.png',
    file_path: 'D:/tmp/screenshot.png',
  });
});

test('repairs a uniquely mismatched compact tool name from its declared schema', () => {
  const result = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'tool_call', args: { query: '航天电子 股价' } },
                thoughtSignature: 'sig-tool-search',
              },
            ],
          },
        },
      ],
    },
    'gemini-3.5-flash',
    [
      {
        name: 'tool_call',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      {
        name: 'tool_search',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ]
  );

  assert.strictEqual(result.content[0].type, 'tool_use');
  assert.strictEqual(result.content[0].name, 'tool_search');
  assert.deepStrictEqual(result.content[0].input, { query: '航天电子 股价' });
});

test('skips Gemini tool calls missing required args', () => {
  const result = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'Glob', args: {} }, thoughtSignature: 'sig-missing' }],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    [
      {
        name: 'Glob',
        input_schema: {
          type: 'object',
          required: ['pattern'],
          properties: { pattern: { type: 'string' } },
        },
      },
    ]
  );

  assert.strictEqual(result.content[0].type, 'text');
  assert.ok(
    result.content[0].text.includes('Please call the same tool again with complete arguments')
  );
  assert.ok(result.content[0].text.includes('pattern'));
});

test('skips common tool calls missing fallback required args', () => {
  const result = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'default_api:Grep', args: {} },
                thoughtSignature: 'sig-grep',
              },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    []
  );

  assert.strictEqual(result.content[0].type, 'text');
  assert.ok(result.content[0].text.includes('pattern'));
});

test('normalizes prefixed Gemini tool names and rejects empty common tool args', () => {
  const bash = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'default_api__Bash', args: {} },
                thoughtSignature: 'sig-bash',
              },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    []
  );
  assert.strictEqual(bash.content[0].type, 'text');
  assert.ok(
    bash.content[0].text.includes('Please call the same tool again with complete arguments')
  );
  assert.ok(bash.content[0].text.includes('command'));

  const undeclared = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'Write', args: { file_path: 'a', content: 'b' } } }],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    [{ name: 'Read', input_schema: { type: 'object', required: ['file_path'] } }]
  );
  assert.strictEqual(undeclared.content[0].type, 'text');
  assert.ok(undeclared.content[0].text.includes('not available in the current tool list'));

  const glob = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'functions.Glob', args: { pattern: '**/*.js' } },
                thoughtSignature: 'sig-glob',
              },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    []
  );
  assert.strictEqual(glob.content[0].type, 'tool_use');
  assert.strictEqual(glob.content[0].name, 'Glob');
  assert.deepStrictEqual(glob.content[0].input, { pattern: '**/*.js' });
});

test('recovers Gemini tool args from wrappers and JSON strings', () => {
  const wrapped = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'tool_Grep', args: { arguments: { pattern: 'needle' } } },
                thoughtSignature: 'sig-grep',
              },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    []
  );
  assert.strictEqual(wrapped.content[0].type, 'tool_use');
  assert.strictEqual(wrapped.content[0].name, 'Grep');
  assert.deepStrictEqual(wrapped.content[0].input, { pattern: 'needle' });

  const sibling = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'Glob', args: {}, arguments: { pattern: '**/*.js' } },
                thoughtSignature: 'sig-glob-sibling',
              },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    []
  );
  assert.strictEqual(sibling.content[0].type, 'tool_use');
  assert.deepStrictEqual(sibling.content[0].input, { pattern: '**/*.js' });

  const jsonArgs = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: 'Bash', args: '{"command":"pwd"}' },
                thoughtSignature: 'sig-bash-json',
              },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    []
  );
  assert.strictEqual(jsonArgs.content[0].type, 'tool_use');
  assert.deepStrictEqual(jsonArgs.content[0].input, { command: 'pwd' });
});

test('normalizes unsafe Gemini asset listing command', () => {
  const result = geminiResponseToClaude(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'Bash',
                  args: {
                    command: 'ls -R assets images static',
                    description: 'Check for any asset directories.',
                  },
                },
                thoughtSignature: 'sig-bash-assets',
              },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    []
  );

  assert.strictEqual(result.content[0].type, 'tool_use');
  assert.strictEqual(result.content[0].name, 'Bash');
  assert.strictEqual(
    result.content[0].input.command,
    'for d in "assets" "images" "static"; do [ -d "$d" ] && ls -R "$d"; done'
  );
});

test('non-stream Gemini large Write tool call is staged as a short Bash copy', () => {
  const content = 'x'.repeat(40000);
  const result = geminiResponseToClaude(
    {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              {
                functionCall: {
                  name: 'Write',
                  args: { file_path: 'E:/tmp/large-write.js', content },
                },
              },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    [
      { name: 'Write', input_schema: { type: 'object', required: ['file_path', 'content'] } },
      { name: 'Bash', input_schema: { type: 'object', required: ['command'] } },
    ]
  );

  assert.strictEqual(result.content[0].type, 'tool_use');
  assert.strictEqual(result.content[0].name, 'Bash');
  assert.ok(result.content[0].input.command.includes('cp '));
  assert.ok(result.content[0].input.command.includes('/e/tmp/large-write.js'));
  assert.ok(result.content[0].input.command.length < 512);
  assert.ok(!result.content[0].input.command.includes(content.slice(0, 100)));
  assert.strictEqual(result.stop_reason, 'tool_use');
});

test('non-stream Gemini large Write falls back to text when Bash is unavailable', () => {
  const content = 'x'.repeat(40000);
  const result = geminiResponseToClaude(
    {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              {
                functionCall: {
                  name: 'Write',
                  args: { file_path: 'E:/tmp/large-write.js', content },
                },
              },
            ],
          },
        },
      ],
    },
    'gemini-3-flash-preview',
    [{ name: 'Write', input_schema: { type: 'object', required: ['file_path', 'content'] } }]
  );

  assert.strictEqual(result.content[0].type, 'text');
  assert.ok(result.content[0].text.includes('too large'));
  assert.strictEqual(result.stop_reason, 'end_turn');
});

test('marks Gemini tool responses with Claude tool_use stop reason', () => {
  const result = geminiResponseToClaude(
    {
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ functionCall: { name: 'Bash', args: { command: 'pwd' } } }] },
        },
      ],
    },
    'gemini-3-flash-preview',
    [{ name: 'Bash', input_schema: { type: 'object', required: ['command'] } }]
  );

  assert.strictEqual(result.content[0].type, 'tool_use');
  assert.strictEqual(result.stop_reason, 'tool_use');
});

test('converts Gemini response to Claude message', () => {
  const result = geminiResponseToClaude(
    {
      candidates: [
        {
          finishReason: 'MAX_TOKENS',
          content: {
            parts: [{ text: 'hello' }, { functionCall: { name: 'lookup', args: { q: 'x' } } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
    },
    'gemini-2.5-pro'
  );

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.role, 'assistant');
  assert.strictEqual(result.model, 'gemini-2.5-pro');
  assert.deepStrictEqual(result.content[0], { type: 'text', text: 'hello' });
  assert.strictEqual(result.content[1].type, 'tool_use');
  assert.strictEqual(result.content[1].name, 'lookup');
  assert.deepStrictEqual(result.content[1].input, { q: 'x' });
  assert.strictEqual(result.stop_reason, 'max_tokens');
  assert.deepStrictEqual(result.usage, { input_tokens: 10, output_tokens: 3 });
});

test('maps Gemini usage and stop reasons', () => {
  assert.deepStrictEqual(geminiUsageToClaude({ promptTokenCount: 1, candidatesTokenCount: 2 }), {
    input_tokens: 1,
    output_tokens: 2,
  });
  assert.strictEqual(claudeStopReasonFromGemini('STOP'), 'end_turn');
  assert.strictEqual(claudeStopReasonFromGemini('SAFETY'), 'stop_sequence');
});

test('parses target URL and rewrites routed model', () => {
  assert.deepStrictEqual(parseTargetUrl('https://example.com:8443/v1'), {
    protocol: 'https:',
    hostname: 'example.com',
    port: 8443,
    path: '/v1',
  });

  const fixedResolver = () => ({
    profile: {
      id: 'openai-official',
      protocol: 'openai',
      targetUrl: 'https://chatgpt.com/backend-api/codex',
    },
    route: { from: 'claude-haiku-4-5-20251001', profileId: 'openai-official', to: 'gpt-5.3-codex' },
  });
  const prepared = prepareRequestBufferWithResolver(
    Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [] })),
    undefined,
    fixedResolver
  );
  const rewritten = JSON.parse(prepared.buffer.toString('utf8'));
  assert.strictEqual(prepared.routed, true);
  assert.strictEqual(rewritten.model, 'gpt-5.3-codex');
});

test('parses Gemini streaming SSE events with CRLF separators', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  processGeminiSseEvent(
    clientRes,
    'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1}}\r\n',
    state,
    'gemini-3-flash-preview'
  );

  assert.strictEqual(state.textOpen, true);
  assert.deepStrictEqual(state.usage, { input_tokens: 2, output_tokens: 1 });
  assert.ok(writes.join('').includes('hi'));
});

test('buffers streaming Gemini tool calls until args are complete', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    tools: [{ name: 'Glob', input_schema: { type: 'object', required: ['pattern'] } }],
    pendingToolCall: null,
  };

  processGeminiSseEvent(
    clientRes,
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Glob","args":{}},"thoughtSignature":"sig-glob"}]}}]}\r\n',
    state,
    'gemini-3-flash-preview'
  );
  assert.strictEqual(writes.length, 0);
  processGeminiSseEvent(
    clientRes,
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"args":{"pattern":"**/*.js"}}}]}}]}\r\n',
    state,
    'gemini-3-flash-preview'
  );
  assert.strictEqual(writes.length, 0);

  const { flushPendingGeminiToolCall } = require('../openai-proxy');
  flushPendingGeminiToolCall(clientRes, state, state.tools);
  const output = writes.join('');
  assert.ok(output.includes('Glob'));
  assert.ok(output.includes('**/*.js'));
});

test('streams retry text for incomplete Gemini tool calls', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    tools: [{ name: 'Bash', input_schema: { type: 'object', required: ['command'] } }],
    pendingToolCall: null,
  };

  processGeminiSseEvent(
    clientRes,
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"default_api:Bash","args":{}},"thoughtSignature":"sig-bash"}]},"finishReason":"STOP"}]}\r\n',
    state,
    'gemini-3-flash-preview'
  );
  const { flushPendingGeminiToolCall } = require('../openai-proxy');
  flushPendingGeminiToolCall(clientRes, state, state.tools);
  const output = writes.join('');
  assert.ok(output.includes('content_block_delta'));
  assert.ok(output.includes('Please call the same tool again with complete arguments'));
  assert.ok(output.includes('command'));
});

test('streams sibling Gemini tool args without emitting empty inputs', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    tools: [{ name: 'Glob', input_schema: { type: 'object', required: ['pattern'] } }],
    pendingToolCall: null,
  };

  processGeminiSseEvent(
    clientRes,
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Glob","args":{},"arguments":{"pattern":"**/*.js"}},"thoughtSignature":"sig-glob"}]}}]}\r\n',
    state,
    'gemini-3-flash-preview'
  );
  const { flushPendingGeminiToolCall } = require('../openai-proxy');
  flushPendingGeminiToolCall(clientRes, state, state.tools);
  const output = writes.join('');
  assert.ok(output.includes('"type":"tool_use"'));
  assert.ok(output.includes('**/*.js'));
  assert.ok(output.includes('"input":{}'));
  assert.ok(output.includes('"type":"input_json_delta"'));
});

test('Gemini SSE write guard rejects empty common tool inputs', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    tools: [{ name: 'Bash', input_schema: { type: 'object', required: ['command'] } }],
    pendingToolCall: null,
  };

  processGeminiSseEvent(
    clientRes,
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Bash","args":{}},"thoughtSignature":"sig-bash"}]}}]}\r\n',
    state,
    'gemini-3-flash-preview'
  );
  state.pendingToolCall.args = {};
  state.pendingToolCall.name = 'Bash';
  const { flushPendingGeminiToolCall } = require('../openai-proxy');
  flushPendingGeminiToolCall(clientRes, state, []);
  const output = writes.join('');
  assert.ok(output.includes('Please call the same tool again with complete arguments'));
  assert.ok(output.includes('command'));
  assert.ok(!output.includes('"type":"tool_use"'));
});

test('unified stream protection rewrites invalid tool_use blocks', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { buffer: '', pendingClaudeTool: null };

  processClaudeSseChunk(
    clientRes,
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    state
  );
  flushClaudeSseFilter(clientRes, state);
  const output = writes.join('');
  assert.ok(output.includes('Please call the same tool again with complete arguments'));
  assert.ok(output.includes('command'));
  assert.ok(!output.includes('"type":"tool_use"'));
});

test('unified stream protection preserves valid tool_use blocks', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { buffer: '', pendingClaudeTool: null };

  processClaudeSseChunk(
    clientRes,
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Glob","input":{}}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\":\\"**/*.js\\"}"}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    state
  );
  flushClaudeSseFilter(clientRes, state);
  const output = writes.join('');
  assert.ok(output.includes('"type":"tool_use"'));
  assert.ok(output.includes('"input":{}'));
  assert.ok(output.includes('"type":"input_json_delta"'));
  assert.ok(output.includes('**/*.js'));
  assert.ok(!output.includes('Please call the same tool again'));
});

test('unified stream protection drops DeepSeek thinking blocks and remaps tool indexes', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { buffer: '', pendingClaudeTool: null };

  processClaudeSseChunk(
    clientRes,
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"Read","input":{}}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"D:/x.js\\"}"}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    state
  );
  flushClaudeSseFilter(clientRes, state);

  const output = writes.join('');
  assert.ok(!output.includes('"type":"thinking"'));
  assert.ok(!output.includes('thinking_delta'));
  assert.ok(!output.includes('signature_delta'));
  assert.ok(output.includes('"type":"tool_use"'));
  assert.ok(output.includes('"index":0'));
  assert.ok(!output.includes('"index":1'));
  assert.ok(output.includes('D:/x.js'));
});

test('OpenAI stream sanitizer drops empty optional tool args only', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { buffer: '', pendingClaudeTool: null, mode: 'strip-empty-optionals' };

  processClaudeSseChunk(
    clientRes,
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"D:/x.js","pages":""}}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    state
  );
  flushClaudeSseFilter(clientRes, state);
  const output = writes.join('');
  assert.ok(output.includes('"type":"tool_use"'));
  assert.ok(output.includes('\\"file_path\\":\\"D:/x.js\\"'));
  assert.ok(!output.includes('"pages":""'));
  assert.ok(!output.includes('Please call the same tool again'));
});

test('OpenAI stream sanitizer drops empty optional tool args from deltas', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { buffer: '', pendingClaudeTool: null, mode: 'strip-empty-optionals' };

  processClaudeSseChunk(
    clientRes,
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"D:/x.js\\",\\"pages\\":\\"\\"}"}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    state
  );
  flushClaudeSseFilter(clientRes, state);
  const output = writes.join('');
  assert.ok(output.includes('"type":"input_json_delta"'));
  assert.ok(output.includes('\\"file_path\\":\\"D:/x.js\\"'));
  assert.ok(!output.includes('\\"pages\\":\\"\\"'));
  assert.ok(!output.includes('Please call the same tool again'));
});

test('OpenAI stream sanitizer buffers split optional args deltas', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { buffer: '', pendingClaudeTool: null, mode: 'strip-empty-optionals' };

  processClaudeSseChunk(
    clientRes,
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Glob","input":{}}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern"}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\":\\"**/*.js\\",\\"pages\\":\\"\\"}"}}\n\n',
    state
  );
  processClaudeSseChunk(
    clientRes,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    state
  );
  flushClaudeSseFilter(clientRes, state);
  const output = writes.join('');
  assert.ok(output.includes('\\"pattern\\":\\"**/*.js\\"'));
  assert.ok(!output.includes('\\"pages\\":\\"\\"'));
  assert.ok(!output.includes('Please call the same tool again'));
});

test('Gemini converted tool_use sends args as input_json_delta', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    tools: [{ name: 'Bash', input_schema: { type: 'object', required: ['command'] } }],
    pendingToolCall: null,
  };

  processGeminiSseEvent(
    clientRes,
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Bash","args":{"command":"ls -R","description":"List files"}},"thoughtSignature":"sig-bash"}]}}]}\r\n',
    state,
    'gemini-3-flash-preview'
  );
  const { flushPendingGeminiToolCall, geminiClaudeStopReason } = require('../openai-proxy');
  flushPendingGeminiToolCall(clientRes, state, state.tools);
  const output = writes.join('');
  assert.ok(output.includes('"type":"tool_use"'));
  assert.ok(output.includes('"input":{}'));
  assert.ok(output.includes('"type":"input_json_delta"'));
  assert.ok(output.includes('\\"command\\":\\"ls -R\\"'));
  assert.ok(!output.includes('Please call the same tool again'));
  assert.strictEqual(geminiClaudeStopReason(state), 'tool_use');
});

test('Gemini converted large tool args are split across input_json_delta chunks', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const content = 'x'.repeat(20000);
  const state = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    tools: [
      { name: 'Write', input_schema: { type: 'object', required: ['file_path', 'content'] } },
    ],
    pendingToolCall: null,
  };

  processGeminiSseEvent(
    clientRes,
    'data: ' +
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'Write',
                    args: { file_path: 'E:/tmp/large.txt', content },
                  },
                },
              ],
            },
          },
        ],
      }) +
      '\r\n',
    state,
    'gemini-3-flash-preview'
  );
  const { flushPendingGeminiToolCall } = require('../openai-proxy');
  flushPendingGeminiToolCall(clientRes, state, state.tools);

  const deltas = writes
    .join('')
    .split(/\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.replace(/^data:\s*/, '')))
    .filter(
      (event) =>
        event.type === 'content_block_delta' &&
        event.delta &&
        event.delta.type === 'input_json_delta'
    );
  assert.ok(deltas.length > 1);
  const parsed = JSON.parse(deltas.map((event) => event.delta.partial_json).join(''));
  assert.deepStrictEqual(parsed, { file_path: 'E:/tmp/large.txt', content });
});

(async () => {
  for (const item of tests) {
    try {
      await item.fn();
      console.log('ok - ' + item.name);
    } catch (err) {
      console.error('not ok - ' + item.name);
      console.error(err.stack || err.message);
      process.exitCode = 1;
    }
  }
  if (process.exitCode) process.exit(process.exitCode);
  console.log('[gemini-adapter.test] ok');
  process.exit(0);
})();
