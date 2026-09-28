const assert = require('assert');
const { EventEmitter } = require('events');
const {
  createChatToResponsesStreamFinalizer,
  createResponsesChatStreamHandler,
} = require('../lib/proxy/handlers/responses-chat-stream');

const {
  openAIResponsesToChat,
  openAIChatToResponses,
  openAIChatToResponsesRequest,
  openAIResponsesToChatResponse,
  openAIChatToClaudeMessages,
  openAIResponseToClaudeMessage,
  geminiResponseToClaude,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  processOpenAIResponsesSseChunkToChat,
  flushOpenAIResponsesSseToChat,
  flushOpenAISseToClaude,
  processClaudeSseChunkToOpenAI,
  flushClaudeSseToOpenAI,
  shouldConvertResponsesToOpenAIChat,
} = require('../openai-proxy');

function createResponsesStreamState(overrides = {}) {
  return {
    id: 'resp_test',
    created_at: 1,
    model: 'client-model',
    buffer: '',
    started: false,
    outputIndex: 0,
    messageId: null,
    textItemStarted: false,
    textItemDone: false,
    text: '',
    pendingToolCalls: [],
    toolCalls: [],
    completedOutputItems: [],
    usage: undefined,
    done: false,
    ...overrides,
  };
}

function event(payload) {
  return 'data: ' + JSON.stringify(payload) + '\n\n';
}

function createChatStreamState(overrides = {}) {
  return {
    id: 'chatcmpl_test',
    created: 1,
    model: 'client-model',
    buffer: '',
    started: false,
    toolCalls: [],
    usage: null,
    done: false,
    ...overrides,
  };
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createResponsesStreamState({ id: 'chatcmpl_before_created' });
  processOpenAIResponsesSseChunkToChat(
    clientRes,
    event({
      type: 'response.created',
      response: { id: 'resp_created', created_at: 123, status: 'in_progress' },
    }),
    state
  );
  processOpenAIResponsesSseChunkToChat(
    clientRes,
    event({ type: 'response.in_progress', response: { id: 'resp_created' } }),
    state
  );
  const output = writes.join('');
  assert.ok(output.includes('"role":"assistant"'));
  assert.strictEqual(
    (output.match(/"role":"assistant"/g) || []).length,
    1,
    'metadata events must emit exactly one early role chunk'
  );
  assert.strictEqual(state.id, 'chatcmpl_created');
  assert.strictEqual(state.created, 123);
}

{
  const result = openAIResponsesToChat({
    model: 'client-model',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'lookup' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '42' },
    ],
    tools: [
      {
        type: 'function',
        name: 'lookup',
        description: 'Lookup data',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        strict: true,
      },
    ],
    tool_choice: { type: 'function', name: 'lookup' },
    parallel_tool_calls: false,
    seed: 123,
    user: 'user-1',
    service_tier: 'priority',
    frequency_penalty: 0.1,
    presence_penalty: 0.2,
    text: {
      format: {
        type: 'json_schema',
        name: 'LookupResult',
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
        strict: true,
      },
    },
    reasoning: { effort: 'medium' },
  });

  assert.deepStrictEqual(result.messages[0].content, [{ type: 'text', text: 'lookup' }]);
  assert.strictEqual(result.messages[1].role, 'assistant');
  assert.strictEqual(result.messages[1].tool_calls[0].id, 'call_1');
  assert.strictEqual(result.messages[1].tool_calls[0].function.name, 'lookup');
  assert.strictEqual(result.messages[1].tool_calls[0].function.arguments, '{"q":"x"}');
  assert.deepStrictEqual(result.messages[2], {
    role: 'tool',
    tool_call_id: 'call_1',
    content: '42',
  });
  assert.deepStrictEqual(result.tool_choice, { type: 'function', function: { name: 'lookup' } });
  assert.strictEqual(result.tools[0].function.strict, true);
  assert.strictEqual(result.parallel_tool_calls, false);
  assert.strictEqual(result.seed, 123);
  assert.strictEqual(result.user, 'user-1');
  assert.strictEqual(result.service_tier, 'priority');
  assert.strictEqual(result.frequency_penalty, 0.1);
  assert.strictEqual(result.presence_penalty, 0.2);
  assert.strictEqual(result.reasoning_effort, 'medium');
  assert.deepStrictEqual(result.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'LookupResult',
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
      strict: true,
    },
  });
}

{
  const result = openAIResponsesToChat({
    model: 'client-model',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe' },
          { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
        ],
      },
    ],
    text: { format: { type: 'json_object' } },
  });

  assert.deepStrictEqual(result.messages[0].content, [
    { type: 'text', text: 'describe' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  ]);
  assert.deepStrictEqual(result.response_format, { type: 'json_object' });
}

{
  const result = openAIResponsesToChat({
    model: 'client-model',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/image.png' }],
      },
    ],
  });

  assert.deepStrictEqual(result.messages[0].content, [
    { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
  ]);
}

{
  const result = openAIResponsesToChat({
    model: 'client-model',
    input: 'latest market news',
    tools: [{ type: 'web_search_preview' }],
  });

  assert.strictEqual(result.__nativeWebSearch, 'gemini-google-search');
  assert.strictEqual(result.tools, undefined);
}

