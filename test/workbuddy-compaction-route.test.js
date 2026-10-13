'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createRequestValidators } = require('../lib/proxy/handlers/request-validators');
const { createRouteResponseHelpers } = require('../lib/proxy/handlers/route-response-helpers');
const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');
const {
  createContextCompactionEnvelopeStore,
} = require('../lib/proxy/context-compaction-envelope');
const {
  createContextCompactionCoordinator,
} = require('../lib/proxy/context-compaction-coordinator');
const { parseBufferedChatCompletion } = require('../lib/proxy/context-artifact-tool');
const { encodeWorkBuddyToolCompletion } = require('../lib/proxy/workbuddy-mixed-tool-phase');
const { LOCAL_SUMMARY_MARKER } = require('../lib/proxy/workbuddy-compaction-bridge');
const {
  normalizeWorkBuddyStandaloneCompactionRequest,
} = require('../lib/proxy/workbuddy-standalone-compaction');
const { summaryFixture } = require('./helpers/compaction-summary-fixture');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { CONTEXT_ARTIFACT_TOOL_NAME } = require('../lib/proxy/context-artifact-tool');

const source = [
  { type: 'message', role: 'system', content: '原始策略🙂', future_field: { exact: true } },
  { type: 'message', role: 'user', content: '不执行外部工具；只修改指定文件。' },
  {
    type: 'function_call',
    name: 'read',
    call_id: 'completed-original',
    arguments: '{ "path": "原文件🙂" }',
  },
  { type: 'function_call_output', call_id: 'completed-original', output: '原始证据中段🙂' },
  { type: 'message', role: 'assistant', content: '任务进展尚未验证。' },
  { type: 'message', role: 'user', content: '撤销旧要求，保留新要求。' },
  { type: 'function_call', call_id: 'recent-1', name: 'read', arguments: '{}' },
  { type: 'function_call_output', call_id: 'recent-1', output: '近期原始结果一🙂' },
  { type: 'function_call', call_id: 'recent-2', name: 'read', arguments: '{}' },
  { type: 'function_call_output', call_id: 'recent-2', output: '近期原始结果二🙂' },
];
const tools = [{ type: 'function', name: 'read', parameters: { type: 'object' } }];
const summaryText = '保留约束、撤销关系、未验证进展和下一步🙂'.repeat(100);

test('history above 16 MiB reaches admission and rejects oversized protected input without host calls', async () => {
  const f = fixture();
  try {
    await f.request([{ role: 'user', content: 'x'.repeat(17 * 1024 * 1024) }]);
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].status, 413);
    assert.equal(f.sent.length, 0);
    assert.equal(f.state.responsesHistory.size, 0);
    assert.ok(!JSON.stringify(f.events).includes('x'.repeat(100)));
  } finally {
    f.close();
  }
});

test('a large tool catalog is compacted before host dispatch without losing the current request', async () => {
  const f = fixture();
  try {
    const response = await f.request([{ role: 'user', content: 'Continue safely.' }], {
      body: {
        tools: [{ ...tools[0], description: 'd'.repeat(17 * 1024 * 1024) }],
      },
    });
    assert.deepEqual(f.errors, []);
    assert.ok(response);
    assert.equal(f.sent.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(f.sent[0])) <= 100000);
    assert.ok(f.sent[0].messages.some((message) => message.content === 'Continue safely.'));
    assert.equal(f.sent[0].tools[0].function.name, 'read');
  } finally {
    f.close();
  }
});

