'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createRouteResponseHelpers } = require('../lib/proxy/handlers/route-response-helpers');
const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
const {
  contextArtifactToolDefinition,
  CONTEXT_ARTIFACT_TOOL_NAME,
  parseBufferedChatCompletion,
} = require('../lib/proxy/context-artifact-tool');
const {
  TASK_STATE_SCHEMA,
  TASK_STATE_MARKER,
  TASK_STATE_DIRECTIVE,
} = require('../lib/proxy/context-task-state');

function workload(stream) {
  const messages = [
    { role: 'system', content: 'Never expose credentials.' },
    { role: 'user', content: 'Preserve unverified work.' },
  ];
  for (let i = 0; i < 20; i++)
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: 'old-' + i, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'old-' + i, content: 'evidence '.repeat(1500) },
      { role: 'assistant', content: 'Reported progress not verified. '.repeat(100) }
    );
  messages.push({ role: 'user', content: 'Continue reading.' });
  return {
    model: 'deepseek-v4.1-flash',
    stream,
    messages,
    tools: [
      contextArtifactToolDefinition(),
      ...['read', 'write'].map((name) => ({
        type: 'function',
        function: { name, parameters: { type: 'object', properties: {} } },
      })),
    ],
  };
}

function hostResponse(body, message, finish = 'stop', status = 200) {
  const payload = {
    id: 'chat_fixture',
    model: body.model,
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }],
  };
  return {
    ok: true,
    status,
    headers: {},
    body: body.stream
      ? 'data: ' +
        JSON.stringify({
          ...payload,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              finish_reason: finish,
              delta: {
                ...payload.choices[0].message,
                ...(message.tool_calls
                  ? {
                      tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })),
                    }
                  : {}),
              },
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n'
      : JSON.stringify(payload),
  };
}