{
  const result = openAIResponsesToChat({
    model: 'client-model',
    input: 'latest market news',
    tools: [
      {
        type: 'function',
        name: 'web_search',
        description: 'Search web',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
  });

  assert.strictEqual(result.__nativeWebSearch, 'gemini-google-search');
  assert.strictEqual(result.tools, undefined);
}

{
  // Test that namespace tools are unwrapped/cleaned up when converting Responses to Chat
  const result = openAIResponsesToChat({
    model: 'client-model',
    input: 'hello',
    tools: [
      {
        type: 'namespace',
        name: 'chat',
      },
      {
        type: 'namespace',
        name: 'custom',
        tools: [
          {
            type: 'function',
            name: 'calculate',
            description: 'do math',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
    ],
  });

  assert.strictEqual(result.tools.length, 1);
  assert.strictEqual(result.tools[0].type, 'function');
  assert.strictEqual(result.tools[0].function.name, 'calculate');
  assert.strictEqual(result.tools[0].function.description, 'do math');
}

{
  const result = openAIChatToResponsesRequest({
    model: 'client-model',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
        ],
      },
    ],
  });

  assert.deepStrictEqual(result.input[0].content, [
    { type: 'input_text', text: 'describe' },
    { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
  ]);
}

{
  const result = openAIChatToResponsesRequest({
    model: 'client-model',
    messages: [
      { role: 'user', content: 'lookup' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_nbeAei9W3PPIiz5JVyTrNrfb',
            type: 'function',
            function: { name: 'builtin_web_search', arguments: '{"q":"x"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_nbeAei9W3PPIiz5JVyTrNrfb', content: 'blocked' },
    ],
  });

  const functionCall = result.input.find((item) => item.type === 'function_call');
  const functionOutput = result.input.find((item) => item.type === 'function_call_output');
  assert.ok(functionCall.id.startsWith('fc_'));
  assert.notStrictEqual(functionCall.id, 'call_nbeAei9W3PPIiz5JVyTrNrfb');
  assert.strictEqual(functionCall.call_id, 'call_nbeAei9W3PPIiz5JVyTrNrfb');
  assert.strictEqual(functionOutput.call_id, 'call_nbeAei9W3PPIiz5JVyTrNrfb');
}

{
  const result = openAIChatToResponses(
    {
      id: 'chatcmpl_123',
      created: 123456,
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'answer',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"x"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    'client-model'
  );

  assert.strictEqual(result.id, 'resp_123');
  assert.strictEqual(result.object, 'response');
  assert.strictEqual(result.output[0].type, 'message');
  assert.strictEqual(result.output[0].content[0].text, 'answer');
  assert.strictEqual(result.output[1].type, 'function_call');
  assert.ok(result.output[1].id.startsWith('fc_'));
  assert.strictEqual(result.output[1].call_id, 'call_1');
  assert.strictEqual(result.output[1].name, 'lookup');
  assert.deepStrictEqual(result.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
}

{
  const result = openAIChatToResponses(
    {
      id: 'chatcmpl_length',
      created: 123457,
      choices: [
        {
          message: { role: 'assistant', content: null },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    },
    'gemini-3.8-flash'
  );

  assert.strictEqual(result.status, 'incomplete');
  assert.deepStrictEqual(result.incomplete_details, { reason: 'max_output_tokens' });
  assert.deepStrictEqual(result.output, []);
  assert.deepStrictEqual(result.usage, { input_tokens: 5, output_tokens: 0, total_tokens: 5 });
}

{
  const result = openAIChatToResponses(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_exec',
                type: 'function',
                function: { name: 'exec', arguments: '{"input":"return 1;"}' },
              },
            ],
          },
        },
      ],
    },
    'gemini-3.8-flash',
    {
      responsesRequest: {
        tools: [{ type: 'custom', name: 'exec', description: 'Run code' }],
      },
    }
  );

  assert.strictEqual(result.output.length, 1);
  assert.strictEqual(result.output[0].type, 'custom_tool_call');
  assert.strictEqual(result.output[0].call_id, 'call_exec');
  assert.strictEqual(result.output[0].name, 'exec');
  assert.strictEqual(result.output[0].input, 'return 1;');
}

{
  const responsesRequest = {
    input: [
      {
        type: 'additional_tools',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [{ type: 'custom', name: 'exec', description: 'Run code' }],
          },
        ],
      },
    ],
  };
  const result = openAIChatToResponses(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_exec_workbuddy',
                type: 'function',
                function: { name: 'exec', arguments: '{"input":"return 2;"}' },
              },
            ],
          },
        },
      ],
    },
    'workbuddy/deepseek-v4.1-flash',
    { responsesRequest }
  );

  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'workbuddy' }), true);
  assert.strictEqual(result.output.length, 1);
  assert.strictEqual(result.output[0].type, 'custom_tool_call');
  assert.strictEqual(result.output[0].call_id, 'call_exec_workbuddy');
  assert.strictEqual(result.output[0].name, 'exec');
  assert.strictEqual(result.output[0].input, 'return 2;');
}