function fixture({
  mode = 'normal',
  maxResponseBytes = 1024 * 1024,
  maxRequestBytes = 100000,
  preset,
  renewable = false,
  artifactTtlMs = 1000,
} = {}) {
  let now = 100;
  let activeReq;
  let rejectedMain = false;
  let readEvidence = false;
  let resolveDone;
  let result;
  const sent = [],
    errors = [],
    endings = [],
    events = [];
  const envelopes = createContextCompactionEnvelopeStore({
    now: () => now,
    ttlMs: 100,
    renewable,
    maxLifetimeMs: 350,
  });
  const artifacts = createContextArtifactStore({ now: () => now, ttlMs: artifactTtlMs });
  const coordinator = createContextCompactionCoordinator();
  const sendJsonError = (_res, status, payload) => {
    errors.push({ status, payload });
  };
  const logRequestEnd = (...args) => {
    endings.push(args);
    resolveDone?.();
  };
  const protocolOptions = { contextWindowPolicy: 'disabled' };
  const protocol = createOpenAIProtocol({
    cleanToolArgs: (_name, args) => args,
    fallbackId: (prefix) => prefix + '_fixture',
    stableCreated: () => 1,
    protocolOptions,
  });
  const state = createResponsesState({
    ...protocol,
    log: { warn() {}, info() {} },
    sendJsonError,
    logRequestEnd,
    fallbackId: (prefix) => prefix + '_fixture',
    stableCreated: () => 1,
    logProxyEvent: (kind, data) => events.push({ kind, data }),
    conversionResponseLimit: maxResponseBytes,
  });
  const ctx = {
    ...protocol,
    ...state,
    ...createRequestValidators({ sendJsonError }),
    CORS_HEADERS: {},
    protocolOptions,
    contextCompactionEnvelopeStore: envelopes,
    contextArtifactStore: artifacts,
    contextCompactionCoordinator: coordinator,
    workbuddyTargetBodyBytes: maxRequestBytes,
    workbuddyPreflightBodyBytes: maxRequestBytes,
    maxConversionResponseBytes: maxResponseBytes,
    logRequestEnd,
    sendJsonError,
    logProxyEvent: (kind, data) => events.push({ kind, data }),
    parseProxyBody: (_res, buffer) => JSON.parse(buffer.toString()),
    parseJsonOrSseJson: (value) =>
      parseBufferedChatCompletion(value, false, 1024 * 1024) ||
      parseBufferedChatCompletion(value, true, 1024 * 1024),
    writeJsonResponse(_res, status, payload) {
      result = { status, payload };
    },
    workBuddyWbipcClient: {
      async request(params, { signal }) {
        const body = JSON.parse(params.body.toString());
        sent.push(body);
        assert.deepEqual(Object.keys(params.headers).sort(), ['accept', 'content-type']);
        assert.equal(params.path, '/v2/chat/completions');
        const summarizing = body.messages[0].content?.startsWith(
          'You are a dedicated historical-context summarizer'
        );
        if (!summarizing && mode === 'retry' && !rejectedMain) {
          rejectedMain = true;
          return { ok: false, status: 'E_PAYLOAD_TOO_LARGE' };
        }
        if (summarizing && mode === 'cancel')
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ ok: false, status: 'cancelled' }), {
              once: true,
            });
            setImmediate(() => activeReq.emit('aborted'));
          });
        if (summarizing && mode === 'throw') throw new Error('PRIVATE_UPSTREAM_ERROR');
        const message = {
          role: 'assistant',
          content: summarizing ? summaryFixture(body, summaryText) : '继续处理新要求🙂',
        };
        if (!summarizing && mode === 'evidence' && !readEvidence) {
          readEvidence = true;
          assert.ok(body.tools.some((tool) => tool.function?.name === CONTEXT_ARTIFACT_TOOL_NAME));
          const text = body.messages.find((m) =>
            m.content?.startsWith(LOCAL_SUMMARY_MARKER)
          ).content;
          const receipt = JSON.parse(text.split('\n')[1]).evidenceReceipts[0];
          message.content = null;
          message.tool_calls = [
            {
              id: 'recover-original-evidence',
              type: 'function',
              function: {
                name: CONTEXT_ARTIFACT_TOOL_NAME,
                arguments: JSON.stringify({
                  locator: receipt.locator,
                  scope: receipt.scope,
                  digest: receipt.digest,
                  limitBytes: 1024,
                }),
              },
            },
          ];
        }
        if (summarizing && mode === 'tool')
          message.tool_calls = [
            {
              id: 'forbidden-side-effect',
              type: 'function',
              function: { name: 'read', arguments: '{}' },
            },
          ];
        if (!summarizing && mode === 'replay-old') {
          message.content = null;
          message.tool_calls = [
            {
              id: 'completed-original',
              type: 'function',
              function: { name: 'read', arguments: '{}' },
            },
          ];
        }
        return {
          ok: true,
          status: 200,
          headers: {},
          body: encodeWorkBuddyToolCompletion(
            {
              id: 'chat_fixture',
              object: 'chat.completion',
              ...(mode === 'usage-missing'
                ? {}
                : {
                    usage: {
                      prompt_tokens: 100,
                      completion_tokens: 20,
                      total_tokens: mode === 'usage-invalid' ? 1 : 120,
                      prompt_tokens_details: { cached_tokens: 50 },
                      completion_tokens_details: { reasoning_tokens: 2 },
                    },
                  }),
              choices: [
                {
                  index: 0,
                  finish_reason:
                    summarizing && mode === 'truncated'
                      ? 'length'
                      : message.tool_calls?.length
                        ? 'tool_calls'
                        : 'stop',
                  message,
                },
              ],
            },
            body.stream === true || (summarizing && mode === 'summary-sse')
          ),
        };
      },
    },
  };
  const handler = createOpenAIResponsesToChatHandler(ctx, createRouteResponseHelpers(ctx));
  return {
    sent,
    errors,
    endings,
    events,
    envelopes,
    artifacts,
    state,
    expire() {
      now += 100;
    },
    advance(milliseconds) {
      now += milliseconds;
    },
    close() {
      envelopes.close();
      artifacts.close();
      coordinator.close();
    },
    async request(
      input,
      {
        stream = false,
        owner = 'owner',
        model = 'hy4-preview-f',
        native = false,
        standalone = false,
        body = {},
      } = {}
    ) {
      result = undefined;
      const before = endings.length;
      activeReq = new EventEmitter();
      activeReq.method = 'POST';
      activeReq.headers = {};
      const res = new EventEmitter();
      const chunks = [];
      res.setHeader = () => {};
      res.write = (value) => {
        chunks.push(String(value));
        return true;
      };
      res.writeHead = () => {
        res.headersSent = true;
      };
      res.end = (value) => {
        if (value) chunks.push(String(value));
        res.writableEnded = true;
        res.emit('finish');
      };
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      let prepared = {
        authProvider: native ? 'other' : 'workbuddy',
        profile: { id: owner, protocol: native ? 'openai' : 'workbuddy' },
        rewriteTo: model,
        activePromptPreset: preset,
        workbuddyAuth: native ? undefined : { accessTokenEncrypted: true },
        buffer: Buffer.from(
          JSON.stringify({
            model: 'workbuddy/hy4',
            stream,
            store: false,
            input,
            ...(standalone ? {} : { tools }),
            ...body,
          })
        ),
      };
      if (standalone) prepared = normalizeWorkBuddyStandaloneCompactionRequest(prepared);
      handler(
        activeReq,
        res,
        prepared,
        { hostname: 'host', port: 443, path: '/v2' },
        '',
        '/v1/responses',
        1
      );
      let timer;
      await Promise.race([
        done,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Compaction route did not terminate')), 5000);
        }),
      ]).finally(() => clearTimeout(timer));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(endings.length - before, 1);
      const final = chunks
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map((line) => JSON.parse(line.slice(6)))
        .find((event) => event.type === 'response.completed');
      return result?.payload || final?.response;
    },
  };
}