async function run(stream, mode) {
  const body = workload(stream);
  const store = createContextArtifactStore();
  const coordinator = createContextCompactionCoordinator();
  const sent = [],
    learned = [],
    errors = [],
    events = [],
    remembered = [];
  const req = Object.assign(new EventEmitter(), { method: 'POST', headers: {} });
  const res = Object.assign(new EventEmitter(), {
    writableLength: 0,
    writes: [],
    writeHead() {
      this.headersSent = true;
    },
    write(value) {
      this.writes.push(String(value));
      return true;
    },
    end() {
      this.writableEnded = true;
      this.emit('finish');
    },
  });
  let settle, summarySeen;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });
  const summaryStarted = new Promise((resolve) => {
    summarySeen = resolve;
  });
  let slowResult, summarySignal;
  const protocol = createOpenAIProtocol({
    cleanToolArgs: (_name, value) => value,
    fallbackId: (prefix) => prefix + '_fixture',
    stableCreated: () => 1,
    protocolOptions: { contextWindowPolicy: 'disabled' },
  });
  const logRequestEnd = (...args) => {
    events.push({ name: 'terminal', status: args[3] });
    settle();
  };
  const sendJsonError = (_res, status, payload) => {
    errors.push({ status, payload });
  };
  const state = createResponsesState({
    ...protocol,
    log: { warn() {}, info() {} },
    sendJsonError,
    logRequestEnd,
    logProxyEvent: (name, value) => events.push({ name, value }),
    fallbackId: (prefix) => prefix + '_fixture',
    stableCreated: () => 1,
    conversionResponseLimit: 16 * 1024 * 1024,
  });
  const ctx = {
    ...protocol,
    ...state,
    CORS_HEADERS: {},
    protocolOptions: { contextWindowPolicy: 'disabled' },
    responsesToChatWithHistory: () => body,
    rememberResponsesFromChatResponse: (...args) => {
      remembered.push(JSON.parse(JSON.stringify(args[1])));
      return state.rememberResponsesFromChatResponse(...args);
    },
    rememberResponsesFromBridge: (...args) => {
      remembered.push(JSON.parse(JSON.stringify(args[1])));
      return state.rememberResponsesFromBridge(...args);
    },
    workbuddyPreflightBodyBytes: 70000,
    workbuddyTargetBodyBytes: 350000,
    workbuddyMinCleanupBytes: 1024,
    workbuddyMaxSelectedTools: 1,
    contextArtifactStore: store,
    contextCompactionCoordinator: {
      async run(request) {
        const result = await coordinator.run(request);
        events.push({ name: 'summary-result', value: { ok: result.ok, reason: result.reason } });
        return result;
      },
    },
    contextCapacityController: {
      targetBytes: (_key, value) => value,
      recordSuccess: (_key, bytes) => learned.push(bytes),
      recordRejection() {},
    },
    parseProxyBody: (_res, buffer) => JSON.parse(buffer.toString()),
    parseJsonOrSseJson: (raw) =>
      raw.startsWith('data:')
        ? parseBufferedChatCompletion(raw, true, 16 * 1024 * 1024)
        : JSON.parse(raw),
    rejectUnsupportedResponsesConversion: () => false,
    logRequestEnd,
    sendJsonError,
    logProxyEvent: (name, value) => events.push({ name, value }),
    writeJsonResponse(_res, _status, value) {
      res.result = value;
    },
    sendUpstreamError(_res, status) {
      errors.push({ status });
    },
    workBuddyWbipcClient: {
      async request(transport, { signal }) {
        assert.equal(transport.path, '/v2/chat/completions');
        assert.ok(signal instanceof globalThis.AbortSignal);
        const request = JSON.parse(transport.body);
        sent.push(request);
        if (request.messages[0].content === TASK_STATE_DIRECTIVE) {
          summarySignal = signal;
          summarySeen();
          assert.equal(request.tools, undefined);
          assert.equal(request.stream, true);
          assert.equal(
            store.stats().entries,
            0,
            'No evidence published while candidate is produced'
          );
          if (mode === 'slow' || mode === 'disconnect')
            return new Promise((resolve) => {
              slowResult = resolve;
            });
          if (mode === 'rate')
            return hostResponse(request, { content: 'PRIVATE_PROVIDER' }, 'stop', 429);
          return hostResponse(request, {
            content: JSON.stringify({
              schema: TASK_STATE_SCHEMA,
              version: 1,
              objectives: [
                {
                  text: 'Preserve unverified work',
                  sources: [{ sourceId: 'm_1', quote: 'Preserve unverified work' }],
                },
              ],
              requirements: [],
              decisions: [],
              work: [],
              blockers: [],
              nextSteps: [],
              files: [],
            }),
          });
        }
        if (
          sent.filter((input) => input.messages[0].content !== TASK_STATE_DIRECTIVE).length === 1
        ) {
          assert.equal(sent.length, 1, 'Main dispatch precedes summary dispatch');
          assert.ok(!request.messages.some((m) => m.content?.startsWith?.(TASK_STATE_MARKER)));
          await summaryStarted;
          // Yield one event-loop boundary: all queued summary parsing/validation
          // microtasks finish before the authorized main response is returned.
          await new Promise((resolve) => setImmediate(resolve));
          if (mode === 'disconnect') {
            req.emit('aborted');
            return { ok: false, status: 'cancelled' };
          }
          if (mode === 'main-error')
            return hostResponse(request, { content: 'failed' }, 'stop', 500);
          if (mode === 'mixed') {
            const receipt = store.put('owner', 'hcs_' + '4'.repeat(32), 'original evidence');
            return hostResponse(
              request,
              {
                content: 'Original external call',
                tool_calls: [
                  {
                    id: 'external-write',
                    type: 'function',
                    function: { name: 'write', arguments: '{"text":"汉🙂"}' },
                  },
                  {
                    id: 'internal-read',
                    type: 'function',
                    function: {
                      name: CONTEXT_ARTIFACT_TOOL_NAME,
                      arguments: JSON.stringify({
                        locator: receipt.locator,
                        scope: 'hcs_' + '4'.repeat(32),
                        digest: receipt.digest,
                      }),
                    },
                  },
                ],
              },
              'tool_calls'
            );
          }
          return hostResponse(request, { content: 'main completed' });
        }
        assert.equal(mode, 'mixed');
        assert.deepEqual(
          request.tools.map((tool) => tool.function.name),
          [CONTEXT_ARTIFACT_TOOL_NAME]
        );
        assert.ok(!request.messages.some((m) => m.tool_call_id === 'external-write'));
        return hostResponse(request, { content: 'PRIVATE_RECOVERY_ACK' });
      },
    },
  };
  const handler = createOpenAIResponsesToChatHandler(ctx, createRouteResponseHelpers(ctx));
  let timer;
  try {
    handler(
      req,
      res,
      {
        authProvider: 'workbuddy',
        profile: { id: 'owner', protocol: 'workbuddy' },
        rewriteTo: 'deepseek-v4.1-flash',
        workbuddyAuth: { accessTokenEncrypted: true },
        buffer: Buffer.from(
          JSON.stringify({ model: 'workbuddy/deepseek-v4.1-flash', input: 'continue', stream })
        ),
      },
      { path: '/v2' },
      '',
      '/v1/responses',
      Date.now()
    );
    await Promise.race([
      finished,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Background route did not reach terminal state')),
          3000
        );
      }),
    ]);
    assert.equal(
      slowResult === undefined || summarySignal.aborted,
      true,
      'Slow summary cancelled before response publication'
    );
    slowResult?.(hostResponse({ model: body.model }, { content: '{}' }));
    await new Promise((resolve) => setImmediate(resolve));
    const completed = res.writes
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.type === 'response.completed');
    return {
      sent,
      learned,
      errors,
      events,
      remembered,
      response: res.result || completed?.response,
      entries: store.stats().entries,
    };
  } finally {
    clearTimeout(timer);
    coordinator.close();
    store.close();
  }
}

