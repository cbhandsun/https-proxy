'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const { createResponsesState } = require('../lib/proxy/handlers/responses-state');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
const { createRouteResponseHelpers } = require('../lib/proxy/handlers/route-response-helpers');
const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');
const {
  CONTEXT_ARTIFACT_TOOL_NAME,
  contextArtifactToolDefinition,
} = require('../lib/proxy/context-artifact-tool');

const scope = 'hcs_' + '4'.repeat(32);
const externalCalls = [
  {
    id: 'write_original',
    type: 'function',
    function: { name: 'write', arguments: '{ "text": "汉🙂", "path": "a" }' },
  },
  { id: 'read_original', type: 'function', function: { name: 'read', arguments: '{}' } },
];

function hostResponse(body, message, finish = 'stop', status = 200) {
  const completion = {
    id: 'chat_fixture',
    model: 'hy4-preview-f',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
  };
  return {
    ok: true,
    status,
    headers: {},
    body: body.stream
      ? 'data: ' +
        JSON.stringify({
          ...completion,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              finish_reason: finish,
              delta: {
                ...completion.choices[0].message,
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
      : JSON.stringify(completion),
  };
}

async function run({ stream = false, mode = 'success', storeHistory = true } = {}) {
  let now = 1;
  const artifactStore = createContextArtifactStore({ now: () => now, ttlMs: 100 });
  const receipt = artifactStore.put(
    'owner',
    scope,
    'a'.repeat(100000) + 'MIDDLE_SENTINEL' + 'b'.repeat(100000)
  );
  const args = { locator: receipt.locator, scope, digest: receipt.digest, offsetBytes: 100000 };
  if (mode === 'expired') now = 101;
  const sent = [],
    events = [],
    endings = [],
    errors = [],
    acceptedSizes = [];
  const fallbackId = (prefix) => prefix + '_fixture';
  const protocol = createOpenAIProtocol({
    cleanToolArgs: (_name, value) => value,
    fallbackId,
    stableCreated: () => 1,
    protocolOptions: { contextWindowPolicy: 'disabled' },
  });
  let resolveDone;
  const logRequestEnd = (...values) => {
    endings.push(values);
    resolveDone?.();
  };
  const sendJsonError = (_res, status, payload) => errors.push({ status, payload });
  const state = createResponsesState({
    ...protocol,
    log: { warn() {}, info() {} },
    sendJsonError,
    logProxyEvent: (kind, value) => events.push({ kind, value }),
    logRequestEnd,
    fallbackId,
    stableCreated: () => 1,
    conversionResponseLimit: 16 * 1024 * 1024,
  });
  let currentReq;
  let capacityCalls = 0;
  const ctx = {
    ...protocol,
    ...state,
    CORS_HEADERS: {},
    protocolOptions: { contextWindowPolicy: 'disabled' },
    workbuddyPreflightBodyBytes: 1,
    workbuddyTargetBodyBytes: mode === 'preflight413' ? 50 : 100000,
    contextArtifactStore: artifactStore,
    contextCapacityController: {
      targetBytes(_key, value) {
        capacityCalls += 1;
        return mode === 'continuation413' && capacityCalls > 1 ? 200 : value;
      },
      recordSuccess(_key, size) {
        acceptedSizes.push(size);
      },
      recordRejection() {},
    },
    parseProxyBody: (_res, buffer) => JSON.parse(buffer.toString()),
    parseJsonOrSseJson: (raw) =>
      raw.startsWith('data:')
        ? (() => {
            const { parseBufferedChatCompletion } = require('../lib/proxy/context-artifact-tool');
            return parseBufferedChatCompletion(raw, true, 16 * 1024 * 1024);
          })()
        : JSON.parse(raw),
    rejectUnsupportedResponsesConversion: () => false,
    logRequestEnd,
    sendJsonError,
    logProxyEvent: (kind, value) => events.push({ kind, value }),
    writeJsonResponse(res, _status, response) {
      res.result = response;
    },
    sendUpstreamError(_res, status) {
      errors.push({ status });
    },
    workBuddyWbipcClient: {
      async request(params, { signal }) {
        const body = JSON.parse(params.body.toString());
        sent.push(body);
        if (sent.length === 1) {
          const internal = {
            id: mode === 'duplicate' ? externalCalls[0].id : 'internal_original',
            type: 'function',
            function: { name: CONTEXT_ARTIFACT_TOOL_NAME, arguments: JSON.stringify(args) },
          };
          const secondInternal = {
            ...internal,
            id: 'internal_missing',
            function: {
              name: CONTEXT_ARTIFACT_TOOL_NAME,
              arguments: JSON.stringify({ ...args, digest: '0'.repeat(64) }),
            },
          };
          return hostResponse(
            body,
            {
              content: 'Original assistant text',
              tool_calls: [
                externalCalls[0],
                internal,
                ...(mode === 'partial' ? [secondInternal] : []),
                externalCalls[1],
              ],
            },
            'tool_calls'
          );
        }
        if (body.messages.some((message) => message.tool_call_id === externalCalls[0].id)) {
          return hostResponse(body, { content: 'Task finished after client tool outputs' });
        }
        assert.deepEqual(
          body.tools.map((tool) => tool.function.name),
          [CONTEXT_ARTIFACT_TOOL_NAME]
        );
        assert.equal(body.tool_choice, 'auto');
        assert.ok(
          body.messages.every(
            (message) =>
              !message.tool_calls?.some((tool) =>
                externalCalls.some((external) => external.id === tool.id)
              )
          )
        );
        const result = body.messages.filter((message) => message.role === 'tool').at(-1);
        const page = JSON.parse(result.content);
        assert.equal(page.ok, true);
        assert.ok(page.page.text.startsWith('MIDDLE_SENTINEL') || sent.length === 3);
        if (mode === 'cancel') {
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ ok: false, status: 'cancelled' }), {
              once: true,
            });
            setImmediate(() => currentReq.emit('aborted'));
          });
        }
        if (mode === 'exception') throw new Error('PRIVATE_FAILURE');
        if (mode === 'upstream500') return hostResponse(body, { content: 'failed' }, 'stop', 500);
        if (mode === 'outOfPhase')
          return hostResponse(
            body,
            { content: null, tool_calls: [externalCalls[0]] },
            'tool_calls'
          );
        if (mode === 'truncated') return hostResponse(body, { content: 'partial' }, 'length');
        if (mode === 'malformed') return { ok: true, status: 200, headers: {}, body: '{bad' };
        if (mode === 'loop' || (mode === 'multiple' && sent.length === 2)) {
          return hostResponse(
            body,
            {
              content: null,
              tool_calls: [
                {
                  id: 'internal_next',
                  type: 'function',
                  function: {
                    name: CONTEXT_ARTIFACT_TOOL_NAME,
                    arguments: JSON.stringify({
                      ...args,
                      ...(mode === 'multiple' ? { offsetBytes: page.page.nextOffsetBytes } : {}),
                    }),
                  },
                },
              ],
            },
            'tool_calls'
          );
        }
        return hostResponse(body, { content: 'PRIVATE_RECOVERY_ACK' });
      },
    },
  };
  const handler = createOpenAIResponsesToChatHandler(ctx, createRouteResponseHelpers(ctx));
  async function invoke(parsed) {
    currentReq = new EventEmitter();
    currentReq.method = 'POST';
    currentReq.headers = {};
    const res = new EventEmitter();
    res.writableLength = 0;
    res.writes = [];
    res.writeHead = () => {
      res.headersSent = true;
    };
    res.write = (value) => {
      res.writes.push(String(value));
      return true;
    };
    res.end = () => {
      res.writableEnded = true;
      res.emit('finish');
    };
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    handler(
      currentReq,
      res,
      {
        authProvider: 'workbuddy',
        profile: { id: 'owner', protocol: 'workbuddy' },
        rewriteTo: 'hy4-preview-f',
        buffer: Buffer.from(JSON.stringify(parsed)),
        workbuddyAuth: { accessTokenEncrypted: true },
      },
      { path: '/v2' },
      '',
      '/v1/responses',
      Date.now()
    );
    const timer = setTimeout(() => resolveDone(), 3000);
    await done;
    clearTimeout(timer);
    await new Promise((resolve) => setImmediate(resolve));
    const completed = res.writes
      .map((chunk) => {
        const line = chunk.split('\n').find((value) => value.startsWith('data: '));
        if (!line || line === 'data: [DONE]') return null;
        return JSON.parse(line.slice(6));
      })
      .find((event) => event?.type === 'response.completed');
    return { res, response: res.result || completed?.response };
  }
  const tools = [
    contextArtifactToolDefinition(),
    ...['write', 'read'].map((name) => ({
      type: 'function',
      function: { name, parameters: { type: 'object', properties: {} } },
    })),
  ].map(({ type, function: definition }) => ({ type, ...definition }));
  const first = await invoke({
    model: 'workbuddy/hy4',
    stream,
    store: storeHistory,
    input: 'Read evidence: ' + JSON.stringify(args),
    tools,
  });
  assert.equal(endings.length, 1);
  const firstOutcomes = events.filter((event) => event.kind === 'workbuddy_context_outcome');
  assert.equal(firstOutcomes.length, 1);
  const outcome = firstOutcomes[0].value;
  const succeeds = ['success', 'multiple'].includes(mode);
  if (succeeds) {
    assert.equal(endings[0][3], 200);
    const calls = first.response.output.filter((item) => item.type === 'function_call');
    assert.deepEqual(
      calls.map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments })),
      externalCalls.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }))
    );
    assert.ok(!JSON.stringify(first.response).includes(CONTEXT_ARTIFACT_TOOL_NAME));
    assert.ok(!first.res.writes.join('').includes('PRIVATE_RECOVERY_ACK'));
    assert.equal(outcome.artifactsResolved, mode === 'multiple' ? 2 : 1);
    assert.equal(outcome.artifactsDelivered, outcome.artifactsResolved);
    assert.equal(acceptedSizes.at(-1), Buffer.byteLength(JSON.stringify(sent.at(-1))));
    assert.equal(
      acceptedSizes.length,
      sent.length,
      'every accepted dispatch is recorded exactly once'
    );
    if (storeHistory) {
      const history = state.responsesHistory.get(first.response.id);
      assert.ok(history.some((message) => message.tool_call_id === 'internal_original'));
      const second = await invoke({
        model: 'workbuddy/hy4',
        stream,
        previous_response_id: first.response.id,
        tools,
        input: externalCalls.map((call) => ({
          type: 'function_call_output',
          call_id: call.id,
          output: 'CLIENT_EXECUTED_RESULT',
        })),
      });
      assert.equal(endings.length, 2);
      assert.equal(endings[1][3], 200);
      assert.ok(
        second.response.output.some((item) =>
          item.content?.some((part) => part.text.includes('Task finished'))
        )
      );
      const resumed = sent.at(-1).messages;
      const allCalls = resumed.flatMap((message) => message.tool_calls || []);
      for (const call of allCalls) {
        assert.equal(allCalls.filter((item) => item.id === call.id).length, 1);
        assert.equal(resumed.filter((message) => message.tool_call_id === call.id).length, 1);
      }
      assert.ok(
        resumed.some(
          (message) => message.role === 'tool' && message.content.includes('MIDDLE_SENTINEL')
        )
      );
      assert.equal(
        resumed.filter((message) => message.content === 'CLIENT_EXECUTED_RESULT').length,
        2
      );
    } else assert.equal(state.responsesHistory.size, 0);
  } else {
    assert.equal(first.response, undefined);
    assert.equal(state.responsesHistory.size, 0);
    assert.equal(
      endings[0][3],
      mode.endsWith('413')
        ? 413
        : mode === 'cancel'
          ? 499
          : mode === 'upstream500'
            ? 500
            : mode === 'exception'
              ? 401
              : 502
    );
    if (['expired', 'partial'].includes(mode)) {
      assert.equal(outcome.terminalCode, 'context_artifact_recovery_failed');
      assert.equal(outcome.artifactsDelivered, 0);
      assert.equal(sent.length, 1);
    }
    if (mode === 'loop') assert.equal(outcome.terminalCode, 'context_artifact_read_loop');
    if (mode === 'duplicate') assert.equal(outcome.artifactsAttempted, 0);
  }
  const contextEvents = JSON.stringify(
    events.filter((event) => event.kind.startsWith('workbuddy_context_'))
  );
  for (const secret of [
    scope,
    receipt.locator,
    receipt.digest,
    'MIDDLE_SENTINEL',
    'PRIVATE_RECOVERY_ACK',
    'PRIVATE_FAILURE',
    externalCalls[0].function.arguments,
  ]) {
    assert.ok(!contextEvents.includes(secret));
  }
  assert.ok(!JSON.stringify(errors).includes('PRIVATE_FAILURE'));
  for (const request of sent) assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 100000);
}

async function main() {
  for (const stream of [false, true]) {
    await run({ stream });
    await run({ stream, mode: 'multiple' });
    await run({ stream, storeHistory: false });
    for (const mode of [
      'expired',
      'partial',
      'duplicate',
      'outOfPhase',
      'truncated',
      'malformed',
      'loop',
      'preflight413',
      'continuation413',
      'cancel',
      'exception',
      'upstream500',
    ]) {
      await run({ stream, mode });
    }
  }
  console.log('[workbuddy-mixed-tool-route.test] ok');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
