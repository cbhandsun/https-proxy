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
const { collectContextArtifactReferences } = require('../lib/proxy/context-artifact-references');
const {
  CONTEXT_ARTIFACT_TOOL_NAME,
  parseBufferedChatCompletion,
} = require('../lib/proxy/context-artifact-tool');
const {
  createContextToolCatalogStore,
  TOOL_DISCOVERY_CAPABILITY,
  TOOL_DISCOVERY_HEADER,
  TOOL_DISCOVERY_NAME,
} = require('../lib/proxy/context-tool-catalog');

const originalTools = Array.from({ length: 40 }, (_entry, index) => ({
  type: 'function',
  name: `tool_${index}`,
  description: 'UNTRUSTED_SCHEMA_METADATA🙂 '.repeat(45),
  strict: false,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', enum: ['安全🙂', 'b'], description: 'retain exact constraints' },
    },
    $defs: { exact: { type: 'string', minLength: 2, maxLength: 40 } },
  },
}));
const expectedTool = (index) => {
  const { type, ...definition } = originalTools[index];
  return { type, function: definition };
};
const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const external = call('external_original', 'tool_0', '{ "path": "安全🙂" }');
const evidencePrefix = 'RAW_EVIDENCE🙂'.repeat(1200);
const mixedModes = new Set([
  'mixed',
  'missingEvidence',
  'mixedTruncated',
  'mixedMalformed',
  'mixedOutOfPhase',
  'mixedProvider500',
]);

function hostResponse(
  body,
  calls,
  { finish = calls ? 'tool_calls' : 'stop', content = null } = {}
) {
  const completion = {
    id: 'chat_fixture',
    model: 'hy4-preview-f',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: finish,
        message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) },
      },
    ],
  };
  return {
    ok: true,
    status: 200,
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
                ...(calls
                  ? { tool_calls: calls.map((entry, index) => ({ ...entry, index })) }
                  : {}),
              },
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n'
      : JSON.stringify(completion),
  };
}

