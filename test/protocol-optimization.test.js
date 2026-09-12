const assert = require('assert');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { cleanToolArgs } = require('../lib/proxy/tools');
const { resolveUpstreamRecovery, shouldAllowFailover } = require('../lib/proxy/upstream-retry');
const { usageFromSsePayload } = require('../lib/proxy/usage-report');
const {
  createConversationAuditData,
  installConversationAuditResponseCapture,
} = require('../lib/proxy/conversation-audit-utils');

function testClaudeConsecutiveRoleMerging() {
  const protocol = createOpenAIProtocol({ cleanToolArgs });

  // Case 1: Multiple consecutive tool outputs
  const bodyWithMultipleTools = {
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: 'Please read files.' },
      {
        role: 'assistant',
        content: 'I will read them.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"file":"a.txt"}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'read', arguments: '{"file":"b.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'content a' },
      { role: 'tool', tool_call_id: 'call_2', content: 'content b' },
    ],
  };

  const claudeBody = protocol.openAIChatToClaudeMessages(
    bodyWithMultipleTools,
    'claude-sonnet-4-6'
  );
  assert.strictEqual(
    claudeBody.messages.length,
    3,
    'Consecutive tool results should merge into a single user message'
  );
  assert.strictEqual(claudeBody.messages[0].role, 'user');
  assert.strictEqual(claudeBody.messages[1].role, 'assistant');
  assert.strictEqual(claudeBody.messages[2].role, 'user');
  assert.strictEqual(Array.isArray(claudeBody.messages[2].content), true);
  assert.strictEqual(claudeBody.messages[2].content.length, 2);
  assert.strictEqual(claudeBody.messages[2].content[0].type, 'tool_result');
  assert.strictEqual(claudeBody.messages[2].content[0].tool_use_id, 'call_1');
  assert.strictEqual(claudeBody.messages[2].content[1].type, 'tool_result');
  assert.strictEqual(claudeBody.messages[2].content[1].tool_use_id, 'call_2');

  // Case 2: Consecutive user messages
  const bodyWithConsecutiveUsers = {
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'World' },
    ],
  };
  const mergedUsers = protocol.openAIChatToClaudeMessages(
    bodyWithConsecutiveUsers,
    'claude-sonnet-4-6'
  );
  assert.strictEqual(mergedUsers.messages.length, 1);
  assert.strictEqual(mergedUsers.messages[0].role, 'user');
  assert.strictEqual(Array.isArray(mergedUsers.messages[0].content), true);
  assert.strictEqual(mergedUsers.messages[0].content.length, 2);
  assert.strictEqual(mergedUsers.messages[0].content[0].text, 'Hello');
  assert.strictEqual(mergedUsers.messages[0].content[1].text, 'World');
}

function testAllowPostFailover() {
  const backup = { id: 'backup-profile' };
  const baseOptions = {
    kind: 'status',
    statusCode: 504,
    attempt: 1,
    maxRetries: 2,
    prepared: { profile: { backupProfileId: 'backup-profile' } },
    profiles: [backup],
    method: 'POST',
    responseStarted: false,
  };

  // Without allowPostFailover: false/none
  assert.strictEqual(shouldAllowFailover(baseOptions), false);
  assert.deepStrictEqual(resolveUpstreamRecovery(baseOptions), { type: 'none' });

  // With allowPostFailover on options
  const failoverOptions = { ...baseOptions, allowPostFailover: true };
  assert.strictEqual(shouldAllowFailover(failoverOptions), true);
  assert.deepStrictEqual(resolveUpstreamRecovery(failoverOptions), {
    type: 'failover',
    profile: backup,
  });

  // With allowPostFailover on profile
  const profileFailoverOptions = {
    ...baseOptions,
    prepared: { profile: { backupProfileId: 'backup-profile', allowPostFailover: true } },
  };
  assert.strictEqual(shouldAllowFailover(profileFailoverOptions), true);
  assert.deepStrictEqual(resolveUpstreamRecovery(profileFailoverOptions), {
    type: 'failover',
    profile: backup,
  });

  // Failover on error (timeout)
  const errorFailoverOptions = {
    ...failoverOptions,
    kind: 'error',
    statusCode: undefined,
  };
  assert.deepStrictEqual(resolveUpstreamRecovery(errorFailoverOptions), {
    type: 'failover',
    profile: backup,
  });

  // If response has already started, failover must be forbidden
  const startedOptions = { ...failoverOptions, responseStarted: true };
  assert.strictEqual(shouldAllowFailover(startedOptions), false);
  assert.deepStrictEqual(resolveUpstreamRecovery(startedOptions), { type: 'none' });
}

