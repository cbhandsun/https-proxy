const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function buildModelsUrls(targetUrl, protocol) {
  const base = new URL(targetUrl);
  if (protocol === 'gemini') return [new URL('/v1beta/models?pageSize=1000', base.origin)];
  if (protocol === 'claude') {
    if (base.hostname === 'api.deepseek.com') return [new URL('/models?limit=1000', base.origin), new URL(base.pathname.replace(/\/$/, '') + '/v1/models?limit=1000', base.origin)];
    return [new URL(base.pathname.replace(/\/$/, '') + '/v1/models?limit=1000', base.origin), new URL('/models?limit=1000', base.origin)];
  }
  return [new URL(base.pathname.replace(/\/$/, '') + '/models?limit=1000', base.origin)];
}

function normalizeModels(payload) {
  const items = Array.isArray(payload && payload.data) ? payload.data : (Array.isArray(payload && payload.models) ? payload.models : []);
  return items.map((item) => String(item.id || item.name || '').replace(/^models\//, '')).filter(Boolean).sort();
}

function prepareModelRequest(requestUrl, headers, apiKey) {
  const nextUrl = new URL(requestUrl.toString());
  const requestHeaders = { ...(headers || {}) };
  if (nextUrl.hostname === 'generativelanguage.googleapis.com') {
    delete requestHeaders.authorization;
    delete requestHeaders['x-api-key'];
    delete requestHeaders['api-key'];
    delete requestHeaders['x-goog-api-key'];
    if (apiKey) nextUrl.searchParams.set('key', apiKey);
  }
  return { requestUrl: nextUrl, requestHeaders };
}
const {
  claudeMessagesToGemini,
  geminiResponseToClaude,
  geminiUsageToClaude,
  claudeStopReasonFromGemini,
  parseTargetUrl,
  geminiGeneratePath,
  processGeminiSseEvent,
  processClaudeSseChunk,
  flushClaudeSseFilter,
  getLocalServer,
  prepareRequestBuffer,
  buildLocalModelsResponse,
  buildLocalClaudeModelObject,
  redactDiagnosticsValue,
  summarizeClaudeToolHistory,
  extractDiagnosticsSsePayload,
  writeJsonlBounded,
  parseGeminiError,
  geminiErrorToClaude,
  setGeminiCooldown,
  getGeminiCooldown,
  openAIResponsesToChat,
  openAIChatToResponses,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  getEntryServers,
  getClaudeDesktopRoutes,
  stripClaudeDesktopPrefix,
  isClaudeDesktopRequest,
  shouldConvertResponsesToOpenAIChat,
  parseModelsRequestPath,
} = require('../openai-proxy');

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function safeUnlink(filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return;
    } catch (err) {
      if (err.code === 'ENOENT') return;
      lastError = err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  if (lastError && process.env.DEBUG_TEST_CLEANUP) console.warn('warn - could not remove test file ' + filePath + ': ' + lastError.message);
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

test('converts images and tool declarations', () => {
  const result = claudeMessagesToGemini({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
      ],
    }],
    tools: [{
      name: 'lookup',
      description: 'lookup data',
      input_schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          q: { type: 'string' },
          maybe: { type: ['string', 'null'] },
          count: { type: 'integer', minimum: 1, exclusiveMinimum: 0 },
          formatted: { type: 'string', format: 'date-time', minLength: 3, maxLength: 30, pattern: '^x' },
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
    }],
    tool_choice: { type: 'tool', name: 'lookup' },
  }, 'gemini-2.5-pro');

  assert.strictEqual(result.contents[0].parts[0].text, 'describe');
  assert.deepStrictEqual(result.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'abc123' } });
  assert.strictEqual(result.tools[0].functionDeclarations[0].name, 'lookup');
  assert.strictEqual(result.tools[0].functionDeclarations[0].parameters.$schema, undefined);
  assert.strictEqual(result.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
  assert.strictEqual(result.tools[0].functionDeclarations[0].parameters.propertyNames, undefined);
  assert.strictEqual(result.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
  assert.deepStrictEqual(result.tools[0].functionDeclarations[0].parameters.properties.q, { type: 'STRING' });
  assert.deepStrictEqual(result.tools[0].functionDeclarations[0].parameters.properties.maybe, { type: 'STRING', nullable: true });
  assert.strictEqual(result.tools[0].functionDeclarations[0].parameters.properties.count.exclusiveMinimum, undefined);
  assert.deepStrictEqual(result.tools[0].functionDeclarations[0].parameters.properties.formatted, { type: 'STRING', format: 'date-time', minLength: 3, maxLength: 30, pattern: '^x' });
  assert.deepStrictEqual(result.tools[0].functionDeclarations[0].parameters.propertyOrdering, ['q', 'count']);
  assert.strictEqual(result.tools[0].functionDeclarations[0].parameters.properties.choice.oneOf, undefined);
  assert.strictEqual(result.tools[0].functionDeclarations[0].parameters.properties.nested.items.additionalProperties, undefined);
  assert.deepStrictEqual(result.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] } });
});