async function run({
  stream = false,
  mode = 'discovery',
  capability = TOOL_DISCOVERY_CAPABILITY,
  disabled = false,
  storeHistory = true,
  forced = false,
  history = true,
} = {}) {
  let now = 1,
    session,
    scope,
    resolveDone;
  const catalogStore = createContextToolCatalogStore({ now: () => now });
  const artifactStore = createContextArtifactStore();
  const sent = [],
    catalogStates = [],
    events = [],
    endings = [],
    errors = [],
    dispatchErrors = [];
  const headers = {};
  const fallbackId = (prefix) => prefix + '_fixture';
  const protocolOptions = {
    contextWindowPolicy: mode === 'tokenBudgetZero' ? 'overflow-drop-oldest' : 'disabled',
    ...(mode === 'tokenBudgetZero' ? { maxContextTokens: 10000 } : {}),
    ...(disabled ? { workbuddyToolDiscoveryPolicy: 'disabled' } : {}),
  };
  const protocol = createOpenAIProtocol({
    cleanToolArgs: (_name, value) => value,
    fallbackId,
    stableCreated: () => 1,
    protocolOptions,
  });
  const logRequestEnd = (...values) => {
    endings.push(values);
    resolveDone?.();
  };
  const sendJsonError = (_res, status, payload) => errors.push({ status, payload });
  const state = createResponsesState({
    ...protocol,
    log: { warn() {}, info() {} },
    sendJsonError,
    logRequestEnd,
    fallbackId,
    stableCreated: () => 1,
    logProxyEvent: (kind, value) => events.push({ kind, value }),
    conversionResponseLimit: 16 * 1024 * 1024,
  });
  const catalogAdapter = {
    open(body, options) {
      if (mode === 'negotiationThrow') throw new Error('PRIVATE_PROVIDER_FAILURE');
      scope = options.scope;
      const opened = catalogStore.open(body, options);
      session = opened.catalog;
      return opened;
    },
  };
  const artifactAdapter =
    mode !== 'publication'
      ? artifactStore
      : {
          beginTransaction(owner, requestScope) {
            const tx = artifactStore.beginTransaction(owner, requestScope);
            return {
              ...tx,
              commit(references) {
                return references && sent.length > 0 ? { ok: false } : tx.commit(references);
              },
            };
          },
          get: (...args) => artifactStore.get(...args),
        };
  const ctx = {
    ...protocol,
    ...state,
    CORS_HEADERS: {},
    protocolOptions,
    workbuddyPreflightBodyBytes: 1,
    workbuddyTargetBodyBytes: mode === 'preflightBudget' ? 50 : 100000,
    contextArtifactStore: artifactAdapter,
    contextToolCatalogStore: catalogAdapter,
    contextCapacityController: {
      targetBytes(_key, value) {
        return mode === 'schemaBudget' && sent.length > 0 ? 200 : value;
      },
      recordSuccess() {},
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
    logProxyEvent: (kind, value) => {
      if (mode === 'loggingThrow' && kind === 'workbuddy_tool_discovery_negotiation')
        throw new Error('PRIVATE_PROVIDER_FAILURE');
      events.push({ kind, value });
    },
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
        catalogStates.push(session?.stats());
        try {
          assert.deepEqual(Object.keys(params.headers).sort(), ['accept', 'content-type']);
          assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 100000);
          // Check original, archived bytes even when the client did not opt
          // into discovery; the early sanitizer must never truncate evidence.
          const archived = collectContextArtifactReferences(body.messages, scope)[0];
          if (archived) {
            const evidence = artifactStore.read('owner', scope, archived.locator, archived.digest);
            assert.equal(evidence.ok, true);
            assert.equal(
              evidence.value,
              evidencePrefix + 'MIDDLE_FULL_EVIDENCE🙂' + 'RAW_TAIL'.repeat(1200)
            );
          }
          if (!session) return hostResponse(body, null, { content: 'FALLBACK_OK' });
          if (forced)
            return hostResponse(body, [call('forced_original', 'tool_39', { path: 'b' })]);
          if (mode === 'cancel') {
            return new Promise((resolve) => {
              signal.addEventListener('abort', () => resolve({ ok: false, status: 'cancelled' }), {
                once: true,
              });
              setImmediate(() => currentReq.emit('aborted'));
            });
          }
          if (mode === 'providerThrow' && sent.length === 2)
            throw new Error('PRIVATE_PROVIDER_FAILURE');
          if (mode === 'limit')
            return hostResponse(body, [
              call('query_' + sent.length, TOOL_DISCOVERY_NAME, { query: 'absent_' + sent.length }),
            ]);
          if (sent.length === 1) {
            assert.ok(!body.tools.some((tool) => tool.function.name === 'tool_39'));
            if (mode === 'unloaded') return hostResponse(body, [call('unloaded', 'tool_39', {})]);
            if (mode === 'unknown') return hostResponse(body, [call('unknown', 'undeclared', {})]);
            if (mode === 'reusedExternal')
              return hostResponse(body, [call('history-0', 'tool_0', {})]);
            if (mode === 'expiry') now += 300000;
            const discovery = call(
              mode === 'reusedInternal' ? 'history-0' : 'discover_original',
              TOOL_DISCOVERY_NAME,
              mode === 'discovery' ? { query: 'tool_39' } : { names: ['tool_39'] }
            );
            if (mode === 'malformedArgs') discovery.function.arguments = '{bad';
            if (mixedModes.has(mode)) {
              const receipt = collectContextArtifactReferences(body.messages, scope)[0];
              assert.ok(receipt);
              return hostResponse(
                body,
                [
                  external,
                  discovery,
                  call('evidence_original', CONTEXT_ARTIFACT_TOOL_NAME, {
                    ...receipt,
                    ...(mode === 'missingEvidence' ? { digest: '0'.repeat(64) } : {}),
                    limitBytes: 4096,
                    offsetBytes: Buffer.byteLength(evidencePrefix),
                  }),
                ],
                { content: 'Original assistant text' }
              );
            }
            return hostResponse(
              body,
              mode === 'duplicate' ? [discovery, discovery] : [discovery],
              mode === 'truncated' ? { finish: 'length' } : {}
            );
          }
          if (mode === 'loop')
            return hostResponse(body, [
              call('loop_next', TOOL_DISCOVERY_NAME, { names: ['tool_39'] }),
            ]);
          if (mixedModes.has(mode)) {
            assert.deepEqual(
              body.tools.map((tool) => tool.function.name),
              [CONTEXT_ARTIFACT_TOOL_NAME, TOOL_DISCOVERY_NAME]
            );
            assert.ok(
              !body.messages.some((message) =>
                message.tool_calls?.some((entry) => entry.id === external.id)
              )
            );
            const evidence = body.messages.find(
              (message) => message.tool_call_id === 'evidence_original'
            );
            assert.equal(JSON.parse(evidence.content).ok, true);
            assert.ok(JSON.parse(evidence.content).page.text.includes('MIDDLE_FULL_EVIDENCE'));
            if (mode === 'mixedMalformed')
              return { ok: true, status: 200, headers: {}, body: '{bad' };
            if (mode === 'mixedOutOfPhase') return hostResponse(body, [external]);
            if (mode === 'mixedProvider500') return { ...hostResponse(body, null), status: 500 };
            if (mode === 'mixedTruncated')
              return hostResponse(body, null, {
                finish: 'length',
                content: 'partial acknowledgement',
              });
            return hostResponse(body, null, { content: 'PRIVATE_RECOVERY_ACK' });
          }
          if (mode === 'discovery' && sent.length === 2) {
            const result = body.messages.find(
              (message) => message.tool_call_id === 'discover_original'
            );
            const found = JSON.parse(result.content);
            assert.equal(found.authority, 'untrusted_tool_metadata');
            assert.deepEqual(
              found.tools.map((tool) => tool.name),
              ['tool_39']
            );
            return hostResponse(body, [
              call('load_original', TOOL_DISCOVERY_NAME, { names: ['tool_39'] }),
            ]);
          }
          assert.deepEqual(
            body.tools.find((tool) => tool.function.name === 'tool_39'),
            expectedTool(39)
          );
          return hostResponse(body, [call('loaded_external', 'tool_39', '{ "path": "安全🙂" }')]);
        } catch (error) {
          if (!(mode === 'providerThrow' && error.message === 'PRIVATE_PROVIDER_FAILURE'))
            dispatchErrors.push(error.message);
          throw error;
        }
      },
    },
  };
  const handler = createOpenAIResponsesToChatHandler(ctx, createRouteResponseHelpers(ctx));
  const input = [{ type: 'message', role: 'user', content: '保留约束，不要替客户端执行工具。' }];
  if (history)
    for (let index = 0; index < 20; index++)
      input.push(
        { type: 'function_call', call_id: `history-${index}`, name: 'tool_0', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: `history-${index}`,
          output: evidencePrefix + 'MIDDLE_FULL_EVIDENCE🙂' + 'RAW_TAIL'.repeat(1200),
        }
      );
  input.push({ type: 'message', role: 'user', content: '继续，遵守原始约束。' });
  const currentReq = new EventEmitter();
  currentReq.method = 'POST';
  currentReq.headers = capability === undefined ? {} : { [TOOL_DISCOVERY_HEADER]: capability };
  const res = new EventEmitter();
  res.writableLength = 0;
  res.writes = [];
  res.setHeader = (name, value) => {
    headers[name] = value;
  };
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
  try {
    handler(
      currentReq,
      res,
      {
        authProvider: 'workbuddy',
        profile: { id: 'owner', protocol: 'workbuddy' },
        rewriteTo: 'hy4-preview-f',
        workbuddyAuth: { accessTokenEncrypted: true },
        buffer: Buffer.from(
          JSON.stringify({
            model: 'workbuddy/hy4',
            stream,
            store: storeHistory,
            input,
            tools: originalTools,
            ...(forced ? { tool_choice: { type: 'function', name: 'tool_39' } } : {}),
          })
        ),
      },
      { path: '/v2' },
      '',
      '/v1/responses',
      Date.now()
    );
    let timer;
    await Promise.race([
      done,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Discovery route did not terminate')), 3000);
      }),
    ]).finally(() => clearTimeout(timer));
    await new Promise((resolve) => setImmediate(resolve));
    const completed = res.writes
      .map((chunk) => {
        const line = chunk.split('\n').find((entry) => entry.startsWith('data: '));
        return line && line !== 'data: [DONE]' ? JSON.parse(line.slice(6)) : null;
      })
      .find((event) => event?.type === 'response.completed');
    assert.equal(endings.length, 1, 'exactly one terminal outcome');
    assert.deepEqual(dispatchErrors, []);
    assert.equal(catalogStore.stats().entries, 0);
    assert.equal(catalogStore.stats().retainedBytes, 0);
    if (session) {
      assert.equal(session.stats().closed, true);
      assert.equal(session.stats().pending, false);
    }
    assert.equal(headers['x-hpm-context-capabilities'], TOOL_DISCOVERY_CAPABILITY);
    const diagnostics = JSON.stringify({ events, errors, endings });
    for (const secret of [
      'UNTRUSTED_SCHEMA_METADATA',
      'RAW_EVIDENCE',
      'MIDDLE_FULL_EVIDENCE',
      'PRIVATE_RECOVERY_ACK',
      'PRIVATE_PROVIDER_FAILURE',
      '安全🙂',
      external.function.arguments,
      scope,
    ]) {
      if (secret) assert.ok(!diagnostics.includes(secret), 'diagnostics are content-minimized');
    }
    return {
      sent,
      catalogStates,
      session,
      events,
      endings,
      errors,
      state,
      response: res.result || completed?.response,
      writes: res.writes.join(''),
    };
  } finally {
    catalogStore.close();
    artifactStore.close();
  }
}

