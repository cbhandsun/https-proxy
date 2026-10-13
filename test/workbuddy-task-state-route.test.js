'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
const {
  TASK_STATE_SCHEMA,
  TASK_STATE_MARKER,
  TASK_STATE_DIRECTIVE,
} = require('../lib/proxy/context-task-state');

function workload() {
  const messages = [
    { role: 'system', content: '禁止泄露凭证。' },
    { role: 'user', content: '修复压缩，保留修改，禁止外部命令重跑。' },
  ];
  for (let index = 0; index < 20; index += 1)
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          { id: `call-${index}`, type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: `call-${index}`, content: 'evidence'.repeat(2500) },
      { role: 'assistant', content: '报告测试完成，但没有验证。'.repeat(70) }
    );
  messages.push({ role: 'user', content: '继续。' });
  return {
    model: 'deepseek-v4.1-flash',
    messages,
    tools: [
      {
        type: 'function',
        function: { name: 'read', parameters: { type: 'object', properties: {} } },
      },
    ],
  };
}
function response(content, finish = 'stop') {
  return {
    ok: true,
    status: 200,
    headers: {},
    body: JSON.stringify({
      choices: [{ finish_reason: finish, message: { role: 'assistant', content } }],
    }),
  };
}
async function run(mode) {
  const body = workload();
  const requests = [],
    learned = [],
    errors = [],
    events = [],
    remembered = [];
  const req = Object.assign(new EventEmitter(), { method: 'POST', headers: {} });
  const res = Object.assign(new EventEmitter(), { headersSent: false });
  const coordinator = createContextCompactionCoordinator({
    deadlineMs: mode === 'timeout' ? 10 : 1000,
  });
  let settle;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });
  let timeout;
  const handler = createOpenAIResponsesToChatHandler(
    {
      CORS_HEADERS: {},
      logRequestEnd: (...args) => {
        if (args[3] === 499) settle();
      },
      logProxyEvent: (name, value) => events.push({ name, value }),
      parseProxyBody: () => ({
        model: 'workbuddy/deepseek-v4.1-flash',
        input: 'continue',
        stream: false,
      }),
      responsesToChatWithHistory: () => body,
      rejectUnsupportedResponsesConversion: () => false,
      rememberResponsesFromChatResponse: (_response, history) => remembered.push(history),
      openAIChatToResponses: () => ({ id: 'resp-test', output: [] }),
      parseJsonOrSseJson: JSON.parse,
      sendJsonError: (_res, status, error) => {
        errors.push({ status, error });
        settle();
      },
      writeJsonResponse: () => settle(),
      workbuddyPreflightBodyBytes: 70000,
      workbuddyTargetBodyBytes: mode === 'rejected' ? 100 : 70000,
      contextCompactionCoordinator: coordinator,
      contextCapacityController: {
        targetBytes: (_key, configured) => configured,
        recordSuccess: (_key, bytes) => learned.push(bytes),
        recordRejection: () => {
          throw new Error('unexpected rejection');
        },
      },
      workBuddyWbipcClient: {
        request: async (transport, { signal }) => {
          const input = JSON.parse(transport.body);
          requests.push(input);
          assert.equal(transport.path, '/v2/chat/completions');
          assert.ok(signal instanceof globalThis.AbortSignal);
          if (input.messages[0].content === TASK_STATE_DIRECTIVE) {
            if (mode === 'throw') throw new Error('private provider error must not leak');
            assert.deepEqual(Object.keys(input).sort(), [
              'max_tokens',
              'messages',
              'model',
              'stream',
            ]);
            if (mode === 'cancelled') {
              req.emit('aborted');
              return response('{}');
            }
            if (mode === 'timeout')
              return new Promise((resolve) =>
                signal.addEventListener(
                  'abort',
                  () => resolve({ ok: false, status: 'cancelled' }),
                  { once: true }
                )
              );
            if (mode === 'invalid') return response('{}', 'length');
            return response(
              JSON.stringify({
                schema: TASK_STATE_SCHEMA,
                version: 1,
                objectives: [],
                requirements: [
                  {
                    id: 'r1',
                    text: '保留修改',
                    status: 'active',
                    sources: [{ sourceId: 'm_1', quote: '保留修改' }],
                  },
                ],
                decisions: [],
                work: [
                  {
                    text: '测试完成仅为报告',
                    status: 'reported_complete',
                    sources: [{ sourceId: 'm_4', quote: '没有验证' }],
                  },
                ],
                blockers: [],
                nextSteps: [],
                files: [],
              })
            );
          }
          assert.ok(input.tools.every((tool) => tool.type === 'function'));
          return response('main completed');
        },
      },
    },
    {
      boundedResponseContext: () => ({}),
      proxyErrorContext: () => ({}),
      handleConvertedJsonResponse: ({ convert, responseBody }) => {
        convert(responseBody);
        settle();
      },
    }
  );
  try {
    handler(
      req,
      res,
      {
        authProvider: 'workbuddy',
        profile: { id: 'profile', protocol: 'workbuddy' },
        buffer: Buffer.from('{}'),
        rewriteTo: 'deepseek-v4.1-flash',
        workbuddyAuth: { accessTokenEncrypted: true },
      },
      { path: '/v2', hostname: 'www.workbuddy.cn', protocol: 'https:' },
      '',
      '/v1/responses',
      Date.now()
    );
    await Promise.race([
      finished,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('route fixture timeout')), 3000);
      }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    return { requests, learned, errors, events, remembered, body };
  } finally {
    clearTimeout(timeout);
    coordinator.close();
  }
}