test('production JSON/SSE replay renews active state and its private evidence without extra model or external-tool execution', async () => {
  const large = source.map((item) =>
    item.type === 'function_call_output' && item.call_id === 'completed-original'
      ? { ...item, output: '完整外置证据🙂'.repeat(12000) }
      : item
  );
  for (const stream of [false, true]) {
    const f = fixture({ renewable: true, artifactTtlMs: 100, maxRequestBytes: 80000 });
    try {
      const compacted = await f.request([...large, { type: 'compaction_trigger' }], { stream });
      assert.ok(compacted, JSON.stringify(f.errors));
      assert.ok(compacted.output[0].encrypted_content.startsWith('hpm-local-compaction-v2:'));
      const initialCalls = f.sent.length;
      for (let turn = 0; turn < 3; turn++) {
        f.advance(90);
        const reply = await f.request(
          [...compacted.output, { role: 'user', content: '继续授权任务🙂' }],
          { stream }
        );
        assert.ok(reply, JSON.stringify(f.errors));
        assert.equal(f.sent.length, initialCalls + turn + 1);
        assert.equal(
          f.artifacts.stats().entries,
          1,
          'evidence remains live without model reading it'
        );
      }
      f.advance(80);
      const calls = f.sent.length;
      assert.equal(await f.request(compacted.output, { stream }), undefined);
      assert.equal(f.sent.length, calls, 'hard-expired state never reaches the host');
      assert.equal(f.errors.at(-1).payload.error.recovery.action, 'resend_full_history');
      assert.equal(f.errors.at(-1).payload.error.recovery.replay_external_tools, false);
      assert.equal(f.state.responsesHistory.size, 0);
    } finally {
      f.close();
    }
  }
});