test('negotiated JSON and SSE routes search then load exact schemas and keep external execution with the client', async () => {
  for (const stream of [false, true]) {
    const result = await run({ stream });
    assert.equal(result.endings[0][3], 200);
    assert.equal(result.sent.length, 3);
    assert.equal(result.session.stats().rounds, 2);
    assert.deepEqual(
      result.response.output
        .filter((item) => item.type === 'function_call')
        .map((item) => ({
          id: item.call_id,
          name: item.name,
          arguments: item.arguments,
        })),
      [{ id: 'loaded_external', name: 'tool_39', arguments: '{ "path": "安全🙂" }' }]
    );
    assert.ok(!JSON.stringify(result.response).includes(TOOL_DISCOVERY_NAME));
    assert.ok(!result.writes.includes('discover_original'));
    assert.equal(
      result.events.filter((event) => event.kind === 'workbuddy_context_outcome').length,
      1
    );
    assert.equal(result.state.responsesHistory.size, 1);
  }
});

test('parallel schema discovery, evidence recovery and external calls release unchanged originals only after acknowledgement', async () => {
  for (const stream of [false, true]) {
    const result = await run({ stream, mode: 'mixed' });
    assert.equal(result.endings[0][3], 200);
    assert.equal(result.sent.length, 2);
    assert.equal(result.session.stats().rounds, 1);
    assert.deepEqual(
      result.response.output
        .filter((item) => item.type === 'function_call')
        .map((item) => ({
          id: item.call_id,
          name: item.name,
          arguments: item.arguments,
        })),
      [{ id: external.id, ...external.function }]
    );
    assert.ok(!result.writes.includes('PRIVATE_RECOVERY_ACK'));
    const saved = result.state.responsesHistory.get(result.response.id);
    assert.ok(saved.some((message) => message.tool_call_id === 'evidence_original'));
    assert.ok(saved.some((message) => message.tool_call_id === 'discover_original'));
    assert.equal(
      saved
        .flatMap((message) => message.tool_calls || [])
        .filter((entry) => entry.id === external.id).length,
      1
    );
  }
});