{
  const result = openAIResponsesToChatResponse(
    {
      id: 'resp_custom',
      status: 'completed',
      output: [
        {
          type: 'custom_tool_call',
          id: 'ctc_1',
          call_id: 'call_exec',
          name: 'exec',
          input: 'return 1;',
        },
      ],
    },
    'gemini-3.8-flash'
  );
  const message = result.choices[0].message;
  assert.strictEqual(result.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(message.content, null);
  assert.strictEqual(message.tool_calls[0].id, 'call_exec');
  assert.strictEqual(message.tool_calls[0].function.name, 'exec');
  assert.strictEqual(message.tool_calls[0].function.arguments, '{"input":"return 1;"}');
}

{
  const result = openAIResponsesToChatResponse(
    {
      output: [
        {
          type: 'custom_tool_call',
          name: 'exec',
          input: 'return 2;',
        },
      ],
    },
    'gemini-3.8-flash'
  );
  const toolCall = result.choices[0].message.tool_calls[0];
  assert.ok(toolCall.id);
  assert.strictEqual(toolCall.function.name, 'exec');
  assert.strictEqual(toolCall.function.arguments, '{"input":"return 2;"}');
}

{
  const result = openAIResponsesToChatResponse(
    {
      output: [
        {
          type: 'custom_tool_call',
          name: 'exec',
          input: { language: 'js', code: 'return 3;' },
        },
      ],
    },
    'gemini-3.8-flash'
  );
  assert.strictEqual(
    result.choices[0].message.tool_calls[0].function.arguments,
    '{"language":"js","code":"return 3;"}'
  );
}

{
  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'openai-chat' }), true);
  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'workbuddy' }), true);
  assert.strictEqual(
    shouldConvertResponsesToOpenAIChat({ protocol: 'openai', supportsResponses: false }),
    true
  );
  assert.strictEqual(
    shouldConvertResponsesToOpenAIChat({ protocol: 'openai', responsesMode: 'chat' }),
    true
  );
  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'openai-responses' }), false);
  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'openai' }), false);
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = createResponsesStreamState();

  processOpenAIChatSseChunkToResponses(
    clientRes,
    event({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    state
  );
  processOpenAIChatSseChunkToResponses(
    clientRes,
    event({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"q"' } }] },
          finish_reason: null,
        },
      ],
    }),
    state
  );
  processOpenAIChatSseChunkToResponses(
    clientRes,
    event({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] },
          finish_reason: null,
        },
      ],
    }),
    state
  );
  processOpenAIChatSseChunkToResponses(
    clientRes,
    event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    state
  );

  assert.strictEqual(state.toolCalls.length, 1);
  assert.strictEqual(state.toolCalls[0].name, 'lookup');
  assert.strictEqual(state.toolCalls[0].arguments, '{"q":"x"}');
  assert.deepStrictEqual(
    state.completedOutputItems.map((item) => item.type),
    ['function_call']
  );
  assert.ok(writes.join('').includes('response.function_call_arguments.done'));
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createResponsesStreamState({ customToolNames: new Set(['exec']) });

  processOpenAIChatSseChunkToResponses(
    clientRes,
    event({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_exec',
                type: 'function',
                function: { name: 'exec', arguments: '{"input":"return 1;"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    state
  );

  assert.strictEqual(state.completedOutputItems.length, 1);
  assert.strictEqual(state.completedOutputItems[0].type, 'custom_tool_call');
  assert.strictEqual(state.completedOutputItems[0].call_id, 'call_exec');
  assert.strictEqual(state.completedOutputItems[0].name, 'exec');
  assert.strictEqual(state.completedOutputItems[0].input, 'return 1;');
  const text = writes.join('');
  assert.ok(text.includes('"type":"custom_tool_call"'));
  assert.ok(!text.includes('response.function_call_arguments.delta'));
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createChatStreamState();
  const responseEvent = (payload) =>
    'event: ' + payload.type + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  const args = JSON.stringify({
    file_path: 'E:/DEV/WorkSpace/Efficiency/package.json',
    offset: 0,
    limit: 2400,
  });

  processOpenAIResponsesSseChunkToChat(
    clientRes,
    responseEvent({
      type: 'response.function_call_arguments.delta',
      item_id: 'call_1',
      delta: args,
    }),
    state
  );
  assert.strictEqual(
    writes.some((chunk) => chunk.includes('tool_calls')),
    false
  );

  processOpenAIResponsesSseChunkToChat(
    clientRes,
    responseEvent({
      type: 'response.output_item.done',
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: args },
    }),
    state
  );

  const output = writes.join('');
  assert.ok(output.includes('"name":"Read"'));
  assert.strictEqual(output.includes('"name":"tool"'), false);
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createChatStreamState();
  const responseEvent = (payload) =>
    'event: ' + payload.type + '\ndata: ' + JSON.stringify(payload) + '\n\n';

  processOpenAIResponsesSseChunkToChat(
    clientRes,
    responseEvent({
      type: 'response.output_item.added',
      output_index: 2,
      item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'lookup' },
    }),
    state
  );
  processOpenAIResponsesSseChunkToChat(
    clientRes,
    responseEvent({
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      delta: '{"q"',
    }),
    state
  );
  processOpenAIResponsesSseChunkToChat(
    clientRes,
    responseEvent({
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      delta: ':"x"}',
    }),
    state
  );
  processOpenAIResponsesSseChunkToChat(
    clientRes,
    responseEvent({
      type: 'response.output_item.done',
      output_index: 2,
      item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'lookup' },
    }),
    state
  );

  const output = writes.join('');
  assert.ok(output.includes('"name":"lookup"'));
  assert.ok(output.includes('"{\\"q\\":\\"x\\"}"'));
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createChatStreamState();
  const responseEvent = (payload) =>
    'event: ' + payload.type + '\ndata: ' + JSON.stringify(payload) + '\n\n';

  processOpenAIResponsesSseChunkToChat(
    clientRes,
    responseEvent({
      type: 'response.output_item.done',
      item: {
        type: 'custom_tool_call',
        id: 'ctc_1',
        call_id: 'call_exec',
        name: 'exec',
        input: 'return 1;',
      },
    }),
    state
  );

  const output = writes.join('');
  assert.ok(output.includes('"tool_calls"'));
  assert.ok(output.includes('"name":"exec"'));
  assert.ok(output.includes('"{\\"input\\":\\"return 1;\\"}"'));
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createChatStreamState();
  const responseEvent = (payload) =>
    'event: ' + payload.type + '\ndata: ' + JSON.stringify(payload) + '\n\n';

  processOpenAIResponsesSseChunkToChat(
    clientRes,
    responseEvent({
      type: 'response.output_item.done',
      item: {
        type: 'custom_tool_call',
        name: 'exec',
        input: { language: 'js', code: 'return 4;' },
      },
    }),
    state
  );

  assert.ok(writes.join('').includes('"{\\"language\\":\\"js\\",\\"code\\":\\"return 4;\\"}"'));
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createChatStreamState();

  processOpenAIResponsesSseChunkToChat(
    clientRes,
    event({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: {
          code: 'context length exceeded\r\nunsafe',
          type: 'invalid request error',
          message: 'Context limit exceeded\r\n' + 'x'.repeat(600),
        },
      },
    }),
    state
  );
  const outcome = flushOpenAIResponsesSseToChat(clientRes, state);
  const output = writes.join('');

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.failed, true);
  assert.strictEqual(outcome.terminalType, 'response.failed');
  assert.strictEqual(outcome.failure.code, 'context_length_exceeded__unsafe');
  assert.strictEqual(outcome.failure.type, 'invalid_request_error');
  assert.ok(outcome.failure.message.length <= 512);
  assert.strictEqual(/[\r\n]/.test(outcome.failure.message), false);
  assert.ok(output.includes('"error"'));
  assert.strictEqual(output.includes('data: [DONE]'), false);
  assert.strictEqual(output.includes('"finish_reason":"stop"'), false);
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createChatStreamState();

  processOpenAIResponsesSseChunkToChat(
    clientRes,
    event({
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 120, output_tokens: 8, total_tokens: 128 },
      },
    }),
    state
  );
  const outcome = flushOpenAIResponsesSseToChat(clientRes, state);
  const output = writes.join('');

  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.incomplete, true);
  assert.strictEqual(outcome.terminalType, 'response.incomplete');
  assert.ok(output.includes('"finish_reason":"length"'));
  assert.ok(output.includes('"completion_tokens":8'));
  assert.ok(output.includes('data: [DONE]'));
  assert.strictEqual(output.includes('"error"'), false);
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createChatStreamState({ started: true });
  const outcome = flushOpenAIResponsesSseToChat(clientRes, state);
  const output = writes.join('');

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.failure.code, 'upstream_stream_incomplete');
  assert.ok(output.includes('upstream_stream_incomplete'));
  assert.strictEqual(output.includes('data: [DONE]'), false);
  assert.strictEqual(output.includes('"finish_reason":"stop"'), false);
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createChatStreamState({ buffer: 'data: {not-json}\n\n' });
  const outcome = flushOpenAIResponsesSseToChat(clientRes, state);

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.failure.code, 'upstream_stream_invalid_event');
  assert.ok(writes.join('').includes('upstream_stream_invalid_event'));
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createChatStreamState();

  processOpenAIResponsesSseChunkToChat(
    clientRes,
    event({
      type: 'error',
      code: 'rate_limit_exceeded',
      message: 'Request rate limit exceeded',
    }),
    state
  );
  const firstOutput = writes.join('');
  const outcome = flushOpenAIResponsesSseToChat(clientRes, state);

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.failure.code, 'rate_limit_exceeded');
  assert.ok(firstOutput.includes('Request rate limit exceeded'));
  assert.strictEqual(writes.join(''), firstOutput, 'terminal errors must be emitted once');
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createChatStreamState({ buffer: 'data: [DONE]' });
  const outcome = flushOpenAIResponsesSseToChat(clientRes, state);

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.failure.code, 'upstream_stream_incomplete');
  assert.strictEqual(writes.join('').includes('data: [DONE]'), false);
}

