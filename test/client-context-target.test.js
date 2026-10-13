'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { fetch, AbortSignal } = globalThis;
const { createCoreRequestHandler } = require('../lib/proxy/core-request-handler');
const { parseTargetUrl } = require('../lib/proxy/routing');
const {
  CONTEXT_TARGET_HEADER,
  contextTargetToken,
  inspectClientContextTarget,
} = require('../lib/proxy/client-context-target');
const { createContextRecoveryClient } = require('../lib/client/context-recovery-client');
const { compactionReplayFailure } = require('../lib/proxy/context-compaction-lifecycle');

const binding = {
  owner: 'profile',
  provider: 'workbuddy-wbipc',
  model: 'model',
  endpoint: 'https://host:443/v2',
};
const token = contextTargetToken(binding);
const prepared = {
  profile: { id: 'profile', protocol: 'workbuddy', targetUrl: 'https://host:443/v2' },
  authMode: 'official-login',
  authProvider: 'workbuddy',
  rewriteTo: 'model',
  workbuddyAuth: { accessTokenEncrypted: true },
  buffer: Buffer.from(JSON.stringify({ model: 'model' })),
};

test('pinning uses the actual authenticated dispatch; changed owner/model/endpoint/provider/key cannot pass', () => {
  assert.deepEqual(inspectClientContextTarget({}, null, null), { pinned: false, ok: true });
  assert.equal(
    inspectClientContextTarget({ [CONTEXT_TARGET_HEADER]: token }, prepared, parseTargetUrl, null)
      .ok,
    true
  );
  const fallback = { ...prepared, rewriteTo: '-' };
  assert.equal(
    inspectClientContextTarget({ [CONTEXT_TARGET_HEADER]: token }, fallback, parseTargetUrl, null)
      .ok,
    true
  );
  for (const change of [
    { profile: { ...prepared.profile, id: 'other' } },
    { profile: { ...prepared.profile, targetUrl: 'https://another/v2' } },
    { profile: { ...prepared.profile, targetUrl: 'https://host:443/v3' } },
    { rewriteTo: 'another-model' },
    { workbuddyAuth: undefined },
    { profile: { ...prepared.profile, protocol: 'openai' }, authProvider: 'other' },
    { profile: { ...prepared.profile, targetUrl: 'invalid' } },
    { rewriteTo: '-', buffer: Buffer.from('bad-json') },
  ])
    assert.equal(
      inspectClientContextTarget(
        { [CONTEXT_TARGET_HEADER]: token },
        { ...prepared, ...change },
        parseTargetUrl,
        null
      ).ok,
      false
    );
  assert.equal(
    inspectClientContextTarget(
      { [CONTEXT_TARGET_HEADER]: token },
      prepared,
      parseTargetUrl,
      'synthetic-key'
    ).ok,
    false
  );
});

test('malformed/duplicate/accessor/extreme target pins fail without evaluating getters or revealing target data', () => {
  for (const value of [
    null,
    '',
    [],
    [token, token],
    token + ',' + token,
    'v2.' + 'a'.repeat(64),
    'v1.' + 'A'.repeat(64),
    'x'.repeat(10000),
    1,
  ])
    assert.equal(
      inspectClientContextTarget({ [CONTEXT_TARGET_HEADER]: value }, prepared, parseTargetUrl, null)
        .ok,
      false
    );
  let read = false;
  const headers = {
    get [CONTEXT_TARGET_HEADER]() {
      read = true;
      return token;
    },
  };
  assert.equal(inspectClientContextTarget(headers, prepared, parseTargetUrl, null).ok, false);
  assert.equal(read, false);
  assert.throws(() => contextTargetToken({ ...binding, cookie: 'forbidden' }));
  assert.equal(
    JSON.stringify(
      inspectClientContextTarget(
        { [CONTEXT_TARGET_HEADER]: token },
        { ...prepared, profile: null },
        parseTargetUrl,
        null
      )
    ),
    '{"pinned":true,"ok":false}'
  );
});

