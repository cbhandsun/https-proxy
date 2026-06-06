const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  fileSignature,
  readLastLinesOfJsonl,
  isQuietLocalPollRequest,
  isLocalManagementPath,
  isAllowedManagementOrigin,
} = require('../lib/proxy/management-utils');
const {
  routeMatches,
  dispatchLocalManagementRoute,
} = require('../lib/proxy/management-router');
const {
  parseVersionText,
  isVersionNewer,
} = require('../lib/proxy/env-tools');
const {
  setTomlValue,
  deleteTomlValue,
  setEnvValue,
  deleteEnvValue,
} = require('../lib/proxy/tool-configs');
const {
  getModelRoutes,
} = require('../lib/proxy/config');
const { createGoogleOfficialRuntime } = require('../lib/proxy/google-official-runtime');
const { handleCountTokens } = require('../lib/proxy/local-handlers');
const { createMcpHub, normalizeMcpTool, mergeClaudeTools } = require('../lib/proxy/mcp-hub');
const {
  buildUsageReport,
  extractUsageFromJsonPayload,
  estimateCost,
} = require('../lib/proxy/usage-report');

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
  prepareRequestBufferWithResolver,
  buildLocalModelsResponse,
  buildLocalClaudeModelObject,
  redactDiagnosticsValue,
  summarizeClaudeToolHistory,
  extractDiagnosticsSsePayload,
  writeJsonlBounded,
  flushJsonlWrites,
  parseGeminiError,
  geminiErrorToClaude,
  setGeminiCooldown,
  getGeminiCooldown,
  openAIResponsesToChat,
  openAIChatToResponses,
  openAIChatToResponsesRequest,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  processOpenAIResponsesSseChunkToChat,
  getEntryServers,
  getClaudeDesktopRoutes,
  stripClaudeDesktopPrefix,
  isClaudeDesktopRequest,
  removeClaudeDesktopGatewayProvider,
  claudeDesktopStatusFromConfig,
  shouldConvertResponsesToOpenAIChat,
  parseModelsRequestPath,
  isOpenAIOfficialLoginToken,
  isGoogleOfficialLoginToken,
  shouldUseChatGPTBackendForOfficialLogin,
  officialLoginProvider,
  configuredAuthMode,
  inferOfficialProfileAuthMode,
  getModelsUrl,
  isOpenAIOfficialCodexTarget,
  codexOfficialModelsFromCache,
  buildOpenAIOfficialCodexModelsResponse,
  openAIOfficialCodexModelSupport,
  isTraeOfficialTarget,
  isTraeOfficialProfile,
  normalizeTraeOfficialModelName,
  traeModelsFromStateRows,
  buildTraeOfficialModelsResponseFromRows,
  traeOfficialModelSupport,
  buildTraeBridgePromptFromOpenAIChat,
  buildTraeBridgeOpenAIChatCompletion,
  normalizeTraeBridgeText,
  googleOfficialCodeAssistUrl,
  buildGoogleOfficialModelsResponse,
  googleOfficialModelsFromAvailableModels,
  decodeAntigravityOAuthStateValue,
  buildGoogleOfficialLoadCodeAssistRequest,
  buildGoogleOfficialAvailableModelsRequest,
  buildGoogleOfficialRetrieveUserQuotaRequest,
  formatGoogleOfficialAvailableModels,
  formatGoogleOfficialUserQuota,
  formatCodexLocalRateLimits,
  prioritizeCodexSessionFiles,
  buildModelListRequest,
  buildProfileAuthProbeRequest,
  evaluateOpenAIProfileAuthResponse,
  evaluateGeminiProfileAuthResponse,
  evaluateClaudeProfileAuthResponse,
} = require('../openai-proxy');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
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

  const fixedResolver = () => ({
    profile: { id: 'openai-official', protocol: 'openai', targetUrl: 'https://chatgpt.com/backend-api/codex' },
    route: { from: 'claude-haiku-4-5-20251001', profileId: 'openai-official', to: 'gpt-5.3-codex' }
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

test('builds real upstream model list request for OpenAI compatible APIs', () => {
  assert.strictEqual(getModelsUrl('https://api.openai.com/v1', 'openai'), 'https://api.openai.com/v1/models?limit=1000');
  const request = buildModelListRequest('https://api.openai.com/v1', 'openai', 'sk-proj-test');
  assert.strictEqual(request.method, 'GET');
  assert.strictEqual(request.requestUrl, 'https://api.openai.com/v1/models?limit=1000');
  assert.strictEqual(request.headers.authorization, 'Bearer sk-proj-test');
});

test('builds real upstream model list request for OpenAI official login', () => {
  const request = buildModelListRequest('https://chatgpt.com/backend-api/codex', 'openai', 'eyJhbGciOiJtest');
  assert.strictEqual(request.method, 'GET');
  assert.strictEqual(request.requestUrl, 'https://chatgpt.com/backend-api/models');
  assert.strictEqual(request.headers.authorization, 'Bearer eyJhbGciOiJtest');
});

test('builds real upstream model list request for Gemini API key auth', () => {
  const request = buildModelListRequest('https://generativelanguage.googleapis.com', 'gemini', 'AIza-api-key');
  const url = new URL(request.requestUrl);
  assert.strictEqual(url.origin + url.pathname, 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.strictEqual(url.searchParams.get('pageSize'), '1000');
  assert.strictEqual(url.searchParams.get('key'), 'AIza-api-key');
  assert.strictEqual(request.headers.authorization, undefined);
  assert.strictEqual(request.headers['x-goog-api-key'], undefined);
});

test('builds real upstream model list request for Gemini official login auth', () => {
  const request = buildModelListRequest('https://generativelanguage.googleapis.com', 'gemini', 'ya29.google-token');
  const url = new URL(request.requestUrl);
  assert.strictEqual(url.searchParams.get('key'), null);
  assert.strictEqual(url.searchParams.get('pageSize'), '1000');
  assert.strictEqual(request.headers.authorization, 'Bearer ya29.google-token');
  assert.strictEqual(request.headers['x-goog-api-key'], undefined);
});

test('detects official login tokens separately from API keys', () => {
  assert.strictEqual(isOpenAIOfficialLoginToken('eyJhbGciOiJtest'), true);
  assert.strictEqual(isOpenAIOfficialLoginToken('sk-proj-test'), false);
  assert.strictEqual(isGoogleOfficialLoginToken('ya29.google-token'), true);
  assert.strictEqual(isGoogleOfficialLoginToken('AIza-api-key'), false);
});

test('infers official credential mode from explicit config and upstream protocol', () => {
  assert.strictEqual(configuredAuthMode({ authMode: 'cli' }), 'official-login');
  assert.strictEqual(configuredAuthMode({ credentialMode: 'api-key' }), 'api-key');
  assert.strictEqual(officialLoginProvider({ protocol: 'gemini', authMode: 'official-login' }), 'google');
  assert.strictEqual(officialLoginProvider({ protocol: 'openai', authMode: 'official-login' }), 'openai');
  assert.strictEqual(officialLoginProvider({ protocol: 'trae', authMode: 'official-login' }), 'trae');
  assert.strictEqual(officialLoginProvider({ targetUrl: 'https://coresg-normal.trae.ai', authMode: 'official-login' }), 'trae');
  assert.strictEqual(officialLoginProvider({ protocol: 'gemini', authMode: 'api-key' }), '');
});

test('keeps Gemini API key mode separate from Google official login mode', () => {
  assert.strictEqual(inferOfficialProfileAuthMode({ apiKey: '' }, 'google'), 'official-login');
  assert.strictEqual(inferOfficialProfileAuthMode({ apiKey: 'ya29.google-token' }, 'google'), 'official-login');
  assert.strictEqual(inferOfficialProfileAuthMode({ apiKey: 'AIza-api-key' }, 'google'), 'api-key');
  assert.strictEqual(inferOfficialProfileAuthMode({ authMode: 'api-key', apiKey: '' }, 'google'), 'api-key');
  assert.strictEqual(inferOfficialProfileAuthMode({ authMode: 'official-login', apiKey: 'AIza-api-key' }, 'google'), 'official-login');
});

test('builds OpenAI official login probe against ChatGPT backend models', () => {
  const probe = buildProfileAuthProbeRequest(
    'openai',
    'https://chatgpt.com/backend-api/codex',
    'eyJhbGciOiJtest',
    'gpt-5.3-codex',
    'official-login'
  );
  assert.strictEqual(probe.method, 'GET');
  assert.strictEqual(probe.fullUrl, 'https://chatgpt.com/backend-api/models');
  assert.strictEqual(probe.headers.authorization, 'Bearer eyJhbGciOiJtest');
  assert.strictEqual(probe.requestBody, null);
  assert.strictEqual(shouldUseChatGPTBackendForOfficialLogin('https://api.openai.com/v1'), true);
  assert.strictEqual(shouldUseChatGPTBackendForOfficialLogin('http://127.0.0.1:9999/v1'), false);
});

test('builds OpenAI official Codex model list from Codex cache only', () => {
  const cache = {
    fetched_at: '2026-06-02T13:23:50Z',
    models: [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_in_api: true, visibility: 'list', priority: 2 },
      { slug: 'gpt-5.3-codex-spark', supported_in_api: false, visibility: 'list', priority: 3 },
      { slug: 'codex-auto-review', supported_in_api: true, visibility: 'hide', priority: 4 }
    ]
  };
  const response = buildOpenAIOfficialCodexModelsResponse(cache);
  assert.strictEqual(isOpenAIOfficialCodexTarget('https://chatgpt.com/backend-api/codex'), true);
  assert.strictEqual(isOpenAIOfficialCodexTarget('https://chatgpt.com/backend-api/models'), false);
  assert.deepStrictEqual(response.models, ['gpt-5.5']);
  assert.deepStrictEqual(response.unsupportedModels, ['gpt-5.3-codex-spark']);
  assert.deepStrictEqual(response.hiddenModels, ['codex-auto-review']);
  assert.deepStrictEqual(codexOfficialModelsFromCache(cache).map(m => m.slug), ['gpt-5.5']);
});

test('checks OpenAI official Codex model support using dot slugs', () => {
  const cache = {
    models: [
      { slug: 'gpt-5.5', supported_in_api: true, visibility: 'list' },
      { slug: 'gpt-5.3-codex-spark', supported_in_api: false, visibility: 'list' },
      { slug: 'codex-auto-review', supported_in_api: true, visibility: 'hide' }
    ]
  };
  assert.deepStrictEqual(openAIOfficialCodexModelSupport('codex/gpt-5.5', cache), {
    known: true,
    supported: true,
    model: 'gpt-5.5',
    visibility: 'list',
    supportedInApi: true
  });
  assert.strictEqual(openAIOfficialCodexModelSupport('gpt-5-5', cache).known, false);
  assert.strictEqual(openAIOfficialCodexModelSupport('gpt-5.3-codex-spark', cache).supported, false);
  assert.strictEqual(openAIOfficialCodexModelSupport('codex-auto-review', cache).supported, false);
});

test('builds Trae official model list from Trae state rows', () => {
  const rows = [
    {
      key: '7478324853305803784_AI.agent.model.model_list_map',
      value: JSON.stringify({
        solo_coder: [
          { name: 'gpt-5.4', display_name: 'GPT-5.4', model_type: 'reasoning_model', is_default: true },
          { name: 'gemini-3-pro', display_name: 'Gemini-3-Pro-Preview', model_type: 'reasoning_model' }
        ],
        solo_builder: [
          { name: 'kimi-k2-0905', display_name: 'Kimi-K2-0905', model_type: 'chat_model' }
        ]
      })
    },
    {
      key: 'AI.agent.modelList',
      value: JSON.stringify([
        { name: 'claude3.5', display_name: 'Claude-3.5-Sonnet', model_type: 'chat_model' }
      ])
    }
  ];
  const response = buildTraeOfficialModelsResponseFromRows(rows);
  assert.strictEqual(isTraeOfficialTarget('https://coresg-normal.trae.ai/api/ide/v1'), true);
  assert.strictEqual(isTraeOfficialProfile({ id: 'trae-official' }), true);
  assert.strictEqual(normalizeTraeOfficialModelName('trae/gpt-5.4'), 'gpt-5.4');
  assert.deepStrictEqual(response.models, ['GPT-5.4', 'Gemini-3-Pro-Preview', 'Kimi-K2-0905', 'Claude-3.5-Sonnet']);
  assert.strictEqual(response.modelMap['GPT-5.4'], 'gpt-5.4');
  assert.strictEqual(traeModelsFromStateRows(rows).length, 4);
  assert.deepStrictEqual(traeOfficialModelSupport('trae/GPT-5.4', rows), {
    known: true,
    supported: true,
    model: 'gpt-5.4',
    displayName: 'GPT-5.4',
    modelType: 'reasoning_model'
  });
  assert.strictEqual(traeOfficialModelSupport('gpt-unknown', rows).known, false);
});

test('builds Trae bridge prompt from OpenAI chat request', () => {
  const imageData = 'data:image/png;base64,ZmFrZS1pbWFnZQ==';
  const result = buildTraeBridgePromptFromOpenAIChat({
    messages: [
      { role: 'system', content: 'Use concise Chinese.' },
      { role: 'developer', content: 'Return only the answer.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '分析这个截图' },
          { type: 'image_url', image_url: { url: imageData } }
        ]
      }
    ]
  });
  assert.ok(result.prompt.includes('System:\nUse concise Chinese.'));
  assert.ok(result.prompt.includes('Developer:\nReturn only the answer.'));
  assert.ok(result.prompt.includes('User:\n分析这个截图\n[image]'));
  assert.strictEqual(result.images.length, 1);
  assert.strictEqual(result.images[0].mimeType, 'image/png');
  assert.strictEqual(result.images[0].base64, 'ZmFrZS1pbWFnZQ==');
});

test('builds OpenAI chat completion from Trae bridge text', () => {
  assert.strictEqual(normalizeTraeBridgeText({ ok: true, text: '你好' }), '你好');
  const response = buildTraeBridgeOpenAIChatCompletion({ model: 'trae/GPT-5.4' }, '桥接成功', 'gpt-5.4');
  assert.strictEqual(response.object, 'chat.completion');
  assert.strictEqual(response.model, 'gpt-5.4');
  assert.strictEqual(response.choices[0].message.role, 'assistant');
  assert.strictEqual(response.choices[0].message.content, '桥接成功');
});

test('formats Codex local session rate limits as OpenAI window limits', () => {
  const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const reset5h = Math.round((nowMs + 2 * 3600 * 1000) / 1000);
  const resetWeek = Math.round((nowMs + 5 * 86400 * 1000) / 1000);
  const resetDate = new Date(reset5h * 1000);
  const expectedResetDisplay = `${String(resetDate.getHours()).padStart(2, '0')}:${String(resetDate.getMinutes()).padStart(2, '0')}`;
  const limits = formatCodexLocalRateLimits({
    limit_id: 'codex',
    plan_type: 'prolite',
    primary: { used_percent: 30, window_minutes: 300, resets_at: reset5h },
    secondary: { used_percent: 14, window_minutes: 10080, resets_at: resetWeek }
  }, nowMs);
  assert.deepStrictEqual(limits.map(item => item.window), ['5小时', '1周']);
  assert.deepStrictEqual(limits.map(item => item.percent), [70, 86]);
  assert.deepStrictEqual(limits.map(item => item.usedPercent), [30, 14]);
  assert.strictEqual(limits[0].resetIn, '2h0m');
  assert.strictEqual(limits[0].resetDisplay, expectedResetDisplay);
  assert.strictEqual(limits[0].planType, 'prolite');
});

test('prioritizes Codex rate limits from the current thread session', () => {
  const current = path.join('sessions', 'rollout-2026-06-02T00-29-10-019e873c-6f4f-7f31-9826-22cd50aae934.jsonl');
  const other = path.join('sessions', 'rollout-2026-06-02T02-41-37-019e87b5-b333-7600-bf25-f00573708191.jsonl');
  const ordered = prioritizeCodexSessionFiles([other, current], '019e873c-6f4f-7f31-9826-22cd50aae934');
  assert.strictEqual(ordered[0], current);
});

test('builds Google official login model list from official config', () => {
  const response = buildGoogleOfficialModelsResponse();
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.authMode, 'official-login');
  assert.strictEqual(response.source, 'official-model-config');
  assert.ok(response.models.includes('Gemini 3.5 Flash (Medium)'));
  assert.ok(response.models.includes('gemini-3.5-flash-low'));
  assert.ok(response.models.includes('gemini-3-flash-agent'));
  assert.ok(response.models.includes('gemini-3.5-flash-extra-low'));
  assert.ok(response.models.includes('gemini-3.1'));
  assert.ok(response.models.includes('gemini-3.1-pro-low'));
});

