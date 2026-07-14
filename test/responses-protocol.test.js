const assert = require('assert');

const {
  openAIResponsesToChat,
  openAIChatToResponses,
  openAIChatToResponsesRequest,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  processOpenAIResponsesSseChunkToChat,
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
          { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
        ],
      },
    ],
    text: { format: { type: 'json_object' } },
  });

  assert.deepStrictEqual(result.messages[0].content, [
    { type: 'text', text: 'describe' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
  ]);
  assert.deepStrictEqual(result.response_format, { type: 'json_object' });
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
  const result = openAIChatToResponsesRequest({
    model: 'client-model',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
        ],
      },
    ],
  });

  assert.deepStrictEqual(result.input[0].content, [
    { type: 'input_text', text: 'describe' },
    { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
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
  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'openai-chat' }), true);
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
  const state = {
    id: 'chatcmpl_test',
    created: 1,
    model: 'client-model',
    buffer: '',
    started: false,
    toolCalls: [],
    usage: null,
    done: false,
  };
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

console.log('[responses-protocol.test] ok');
process.exit(0);