{
  assert.throws(
    () => createChatToResponsesStreamFinalizer(),
    /requires clientRes/,
    'stream finalizer validates required boundaries'
  );
  const requestEnds = [];
  let endCalls = 0;
  const failureOptions = { code: 'upstream_stream_aborted' };
  const finalize = createChatToResponsesStreamFinalizer({
    clientRes: { end: () => endCalls++ },
    state: {},
    flushOpenAIResponsesSseToChat(_clientRes, _state, options) {
      assert.strictEqual(options, failureOptions);
      return {
        failed: true,
        incomplete: false,
        terminalType: 'upstream_stream_aborted',
        failure: { code: 'upstream_stream_aborted' },
      };
    },
    logRequestEnd(method, path, startTime, statusCode, extra) {
      requestEnds.push({ method, path, startTime, statusCode, extra });
    },
    method: 'POST',
    upstreamPath: '/responses',
    startTime: 10,
  });

  assert.strictEqual(finalize(failureOptions), true);
  assert.strictEqual(finalize(failureOptions), false, 'stream finalization must be idempotent');
  assert.strictEqual(endCalls, 1);
  assert.strictEqual(requestEnds.length, 1);
  assert.strictEqual(requestEnds[0].statusCode, 502);
  assert.strictEqual(requestEnds[0].extra.type, 'chat_to_responses_stream_error');
  assert.strictEqual(requestEnds[0].extra.errorCode, 'upstream_stream_aborted');
}

{
  const requestEnds = [];
  const finalize = createChatToResponsesStreamFinalizer({
    clientRes: { end() {} },
    state: {},
    flushOpenAIResponsesSseToChat() {
      return {
        failed: false,
        incomplete: true,
        terminalType: 'response.incomplete',
        failure: null,
      };
    },
    logRequestEnd(_method, _path, _startTime, statusCode, extra) {
      requestEnds.push({ statusCode, extra });
    },
    method: 'POST',
    upstreamPath: '/responses',
    startTime: 10,
  });

  finalize();
  assert.strictEqual(requestEnds[0].statusCode, 200);
  assert.strictEqual(requestEnds[0].extra.type, 'chat_to_responses_stream_incomplete');
  assert.strictEqual(requestEnds[0].extra.errorCode, undefined);
}

{
  const requestEnds = [];
  let endCalls = 0;
  const finalize = createChatToResponsesStreamFinalizer({
    clientRes: { end: () => endCalls++ },
    state: {},
    flushOpenAIResponsesSseToChat() {
      throw new Error('sensitive upstream detail');
    },
    logRequestEnd(_method, _path, _startTime, statusCode, extra) {
      requestEnds.push({ statusCode, extra });
    },
    method: 'POST',
    upstreamPath: '/responses',
    startTime: 10,
  });

  assert.doesNotThrow(() => finalize());
  assert.strictEqual(endCalls, 1);
  assert.deepStrictEqual(requestEnds, [
    {
      statusCode: 502,
      extra: {
        type: 'chat_to_responses_stream_error',
        upstreamEvent: 'stream_finalization_error',
        errorCode: 'stream_finalization_error',
      },
    },
  ]);
}

{
  const writes = [];
  const requestEnds = [];
  const proxyRes = new EventEmitter();
  proxyRes.complete = true;
  const clientRes = {
    headers: null,
    statusCode: 0,
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
    },
  };
  const handleStream = createResponsesChatStreamHandler({
    CORS_HEADERS: { 'access-control-allow-origin': '*' },
    fallbackId: () => 'chatcmpl_route_test',
    stableCreated: () => 10,
    processOpenAIResponsesSseChunkToChat,
    flushOpenAIResponsesSseToChat,
    logRequestEnd(method, path, startTime, statusCode, extra) {
      requestEnds.push({ method, path, startTime, statusCode, extra });
    },
  });

  handleStream({
    clientReq: { method: 'POST' },
    clientRes,
    parsed: { model: 'client-model', messages: [], stream: true },
    proxyRes,
    startTime: 5,
    targetModel: 'target-model',
    upstreamPath: '/responses',
  });
  proxyRes.emit(
    'data',
    Buffer.from(
      event({
        type: 'response.failed',
        response: { error: { code: 'model_error', message: 'Generation failed' } },
      })
    )
  );
  proxyRes.emit('end');

  assert.strictEqual(clientRes.statusCode, 200, 'SSE headers are committed before terminal events');
  assert.strictEqual(clientRes.headers['access-control-allow-origin'], '*');
  assert.strictEqual(clientRes.ended, true);
  assert.ok(writes.join('').includes('model_error'));
  assert.strictEqual(requestEnds.length, 1);
  assert.strictEqual(requestEnds[0].statusCode, 502);
  assert.strictEqual(requestEnds[0].extra.type, 'chat_to_responses_stream_error');
  assert.strictEqual(requestEnds[0].extra.errorCode, 'model_error');
}

{
  const writes = [];
  const requestEnds = [];
  const proxyRes = new EventEmitter();
  proxyRes.complete = false;
  const clientRes = {
    writeHead() {},
    write: (chunk) => writes.push(String(chunk)),
    end() {},
  };
  const handleStream = createResponsesChatStreamHandler({
    fallbackId: () => 'chatcmpl_closed',
    stableCreated: () => 10,
    processOpenAIResponsesSseChunkToChat,
    flushOpenAIResponsesSseToChat,
    logRequestEnd(_method, _path, _startTime, statusCode, extra) {
      requestEnds.push({ statusCode, extra });
    },
  });

  handleStream({
    clientReq: { method: 'POST' },
    clientRes,
    parsed: { model: 'client-model', messages: [] },
    proxyRes,
    startTime: 5,
    targetModel: 'target-model',
    upstreamPath: '/responses',
  });
  proxyRes.emit('close');

  assert.ok(writes.join('').includes('upstream_stream_closed'));
  assert.strictEqual(requestEnds[0].statusCode, 502);
  assert.strictEqual(requestEnds[0].extra.errorCode, 'upstream_stream_closed');
}