test('omits Claude tool history when Gemini tools are present', () => {
  const result = claudeMessagesToGemini({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'price' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', name: 'lookup', content: '42' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'nested' }, { type: 'server_tool_use', payload: { functionCall: { name: 'Grep', args: { pattern: 'x' } } } }] },
      { role: 'user', content: 'continue' },
    ],
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
  }, 'gemini-2.5-pro');

  assert.strictEqual(result.contents.length, 3);
  assert.deepStrictEqual(result.contents[0], { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'price' } }, thoughtSignature: 'context_engineering_is_the_way_to_go' }] });
  assert.deepStrictEqual(result.contents[1], { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { content: '42' } } }] });
  assert.deepStrictEqual(result.contents[2], { role: 'user', parts: [{ text: 'continue' }] });
});

test('restores Gemini thought signatures for tool history', () => {
  const response = geminiResponseToClaude({
    candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'sig-1' }] } }],
  }, 'gemini-3-flash-preview');

  const result = claudeMessagesToGemini({
    messages: [
      { role: 'assistant', content: response.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: response.content[0].id, content: '42' }] },
    ],
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
  }, 'gemini-3-flash-preview');

  assert.deepStrictEqual(result.contents[0], {
    role: 'model',
    parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'sig-1' }],
  });
  assert.deepStrictEqual(result.contents[1], {
    role: 'user',
    parts: [{ functionResponse: { name: 'lookup', response: { content: '42' } } }],
  });
});

test('keeps Gemini tool result names when thought signature is absent', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { textIndex: -1, textOpen: false, stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, tools: [{ name: 'Read', input_schema: { type: 'object', required: ['file_path'] } }], pendingToolCall: null };

  processGeminiSseEvent(clientRes, 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Read","args":{"file_path":"D:\\\\DEV\\\\WorkSapce\\\\Efficiency\\\\https-proxy\\\\electron-main.js"},"id":"read-abc"}}]}}]}\r\n', state, 'gemini-3-flash-preview');
  const { flushPendingGeminiToolCall } = require('../openai-proxy');
  flushPendingGeminiToolCall(clientRes, state, state.tools);
  const next = claudeMessagesToGemini({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gemini-tool-read-abc', content: 'file contents' }] }],
    tools: [{ name: 'Read', input_schema: { type: 'object', required: ['file_path'] } }],
  }, 'gemini-3-flash-preview');
  assert.strictEqual(next.contents[0].parts[0].functionResponse.name, 'Read');
});
test('skips Gemini tool calls missing required args', () => {
  const result = geminiResponseToClaude({
    candidates: [{ content: { parts: [{ functionCall: { name: 'Glob', args: {} }, thoughtSignature: 'sig-missing' }] } }],
  }, 'gemini-3-flash-preview', [{ name: 'Glob', input_schema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } } }]);

  assert.strictEqual(result.content[0].type, 'text');
  assert.ok(result.content[0].text.includes('Please call the same tool again with complete arguments'));
  assert.ok(result.content[0].text.includes('pattern'));
});

test('skips common tool calls missing fallback required args', () => {
  const result = geminiResponseToClaude({
    candidates: [{ content: { parts: [{ functionCall: { name: 'default_api:Grep', args: {} }, thoughtSignature: 'sig-grep' }] } }],
  }, 'gemini-3-flash-preview', []);

  assert.strictEqual(result.content[0].type, 'text');
  assert.ok(result.content[0].text.includes('pattern'));
});