function testResponsesSseAuditCapture() {
  const auditData = createConversationAuditData({
    id: 'test-req',
    method: 'POST',
    path: '/v1/responses',
    captureContent: true,
  });

  const writtenChunks = [];
  const fakeRes = {
    __auditData: auditData,
    statusCode: 200,
    writeHead(_status, _headers) {},
    write(chunk) {
      writtenChunks.push(chunk);
    },
    end(chunk) {
      if (chunk) writtenChunks.push(chunk);
    },
  };

  installConversationAuditResponseCapture(fakeRes, {
    maxCaptureBytes: 1024 * 1024,
    maxTextChars: 120000,
    redactHeaders: (h) => h,
    captureContent: true,
    appendAuditRecord: (rec) => {
      fakeRes.__savedAudit = rec;
    },
    logUsage: () => {},
    estimateCost: () => ({ amount: 0, currency: 'USD' }),
    mergeUsage: (base, next) => next || base,
    usageFromSsePayload: () => null,
    estimateUsageForRecord: () => ({ input_tokens: 0, output_tokens: 0 }),
    config: {},
    log: { error() {}, warn() {} },
  });

  fakeRes.writeHead(200, { 'content-type': 'text/event-stream' });

  // Send SSE events conforming to OpenAI Responses API
  fakeRes.write('data: {"type":"response.output_text.delta","delta":"Hello "}\n\n');
  fakeRes.write('data: {"type":"response.output_text.delta","delta":"world!"}\n\n');
  fakeRes.write(
    'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"lookup","call_id":"call_123"},"output_index":0}\n\n'
  );
  fakeRes.write(
    'data: {"type":"response.function_call_arguments.delta","delta":"{\\"query\\":\\"test\\"}","output_index":0}\n\n'
  );
  fakeRes.write(
    'data: {"type":"response.done","response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n'
  );
  fakeRes.end();

  assert.ok(fakeRes.__savedAudit, 'Audit record should be saved');
  assert.strictEqual(fakeRes.__savedAudit.response.content, 'Hello world!');
  assert.strictEqual(fakeRes.__savedAudit.response.tool_calls.length, 1);
  assert.strictEqual(fakeRes.__savedAudit.response.tool_calls[0].name, 'lookup');
  assert.deepStrictEqual(fakeRes.__savedAudit.response.tool_calls[0].args, { query: 'test' });
}

function testResponsesUsageFromSse() {
  const payload = {
    type: 'response.done',
    response: {
      usage: {
        input_tokens: 15,
        output_tokens: 25,
        total_tokens: 40,
      },
    },
  };
  const usage = usageFromSsePayload(payload);
  assert.ok(usage);
  assert.strictEqual(usage.inputTokens, 15);
  assert.strictEqual(usage.outputTokens, 25);
  assert.strictEqual(usage.totalTokens, 40);
}

function testOpenAIChatToResponsesEmptyToolCalls() {
  let idCounter = 0;
  const protocol = createOpenAIProtocol({
    cleanToolArgs: (x) => x,
    fallbackId: (prefix) => `${prefix}_${++idCounter}`,
    stableCreated: () => 1700000000,
    protocolOptions: {},
  });

  const state = {
    id: 'resp-test-empty-tools',
    model: 'deepseek-v4-flash',
    outputIndex: 0,
    started: false,
    textItemStarted: false,
    textItemDone: false,
    completedOutputItems: [],
    pendingToolCalls: [],
    toolCalls: [],
    buffer: '',
  };

  const written = [];
  const fakeRes = {
    write: (chunk) => written.push(chunk),
  };

  // Simulate multiple chunks each having tool_calls: [] (as returned by Tencent/WorkBuddy)
  protocol.processOpenAIChatSseChunkToResponses(
    fakeRes,
    'data: {"choices":[{"delta":{"content":"Hello ","tool_calls":[]}}]}\n\n',
    state
  );
  protocol.processOpenAIChatSseChunkToResponses(
    fakeRes,
    'data: {"choices":[{"delta":{"content":"world!","tool_calls":[]}}]}\n\n',
    state
  );

  assert.strictEqual(state.outputIndex, 0, 'outputIndex must not advance on empty tool_calls');
  assert.strictEqual(
    state.completedOutputItems.length,
    0,
    'No output item should be completed mid-stream'
  );

  const addedEvents = written.filter((e) => e.startsWith('event: response.output_item.added'));
  assert.strictEqual(
    addedEvents.length,
    1,
    'Only one output_item should be added across text deltas'
  );
}

function testOpenAIResponsesToChatAdjacentAssistantMerging() {
  const protocol = createOpenAIProtocol({
    cleanToolArgs: (x) => x,
    fallbackId: (prefix) => `${prefix}_test`,
  });

  const input = [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'I will run commands.' }],
    },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'exec_command',
      arguments: '{"cmd":"git status"}',
    },
    {
      type: 'function_call',
      id: 'fc_2',
      call_id: 'call_2',
      name: 'exec_command',
      arguments: '{"cmd":"node -v"}',
    },
    {
      type: 'function_call_output',
      id: 'fco_1',
      call_id: 'call_1',
      output: 'On branch main',
    },
    {
      type: 'function_call_output',
      id: 'fco_2',
      call_id: 'call_2',
      output: 'v22.2.0',
    },
  ];

  const chat = protocol.openAIResponsesToChat({
    model: 'deepseek-v4-flash',
    input,
  });

  // Assistant messages must be merged into 1 message before tool outputs
  assert.strictEqual(
    chat.messages.length,
    3,
    'Should have 1 assistant message followed by 2 tool messages'
  );
  const assistantMsg = chat.messages[0];
  assert.strictEqual(assistantMsg.role, 'assistant');
  assert.strictEqual(assistantMsg.content, 'I will run commands.');
  assert.strictEqual(Array.isArray(assistantMsg.tool_calls), true);
  assert.strictEqual(assistantMsg.tool_calls.length, 2);
  assert.strictEqual(assistantMsg.tool_calls[0].id, 'call_1');
  assert.strictEqual(assistantMsg.tool_calls[0].function.name, 'exec_command');
  assert.strictEqual(assistantMsg.tool_calls[1].id, 'call_2');
  assert.strictEqual(assistantMsg.tool_calls[1].function.name, 'exec_command');

  assert.strictEqual(chat.messages[1].role, 'tool');
  assert.strictEqual(chat.messages[1].tool_call_id, 'call_1');
  assert.strictEqual(chat.messages[2].role, 'tool');
  assert.strictEqual(chat.messages[2].tool_call_id, 'call_2');
}

testClaudeConsecutiveRoleMerging();
testAllowPostFailover();
testResponsesSseAuditCapture();
testResponsesUsageFromSse();
testOpenAIChatToResponsesEmptyToolCalls();
testOpenAIResponsesToChatAdjacentAssistantMerging();

console.log('[protocol-optimization.test] ok');