test('malformed replay cannot renew a valid prefix before its original expiry', async () => {
  const f = fixture({ renewable: true });
  try {
    const compacted = await f.request([...source, { type: 'compaction_trigger' }]);
    f.advance(90);
    const calls = f.sent.length;
    assert.equal(
      await f.request([
        ...compacted.output,
        { type: 'compaction_trigger' },
        { role: 'user', content: 'bad ordering' },
      ]),
      undefined
    );
    assert.equal(f.sent.length, calls);
    f.advance(10);
    assert.equal(await f.request(compacted.output), undefined);
    assert.equal(f.sent.length, calls);
    assert.equal(f.envelopes.stats().entries, 0);
  } finally {
    f.close();
  }
});

test('production JSON and SSE trigger/replay paths preserve complete state without storing Responses history', async () => {
  for (const stream of [false, true]) {
    const f = fixture();
    try {
      const response = await f.request([...source, { type: 'compaction_trigger' }], {
        stream,
        body: {
          instructions: '固定指令原文🙂',
          tool_choice: { type: 'function', name: 'read' },
          text: { format: { type: 'text' } },
        },
      });
      assert.equal(response.status, 'completed');
      assert.equal(response.output.length, 1);
      assert.equal(response.output[0].type, 'compaction');
      assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0].tools, undefined);
      assert.equal(f.sent[0].tool_choice, undefined);
      assert.equal(f.sent[0].response_format, undefined);
      const quoted = JSON.parse(f.sent[0].messages[1].content);
      assert.ok(quoted.transcript.some(({ item }) => item.output === '原始证据中段🙂'));
      assert.deepEqual(quoted.transcript[0], {
        index: 0,
        item: { type: 'message', role: 'system', content: '固定指令原文🙂' },
      });
      const reply = await f.request([
        ...response.output,
        { type: 'message', role: 'user', content: '新增要求🙂' },
      ]);
      assert.equal(reply.output[0].content[0].text, '继续处理新要求🙂');
      const replayed = f.sent[1];
      for (const output of [source[7].output, source[9].output])
        assert.ok(
          replayed.messages.some(
            (message) => message.role === 'tool' && JSON.stringify(message.content).includes(output)
          ),
          'recent original tool evidence must survive production replay'
        );
      assert.ok(
        replayed.messages.some(
          (message) => message.role === 'system' && message.content === '固定指令原文🙂'
        )
      );
      assert.ok(
        replayed.messages.some(
          (message) => message.role === 'system' && message.content === source[0].content
        )
      );
      for (const requirement of [source[1].content, source[5].content, '新增要求🙂'])
        assert.ok(
          replayed.messages.some(
            (message) => message.role === 'user' && message.content === requirement
          )
        );
      assert.ok(
        replayed.messages.some(
          (message) =>
            message.role === 'assistant' && message.content.startsWith(LOCAL_SUMMARY_MARKER)
        )
      );
      assert.equal(f.state.responsesHistory.size, 0);
      assert.ok(!JSON.stringify(f.events).includes(summaryText));
      assert.ok(!JSON.stringify(f.endings).includes('原始证据'));
      assert.deepEqual(f.errors, []);
    } finally {
      f.close();
    }
  }
});