{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = createResponsesStreamState({ id: 'resp_order' });

  processOpenAIChatSseChunkToResponses(
    clientRes,
    event({ choices: [{ delta: { content: 'before' }, finish_reason: null }] }),
    state
  );
  processOpenAIChatSseChunkToResponses(
    clientRes,
    event({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"x"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    state
  );
  processOpenAIChatSseChunkToResponses(
    clientRes,
    event({ choices: [{ delta: { content: 'after' }, finish_reason: null }] }),
    state
  );
  flushOpenAIChatSseToResponses(clientRes, state);

  assert.deepStrictEqual(
    state.completedOutputItems.map((item) => item.type),
    ['message', 'function_call', 'message']
  );
  assert.strictEqual(state.completedOutputItems[0].content[0].text, 'before');
  assert.strictEqual(state.completedOutputItems[2].content[0].text, 'after');
}

{
  const result = openAIResponsesToChat({
    model: 'deepseek-v4.1-flash',
    input: [
      {
        type: 'additional_tools',
        tools: [
          {
            type: 'function',
            name: 'dynamic_tool_1',
            description: 'A dynamically injected tool',
            parameters: { type: 'object', properties: { p: { type: 'string' } } },
          },
        ],
      },
      { role: 'user', content: 'hello with dynamic tools' },
    ],
    tools: [
      {
        type: 'function',
        name: 'static_tool',
        description: 'A static tool',
        parameters: { type: 'object', properties: {} },
      },
    ],
  });

  // 1. additional_tools must not pollute chat messages
  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.messages[0].role, 'user');
  assert.strictEqual(result.messages[0].content, 'hello with dynamic tools');

  // 2. additional_tools must be merged into result.tools alongside static tools
  assert.strictEqual(result.tools.length, 2);
  const toolNames = result.tools.map((t) => t.function.name);
  assert.ok(toolNames.includes('static_tool'));
  assert.ok(toolNames.includes('dynamic_tool_1'));
  const dynamicTool = result.tools.find((t) => t.function.name === 'dynamic_tool_1');
  assert.strictEqual(dynamicTool.function.description, 'A dynamically injected tool');
}

{
  const result = openAIResponsesToChat({
    model: 'deepseek-v4.1-flash',
    input: [
      {
        type: 'additional_tools',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            description: '',
            tools: [
              {
                type: 'custom',
                name: 'exec',
                description: 'Run JavaScript code to orchestrate tool calls',
              },
              {
                type: 'function',
                name: 'mcp__cua_repl',
                description: 'Computer use repl tool',
                parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
              },
            ],
          },
        ],
      },
      { role: 'user', content: 'run something' },
    ],
  });

  assert.strictEqual(result.tools.length, 2);
  const names = result.tools.map((t) => t.function.name);
  assert.ok(names.includes('exec'), 'exec tool should be preserved and extracted from namespace');
  assert.ok(names.includes('mcp__cua_repl'), 'mcp__cua_repl should be extracted from namespace');
  const execTool = result.tools.find((t) => t.function.name === 'exec');
  assert.strictEqual(execTool.type, 'function');
  assert.ok(execTool.function.parameters);
  assert.strictEqual(execTool.function.parameters.type, 'object');
  assert.ok(execTool.function.parameters.properties.input);
}

{
  const result = openAIResponsesToChat({
    model: 'gemini-3.8-flash',
    input: [
      {
        type: 'custom_tool_call',
        call_id: 'call_exec',
        name: 'exec',
        input: 'return 1;',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_exec',
        output: '1',
      },
    ],
  });

  assert.strictEqual(result.messages.length, 2);
  assert.strictEqual(result.messages[0].role, 'assistant');
  assert.strictEqual(result.messages[0].tool_calls[0].id, 'call_exec');
  assert.strictEqual(result.messages[0].tool_calls[0].function.name, 'exec');
  assert.strictEqual(result.messages[0].tool_calls[0].function.arguments, '{"input":"return 1;"}');
  assert.strictEqual(result.messages[1].role, 'tool');
  assert.strictEqual(result.messages[1].tool_call_id, 'call_exec');
  assert.strictEqual(result.messages[1].content, '1');
}

{
  const result = openAIResponsesToChat({
    model: 'gemini-3.8-flash',
    input: [
      {
        type: 'custom_tool_call',
        call_id: 'call_exec_object',
        name: 'exec',
        input: { language: 'js', code: 'return 5;' },
      },
    ],
  });

  assert.strictEqual(
    result.messages[0].tool_calls[0].function.arguments,
    '{"language":"js","code":"return 5;"}'
  );
}

{
  // Test non-streaming reasoning_content mapping
  const res = openAIChatToResponses(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            reasoning_content: 'Let me analyze the problem deeply...',
            content: 'Here is the answer.',
          },
        },
      ],
    },
    'deepseek-v4.1-flash'
  );

  assert.strictEqual(res.output.length, 2);
  assert.strictEqual(res.output[0].type, 'reasoning');
  assert.strictEqual(res.output[0].summary, 'Let me analyze the problem deeply...');
  assert.strictEqual(res.output[1].type, 'message');
  assert.strictEqual(res.output[1].content[0].text, 'Here is the answer.');
}

{
  // Test streaming reasoning_content SSE conversion
  const events = [];
  const clientRes = {
    writeHead() {},
    write(str) {
      events.push(str);
    },
  };
  const state = createResponsesStreamState({ model: 'deepseek-v4.1-flash' }, 'deepseek-v4.1-flash');

  processOpenAIChatSseChunkToResponses(
    clientRes,
    'data: {"choices":[{"delta":{"reasoning_content":"step 1 "}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"step 2"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"final "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"output"}}]}\n\n' +
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    state
  );
  flushOpenAIChatSseToResponses(clientRes, state);

  // Check reasoning deltas emitted
  const reasoningDeltas = events.filter(
    (e) => e.startsWith('data:') && e.includes('response.reasoning.delta')
  );
  assert.strictEqual(reasoningDeltas.length, 2);
  assert.ok(reasoningDeltas[0].includes('step 1 '));
  assert.ok(reasoningDeltas[1].includes('step 2'));

  // Check output text deltas emitted
  const textDeltas = events.filter(
    (e) => e.startsWith('data:') && e.includes('response.output_text.delta')
  );
  assert.strictEqual(textDeltas.length, 2);
  assert.ok(textDeltas[0].includes('final '));
  assert.ok(textDeltas[1].includes('output'));

  // Check completed items
  assert.strictEqual(state.completedOutputItems.length, 2);
  assert.strictEqual(state.completedOutputItems[0].type, 'reasoning');
  assert.strictEqual(state.completedOutputItems[0].summary, 'step 1 step 2');
  assert.strictEqual(state.completedOutputItems[1].type, 'message');
  assert.strictEqual(state.completedOutputItems[1].content[0].text, 'final output');
}

// ==================== Audit Tests: 10 Protocol Conversion Fixes ====================

// Test 1: Developer role preservation across protocols
{
  // 1a: Responses -> Chat keeps role: developer
  const chat = openAIResponsesToChat({
    model: 'gpt-4o',
    input: [
      { role: 'developer', content: 'You are an expert coder.' },
      { role: 'user', content: 'Hello' },
    ],
  });
  assert.strictEqual(chat.messages.length, 2);
  assert.strictEqual(chat.messages[0].role, 'developer');
  assert.strictEqual(chat.messages[0].content, 'You are an expert coder.');

  // 1b: Chat -> Responses merges developer role into instructions
  const resp = openAIChatToResponsesRequest({
    model: 'gpt-4o',
    messages: [
      { role: 'developer', content: 'Developer guidelines.' },
      { role: 'user', content: 'Hello' },
    ],
  });
  assert.ok(resp.instructions.includes('Developer guidelines.'));
  assert.strictEqual(resp.input.length, 1);
  assert.strictEqual(resp.input[0].role, 'user');

  // 1c: Chat -> Claude merges developer role into system parameter
  const claude = openAIChatToClaudeMessages(
    {
      messages: [
        { role: 'developer', content: 'Developer prompt.' },
        { role: 'user', content: 'Hello' },
      ],
    },
    'claude-3-7-sonnet'
  );
  assert.strictEqual(claude.system, 'Developer prompt.');
  assert.strictEqual(claude.messages.length, 1);
  assert.strictEqual(claude.messages[0].role, 'user');
}