test('normalizes prefixed Gemini tool names and rejects empty common tool args', () => {
  const bash = geminiResponseToClaude({
    candidates: [{ content: { parts: [{ functionCall: { name: 'default_api__Bash', args: {} }, thoughtSignature: 'sig-bash' }] } }],
  }, 'gemini-3-flash-preview', []);
  assert.strictEqual(bash.content[0].type, 'text');
  assert.ok(bash.content[0].text.includes('Please call the same tool again with complete arguments'));
  assert.ok(bash.content[0].text.includes('command'));

  const glob = geminiResponseToClaude({
    candidates: [{ content: { parts: [{ functionCall: { name: 'functions.Glob', args: { pattern: '**/*.js' } }, thoughtSignature: 'sig-glob' }] } }],
  }, 'gemini-3-flash-preview', []);
  assert.strictEqual(glob.content[0].type, 'tool_use');
  assert.strictEqual(glob.content[0].name, 'Glob');
  assert.deepStrictEqual(glob.content[0].input, { pattern: '**/*.js' });
});

test('recovers Gemini tool args from wrappers and JSON strings', () => {
  const wrapped = geminiResponseToClaude({
    candidates: [{ content: { parts: [{ functionCall: { name: 'tool_Grep', args: { arguments: { pattern: 'needle' } } }, thoughtSignature: 'sig-grep' }] } }],
  }, 'gemini-3-flash-preview', []);
  assert.strictEqual(wrapped.content[0].type, 'tool_use');
  assert.strictEqual(wrapped.content[0].name, 'Grep');
  assert.deepStrictEqual(wrapped.content[0].input, { pattern: 'needle' });

  const sibling = geminiResponseToClaude({
    candidates: [{ content: { parts: [{ functionCall: { name: 'Glob', args: {}, arguments: { pattern: '**/*.js' } }, thoughtSignature: 'sig-glob-sibling' }] } }],
  }, 'gemini-3-flash-preview', []);
  assert.strictEqual(sibling.content[0].type, 'tool_use');
  assert.deepStrictEqual(sibling.content[0].input, { pattern: '**/*.js' });

  const jsonArgs = geminiResponseToClaude({
    candidates: [{ content: { parts: [{ functionCall: { name: 'Bash', args: '{"command":"pwd"}' }, thoughtSignature: 'sig-bash-json' }] } }],
  }, 'gemini-3-flash-preview', []);
  assert.strictEqual(jsonArgs.content[0].type, 'tool_use');
  assert.deepStrictEqual(jsonArgs.content[0].input, { command: 'pwd' });
});

test('normalizes unsafe Gemini asset listing command', () => {
  const result = geminiResponseToClaude({
    candidates: [{ content: { parts: [{ functionCall: { name: 'Bash', args: { command: 'ls -R assets images static', description: 'Check for any asset directories.' } }, thoughtSignature: 'sig-bash-assets' }] } }],
  }, 'gemini-3-flash-preview', []);

  assert.strictEqual(result.content[0].type, 'tool_use');
  assert.strictEqual(result.content[0].name, 'Bash');
  assert.strictEqual(result.content[0].input.command, 'for d in "assets" "images" "static"; do [ -d "$d" ] && ls -R "$d"; done');
});

test('converts Gemini response to Claude message', () => {
  const result = geminiResponseToClaude({
    candidates: [{
      finishReason: 'MAX_TOKENS',
      content: { parts: [{ text: 'hello' }, { functionCall: { name: 'lookup', args: { q: 'x' } } }] },
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
  }, 'gemini-2.5-pro');

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
  assert.deepStrictEqual(geminiUsageToClaude({ promptTokenCount: 1, candidatesTokenCount: 2 }), { input_tokens: 1, output_tokens: 2 });
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

  const prepared = prepareRequestBuffer(Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [] })), undefined);
  const rewritten = JSON.parse(prepared.buffer.toString('utf8'));
  assert.strictEqual(prepared.routed, true);
  assert.strictEqual(rewritten.model, 'gpt-5.3-codex');
});

test('parses Gemini streaming SSE events with CRLF separators', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { textIndex: -1, textOpen: false, stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } };

  processGeminiSseEvent(clientRes, 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1}}\r\n', state, 'gemini-3-flash-preview');

  assert.strictEqual(state.textOpen, true);
  assert.deepStrictEqual(state.usage, { input_tokens: 2, output_tokens: 1 });
  assert.ok(writes.join('').includes('hi'));
});