test('retired external call identities survive local compaction and repeated compaction before client publication', async () => {
  for (const stream of [false, true]) {
    const f = fixture({ mode: 'replay-old' });
    try {
      const first = await f.request([...source, { type: 'compaction_trigger' }], { stream });
      const second = await f.request(
        [
          ...first.output,
          { type: 'message', role: 'user', content: '继续压缩' },
          { type: 'compaction_trigger' },
        ],
        { stream }
      );
      assert.ok(second);
      const replay = await f.request(
        [...second.output, { type: 'message', role: 'user', content: '继续任务' }],
        { stream }
      );
      assert.equal(replay, undefined, 'reused call must never be sent to the client for execution');
      assert.equal(f.errors.at(-1)?.status, 502);
      assert.equal(f.envelopes.stats().entries, 2);
      assert.ok(
        !JSON.stringify(f.sent).includes('callIdDigests'),
        'identity lineage is not model context'
      );
    } finally {
      f.close();
    }
  }
});

test('production JSON/SSE paths incrementally summarize oversized history and replay structured state with exact recent evidence', async () => {
  const large = [source[0], source[1]];
  for (let index = 0; index < 22; index++)
    large.push(
      { type: 'function_call', call_id: 'batch-' + index, name: 'read', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'batch-' + index,
        // Each result stays below offload thresholds. Their combined history
        // still requires real incremental summary calls rather than one chunk.
        output: index < 20 ? 'x'.repeat(7000) : '近期原始证据-' + index + '🙂',
      },
      { role: 'assistant', content: '报告进展，尚未验证🙂' }
    );
  for (const stream of [false, true]) {
    const f = fixture({ maxRequestBytes: 80000 });
    try {
      const compacted = await f.request([...large, { type: 'compaction_trigger' }], { stream });
      assert.ok(compacted, JSON.stringify(f.errors));
      assert.ok(f.sent.length > 1 && f.sent.length <= 16);
      const summaryCalls = [...f.sent];
      for (const request of summaryCalls) {
        assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 80000);
        assert.equal(request.tools, undefined);
      }
      const indexed = summaryCalls.flatMap(
        (request) => JSON.parse(request.messages[1].content).transcript
      );
      assert.equal(new Set(indexed.map((entry) => entry.index)).size, indexed.length);
      for (let index = 0; index < 20; index++)
        assert.equal(
          indexed.find(
            ({ item }) => item.type === 'function_call_output' && item.call_id === 'batch-' + index
          ).item.output,
          'x'.repeat(7000)
        );
      assert.ok(!indexed.some(({ item }) => ['batch-20', 'batch-21'].includes(item.call_id)));
      const reply = await f.request(
        [...compacted.output, { role: 'user', content: '继续验证🙂' }],
        { stream }
      );
      assert.ok(reply, JSON.stringify(f.errors));
      const replayed = f.sent.at(-1);
      const checkpoint = replayed.messages.find((message) =>
        message.content?.startsWith(LOCAL_SUMMARY_MARKER)
      );
      const value = JSON.parse(checkpoint.content.split('\n')[1]);
      assert.equal(checkpoint.role, 'assistant');
      assert.equal(value.verification, 'not_verified');
      assert.equal(value.taskState.schema, 'hpm.context.task_state');
      for (const index of [20, 21])
        assert.ok(
          replayed.messages.some(
            (message) =>
              message.role === 'tool' &&
              JSON.stringify(message.content).includes('近期原始证据-' + index + '🙂')
          )
        );
      assert.deepEqual(f.errors, []);
      assert.equal(f.state.responsesHistory.size, 0);
    } finally {
      f.close();
    }
  }
});