// Test 2: Remote HTTP/HTTPS image URLs in Responses -> Chat
{
  const chat = openAIResponsesToChat({
    model: 'gpt-4o',
    input: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this image' },
          {
            type: 'input_image',
            image_url: { url: 'https://example.com/cat.jpg', detail: 'high' },
          },
          {
            type: 'image_url',
            image_url: 'https://example.com/dog.png',
          },
        ],
      },
    ],
  });
  assert.strictEqual(chat.messages.length, 1);
  const parts = chat.messages[0].content;
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[1].type, 'image_url');
  assert.strictEqual(parts[1].image_url.url, 'https://example.com/cat.jpg');
  assert.strictEqual(parts[1].image_url.detail, 'high');
  assert.strictEqual(parts[2].type, 'image_url');
  assert.strictEqual(parts[2].image_url.url, 'https://example.com/dog.png');
}

// Test 3: Tool is_error / status: 'error' preservation
{
  // Responses -> Chat: error status is preserved
  const chatFromResp = openAIResponsesToChat({
    model: 'gpt-4o',
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'Command failed: file not found',
        status: 'error',
      },
    ],
  });
  assert.strictEqual(chatFromResp.messages.length, 1);
  assert.strictEqual(chatFromResp.messages[0].role, 'tool');
  assert.strictEqual(chatFromResp.messages[0].is_error, true);

  // Chat -> Claude: is_error is preserved on tool_result
  const claudeMsg = openAIChatToClaudeMessages(
    {
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_123',
          content: 'File not found',
          is_error: true,
        },
      ],
    },
    'claude-3-7-sonnet'
  );
  assert.strictEqual(claudeMsg.messages.length, 1);
  assert.strictEqual(claudeMsg.messages[0].content[0].type, 'tool_result');
  assert.strictEqual(claudeMsg.messages[0].content[0].is_error, true);

  // Chat -> Responses: is_error is preserved as status: 'error'
  const respFromChat = openAIChatToResponsesRequest({
    model: 'gpt-4o',
    messages: [
      {
        role: 'tool',
        tool_call_id: 'call_123',
        content: 'File not found',
        is_error: true,
      },
    ],
  });
  assert.strictEqual(respFromChat.input[0].type, 'function_call_output');
  assert.strictEqual(respFromChat.input[0].status, 'error');
}

// Test 4: Merging adjacent assistant messages retains reasoning_content
{
  const chat = openAIResponsesToChat({
    model: 'gpt-4o',
    input: [
      { type: 'reasoning', text: 'Step 1: thinking' },
      { role: 'assistant', content: 'Here is the result.' },
    ],
  });
  assert.strictEqual(chat.messages.length, 1);
  assert.strictEqual(chat.messages[0].role, 'assistant');
  assert.strictEqual(chat.messages[0].content, 'Here is the result.');
  assert.strictEqual(chat.messages[0].reasoning_content, 'Step 1: thinking');
}

// Test 5: max_completion_tokens for reasoning models (o1, o3, gpt-5)
{
  const chatO1 = openAIResponsesToChat({
    model: 'o1-preview',
    max_output_tokens: 16000,
    input: 'hello',
  });
  assert.strictEqual(chatO1.max_completion_tokens, 16000);
  assert.strictEqual(chatO1.max_tokens, undefined);

  const chatGpt5 = openAIResponsesToChat({
    model: 'gpt-5-preview',
    max_output_tokens: 8000,
    input: 'hello',
  });
  assert.strictEqual(chatGpt5.max_completion_tokens, 8000);
  assert.strictEqual(chatGpt5.max_tokens, undefined);

  const chatGpt4o = openAIResponsesToChat({
    model: 'gpt-4o',
    max_output_tokens: 4000,
    input: 'hello',
  });
  assert.strictEqual(chatGpt4o.max_tokens, 4000);
}

// Test 6: json_schema response_format wrapper normalization
{
  const chat = openAIResponsesToChat({
    model: 'gpt-4o',
    input: 'Give JSON',
    response_format: {
      type: 'json_schema',
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
    },
  });
  assert.strictEqual(chat.response_format.type, 'json_schema');
  assert.ok(chat.response_format.json_schema);
  assert.strictEqual(chat.response_format.json_schema.schema.type, 'object');
}

// Test 7: Responses -> Chat SSE streaming reasoning delta
{
  const events = [];
  const clientRes = {
    write(str) {
      events.push(str);
    },
  };
  const state = createChatStreamState();
  processOpenAIResponsesSseChunkToChat(
    clientRes,
    'data: {"type":"response.reasoning.delta","delta":"thinking step 1"}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"Hello world"}\n\n' +
      'data: {"type":"response.completed"}\n\n',
    state
  );
  flushOpenAIResponsesSseToChat(clientRes, state);

  const reasoningChunks = events
    .filter((e) => e.startsWith('data:') && !e.includes('[DONE]'))
    .map((e) => JSON.parse(e.replace(/^data:\s*/, '')))
    .filter((chunk) => chunk.choices && chunk.choices[0].delta.reasoning_content);

  assert.strictEqual(reasoningChunks.length, 1);
  assert.strictEqual(reasoningChunks[0].choices[0].delta.reasoning_content, 'thinking step 1');
}

// Test 8: Responses -> Chat non-streaming reasoning extraction
{
  const chatResponse = openAIResponsesToChatResponse(
    {
      output: [
        { type: 'reasoning', summary: 'I pondered deeply' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The answer is 42.' }],
        },
      ],
    },
    'gpt-4o'
  );
  assert.strictEqual(chatResponse.choices.length, 1);
  assert.strictEqual(chatResponse.choices[0].message.content, 'The answer is 42.');
  assert.strictEqual(chatResponse.choices[0].message.reasoning_content, 'I pondered deeply');
}