test('buffers streaming Gemini tool calls until args are complete', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { textIndex: -1, textOpen: false, stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, tools: [{ name: 'Glob', input_schema: { type: 'object', required: ['pattern'] } }], pendingToolCall: null };

  processGeminiSseEvent(clientRes, 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Glob","args":{}},"thoughtSignature":"sig-glob"}]}}]}\r\n', state, 'gemini-3-flash-preview');
  assert.strictEqual(writes.length, 0);
  processGeminiSseEvent(clientRes, 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"args":{"pattern":"**/*.js"}}}]}}]}\r\n', state, 'gemini-3-flash-preview');
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
  const state = { textIndex: -1, textOpen: false, stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, tools: [{ name: 'Bash', input_schema: { type: 'object', required: ['command'] } }], pendingToolCall: null };

  processGeminiSseEvent(clientRes, 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"default_api:Bash","args":{}},"thoughtSignature":"sig-bash"}]},"finishReason":"STOP"}]}\r\n', state, 'gemini-3-flash-preview');
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
  const state = { textIndex: -1, textOpen: false, stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, tools: [{ name: 'Glob', input_schema: { type: 'object', required: ['pattern'] } }], pendingToolCall: null };

  processGeminiSseEvent(clientRes, 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Glob","args":{},"arguments":{"pattern":"**/*.js"}},"thoughtSignature":"sig-glob"}]}}]}\r\n', state, 'gemini-3-flash-preview');
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
  const state = { textIndex: -1, textOpen: false, stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, tools: [{ name: 'Bash', input_schema: { type: 'object', required: ['command'] } }], pendingToolCall: null };

  processGeminiSseEvent(clientRes, 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Bash","args":{}},"thoughtSignature":"sig-bash"}]}}]}\r\n', state, 'gemini-3-flash-preview');
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

  processClaudeSseChunk(clientRes, 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}\n\n', state);
  processClaudeSseChunk(clientRes, 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n', state);
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

  processClaudeSseChunk(clientRes, 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Glob","input":{}}}\n\n', state);
  processClaudeSseChunk(clientRes, 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\":\\"**/*.js\\"}"}}\n\n', state);
  processClaudeSseChunk(clientRes, 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n', state);
  flushClaudeSseFilter(clientRes, state);
  const output = writes.join('');
  assert.ok(output.includes('"type":"tool_use"'));
  assert.ok(output.includes('"input":{}'));
  assert.ok(output.includes('"type":"input_json_delta"'));
  assert.ok(output.includes('**/*.js'));
  assert.ok(!output.includes('Please call the same tool again'));
});