function coreFixture({ drift = false, authorized = true } = {}) {
  let calls = 0;
  let forbiddenCalls = 0;
  let route = prepared;
  const requestEnds = [];
  const handler = createCoreRequestHandler({
    getRuntimeState: () => ({
      ACTIVE_PROFILE: route.profile,
      PROFILES: [route.profile],
      MODEL_ROUTES: [],
      CLAUDE_DESKTOP_ROUTES: [],
      CLI_SESSIONS: new Map(),
      CONFIG: { appSettings: { conversationAuditEnabled: false } },
    }),
    MAX_REQUEST_BODY_BYTES: 2 * 1024 * 1024,
    getClientIp: () => '127.0.0.1',
    isClaudeDesktopRequest: () => false,
    stripClaudeDesktopPrefix: (value) => value,
    isLocalManagementPath: () => false,
    isConversationRequestPath: () => true,
    metricsInstance: { counter: () => ({ inc() {} }) },
    isQuietLocalPollRequest: () => true,
    resolveCliSession: () => ({}),
    log: { info() {}, error() {} },
    logProxyEvent() {},
    entryLabel: () => 'openai-responses',
    installEntryCorsGuard: () => true,
    dispatchLocalManagementRoute: () => false,
    authorizeEntryRequest: () => ({ ok: authorized, enabled: false }),
    isEntryHealthPath: () => false,
    isAllowedEntryPath: () => true,
    parseOpenAIImageJobId: () => null,
    forceChatEntry: () => false,
    forceClaudeEntry: () => false,
    forceResponsesEntry: () => true,
    parseModelsRequestPath: () => null,
    isOpenAIChatCompletionsPath: (value) => value === '/v1/chat/completions',
    isOpenAIResponsesPath: (value) => value === '/v1/responses',
    isOpenAIImagesGenerationsPath: () => false,
    isOpenAIImageJobsCollectionPath: () => false,
    profileMatchesEntryKey: () => true,
    isClaudeDesktop3pRequest: () => false,
    prepareRequestBufferWithResolver: (buffer) => ({ ...route, buffer }),
    resolveRoute() {},
    collectLimitedRequestBody(req, { onComplete }) {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => onComplete({ tooLarge: false, buffer: Buffer.concat(chunks) }));
    },
    applyCliSessionModelOverride() {},
    resolveOfficialCredentials: async (value) => value,
    isClaudeMessagesPath: () => false,
    isGeminiProfile: () => false,
    isClaudeProfile: () => false,
    isOpenAIProfile: () => true,
    resolveProfileProtocolVersion: () => null,
    parseTargetUrl,
    logModelMapping() {},
    shouldConvertClaudeMessagesToOpenAI: () => false,
    shouldConvertResponsesToOpenAIChat: () => true,
    logRequestEnd(_method, _path, _start, status, extra) {
      requestEnds.push({ status, extra });
    },
    sendJsonError(res, status, payload) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    },
    recordAuditUpstreamFailure() {},
    handleTraeOfficialResponses() {
      forbiddenCalls++;
    },
    handleTianxiOfficialResponses() {
      forbiddenCalls++;
    },
    handleOpenAIResponsesToOpenAIChat(_req, res, current) {
      calls++;
      const body = JSON.parse(current.buffer.toString());
      if (body.input.some((item) => item.type === 'compaction')) {
        const failure = compactionReplayFailure({ code: 'invalid_local_compaction' });
        if (drift) route = { ...prepared, profile: { ...prepared.profile, id: 'other-profile' } };
        res.writeHead(failure.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failure.payload));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output: body.input }));
      }
    },
  });
  const server = http.createServer((req, res) =>
    handler(req, res, { protocol: 'openai-responses' })
  );
  return {
    server,
    setRoute(value) {
      route = value;
    },
    calls: () => calls,
    forbiddenCalls: () => forbiddenCalls,
    requestEnds,
  };
}

test('real core HTTP guards every rebuild against a profile switch and acknowledges unchanged targets', async () => {
  for (const drift of [false, true]) {
    const fixture = coreFixture({ drift });
    fixture.server.listen(0, '127.0.0.1');
    await once(fixture.server, 'listening');
    const endpoint = `http://127.0.0.1:${fixture.server.address().port}/v1/responses`;
    const client = createContextRecoveryClient({
      enabled: true,
      endpoint,
      owner: 'profile',
      threadId: 'thread',
      model: 'model',
      targetBinding: binding,
    });
    const original = [
      { role: 'system', content: 'unchanged policy' },
      { role: 'user', content: '撤销旧要求🙂' },
    ];
    const request = {
      model: 'model',
      input: [
        { type: 'compaction', encrypted_content: 'hpm-local-compaction-v2:expired' },
        original[1],
      ],
    };
    try {
      const history = client.capture({ request, originalInput: original, complete: true });
      const response = await client.send(request, { history, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, drift ? 409 : 200);
      assert.equal(
        fixture.calls(),
        drift ? 1 : 2,
        'no original history reaches a changed provider dispatch'
      );
      if (drift) {
        assert.equal((await response.json()).error.code, 'context_target_mismatch');
        assert.equal(fixture.requestEnds.at(-1).extra.type, 'context_target_mismatch');
      } else assert.deepEqual((await response.json()).output, original);
      for (const provider of ['trae', 'tianxi']) {
        fixture.setRoute({ ...prepared, authProvider: provider, workbuddyAuth: undefined });
        const rejected = await fetch(endpoint, {
          method: 'POST',
          body: JSON.stringify(request),
          headers: { [CONTEXT_TARGET_HEADER]: token },
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(rejected.status, 409);
      }
      assert.equal(fixture.forbiddenCalls(), 0);
      const unsupported = await fetch(endpoint.replace('/responses', '/chat/completions'), {
        method: 'POST',
        body: '{}',
        headers: { [CONTEXT_TARGET_HEADER]: token },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(unsupported.status, 409);
    } finally {
      client.close();
      fixture.server.close();
      fixture.server.closeAllConnections();
      await once(fixture.server, 'close');
    }
  }
});

test('a matching target digest never grants entry authorization', async () => {
  const fixture = coreFixture({ authorized: false });
  fixture.server.listen(0, '127.0.0.1');
  await once(fixture.server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.server.address().port}/v1/responses`, {
      method: 'POST',
      body: '{"model":"model","input":[]}',
      headers: { [CONTEXT_TARGET_HEADER]: token },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get(CONTEXT_TARGET_HEADER), null);
    assert.equal(fixture.calls(), 0);
    assert.equal(fixture.forbiddenCalls(), 0);
  } finally {
    fixture.server.close();
    fixture.server.closeAllConnections();
    await once(fixture.server, 'close');
  }
});