test('production JSON/SSE compaction replays its evidence index and privately delivers an original page', async () => {
  for (const stream of [false, true]) {
    const f = fixture({ mode: 'evidence', maxRequestBytes: 80000 });
    try {
      const input = source.map((item) =>
        item.call_id === 'completed-original' && item.type === 'function_call_output'
          ? { ...item, output: '原始完整证据🙂'.repeat(12000), future: { intact: true } }
          : item
      );
      const compacted = await f.request([...input, { type: 'compaction_trigger' }], { stream });
      assert.ok(compacted, JSON.stringify(f.errors));
      assert.equal(f.artifacts.stats().entries, 1);
      assert.ok(!JSON.stringify(f.sent).includes(input[3].output));
      const reply = await f.request(
        [...compacted.output, { role: 'user', content: '读取原证据，不能自行重跑工具。' }],
        { stream }
      );
      assert.ok(reply, JSON.stringify(f.errors));
      const delivered = f.sent
        .at(-1)
        .messages.find((m) => m.role === 'tool' && m.name === CONTEXT_ARTIFACT_TOOL_NAME);
      assert.ok(delivered, JSON.stringify(f.sent.at(-1)));
      const page = JSON.parse(delivered.content);
      assert.equal(page.ok, true, JSON.stringify(page));
      assert.ok(page.page.text.includes('原始完整证据🙂'));
      assert.equal(page.page.totalBytes, Buffer.byteLength(JSON.stringify(input[3])));
      assert.equal(f.sent.length, 3);
      assert.deepEqual(f.errors, []);
      assert.ok(!JSON.stringify(f.events).includes('原始完整证据'));
      assert.ok(!JSON.stringify(f.endings).includes('原始完整证据'));
    } finally {
      f.close();
    }
  }
});

test('dedicated compaction cannot inherit an execution prompt preset', async () => {
  const f = fixture({ preset: { name: 'execution', content: 'EXECUTE_SIDE_EFFECT_NOW' } });
  try {
    assert.ok(await f.request([...source, { type: 'compaction_trigger' }]));
    assert.ok(
      f.sent[0].messages[0].content.startsWith('You are a dedicated historical-context summarizer')
    );
    assert.ok(!JSON.stringify(f.sent[0]).includes('EXECUTE_SIDE_EFFECT_NOW'));
  } finally {
    f.close();
  }
});

test('production replay rejects tampering, expired state and model/owner switches before host calls', async () => {
  const f = fixture();
  try {
    const response = await f.request([...source, { type: 'compaction_trigger' }]);
    const item = response.output[0];
    for (const opts of [{ owner: 'other' }, { model: 'other-model' }])
      await f.request([item], opts);
    await f.request([{ ...item, encrypted_content: item.encrypted_content.slice(0, -4) + 'AAAA' }]);
    f.expire();
    await f.request([item]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.errors.length, 4);
    assert.ok(f.errors.every((error) => error.status === 400));
  } finally {
    f.close();
  }
});

test('authenticated local summary stays verbatim through historical eviction and the smaller adaptive retry', async () => {
  const f = fixture({ mode: 'retry' });
  try {
    const compacted = await f.request([...source, { type: 'compaction_trigger' }]);
    const older = [];
    for (let index = 0; index < 20; index++)
      older.push(
        { type: 'function_call', call_id: 'extra-' + index, name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'extra-' + index, output: '大证据🙂'.repeat(2500) }
      );
    const reply = await f.request([
      ...compacted.output,
      ...older,
      { type: 'message', role: 'user', content: '继续并保持原始摘要状态。' },
    ]);
    assert.ok(reply, JSON.stringify(f.errors));
    assert.equal(f.sent.length, 3);
    const summaries = f.sent
      .slice(1)
      .map(
        (body) =>
          body.messages.find((message) => message.content?.startsWith(LOCAL_SUMMARY_MARKER))
            ?.content
      );
    assert.ok(summaries[0]?.includes(summaryText));
    assert.equal(summaries[1], summaries[0]);
    assert.ok(
      Buffer.byteLength(JSON.stringify(f.sent[2])) < Buffer.byteLength(JSON.stringify(f.sent[1]))
    );
  } finally {
    f.close();
  }
});