test('OpenAI stream sanitizer drops empty optional tool args only', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { buffer: '', pendingClaudeTool: null, mode: 'strip-empty-optionals' };

  processClaudeSseChunk(clientRes, 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"D:/x.js","pages":""}}}\n\n', state);
  processClaudeSseChunk(clientRes, 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n', state);
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

  processClaudeSseChunk(clientRes, 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}\n\n', state);
  processClaudeSseChunk(clientRes, 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"D:/x.js\\",\\"pages\\":\\"\\"}"}}\n\n', state);
  processClaudeSseChunk(clientRes, 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n', state);
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

  processClaudeSseChunk(clientRes, 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Glob","input":{}}}\n\n', state);
  processClaudeSseChunk(clientRes, 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern"}}\n\n', state);
  processClaudeSseChunk(clientRes, 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\":\\"**/*.js\\",\\"pages\\":\\"\\"}"}}\n\n', state);
  processClaudeSseChunk(clientRes, 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n', state);
  flushClaudeSseFilter(clientRes, state);
  const output = writes.join('');
  assert.ok(output.includes('\\"pattern\\":\\"**/*.js\\"'));
  assert.ok(!output.includes('\\"pages\\":\\"\\"'));
  assert.ok(!output.includes('Please call the same tool again'));
});

test('Gemini converted tool_use sends args as input_json_delta', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { textIndex: -1, textOpen: false, stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, tools: [{ name: 'Bash', input_schema: { type: 'object', required: ['command'] } }], pendingToolCall: null };

  processGeminiSseEvent(clientRes, 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Bash","args":{"command":"ls -R","description":"List files"}},"thoughtSignature":"sig-bash"}]}}]}\r\n', state, 'gemini-3-flash-preview');
  const { flushPendingGeminiToolCall } = require('../openai-proxy');
  flushPendingGeminiToolCall(clientRes, state, state.tools);
  const output = writes.join('');
  assert.ok(output.includes('"type":"tool_use"'));
  assert.ok(output.includes('"input":{}'));
  assert.ok(output.includes('"type":"input_json_delta"'));
  assert.ok(output.includes('\\"command\\":\\"ls -R\\"'));
  assert.ok(!output.includes('Please call the same tool again'));
});

test('builds Gemini generateContent paths', () => {
  assert.strictEqual(geminiGeneratePath('', 'gemini-3-flash-preview', false), '/v1beta/models/gemini-3-flash-preview:generateContent');
  assert.strictEqual(geminiGeneratePath('/v1', 'gemini 3 flash', true), '/v1beta/models/gemini%203%20flash:streamGenerateContent');
});

test('builds and normalizes OpenAI-compatible model list requests', () => {
  const urls = buildModelsUrls('http://yhrouter.example:80/v1', 'openai');
  assert.strictEqual(urls[0].toString(), 'http://yhrouter.example/v1/models?limit=1000');
  assert.deepStrictEqual(normalizeModels({
    data: [
      { id: 'yh/gpt-5.3-codex' },
      { id: 'gpt-5.5' },
    ],
  }), ['gpt-5.5', 'yh/gpt-5.3-codex']);
});

test('builds Claude model list requests under the upstream base path', () => {
  const urls = buildModelsUrls('https://claude.example/anthropic', 'claude');
  assert.deepStrictEqual(urls.map((url) => url.toString()), [
    'https://claude.example/anthropic/v1/models?limit=1000',
    'https://claude.example/models?limit=1000',
  ]);
});

test('builds DeepSeek model list requests with the documented endpoint first', () => {
  const urls = buildModelsUrls('https://api.deepseek.com/anthropic', 'claude');
  assert.deepStrictEqual(urls.map((url) => url.toString()), [
    'https://api.deepseek.com/models?limit=1000',
    'https://api.deepseek.com/anthropic/v1/models?limit=1000',
  ]);
});

test('builds and normalizes Gemini model list requests', () => {
  const urls = buildModelsUrls('https://generativelanguage.googleapis.com', 'gemini');
  assert.strictEqual(urls.length, 1);
  assert.strictEqual(urls[0].toString(), 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
  assert.deepStrictEqual(normalizeModels({
    models: [
      { name: 'models/gemini-2.5-pro' },
      { name: 'models/gemini-2.5-flash' },
    ],
  }), ['gemini-2.5-flash', 'gemini-2.5-pro']);
});

test('uses Gemini API key query param without bearer headers', () => {
  const { requestUrl, requestHeaders } = prepareModelRequest(
    new URL('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'),
    {
      accept: 'application/json',
      authorization: 'Bearer bad-key',
      'x-api-key': 'bad-key',
      'api-key': 'bad-key',
      'x-goog-api-key': 'bad-key',
    },
    'gemini-key'
  );

  assert.strictEqual(requestUrl.toString(), 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=gemini-key');
  assert.deepStrictEqual(requestHeaders, { accept: 'application/json' });
});

test('builds local OpenAI-compatible model list from routed model names', () => {
  assert.deepStrictEqual(buildLocalModelsResponse([
    { from: 'claude-haiku-4-5-20251001', profileId: 'yhrouter', to: 'gpt-5.5' },
    { from: 'claude-gemini', profileId: 'google-gemini', to: 'gemini-3-flash-preview' },
    { from: 'claude-haiku-4-5-20251001', profileId: 'other', to: 'other-model' },
  ]), {
    object: 'list',
    data: [
      { id: 'claude-gemini', object: 'model', created: 0, owned_by: 'local-proxy', root: 'claude-gemini', parent: null, permission: [] },
      { id: 'claude-haiku-4-5-20251001', object: 'model', created: 0, owned_by: 'local-proxy', root: 'claude-haiku-4-5-20251001', parent: null, permission: [] },
    ],
  });
});

test('builds local Claude-compatible model list from routed model names', () => {
  assert.deepStrictEqual(buildLocalModelsResponse([
    { from: 'claude-haiku-4-5-20251001', profileId: 'yhrouter', to: 'gpt-5.5' },
    { from: 'claude-gemini', profileId: 'google-gemini', to: 'gemini-3-flash-preview' },
  ], 'claude'), {
    data: [
      { id: 'claude-gemini', type: 'model', display_name: 'claude-gemini', created_at: '1970-01-01T00:00:00.000Z' },
      { id: 'claude-haiku-4-5-20251001', type: 'model', display_name: 'claude-haiku-4-5-20251001', created_at: '1970-01-01T00:00:00.000Z' },
    ],
    has_more: false,
    first_id: 'claude-gemini',
    last_id: 'claude-haiku-4-5-20251001',
  });
  assert.deepStrictEqual(buildLocalClaudeModelObject('claude-gemini'), {
    id: 'claude-gemini',
    type: 'model',
    display_name: 'claude-gemini',
    created_at: '1970-01-01T00:00:00.000Z',
  });
});

test('parses model list and retrieve paths with and without v1 prefix', () => {
  assert.deepStrictEqual(parseModelsRequestPath('/v1/models'), { kind: 'list' });
  assert.deepStrictEqual(parseModelsRequestPath('/models'), { kind: 'list' });
  assert.deepStrictEqual(parseModelsRequestPath('/v1/models/claude-gemini'), { kind: 'retrieve', id: 'claude-gemini' });
  assert.deepStrictEqual(parseModelsRequestPath('/models/claude-gemini'), { kind: 'retrieve', id: 'claude-gemini' });
});

test('uses explicit model list format for each entry protocol', () => {
  const routes = [
    { from: 'claude-gemini', profileId: 'google-gemini', to: 'gemini-3-flash-preview' },
  ];
  assert.strictEqual(buildLocalModelsResponse(routes, 'claude').data[0].type, 'model');
  assert.strictEqual(buildLocalModelsResponse(routes, 'claude').data[0].display_name, 'claude-gemini');
  assert.strictEqual(buildLocalModelsResponse(routes, 'openai').object, 'list');
  assert.strictEqual(buildLocalModelsResponse(routes, 'openai').data[0].object, 'model');
});

test('uses global local server config with legacy profile port fallback', () => {
  assert.deepStrictEqual(getLocalServer({
    activeProfile: 'legacy',
    profiles: [{ id: 'legacy', listenPort: 4555 }],
  }), {
    host: 'localhost',
    listenPort: 4555,
    basePath: '/v1',
  });

  assert.deepStrictEqual(getLocalServer({
    localServer: { host: '127.0.0.1', listenPort: 3666, basePath: '/proxy' },
    activeProfile: 'legacy',
    profiles: [{ id: 'legacy', listenPort: 4555 }],
  }), {
    host: '127.0.0.1',
    listenPort: 3666,
    basePath: '/proxy',
  });
});

test('maps OpenAI Responses function items and tool choice to Chat format', () => {
  const result = openAIResponsesToChat({
    model: 'client-model',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'lookup' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '42' },
    ],
    tools: [{ type: 'function', name: 'lookup', description: 'Lookup data', parameters: { type: 'object', properties: { q: { type: 'string' } } }, strict: true }],
    tool_choice: { type: 'function', name: 'lookup' },
    parallel_tool_calls: false,
    seed: 123,
    user: 'user-1',
    frequency_penalty: 0.1,
    presence_penalty: 0.2,
    text: { format: { type: 'json_schema', name: 'LookupResult', schema: { type: 'object', properties: { answer: { type: 'string' } } }, strict: true } },
    reasoning: { effort: 'medium' },
  });

  assert.deepStrictEqual(result.messages[0].content, [{ type: 'text', text: 'lookup' }]);
  assert.strictEqual(result.messages[1].role, 'assistant');
  assert.strictEqual(result.messages[1].tool_calls[0].id, 'call_1');
  assert.strictEqual(result.messages[1].tool_calls[0].function.name, 'lookup');
  assert.strictEqual(result.messages[1].tool_calls[0].function.arguments, '{"q":"x"}');
  assert.deepStrictEqual(result.messages[2], { role: 'tool', tool_call_id: 'call_1', content: '42' });
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
});

test('maps Responses image URLs and JSON object format to Chat format', () => {
  const result = openAIResponsesToChat({
    model: 'client-model',
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'describe' },
      { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
    ] }],
    text: { format: { type: 'json_object' } },
  });

  assert.deepStrictEqual(result.messages[0].content, [
    { type: 'text', text: 'describe' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
  ]);
  assert.deepStrictEqual(result.response_format, { type: 'json_object' });
});

test('converts Chat response text and tool calls to Responses output', () => {
  const result = openAIChatToResponses({
    id: 'chatcmpl_123',
    created: 123456,
    choices: [{ message: { role: 'assistant', content: 'answer', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }, 'client-model');

  assert.strictEqual(result.id, 'resp_123');
  assert.strictEqual(result.object, 'response');
  assert.strictEqual(result.output[0].type, 'message');
  assert.strictEqual(result.output[0].content[0].text, 'answer');
  assert.strictEqual(result.output[1].type, 'function_call');
  assert.strictEqual(result.output[1].call_id, 'call_1');
  assert.strictEqual(result.output[1].name, 'lookup');
  assert.deepStrictEqual(result.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
});

test('builds configured multi-protocol entry servers', () => {
  const entries = getEntryServers({
    localServer: { host: '127.0.0.1', listenPort: 3000, basePath: '/v1', protocol: 'claude' },
    entryServers: [
      { listenPort: 3443, protocol: 'claude' },
      { listenPort: 3445, protocol: 'responses' },
      { listenPort: 3447, protocol: 'chat-completions' },
      { listenPort: 15721, protocol: 'claude-desktop', host: '127.0.0.1', basePath: '/claude-desktop', tls: false },
    ],
  });

  assert.deepStrictEqual(entries.map((entry) => entry.listenPort + ':' + entry.protocol), [
    '3443:claude',
    '3445:openai-responses',
    '3447:openai-chat',
    '15721:claude-desktop',
  ]);
  assert.strictEqual(entries[3].tls, false);
});

test('falls back to local server entry with protocol when entries are disabled', () => {
  const entries = getEntryServers({
    localServer: { host: '127.0.0.1', listenPort: 3000, basePath: '/proxy', protocol: 'responses' },
    entryServers: [{ listenPort: 3443, protocol: 'claude', enabled: false }],
  }).filter((entry) => entry.protocol !== 'claude-desktop');

  assert.deepStrictEqual(entries, [{
    name: 'openai-responses',
    host: '127.0.0.1',
    listenPort: 3000,
    basePath: '/proxy',
    protocol: 'openai-responses',
    tls: true,
  }]);
});

test('builds Claude Desktop safe routes from explicit mappings', () => {
  const routes = getClaudeDesktopRoutes({
    activeProfile: 'yhrouter',
    profiles: [{ id: 'yhrouter' }],
    claudeDesktop: {
      models: [
        { routeId: 'gpt-5.5', profileId: 'yhrouter', upstreamModel: 'gpt-5.5', labelOverride: 'GPT-5.5', supports1m: true },
        { routeId: 'claude-opus-4-7', profileId: 'yhrouter', upstreamModel: 'gpt-5.4', supports1m: false },
      ],
    },
  });

  assert.deepStrictEqual(routes.map((route) => route.from), ['claude-sonnet-4-6', 'claude-opus-4-7']);
  assert.strictEqual(routes[0].to, 'gpt-5.5');
  assert.strictEqual(routes[0].labelOverride, 'GPT-5.5');
  assert.strictEqual(routes[1].supports1m, false);
});

test('detects and strips Claude Desktop gateway prefix', () => {
  assert.strictEqual(isClaudeDesktopRequest({ protocol: 'claude-desktop' }, '/v1/messages'), true);
  assert.strictEqual(isClaudeDesktopRequest({ protocol: 'claude' }, '/claude-desktop/v1/messages'), true);
  assert.strictEqual(stripClaudeDesktopPrefix('/claude-desktop/v1/models'), '/v1/models');
});

test('detects Chat-only OpenAI upstream profiles for Responses bridging', () => {
  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'openai-chat' }), true);
  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'openai', supportsResponses: false }), true);
  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'openai', responsesMode: 'chat' }), true);
  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'openai-responses' }), false);
  assert.strictEqual(shouldConvertResponsesToOpenAIChat({ protocol: 'openai' }), false);
});