test('authorized WorkBuddy route makes a tool-free summary, installs validated state and learns only main-request capacity', async () => {
  const result = await run('valid');
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.requests.length, 2);
  assert.equal(result.learned.length, 1);
  assert.equal(
    result.events.find((entry) => entry.name === 'workbuddy_context_plan').value
      .historyTransactionStatus,
    'committed'
  );
  const main = result.requests[1];
  assert.equal(result.learned[0], Buffer.byteLength(JSON.stringify(main)));
  assert.ok(
    main.messages.some(
      (entry) => entry.role === 'assistant' && entry.content?.startsWith?.(TASK_STATE_MARKER)
    )
  );
  for (const text of ['禁止泄露凭证。', '修复压缩，保留修改，禁止外部命令重跑。', '继续。'])
    assert.ok(main.messages.some((entry) => entry.content === text));
  assert.equal(result.remembered.length, 1);
  assert.equal(
    result.events.find((entry) => entry.name === 'workbuddy_context_plan').value.taskStateStatus,
    'applied'
  );
  assert.ok(!JSON.stringify(result.events).includes('禁止泄露'));
});

test('invalid or timed-out summaries use structural fallback without treating summarizer success as capacity evidence', async () => {
  for (const mode of ['invalid', 'timeout']) {
    const result = await run(mode);
    assert.equal(result.errors.length, 0);
    assert.equal(result.requests.length, 2);
    assert.equal(result.learned.length, 1);
    assert.ok(
      !result.requests[1].messages.some((entry) => entry.content?.startsWith?.(TASK_STATE_MARKER))
    );
    assert.equal(
      result.events.find((entry) => entry.name === 'workbuddy_context_plan').value.taskStateStatus,
      mode === 'invalid' ? 'invalid_compaction_candidate' : 'compaction_timeout'
    );
  }
});

test('client cancellation aborts compaction and never sends the main request', async () => {
  const result = await run('cancelled');
  assert.equal(result.requests.length, 1);
  assert.equal(result.learned.length, 0);
  assert.equal(result.remembered.length, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(
    result.events.filter((entry) => entry.name === 'workbuddy_context_outcome').length,
    1
  );
});

test('failed preflight returns one bounded 413 without continuing null response into authentication failure', async () => {
  const result = await run('rejected');
  assert.equal(result.requests.length, 0);
  assert.equal(result.learned.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].status, 413);
  assert.equal(result.errors[0].error.error.code, 'workbuddy_request_too_large');
});

test('summarizer exceptions remain processing failures, not misleading authentication failures', async () => {
  const result = await run('throw');
  assert.equal(result.requests.length, 1);
  assert.equal(result.learned.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].status, 502);
  assert.equal(result.errors[0].error.error.type, 'api_error');
  assert.ok(!JSON.stringify(result.errors).includes('private provider error'));
  assert.equal(
    result.events.filter((entry) => entry.name === 'workbuddy_context_outcome').length,
    1
  );
});
