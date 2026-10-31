'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const {
  createTianxiNativeClaudeSessions,
  convertClaudeToolsToMcp,
  formatClaudeMessagesPrompt,
  writeClaudeMessageJsonResponse,
  writeClaudeMessageStream,
  resolveSdkModelId,
} = require('../lib/proxy/tianxi-native-claude-session');

function createMockResponse() {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 0;
  res.body = '';
  res.writeHead = function (code, headers) {
    this.statusCode = code;
    Object.assign(this.headers, headers);
  };
  res.write = function (chunk) {
    this.body += chunk;
  };
  res.end = function (chunk = '') {
    this.body += chunk;
    this.emit('finish');
  };
  return res;
}

test('convertClaudeToolsToMcp converts tools with input_schema to inputSchema', () => {
  const claudeTools = [
    {
      name: 'read_file',
      description: 'Read file from disk',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ];
  const mcpTools = convertClaudeToolsToMcp(claudeTools);
  assert.equal(mcpTools.length, 1);
  assert.equal(mcpTools[0].name, 'read_file');
  assert.equal(mcpTools[0].description, 'Read file from disk');
  assert.deepEqual(mcpTools[0].inputSchema, claudeTools[0].input_schema);
});

test('resolveSdkModelId maps aliases and defaults', () => {
  assert.equal(resolveSdkModelId('tianxi/qwen3.8-flash'), 'qfmodel');
  assert.equal(resolveSdkModelId('tianxi/deepseek-flash'), 'dfmodel');
  assert.equal(resolveSdkModelId('tianxi/deepseek-v4-pro'), 'dmodel');
  assert.equal(resolveSdkModelId('unknown-alias'), 'qfmodel');
});

test('formatClaudeMessagesPrompt formats text and tool results', () => {
  const messages = [
    { role: 'user', content: 'Read file package.json' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading file now.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'package.json' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"name": "test"}' },
      ],
    },
  ];
  const prompt = formatClaudeMessagesPrompt(messages);
  assert.ok(prompt.includes('User: Read file package.json'));
  assert.ok(prompt.includes('Assistant: Reading file now.'));
  assert.ok(prompt.includes('[Assistant Tool Call read_file (toolu_1)]'));
  assert.ok(prompt.includes('[Tool Result for toolu_1]:\n{"name": "test"}'));
});

test('handles full Claude tool call and continuation lifecycle', async () => {
  let pendingToolResolve;
  const mockRun = async ({ tools, onCall, signal }) => {
    // Model calls the tool
    const toolResult = await onCall('read_file', { path: 'package.json' }, { signal });
    // Model receives tool result and finishes
    return {
      finalText: `Found file content: ${toolResult.content[0].text}`,
    };
  };

  const sessions = createTianxiNativeClaudeSessions({ run: mockRun });

  // Turn 1: initial message with tool definition
  const step1 = await sessions.handleClaudeRequest(
    {
      model: 'tianxi/qwen3.8-flash',
      messages: [{ role: 'user', content: 'Check package.json' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read file',
          input_schema: { type: 'object' },
        },
      ],
    },
    'test-owner'
  );

  assert.ok(step1.toolCall, 'Expected tool call in step 1');
  assert.equal(step1.toolCall.name, 'read_file');
  assert.deepEqual(step1.toolCall.input, { path: 'package.json' });
  assert.ok(step1.toolCall.id.startsWith('toolu_'));

  // Verify writeClaudeMessageJsonResponse produces valid Claude message response
  const jsonRes = createMockResponse();
  writeClaudeMessageJsonResponse(jsonRes, step1, 'tianxi/qwen3.8-flash');
  const jsonBody = JSON.parse(jsonRes.body);
  assert.equal(jsonBody.type, 'message');
  assert.equal(jsonBody.role, 'assistant');
  assert.equal(jsonBody.stop_reason, 'tool_use');
  assert.equal(jsonBody.content[0].type, 'tool_use');
  assert.equal(jsonBody.content[0].name, 'read_file');

  // Verify writeClaudeMessageStream produces valid SSE events
  const sseRes = createMockResponse();
  writeClaudeMessageStream(sseRes, step1, 'tianxi/qwen3.8-flash');
  assert.ok(sseRes.body.includes('event: message_start'));
  assert.ok(sseRes.body.includes('event: content_block_start'));
  assert.ok(sseRes.body.includes('"type":"tool_use"'));
  assert.ok(sseRes.body.includes('event: content_block_delta'));
  assert.ok(sseRes.body.includes('"type":"input_json_delta"'));
  assert.ok(sseRes.body.includes('event: message_delta'));
  assert.ok(sseRes.body.includes('"stop_reason":"tool_use"'));
  assert.ok(sseRes.body.includes('event: message_stop'));

  // Turn 2: client returns tool_result
  const step2 = await sessions.handleClaudeRequest(
    {
      model: 'tianxi/qwen3.8-flash',
      messages: [
        { role: 'user', content: 'Check package.json' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: step1.toolCall.id,
              name: 'read_file',
              input: { path: 'package.json' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: step1.toolCall.id,
              content: '{"version": "1.0.0"}',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read file',
          input_schema: { type: 'object' },
        },
      ],
    },
    'test-owner'
  );

  assert.ok(!step2.toolCall, 'Step 2 should be final text, not tool call');
  assert.ok(step2.text.includes('Found file content: {"version": "1.0.0"}'));

  // Verify final text streaming
  const finalSseRes = createMockResponse();
  writeClaudeMessageStream(finalSseRes, step2, 'tianxi/qwen3.8-flash');
  assert.ok(finalSseRes.body.includes('event: message_start'));
  assert.ok(finalSseRes.body.includes('event: content_block_start'));
  assert.ok(finalSseRes.body.includes('event: content_block_delta'));
  assert.ok(finalSseRes.body.includes('Found file content'));
  assert.ok(finalSseRes.body.includes('"stop_reason":"end_turn"'));
  assert.ok(finalSseRes.body.includes('event: message_stop'));
});