test('buffers fragmented Chat tool-call SSE when converting to Responses stream', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { id: 'resp_test', created_at: 1, model: 'client-model', buffer: '', started: false, outputIndex: 0, messageId: null, textItemStarted: false, textItemDone: false, text: '', pendingToolCalls: [], toolCalls: [], completedOutputItems: [], usage: undefined, done: false };
  const event = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';

  processOpenAIChatSseChunkToResponses(clientRes, event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '' } }] }, finish_reason: null }] }), state);
  processOpenAIChatSseChunkToResponses(clientRes, event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q"' } }] }, finish_reason: null }] }), state);
  processOpenAIChatSseChunkToResponses(clientRes, event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] }, finish_reason: null }] }), state);
  processOpenAIChatSseChunkToResponses(clientRes, event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), state);

  assert.strictEqual(state.toolCalls.length, 1);
  assert.strictEqual(state.toolCalls[0].name, 'lookup');
  assert.strictEqual(state.toolCalls[0].arguments, '{"q":"x"}');
  assert.deepStrictEqual(state.completedOutputItems.map((item) => item.type), ['function_call']);
  assert.ok(writes.join('').includes('response.function_call_arguments.done'));
});

test('keeps Responses stream output order across text, tool call, and more text', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(chunk) };
  const state = { id: 'resp_order', created_at: 1, model: 'client-model', buffer: '', started: false, outputIndex: 0, messageId: null, textItemStarted: false, textItemDone: false, text: '', pendingToolCalls: [], toolCalls: [], completedOutputItems: [], usage: undefined, done: false };
  const event = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';

  processOpenAIChatSseChunkToResponses(clientRes, event({ choices: [{ delta: { content: 'before' }, finish_reason: null }] }), state);
  processOpenAIChatSseChunkToResponses(clientRes, event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, finish_reason: null }] }), state);
  processOpenAIChatSseChunkToResponses(clientRes, event({ choices: [{ delta: { content: 'after' }, finish_reason: null }] }), state);
  flushOpenAIChatSseToResponses(clientRes, state);

  assert.deepStrictEqual(state.completedOutputItems.map((item) => item.type), ['message', 'function_call', 'message']);
  assert.strictEqual(state.completedOutputItems[0].content[0].text, 'before');
  assert.strictEqual(state.completedOutputItems[2].content[0].text, 'after');
});