test('unsupported and malformed negotiation fall back, while forced tools retain exact schemas and store:false stays private', async () => {
  for (const stream of [false, true]) {
    for (const options of [
      { capability: null },
      { capability: ['wrong'] },
      { capability: 'tool_reference' },
      { disabled: true },
    ]) {
      const result = await run({ stream, ...options });
      assert.equal(result.endings[0][3], 200);
      assert.equal(result.session, undefined);
      assert.ok(!result.sent[0].tools.some((tool) => tool.function.name === TOOL_DISCOVERY_NAME));
    }
    const forced = await run({ stream, forced: true, storeHistory: false });
    assert.equal(forced.endings[0][3], 200);
    assert.equal(forced.sent.length, 1);
    assert.deepEqual(
      forced.sent[0].tools.find((tool) => tool.function.name === 'tool_39'),
      expectedTool(39)
    );
    assert.deepEqual(forced.sent[0].tool_choice, {
      type: 'function',
      function: { name: 'tool_39' },
    });
    assert.equal(forced.state.responsesHistory.size, 0);
  }
});

test('unloaded tools, duplicate and archived IDs, invalid arguments, truncated discovery and expiry fail without client calls', async () => {
  for (const stream of [false, true])
    for (const mode of [
      'unloaded',
      'unknown',
      'duplicate',
      'reusedInternal',
      'reusedExternal',
      'malformedArgs',
      'truncated',
      'expiry',
    ]) {
      const result = await run({ stream, mode });
      assert.equal(result.endings[0][3], 502, mode);
      assert.equal(result.sent.length, 1, mode);
      assert.equal(result.response, undefined, mode);
      assert.equal(result.session.stats().rounds, 0, mode);
      assert.equal(result.state.responsesHistory.size, 0, mode);
    }
});