test('production JSON/SSE sends original main request first and remembers only safe-point committed history', async () => {
  for (const stream of [false, true]) {
    const result = await run(stream, 'success');
    assert.deepEqual(result.errors, []);
    assert.equal(result.sent.length, 2);
    assert.equal(result.learned.length, 1);
    assert.equal(result.learned[0], Buffer.byteLength(JSON.stringify(result.sent[0])));
    assert.equal(result.remembered.length, 1);
    assert.ok(
      result.remembered[0].messages.some((m) => m.content?.startsWith?.(TASK_STATE_MARKER)),
      JSON.stringify(result.events)
    );
    assert.ok(result.events.some((event) => event.value?.backgroundAppliedToContinuationHistory));
    assert.equal(
      result.entries,
      0,
      'Unused speculative evidence is discarded when the final summary window retains original tool results'
    );
    assert.ok(!JSON.stringify(result.events).includes('Reported progress'));
  }
});

test('slow, rate-limited, failed main and disconnected routes do not publish background candidates', async () => {
  for (const mode of ['slow', 'rate', 'main-error', 'disconnect'])
    for (const stream of [false, true]) {
      const result = await run(stream, mode);
      assert.ok(
        !result.events.some((event) => event.value?.backgroundAppliedToContinuationHistory),
        mode
      );
      assert.equal(result.entries, 0, mode);
      assert.ok(
        result.remembered.every(
          (history) => !history.messages.some((m) => m.content?.startsWith?.(TASK_STATE_MARKER))
        )
      );
      assert.equal(result.learned.length, ['main-error', 'disconnect'].includes(mode) ? 0 : 1);
      assert.equal(result.events.filter((event) => event.name === 'terminal').length, 1);
    }
});

test('mixed internal/external calls validate original offered tools even when background pruning removes them', async () => {
  for (const stream of [false, true]) {
    const result = await run(stream, 'mixed');
    assert.deepEqual(result.errors, []);
    assert.ok(result.events.some((event) => event.value?.backgroundAppliedToContinuationHistory));
    const call = result.response.output.find((item) => item.type === 'function_call');
    assert.equal(call.name, 'write');
    assert.equal(call.call_id, 'external-write');
    assert.equal(call.arguments, '{"text":"汉🙂"}');
    assert.equal(result.learned.length, 2, 'Summary does not teach capacity, recovery main does');
    assert.ok(!JSON.stringify(result.response).includes('PRIVATE_RECOVERY_ACK'));
  }
});