test('truncated/tool/thrown/cancelled provider summaries never publish a successful checkpoint', async () => {
  for (const mode of ['truncated', 'tool', 'throw', 'cancel']) {
    const f = fixture({ mode });
    try {
      assert.equal(await f.request([...source, { type: 'compaction_trigger' }]), undefined);
      assert.equal(f.envelopes.stats().entries, 0);
      assert.equal(f.endings[0][3], mode === 'cancel' ? 499 : 502);
      assert.ok(!JSON.stringify([...f.errors, ...f.endings]).includes('PRIVATE_UPSTREAM_ERROR'));
    } finally {
      f.close();
    }
  }
});

test('standalone JSON compaction preserves canonical retained items and host-only accounting before JSON/SSE continuation', async () => {
  for (const mode of ['normal', 'summary-sse']) {
    const f = fixture({ mode });
    try {
      const compacted = await f.request(source, { standalone: true });
      assert.ok(compacted, JSON.stringify(f.errors));
      assert.equal(compacted.object, 'response.compaction');
      assert.equal(compacted.output[0].type, 'compaction');
      assert.equal(compacted.hpm_compaction.origin, 'hpm-local-compaction-v1');
      assert.equal(compacted.hpm_compaction.provider_billing, 'not_verified');
      assert.equal(compacted.hpm_compaction.upstream_calls, 1);
      assert.deepEqual(compacted.usage, {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 50 },
        output_tokens_details: { reasoning_tokens: 2 },
      });
      for (const item of [source[0], source[1], source[5], ...source.slice(6)])
        assert.ok(
          compacted.output.some((output) => JSON.stringify(output) === JSON.stringify(item))
        );
      const hidden = f.envelopes.read(compacted.output[0].encrypted_content, {
        owner: 'owner',
        provider: 'workbuddy-wbipc',
        model: 'hy4-preview-f',
        endpoint: 'https://host:443/v2',
      });
      assert.ok(hidden.every((item) => item.role === 'assistant'));
      assert.ok(hidden[0].content.startsWith(LOCAL_SUMMARY_MARKER));
      assert.equal(f.sent[0].tools, undefined);
      assert.equal(f.sent[0].stream, true);
      const next = await f.request([...compacted.output, { role: 'user', content: '继续验证🙂' }], {
        stream: mode === 'summary-sse',
      });
      assert.ok(next, JSON.stringify(f.errors));
      const main = f.sent.at(-1);
      for (const original of [source[1], source[5]])
        assert.equal(
          main.messages.filter((message) => message.content === original.content).length,
          1
        );
      assert.equal(
        main.messages.filter((message) => message.content?.startsWith(LOCAL_SUMMARY_MARKER)).length,
        1
      );
      assert.deepEqual(f.errors, []);
      assert.equal(f.state.responsesHistory.size, 0);
    } finally {
      f.close();
    }
  }
});