// Test 9: OpenAI -> Claude tool call stop_reason: 'tool_use'
{
  // 9a: Non-streaming OpenAI response to Claude message
  const claudeRes = openAIResponseToClaudeMessage(
    {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'Read', arguments: '{"file_path":"foo.txt"}' },
              },
            ],
          },
        },
      ],
    },
    'claude-3-7-sonnet'
  );
  assert.strictEqual(claudeRes.stop_reason, 'tool_use');

  // 9b: Streaming OpenAI response to Claude
  const sseEvents = [];
  const sseRes = {
    write(str) {
      sseEvents.push(str);
    },
  };
  const streamState = {
    buffer: '',
    textIndex: 0,
    toolCalls: [{ id: 'call_1', name: 'Read', arguments: '{}', flushed: true }],
    finishReason: 'tool_calls',
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  flushOpenAISseToClaude(sseRes, streamState);
  const messageDeltaEvent = sseEvents.find((e) => e.includes('"type":"message_delta"'));
  assert.ok(messageDeltaEvent);
  assert.ok(messageDeltaEvent.includes('"stop_reason":"tool_use"'));
}

// Test 10: Gemini thought: true mapping to Claude thinking block
{
  const claudeFromGemini = geminiResponseToClaude(
    {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: 'Thinking about physics...', thought: true },
              { text: 'E=mc^2 is the mass-energy equivalence.' },
            ],
          },
        },
      ],
    },
    'gemini-2.5-flash',
    []
  );
  assert.strictEqual(claudeFromGemini.content.length, 2);
  assert.strictEqual(claudeFromGemini.content[0].type, 'thinking');
  assert.strictEqual(claudeFromGemini.content[0].thinking, 'Thinking about physics...');
  assert.strictEqual(claudeFromGemini.content[1].type, 'text');
  assert.strictEqual(claudeFromGemini.content[1].text, 'E=mc^2 is the mass-energy equivalence.');
}

// Test 11: Gemini streaming thought: true converted through Claude SSE bridge to Responses reasoning delta
{
  const { createClaudeStream } = require('../lib/proxy/stream-claude');
  const { finishGeminiClaudeStream } = require('../lib/proxy/handlers/route-gemini-utils');
  const claudeStream = createClaudeStream({
    cleanToolArgs: (name, args) => args,
    stripEmptyOptionalToolArgs: (a) => a,
    sanitizeGeminiToolCall: (c) => c,
    sampleGeminiToolEvent: () => {},
    auditToolCall: () => {},
    sampleOutboundSse: () => {},
    parseClaudeSseEvent: (raw) => {
      const text = String(raw || '').trim();
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
    },
    resolveSseBlockIndex: () => 0,
    deltaPartialJson: (d) => (d && d.partial_json ? d.partial_json : ''),
    geminiFunctionCallArgs: (a) => a,
    geminiClaudeToolId: (i) => 'tool_' + i,
    rememberGeminiToolCall: () => {},
    claudeStopReasonFromGemini: (r) => r,
    geminiUsageToClaude: (usage) => ({
      input_tokens: usage && usage.promptTokenCount ? usage.promptTokenCount : 0,
      output_tokens: usage && usage.candidatesTokenCount ? usage.candidatesTokenCount : 0,
      cached_input_tokens:
        usage && usage.cachedContentTokenCount ? usage.cachedContentTokenCount : 0,
    }),
    fallbackId: (p) => p + '_mock',
    protocolOptions: { thinkingPolicy: 'passthrough' },
  });

  const events = [];
  const clientRes = {
    writeHead() {},
    write(chunk) {
      events.push(String(chunk));
    },
    end() {},
  };

  const targetModel = 'gemini-3.8-flash-tiered';
  const responseState = createResponsesStreamState({ model: targetModel });
  const chatRes = {
    write: (chunk) => processOpenAIChatSseChunkToResponses(clientRes, String(chunk), responseState),
  };
  const chatState = {
    id: 'chatcmpl_test',
    created: 12345,
    model: targetModel,
    buffer: '',
    pendingToolCall: null,
    toolCallIndex: 0,
    hasToolCalls: false,
    stopReason: 'end_turn',
    done: false,
    thinkingPolicy: 'passthrough',
  };
  const claudeBridge = {
    write: (chunk) => processClaudeSseChunkToOpenAI(chatRes, String(chunk), chatState),
  };
  const geminiState = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    buffer: '',
    tools: [],
    pendingToolCall: null,
  };

  // 1. Thinking chunk
  claudeStream.streamGeminiChunkToClaude(
    claudeBridge,
    {
      candidates: [
        {
          content: {
            parts: [
              {
                thought: true,
                text: 'Analyzing the user codebase to run script...',
                thoughtSignature: 'sig-test',
              },
            ],
          },
        },
      ],
    },
    geminiState,
    targetModel,
    []
  );

  // 2. Tool call chunk
  claudeStream.streamGeminiChunkToClaude(
    claudeBridge,
    {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'Bash', args: { command: 'node test.js' } } }],
          },
          finishReason: 'STOP',
        },
      ],
    },
    geminiState,
    targetModel,
    []
  );

  claudeStream.flushPendingGeminiToolCall(claudeBridge, geminiState, []);
  flushClaudeSseToOpenAI(chatRes, chatState);
  flushOpenAIChatSseToResponses(clientRes, responseState);

  // Verify response.reasoning.delta was emitted
  const reasoningDeltas = events.filter(
    (e) => e.startsWith('data:') && e.includes('response.reasoning.delta')
  );
  assert.strictEqual(reasoningDeltas.length, 1);
  assert.ok(reasoningDeltas[0].includes('Analyzing the user codebase to run script...'));

  // Verify response.reasoning.done was emitted before tool call
  const reasoningDone = events.filter(
    (e) => e.startsWith('data:') && e.includes('response.reasoning.done')
  );
  assert.strictEqual(reasoningDone.length, 1);

  // Verify tool call argument delta was emitted
  const toolCallDeltas = events.filter(
    (e) => e.startsWith('data:') && e.includes('response.function_call_arguments.delta')
  );
  assert.strictEqual(toolCallDeltas.length, 1);
  assert.ok(toolCallDeltas[0].includes('node test.js'));

  const preambleEvents = [];
  const preambleClientRes = {
    writeHead() {},
    write(chunk) {
      preambleEvents.push(String(chunk));
    },
    end() {},
  };
  const preambleResponseState = createResponsesStreamState({ model: targetModel });
  const preambleChatRes = {
    write: (chunk) =>
      processOpenAIChatSseChunkToResponses(preambleClientRes, String(chunk), preambleResponseState),
  };
  const preambleChatState = {
    id: 'chatcmpl_preamble',
    created: 12345,
    model: targetModel,
    buffer: '',
    pendingToolCall: null,
    toolCallIndex: 0,
    hasToolCalls: false,
    stopReason: 'end_turn',
    done: false,
    thinkingPolicy: 'passthrough',
  };
  const preambleClaudeBridge = {
    write: (chunk) =>
      processClaudeSseChunkToOpenAI(preambleChatRes, String(chunk), preambleChatState),
  };
  const preambleGeminiState = {
    textIndex: -1,
    textOpen: false,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    buffer: '',
    tools: [{ name: 'exec', input_schema: { type: 'object', required: ['input'] } }],
    pendingToolCall: null,
    responsesToolPreambleText: '我先看一下。',
  };

  claudeStream.streamGeminiChunkToClaude(
    preambleClaudeBridge,
    {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'exec', args: { input: 'return 1;' } } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 8,
        cachedContentTokenCount: 99,
      },
    },
    preambleGeminiState,
    targetModel,
    preambleGeminiState.tools
  );

  finishGeminiClaudeStream({
    sink: preambleClaudeBridge,
    state: preambleGeminiState,
    targetModel,
    processGeminiSseEvent: claudeStream.processGeminiSseEvent,
    flushPendingGeminiToolCall: claudeStream.flushPendingGeminiToolCall,
    writeClaudeSseEvent: claudeStream.writeClaudeSseEvent,
    geminiClaudeStopReason: claudeStream.geminiClaudeStopReason,
  });
  flushClaudeSseToOpenAI(preambleChatRes, preambleChatState);
  flushOpenAIChatSseToResponses(preambleClientRes, preambleResponseState);

  const preambleOutput = preambleEvents.join('');
  const preambleIndex = preambleOutput.indexOf('response.output_text.delta');
  const toolCallIndex = preambleOutput.indexOf('"type":"function_call"');
  assert.ok(
    preambleOutput.includes('我先看一下。'),
    'Responses stream should expose fallback text'
  );
  assert.ok(preambleIndex >= 0, 'fallback text should be emitted as Responses text delta');
  assert.ok(toolCallIndex >= 0, 'tool call should still be emitted');
  assert.ok(preambleIndex < toolCallIndex, 'fallback text must precede the tool call item');
  assert.ok(
    preambleOutput.includes('"cached_input_tokens":99'),
    'Gemini cached input usage must survive Gemini -> Claude -> Chat -> Responses streaming'
  );
}