test('parses Gemini rate limit retry metadata', () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: 'Quota exceeded. Please retry in 43.024s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'tokens', quotaId: 'InputTokensPerMinute' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '43s' },
      ],
    },
  });
  const parsed = parseGeminiError(429, body);
  assert.strictEqual(parsed.type, 'rate_limit_error');
  assert.strictEqual(parsed.retryAfterSeconds, 43);
  assert.strictEqual(parsed.quotaId, 'InputTokensPerMinute');
  assert.deepStrictEqual(JSON.parse(geminiErrorToClaude(429, body)).error.type, 'rate_limit_error');
});

test('tracks Gemini local rate limit cooldown', () => {
  const cooldown = setGeminiCooldown('google-gemini', 'gemini-3-flash-preview', 2);
  assert.strictEqual(cooldown.retryAfterSeconds, 2);
  const active = getGeminiCooldown('google-gemini', 'gemini-3-flash-preview');
  assert.ok(active.retryAfterSeconds > 0);
});
test('redacts diagnostics secrets recursively', () => {
  const result = redactDiagnosticsValue({ apiKey: 'secret', headers: { authorization: 'Bearer abc', ok: 'yes' }, nested: [{ 'x-goog-api-key': 'gemini' }] });
  assert.strictEqual(result.apiKey, '[redacted]');
  assert.strictEqual(result.headers.authorization, '[redacted]');
  assert.strictEqual(result.headers.ok, 'yes');
  assert.strictEqual(result.nested[0]['x-goog-api-key'], '[redacted]');
});