test('maps Google official available models using AGY model ids and labels', () => {
  const models = googleOfficialModelsFromAvailableModels({
    models: {
      'gemini-3.5-flash-low': { displayName: 'Gemini 3.5 Flash (Medium)' },
      'gemini-3-flash-agent': { displayName: 'Gemini 3.5 Flash (High)' },
      'gemini-3.5-flash-extra-low': { displayName: 'Gemini 3.5 Flash (Low)' }
    }
  });
  assert.ok(models.includes('Gemini 3.5 Flash (Medium)'));
  assert.ok(models.includes('gemini-3.5-flash-low'));
  assert.ok(models.includes('gemini-3-flash-agent'));
  assert.ok(models.includes('gemini-3.5-flash-extra-low'));
});

test('decodes Antigravity OAuth state payload without Gemini CLI credentials', () => {
  const toBase64Url = (value) => Buffer.from(value).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const inner = toBase64Url('token ya29.test-access Bearer refresh 1//test-refresh ' + 'x'.repeat(96));
  const outer = Buffer.from(`oauthTokenInfoSentinelKey ${inner}`).toString('base64');
  const creds = decodeAntigravityOAuthStateValue(outer);
  assert.strictEqual(creds.access_token, 'ya29.test-access');
  assert.strictEqual(creds.refresh_token, '1//test-refresh');
  assert.ok(creds.client_id.includes('apps.googleusercontent.com'));
  assert.strictEqual(creds.__readOnly, true);
});