test('loops, bounded discovery rounds, quota publication and missing evidence terminate without partial mixed-call delivery', async () => {
  for (const stream of [false, true])
    for (const mode of ['loop', 'limit', 'publication', 'missingEvidence']) {
      const result = await run({ stream, mode });
      assert.equal(result.endings[0][3], 502, mode);
      assert.equal(result.response, undefined, mode);
      assert.equal(result.state.responsesHistory.size, 0, mode);
      assert.equal(
        result.session.stats().rounds,
        mode === 'loop' ? 1 : mode === 'limit' ? 8 : 0,
        mode
      );
    }
});

test('failed, malformed, truncated and out-of-phase internal acknowledgements never release held external calls', async () => {
  for (const stream of [false, true])
    for (const mode of [
      'mixedTruncated',
      'mixedMalformed',
      'mixedOutOfPhase',
      'mixedProvider500',
    ]) {
      const result = await run({ stream, mode });
      assert.equal(result.endings[0][3], mode === 'mixedProvider500' ? 500 : 502, mode);
      assert.equal(result.response, undefined, mode);
      assert.equal(result.sent.length, 2, mode);
      assert.equal(result.state.responsesHistory.size, 0, mode);
      assert.ok(!result.writes.includes(external.id));
    }
});

test('budget rejection, client cancellation and provider or synchronous preparation exceptions release catalogs safely', async () => {
  for (const stream of [false, true])
    for (const mode of [
      'schemaBudget',
      'preflightBudget',
      'tokenBudgetZero',
      'cancel',
      'providerThrow',
      'negotiationThrow',
      'loggingThrow',
    ]) {
      const result = await run({ stream, mode });
      assert.equal(
        result.endings[0][3],
        mode === 'tokenBudgetZero'
          ? 400
          : mode.endsWith('Budget')
            ? 413
            : mode === 'cancel'
              ? 499
              : 502,
        mode
      );
      assert.equal(result.response, undefined, mode);
      assert.equal(result.state.responsesHistory.size, 0, mode);
      if (mode === 'tokenBudgetZero') {
        assert.equal(result.errors[0].status, 400);
        assert.equal(result.errors[0].payload.error.code, 'context_length_exceeded');
      }
      if (['negotiationThrow', 'loggingThrow', 'preflightBudget', 'tokenBudgetZero'].includes(mode))
        assert.equal(result.sent.length, 0, mode);
    }
});