test('summarizes Claude tool history diagnostics', () => {
  const summary = summarizeClaudeToolHistory({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'abc' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x', is_error: true }] },
  ] });
  assert.strictEqual(summary.toolUses.length, 2);
  assert.strictEqual(summary.toolResults[0].hasMatchingToolUse, true);
  assert.strictEqual(summary.toolResults[1].hasMatchingToolUse, false);
  assert.deepStrictEqual(summary.duplicateToolUseIds, ['toolu_1']);
});

test('extracts diagnostics only for key SSE events', () => {
  assert.strictEqual(extractDiagnosticsSsePayload('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } }), null);
  const payload = extractDiagnosticsSsePayload('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } });
  assert.strictEqual(payload.event, 'content_block_delta');
  assert.strictEqual(payload.partial_json, '{"command":"ls"}');
  const start = extractDiagnosticsSsePayload('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu', name: 'Bash', input: {} } });
  assert.strictEqual(start.toolUseId, 'toolu');
  assert.strictEqual(start.toolName, 'Bash');
});

test('writes bounded JSONL and rotates oversized diagnostics files', () => {
  const filePath = path.join(os.tmpdir(), 'https-proxy-diagnostics-test-' + process.pid + '-' + Date.now() + '.jsonl');
  const rotated = filePath + '.1';
  try {
    fs.writeFileSync(filePath, 'x'.repeat(2048));
    safeUnlink(rotated);
    assert.strictEqual(writeJsonlBounded(filePath, { ok: true }, 1024), true);
    assert.ok(fs.existsSync(rotated));
    const text = fs.readFileSync(filePath, 'utf8');
    assert.ok(text.includes('"ok":true'));
  } finally {
    safeUnlink(filePath);
    safeUnlink(rotated);
  }
});

if (process.exitCode) process.exit(process.exitCode);
console.log('all tests passed');