test('standalone no-op and local reuse report no upstream calls, not estimated token costs', async () => {
  const f = fixture();
  try {
    const compacted = await f.request([{ role: 'user', content: '保留全文🙂', future: true }], {
      standalone: true,
    });
    assert.ok(compacted, JSON.stringify(f.errors));
    assert.equal(f.sent.length, 0);
    assert.deepEqual(compacted.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    assert.equal(compacted.hpm_compaction.usage_source, 'no_upstream_call');
    assert.equal(compacted.output[1].content, '保留全文🙂');
    const first = await f.request(source, { standalone: true });
    const second = await f.request(source, { standalone: true });
    assert.ok(first && second, JSON.stringify(f.errors));
    assert.equal(f.sent.length, 1);
    assert.equal(second.hpm_compaction.summary_reused, true);
    assert.deepEqual(second.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  } finally {
    f.close();
  }
});

test('standalone missing/invalid usage or oversized final window cannot publish checkpoints or evidence', async () => {
  for (const mode of ['usage-missing', 'usage-invalid']) {
    const f = fixture({ mode, maxRequestBytes: 80000 });
    try {
      const input = source.map((item) =>
        item.type === 'function_call_output' && item.call_id === 'completed-original'
          ? { ...item, output: '大证据🙂'.repeat(12000) }
          : item
      );
      assert.equal(await f.request(input, { standalone: true }), undefined);
      assert.equal(f.errors[0].payload.error.code, 'compaction_usage_unavailable');
      assert.equal(f.errors[0].status, 502);
      assert.equal(f.envelopes.stats().entries, 0);
      assert.equal(f.artifacts.stats().entries, 0);
      assert.ok(!JSON.stringify(f.endings).includes('大证据'));
    } finally {
      f.close();
    }
  }
  const f = fixture({ maxRequestBytes: 5000 });
  try {
    assert.equal(
      await f.request([{ role: 'user', content: '不允许裁剪🙂'.repeat(1000) }], {
        standalone: true,
      }),
      undefined
    );
    assert.equal(f.errors[0].status, 413);
    assert.equal(f.sent.length, 0);
    assert.equal(f.envelopes.stats().entries, 0);
  } finally {
    f.close();
  }
});

test('repeated standalone compaction keeps authenticated old summaries inside checkpoints and renews continuation without duplicate policies', async () => {
  const f = fixture({ renewable: true });
  try {
    const first = await f.request(source, { standalone: true });
    assert.ok(first, JSON.stringify(f.errors));
    f.advance(50);
    const second = await f.request(
      [...first.output, { role: 'user', content: '第二轮明确约束🙂' }],
      { standalone: true }
    );
    assert.ok(second, JSON.stringify(f.errors));
    assert.ok(!second.output.some((item) => item.content?.startsWith(LOCAL_SUMMARY_MARKER)));
    assert.equal(second.hpm_compaction.upstream_calls, 0);
    f.advance(60);
    const next = await f.request([...second.output, { role: 'user', content: '第三轮继续🙂' }]);
    assert.ok(next, JSON.stringify(f.errors));
    const main = f.sent.at(-1);
    assert.equal(
      main.messages.filter((message) => message.content?.startsWith(LOCAL_SUMMARY_MARKER)).length,
      1
    );
    assert.equal(
      main.messages.filter((message) => message.content === source[1].content).length,
      1
    );
    assert.equal(
      main.messages.filter((message) => message.content === '第二轮明确约束🙂').length,
      1
    );
    assert.equal(f.sent.length, 2);
    await f.request(second.output, { owner: 'unrelated-owner' });
    assert.equal(f.errors.at(-1).status, 400);
    assert.equal(f.sent.length, 2);
  } finally {
    f.close();
  }
});

test('source/response limits, foreign native state and invalid trigger ordering fail without success publication', async () => {
  for (const settings of [{ maxRequestBytes: 100 }, { maxResponseBytes: 100 }]) {
    const f = fixture(settings);
    try {
      assert.equal(await f.request([...source, { type: 'compaction_trigger' }]), undefined);
      assert.equal(f.envelopes.stats().entries, 0);
      assert.equal(f.errors[0].status, settings.maxRequestBytes ? 413 : 502);
      assert.equal(f.sent.length, settings.maxRequestBytes ? 0 : 1);
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    for (const input of [
      [{ type: 'compaction', encrypted_content: 'foreign-native' }],
      [{ type: 'compaction_trigger' }, source[0]],
      [{ type: 'compaction_trigger' }],
    ])
      await f.request(input);
    assert.equal(f.sent.length, 0);
    assert.ok(f.errors.every((error) => error.status === 400));
  } finally {
    f.close();
  }
});