test('caches refreshed Antigravity official access token in process', async () => {
  let refreshCalls = 0;
  const runtime = createGoogleOfficialRuntime({
    makeRequest: async () => {
      refreshCalls += 1;
      return {
        statusCode: 200,
        body: JSON.stringify({ access_token: 'ya29.fresh-' + refreshCalls, expires_in: 3600 })
      };
    },
    googleOfficialCodeAssistUrl,
    googleOfficialModelsFromAvailableModels,
    readAntigravityOfficialCredentialState: () => ({
      credsPath: null,
      source: 'antigravity-state',
      content: {
        access_token: 'ya29.old',
        refresh_token: '1//same-refresh',
        token_type: 'Bearer',
        __readOnly: true,
        __source: 'antigravity-state',
        expiry_date: 1
      }
    }),
    isGoogleOfficialLoginToken,
    buildGoogleOfficialLoadCodeAssistRequest,
  });

  assert.strictEqual(await runtime.getFreshAntigravityOfficialAccessToken(), 'ya29.fresh-1');
  assert.strictEqual(await runtime.getFreshAntigravityOfficialAccessToken(), 'ya29.fresh-1');
  assert.strictEqual(refreshCalls, 1);
});

test('builds Google official login Code Assist probe instead of public Gemini API', () => {
  const probe = buildGoogleOfficialLoadCodeAssistRequest('ya29.google-token');
  assert.strictEqual(googleOfficialCodeAssistUrl('loadCodeAssist'), 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  assert.strictEqual(probe.method, 'POST');
  assert.strictEqual(probe.fullUrl, 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  assert.strictEqual(probe.headers.authorization, 'Bearer ya29.google-token');
  assert.strictEqual(probe.headers['content-type'], 'application/json');
  const body = JSON.parse(probe.requestBody);
  assert.strictEqual(body.mode, 'HEALTH_CHECK');
  assert.strictEqual(body.metadata.pluginType, 'GEMINI');
});

test('builds Google official quota requests for Antigravity backend', () => {
  const available = buildGoogleOfficialAvailableModelsRequest('ya29.google-token', 'project-1');
  assert.strictEqual(available.method, 'POST');
  assert.strictEqual(available.fullUrl, 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
  assert.strictEqual(available.headers.authorization, 'Bearer ya29.google-token');
  assert.deepStrictEqual(JSON.parse(available.requestBody), { project: 'project-1' });

  const quota = buildGoogleOfficialRetrieveUserQuotaRequest('ya29.google-token', 'project-1');
  assert.strictEqual(quota.fullUrl, 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
  assert.deepStrictEqual(JSON.parse(quota.requestBody), { project: 'project-1', userAgent: 'antigravity' });
});

test('formats Google official available model quota as remaining percent', () => {
  const limits = formatGoogleOfficialAvailableModels({
    models: {
      'chat_20706': {
        displayName: 'chat_20706',
        quotaInfo: { remainingFraction: 1 }
      },
      'tab_flash_lite_preview': {
        displayName: 'tab_flash_lite_preview',
        quotaInfo: { remainingFraction: 1 }
      },
      'gemini-3-pro-high': {
        displayName: 'Gemini 3 Pro High',
        quotaInfo: { remainingFraction: 0.12, resetTime: '2999-01-01T00:00:00Z' }
      },
      'gemini-3-pro-agent': {
        displayName: 'Gemini 3 Pro High',
        quotaInfo: { remainingFraction: 0.12, resetTime: '2999-01-01T00:00:00Z' }
      },
      'claude-sonnet-4-6-thinking': {
        displayName: 'Claude Sonnet 4.6 Thinking',
        quotaInfo: { remainingFraction: 0.75, resetTime: '2999-01-01T00:00:00Z' }
      }
    }
  });
  assert.strictEqual(limits.length, 2);
  assert.strictEqual(limits.some(item => item.modelId.startsWith('chat_')), false);
  assert.strictEqual(limits.some(item => item.modelId.startsWith('tab_')), false);
  const low = limits.find(item => item.modelId === 'gemini-3-pro-high');
  assert.strictEqual(low.remainingPercent, 12);
  assert.strictEqual(low.percent, 12);
  assert.notStrictEqual(low.resetIn, '2h2m');
});

test('formats Google official user quota buckets as remaining percent fallback', () => {
  const limits = formatGoogleOfficialUserQuota({
    buckets: [{
      modelId: 'gemini-3-flash',
      remainingFraction: 0.25,
      remainingAmount: '25',
      resetTime: '2999-01-01T00:00:00Z'
    }]
  });
  assert.strictEqual(limits[0].model, 'gemini-3-flash');
  assert.strictEqual(limits[0].remainingPercent, 25);
  assert.strictEqual(limits[0].remainingAmount, '25');
});

test('builds Gemini official login probe through Code Assist backend', () => {
  const probe = buildProfileAuthProbeRequest(
    'gemini',
    'https://generativelanguage.googleapis.com',
    'ya29.google-token',
    'models/gemini-2.5-pro',
    'official-login'
  );
  assert.strictEqual(probe.method, 'POST');
  assert.strictEqual(probe.fullUrl, 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  assert.strictEqual(probe.headers.authorization, 'Bearer ya29.google-token');
  assert.strictEqual(probe.headers['content-type'], 'application/json');
  assert.strictEqual(probe.fullUrl.includes('generativelanguage.googleapis.com'), false);
});

test('builds Gemini API key probe with key query param', () => {
  const probe = buildProfileAuthProbeRequest(
    'gemini',
    'https://generativelanguage.googleapis.com',
    'AIza-api-key',
    'gemini-2.5-flash',
    'api-key'
  );
  const url = new URL(probe.fullUrl);
  assert.strictEqual(probe.method, 'POST');
  assert.strictEqual(url.searchParams.get('key'), 'AIza-api-key');
  assert.strictEqual(probe.headers.authorization, undefined);
});

test('evaluates OpenAI official login probe responses without rejecting network-side blocks', () => {
  const success = evaluateOpenAIProfileAuthResponse(
    { statusCode: 200, headers: {}, body: JSON.stringify({ models: [{ slug: 'gpt-5.3-codex' }] }) },
    { testModel: 'gpt-5.3-codex', authMode: 'official-login' }
  );
  assert.deepStrictEqual(success, {
    ok: true,
    authMode: 'official-login',
    message: '官方登录凭证有效，模型 gpt-5.3-codex 已在后台列表中。'
  });

  const cloudflare = evaluateOpenAIProfileAuthResponse(
    { statusCode: 403, headers: { 'content-type': 'text/html' }, body: '<html>blocked</html>' },
    { testModel: 'gpt-5.3-codex', authMode: 'official-login' }
  );
  assert.strictEqual(cloudflare.ok, true);
  assert.strictEqual(cloudflare.authMode, 'official-login');
  assert.ok(cloudflare.warning.includes('403'));
});

test('evaluates Gemini Code Assist profile auth responses', () => {
  const ok = evaluateGeminiProfileAuthResponse(
    { statusCode: 200, headers: {}, body: '{}' },
    {
      authMode: 'official-login',
      probeFullUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
    }
  );
  assert.deepStrictEqual(ok, {
    ok: true,
    authMode: 'official-login',
    source: 'code-assist',
    message: 'Google 官方登录凭证有效，Code Assist/Antigravity 后端可达。'
  });

  const failed = evaluateGeminiProfileAuthResponse(
    { statusCode: 401, headers: {}, body: JSON.stringify([{ error: { message: 'invalid oauth' } }]) },
    {
      authMode: 'official-login',
      probeFullUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
    }
  );
  assert.deepStrictEqual(failed, {
    ok: false,
    authMode: 'official-login',
    source: 'code-assist',
    error: 'Google 官方登录后端探测失败 HTTP 401: invalid oauth'
  });
});

test('evaluates Claude profile auth error responses', () => {
  const result = evaluateClaudeProfileAuthResponse(
    { statusCode: 404, headers: {}, body: JSON.stringify({ error: { message: 'model not found' } }) },
    { testModel: 'claude-3-5-sonnet-20241022' }
  );
  assert.deepStrictEqual(result, {
    ok: false,
    error: 'HTTP 404: model not found'
  });
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

test('carries Claude Desktop display labels into regular Claude model discovery', () => {
  const routes = getModelRoutes({
    modelRoutes: [
      { from: 'claude-opus-4-7', profileId: 'openai-official', to: 'gpt-5.5' },
    ],
    claudeDesktop: {
      models: [
        { routeId: 'claude-opus-4-7', labelOverride: 'GPT-5.5', supports1m: true },
      ],
    },
  });

  assert.strictEqual(routes[0].labelOverride, 'GPT-5.5');
  assert.strictEqual(routes[0].supports1m, true);
  assert.deepStrictEqual(buildLocalModelsResponse(routes, 'claude').data[0], {
    id: 'claude-opus-4-7',
    type: 'model',
    display_name: 'GPT-5.5',
    created_at: '1970-01-01T00:00:00.000Z',
    supports1m: true,
  });
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

test('maps Chat image URLs to Responses input_image URL strings', () => {
  const result = openAIChatToResponsesRequest({
    model: 'client-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
      ],
    }],
  });

  assert.deepStrictEqual(result.input[0].content, [
    { type: 'input_text', text: 'describe' },
    { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
  ]);
});

test('maps Chat tool call ids to Responses function-call item ids', () => {
  const result = openAIChatToResponsesRequest({
    model: 'client-model',
    messages: [
      { role: 'user', content: 'lookup' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_nbeAei9W3PPIiz5JVyTrNrfb',
          type: 'function',
          function: { name: 'builtin_web_search', arguments: '{"q":"x"}' },
        }],
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
  assert.ok(result.output[1].id.startsWith('fc_'));
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
        { routeId: 'claude-opus-4-6-thinking', profileId: 'yhrouter', upstreamModel: 'gpt-5.6', labelOverride: 'GPT-5.6' },
      ],
    },
  });

  assert.deepStrictEqual(routes.map((route) => route.from), ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-6-thinking']);
  assert.strictEqual(routes[0].to, 'gpt-5.5');
  assert.strictEqual(routes[0].labelOverride, 'GPT-5.5');
  assert.strictEqual(routes[1].supports1m, false);
  assert.strictEqual(routes[2].to, 'gpt-5.6');
  assert.strictEqual(routes[2].labelOverride, 'GPT-5.6');
});

test('inherits Claude Desktop upstream routing from global routes while keeping labels and 1M flag', () => {
  const routes = getClaudeDesktopRoutes({
    activeProfile: 'yhrouter',
    profiles: [{ id: 'yhrouter' }],
    modelRoutes: [
      { from: 'claude-opus-4-6-thinking', profileId: 'openai-official', to: 'gpt-5.6' },
    ],
    claudeDesktop: {
      models: [
        { routeId: 'claude-opus-4-6-thinking', labelOverride: 'GPT-5.6 Thinking', supports1m: false },
      ],
    },
  });

  assert.deepStrictEqual(routes, [{
    from: 'claude-opus-4-6-thinking',
    profileId: 'openai-official',
    to: 'gpt-5.6',
    labelOverride: 'GPT-5.6 Thinking',
    supports1m: false,
  }]);
});

test('detects and strips Claude Desktop gateway prefix', () => {
  assert.strictEqual(isClaudeDesktopRequest({ protocol: 'claude-desktop' }, '/v1/messages'), true);
  assert.strictEqual(isClaudeDesktopRequest({ protocol: 'claude' }, '/claude-desktop/v1/messages'), true);
  assert.strictEqual(stripClaudeDesktopPrefix('/claude-desktop/v1/models'), '/v1/models');
});

test('classifies and removes Claude Desktop gateway config', () => {
  const proxyStatus = claudeDesktopStatusFromConfig({
    primaryProvider: 'gateway',
    providers: {
      gateway: {
        inferenceGatewayBaseUrl: 'https://localhost:3443/claude-desktop',
        inferenceGatewayApiKey: 'hpm-test',
      },
      other: { keep: true },
    },
  }, true, 'claude_desktop_config.json');
  assert.strictEqual(proxyStatus.mode, 'proxy');
  assert.strictEqual(proxyStatus.gatewayUrl, 'https://localhost:3443/claude-desktop');
  assert.strictEqual(proxyStatus.hasToken, true);

  const directStatus = claudeDesktopStatusFromConfig({
    primaryProvider: 'gateway',
    providers: {
      gateway: {
        inferenceGatewayBaseUrl: 'https://api.anthropic.com',
      },
    },
  }, true, 'claude_desktop_config.json');
  assert.strictEqual(directStatus.mode, 'direct');

  const restored = removeClaudeDesktopGatewayProvider({
    primaryProvider: 'gateway',
    providers: {
      gateway: { inferenceGatewayBaseUrl: 'https://localhost:3443' },
      custom: { keep: true },
    },
  });
  assert.deepStrictEqual(restored, { providers: { custom: { keep: true } } });
  assert.deepStrictEqual(removeClaudeDesktopGatewayProvider({ primaryProvider: 'gateway', providers: { gateway: {} } }), {});
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

test('waits for Responses function_call name before emitting Chat tool call', () => {
  const writes = [];
  const clientRes = { write: (chunk) => writes.push(String(chunk)) };
  const state = { id: 'chatcmpl_test', created: 1, model: 'client-model', buffer: '', started: false, toolCalls: [], usage: null, done: false };
  const event = (payload) => 'event: ' + payload.type + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  const args = JSON.stringify({ file_path: 'E:/DEV/WorkSpace/Efficiency/package.json', offset: 0, limit: 2400 });

  processOpenAIResponsesSseChunkToChat(clientRes, event({
    type: 'response.function_call_arguments.delta',
    item_id: 'call_1',
    delta: args,
  }), state);
  assert.strictEqual(writes.some((chunk) => chunk.includes('tool_calls')), false);

  processOpenAIResponsesSseChunkToChat(clientRes, event({
    type: 'response.output_item.done',
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: args },
  }), state);

  const output = writes.join('');
  assert.ok(output.includes('"name":"Read"'));
  assert.strictEqual(output.includes('"name":"tool"'), false);
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

test('writes bounded JSONL and rotates oversized diagnostics files', async () => {
  const filePath = path.join(os.tmpdir(), 'https-proxy-diagnostics-test-' + process.pid + '-' + Date.now() + '.jsonl');
  const rotated = filePath + '.1';
  try {
    fs.writeFileSync(filePath, 'x'.repeat(2048));
    safeUnlink(rotated);
    assert.strictEqual(writeJsonlBounded(filePath, { ok: true }, 1024), true);
    await flushJsonlWrites();
    assert.ok(fs.existsSync(rotated));
    const text = fs.readFileSync(filePath, 'utf8');
    assert.ok(text.includes('"ok":true'));
  } finally {
    safeUnlink(filePath);
    safeUnlink(rotated);
  }
});

test('reads JSONL tail records and reports file signatures', () => {
  const filePath = path.join(os.tmpdir(), 'https-proxy-management-utils-test-' + process.pid + '-' + Date.now() + '.jsonl');
  try {
    fs.writeFileSync(filePath, [
      JSON.stringify({ index: 1 }),
      JSON.stringify({ index: 2 }),
      JSON.stringify({ index: 3 }),
      ''
    ].join('\n'));
    assert.notStrictEqual(fileSignature(filePath), 'missing');
    assert.deepStrictEqual(readLastLinesOfJsonl(filePath, 2).map((item) => item.index), [2, 3]);
  } finally {
    safeUnlink(filePath);
  }
});

test('identifies quiet management polling endpoints', () => {
  assert.strictEqual(isLocalManagementPath('/v1/local/config'), true);
  assert.strictEqual(isLocalManagementPath('/local/events?after=1'), true);
  assert.strictEqual(isLocalManagementPath('/v1/messages'), false);
  assert.strictEqual(isQuietLocalPollRequest('GET', '/v1/local/cli/sessions'), true);
  assert.strictEqual(isQuietLocalPollRequest('HEAD', '/local/events'), true);
  assert.strictEqual(isQuietLocalPollRequest('GET', '/v1/local/log'), true);
  assert.strictEqual(isQuietLocalPollRequest('GET', '/v1/local/audit/conversations'), true);
  assert.strictEqual(isQuietLocalPollRequest('GET', '/v1/local/usage/report'), true);
  assert.strictEqual(isQuietLocalPollRequest('POST', '/v1/local/config'), false);
  assert.strictEqual(isQuietLocalPollRequest('GET', '/v1/messages'), false);
});

test('logs request_end for local count_tokens responses', () => {
  const chunks = [];
  const headers = [];
  const events = [];
  const req = { method: 'POST', url: '/v1/messages/count_tokens?beta=true' };
  const res = {
    writeHead(statusCode, nextHeaders) {
      headers.push({ statusCode, headers: nextHeaders });
    },
    end(body) {
      chunks.push(body);
    },
  };
  handleCountTokens(
    req,
    res,
    Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hello world' }] })),
    (value) => String(value || '').split(/\s+/).filter(Boolean).length,
    (method, requestPath, startTime, statusCode, extra) => events.push({ method, requestPath, startTime, statusCode, extra }),
    Date.now()
  );

  assert.strictEqual(headers[0].statusCode, 200);
  assert.deepStrictEqual(JSON.parse(chunks[0]), { input_tokens: 2 });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].requestPath, '/v1/messages/count_tokens?beta=true');
  assert.strictEqual(events[0].statusCode, 200);
  assert.strictEqual(events[0].extra.type, 'local_count_tokens');
  assert.strictEqual(events[0].extra.inputTokens, 2);
});

test('normalizes and merges MCP tools as Claude tool declarations', () => {
  const server = { id: 'local', prefix: 'fs' };
  const normalized = normalizeMcpTool({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  }, server);
  assert.deepStrictEqual(normalized, {
    name: 'fs_read_file',
    description: 'Read a file',
    input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  });

  const merged = mergeClaudeTools([
    { name: 'Read', input_schema: { type: 'object', properties: {} } },
  ], [
    { name: 'Read', input_schema: { type: 'object', properties: { duplicate: { type: 'string' } } } },
    normalized,
  ]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[1].name, 'fs_read_file');
});

test('injects MCP tools into Claude request bodies', async () => {
  const server = require('http').createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      assert.strictEqual(parsed.method, 'tools/list');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: {
          tools: [{
            name: 'search_docs',
            description: 'Search docs',
            input_schema: { type: 'object', properties: { q: { type: 'string' } } },
          }],
        },
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const hub = createMcpHub({
      getConfig: () => ({
        mcpHub: {
          servers: [{ id: 'docs', url: `http://127.0.0.1:${address.port}`, injectAll: true, prefix: 'docs' }],
          routing: [],
        },
      }),
    });
    assert.strictEqual(typeof hub.augmentRequestTools, 'function');
    const augmented = await hub.augmentRequestTools({ model: 'claude-sonnet', tools: [] });
    assert.deepStrictEqual(augmented.tools, [{
      name: 'docs_search_docs',
      description: 'Search docs',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('allows only local management origins by default', () => {
  assert.strictEqual(isAllowedManagementOrigin('http://localhost:1430'), true);
  assert.strictEqual(isAllowedManagementOrigin('https://127.0.0.1:3443'), true);
  assert.strictEqual(isAllowedManagementOrigin('tauri://localhost'), true);
  assert.strictEqual(isAllowedManagementOrigin('https://example.com'), false);
  assert.strictEqual(isAllowedManagementOrigin('null'), false);
});

test('dispatches local management routes from a route table', () => {
  const route = { method: 'GET', paths: ['/v1/local/auth/rate-limits'], match: 'prefix' };
  assert.strictEqual(routeMatches(route, 'GET', '/v1/local/auth/rate-limits?profileId=codex'), true);
  assert.strictEqual(routeMatches(route, 'POST', '/v1/local/auth/rate-limits'), false);
  assert.strictEqual(routeMatches({ method: 'GET', paths: ['/v1/local/usage/report'] }, 'GET', '/v1/local/usage/report'), true);

  const calls = [];
  const req = {};
  const res = {};
  const handled = dispatchLocalManagementRoute({
    method: 'GET',
    pathname: '/v1/local/health',
    req,
    res,
    handlers: {
      health: (nextReq, nextRes) => calls.push([nextReq === req, nextRes === res]),
    },
  });
  assert.strictEqual(handled, true);
  assert.deepStrictEqual(calls, [[true, true]]);
  assert.strictEqual(dispatchLocalManagementRoute({ method: 'GET', pathname: '/v1/messages', req, res, handlers: {} }), false);
});

test('usage report aggregates provider usage and model pricing by profile', () => {
  const usage = extractUsageFromJsonPayload({ usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } });
  assert.deepStrictEqual(usage, {
    inputTokens: 1000,
    outputTokens: 500,
    cachedInputTokens: 0,
    totalTokens: 1500,
    source: 'provider',
  });

  const cost = estimateCost(usage, 'gpt-5-mini', {});
  assert.strictEqual(cost.known, true);
  assert.ok(cost.amount > 0);

  const report = buildUsageReport([
    {
      id: 'req-1',
      time: '2026-06-05T10:00:00.000Z',
      profileId: 'openai-main',
      profileName: 'OpenAI Main',
      originalModel: 'gpt-5-mini',
      rewriteModel: 'gpt-5-mini',
      protocol: 'openai',
      statusCode: 200,
      usage,
    },
    {
      id: 'req-2',
      time: '2026-06-05T11:00:00.000Z',
      profileId: 'openai-main',
      profileName: 'OpenAI Main',
      originalModel: 'gpt-5-mini',
      statusCode: 500,
      messages: [{ role: 'user', content: 'hello' }],
      response: { content: 'error' },
    },
  ], {});

  assert.strictEqual(report.total.requests, 2);
  assert.strictEqual(report.total.successes, 1);
  assert.strictEqual(report.total.errors, 1);
  assert.strictEqual(report.byProfile[0].key, 'openai-main');
  assert.ok(report.total.inputTokens >= 1000);
  assert.ok(report.total.cost > 0);
});

test('parses and compares environment tool versions', () => {
  assert.strictEqual(parseVersionText('claude 1.2.3'), '1.2.3');
  assert.strictEqual(parseVersionText('0.7.1-beta.2'), '0.7.1-beta.2');
  assert.strictEqual(isVersionNewer('1.2.3', '1.2.4'), true);
  assert.strictEqual(isVersionNewer('1.3.0', '1.2.9'), false);
  assert.strictEqual(isVersionNewer('1.2.3', '1.2.3'), false);
});

test('updates TOML and env values for local tool proxy config', () => {
  const toml = 'theme = "dark"\nbase_url = "https://old.example"\n';
  const updatedToml = setTomlValue(toml, 'base_url', 'https://localhost:3447');
  assert.strictEqual(updatedToml, 'theme = "dark"\nbase_url = "https://localhost:3447"\n');
  assert.strictEqual(setTomlValue('', 'model_provider', 'custom'), '\nmodel_provider = "custom"\n');
  assert.strictEqual(deleteTomlValue(updatedToml, 'base_url'), 'theme = "dark"\n');

  const env = 'KEEP=yes\nGOOGLE_GEMINI_BASE_URL=https://old.example\n';
  const updatedEnv = setEnvValue(env, 'GOOGLE_GEMINI_BASE_URL', 'https://localhost:3443');
  assert.strictEqual(updatedEnv, 'KEEP=yes\nGOOGLE_GEMINI_BASE_URL=https://localhost:3443\n');
  assert.strictEqual(setEnvValue('', 'ANTHROPIC_BASE_URL', 'https://localhost:3443'), '\nANTHROPIC_BASE_URL=https://localhost:3443\n');
  assert.strictEqual(deleteEnvValue(updatedEnv, 'GOOGLE_GEMINI_BASE_URL'), 'KEEP=yes\n');
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
  console.log('all tests passed');
  process.exit(0);
})();