// --- Regression: Responses reasoning summary shapes (array form was lost) ---
{
  // Newer Responses payloads ship summary as an array of {type:'summary_text'}.
  // Reading it as a string produced "[object Object]" and destroyed the reasoning.
  const arraySummary = openAIResponsesToChatResponse(
    {
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'I weighed the tradeoffs' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      ],
    },
    'gpt-4o'
  );
  assert.strictEqual(
    arraySummary.choices[0].message.reasoning_content,
    'I weighed the tradeoffs',
    'array-form reasoning summary must not degrade to [object Object]'
  );
  assert.ok(!String(arraySummary.choices[0].message.reasoning_content).includes('[object Object]'));

  // Legacy string form must keep working.
  const stringSummary = openAIResponsesToChatResponse(
    { output: [{ type: 'reasoning', summary: 'legacy summary' }] },
    'gpt-4o'
  );
  assert.strictEqual(stringSummary.choices[0].message.reasoning_content, 'legacy summary');

  // Multi-part summary arrays are joined, not truncated to the first part.
  const multiPart = openAIResponsesToChatResponse(
    {
      output: [
        {
          type: 'reasoning',
          summary: [
            { type: 'summary_text', text: 'step one' },
            { type: 'summary_text', text: 'step two' },
          ],
        },
      ],
    },
    'gpt-4o'
  );
  assert.strictEqual(multiPart.choices[0].message.reasoning_content, 'step one\nstep two');

  // Empty / malformed summaries must not throw or invent content.
  for (const empty of [
    { type: 'reasoning' },
    { type: 'reasoning', summary: [] },
    { type: 'reasoning', summary: null },
    { type: 'reasoning', summary: [{}] },
  ]) {
    const res = openAIResponsesToChatResponse({ output: [empty] }, 'gpt-4o');
    assert.strictEqual(
      res.choices[0].message.reasoning_content,
      undefined,
      'empty reasoning must stay absent'
    );
  }
}

// --- Regression: Responses -> Chat stream tool-call buffers are released ---
{
  const written = [];
  const fakeRes = { write: (chunk) => written.push(String(chunk)) };
  const state = createResponsesStreamState();
  for (let i = 0; i < 500; i += 1) {
    processOpenAIResponsesSseChunkToChat(
      fakeRes,
      'event: response.function_call_arguments.delta\ndata: ' +
        JSON.stringify({
          type: 'response.function_call_arguments.delta',
          item_id: 'item_' + i,
          delta: '{}',
        }) +
        '\n\n',
      state
    );
  }
  assert.ok(state.responseToolCallBuffers.size > 0, 'buffers accumulate while the stream is open');
  flushOpenAIResponsesSseToChat(fakeRes, state);
  assert.strictEqual(
    state.responseToolCallBuffers.size,
    0,
    'per-request tool-call buffers must be cleared after flush'
  );
}

// Chat -> Responses waits for the terminal frame so trailing usage is retained.
{
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = createResponsesStreamState();
  processOpenAIChatSseChunkToResponses(
    clientRes,
    event({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) +
      event({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }) +
      'data: [DONE]\n\n',
    state
  );
  const output = writes.join('');
  assert.equal(state.done, true);
  assert.equal(state.failed, undefined);
  assert.match(output, /"input_tokens":10/);
  assert.match(output, /"output_tokens":2/);
  assert.equal((output.match(/response\.completed/g) || []).length >= 1, true);
}

// Missing, malformed, and structurally unsafe terminal data fail closed once.
for (const [chunk, expectedCode] of [
  [
    event({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }),
    'upstream_stream_incomplete',
  ],
  ['data: {bad json}\n\n', 'upstream_stream_invalid_event'],
  [
    event({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 999999,
                function: { name: 'unsafe', arguments: '{}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    'upstream_stream_invalid_tool_index',
  ],
]) {
  const writes = [];
  const clientRes = { write: (value) => writes.push(String(value)) };
  const state = createResponsesStreamState();
  processOpenAIChatSseChunkToResponses(clientRes, chunk, state);
  flushOpenAIChatSseToResponses(clientRes, state);
  flushOpenAIChatSseToResponses(clientRes, state);
  const output = writes.join('');
  assert.equal(state.failed, true);
  assert.equal(state.failure.code, expectedCode);
  assert.equal((output.match(/event: response\.failed/g) || []).length, 1);
  assert.equal(output.includes('data: [DONE]'), false);
}

// Length/content filtering preserve the Responses incomplete contract.
for (const [finishReason, incompleteReason] of [
  ['length', 'max_output_tokens'],
  ['content_filter', 'content_filter'],
]) {
  const writes = [];
  const state = createResponsesStreamState();
  processOpenAIChatSseChunkToResponses(
    { write: (value) => writes.push(String(value)) },
    event({ choices: [{ delta: { content: 'partial' }, finish_reason: finishReason }] }) +
      'data: [DONE]\n\n',
    state
  );
  const output = writes.join('');
  assert.match(output, /event: response\.incomplete/);
  assert.ok(output.includes(`"reason":"${incompleteReason}"`));
}

console.log('[responses-protocol.test] ok');
process.exit(0);
