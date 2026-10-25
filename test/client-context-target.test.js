'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
require('../scripts/lib/coverage-io-capture').installCoverageIoCapture(test);
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
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
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
  exportContextRecoveryRootMetadata,
} = require('../lib/proxy/context-recovery-sessions');
const { stripEntryAuthHeaders } = require('../lib/proxy/entry-auth');
const { FakeWbipcSocket } = require('./helpers/workbuddy-wbipc-socket');
const { createContextRecoveryDiagnostics } = require('../lib/proxy/context-recovery-diagnostics');
const { createContextRecoveryRuntime } = require('../lib/proxy/context-recovery-runtime');
const { createRecoveryFixtureTiming } = require('./helpers/recovery-fixture-timing.cjs');
const {
  declareRecoveryScan,
  supportsRecoveryScan,
} = require('../lib/proxy/context-recovery-storage-contract');

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

function coreFixture({
  drift = false,
  authorized = true,
  recovery = false,
  recoverySessions,
  recoveryLifecycle,
  responseFactory,
  native = false,
  kind = 'responses',
  liveProfile,
  resolveCredentials,
  converted = false,
  wbipc,
  reportingFailure = false,
  forwardFailure = false,
} = {}) {
  let calls = 0;
  let forbiddenCalls = 0;
  let route = prepared;
  const requestEnds = [];
  const diagnostics = createContextRecoveryDiagnostics();
  const handler = createCoreRequestHandler({
    contextRecoveryDiagnostics: diagnostics,
    contextRecoverySessions: recoverySessions,
    contextRecoveryLifecycle: recoveryLifecycle,
    contextRecoveryWbipc: wbipc,
    ...(wbipc
      ? {
          createWorkBuddyHttpTransport() {
            forbiddenCalls++;
            throw new Error('Unexpected legacy WBIPC transport');
          },
        }
      : {}),
    contextRecoveryProviderAllowed: native || converted ? () => true : undefined,
    contextRecoveryConverters: converted
      ? require('./helpers/recovery-converters').recoveryConverters()
      : undefined,
    contextRecoveryCompactionProviderAllowed: native ? () => true : undefined,
    buildOutgoingHeaders: require('../lib/proxy/upstream-request').buildOutgoingHeaders,
    parsePortOrDefault: (value, fallback) => Number(value) || fallback,
    getRuntimeState: () => ({
      ACTIVE_PROFILE: liveProfile || route.profile,
      PROFILES: [liveProfile || route.profile],
      MODEL_ROUTES: [],
      CLAUDE_DESKTOP_ROUTES: [],
      CLI_SESSIONS: new Map(),
      CONFIG: {
        appSettings: { conversationAuditEnabled: false, contextRecoveryEnabled: recovery },
      },
    }),
    MAX_REQUEST_BODY_BYTES: 2 * 1024 * 1024,
    MAX_CONVERSION_RESPONSE_BYTES: 2 * 1024 * 1024,
    resolveUpstreamRecovery: require('../lib/proxy/upstream-retry').resolveUpstreamRecovery,
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
    stripEntryAuthHeaders,
    dispatchLocalManagementRoute: () => false,
    authorizeEntryRequest: () => ({
      ok: authorized,
      enabled: recovery,
      ...(recovery ? { key: { id: 'fixture-owner' } } : {}),
    }),
    isEntryHealthPath: () => false,
    isAllowedEntryPath: () => true,
    parseOpenAIImageJobId: () => null,
    forceChatEntry: () => kind === 'chat',
    forceClaudeEntry: () => kind === 'claude',
    forceResponsesEntry: () => kind === 'responses',
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
    resolveOfficialCredentials:
      resolveCredentials ||
      (async (value) =>
        value.authProvider === 'workbuddy'
          ? require('../lib/proxy/context-recovery-auth').bindRecoveryWbipcCredentials(
              value,
              value.profile,
              () => true
            )
          : value),
    isClaudeMessagesPath: (value) => value === '/v1/messages',
    sampleRequestToolResults() {},
    isGeminiProfile: () => converted && route.profile.protocol === 'gemini',
    isClaudeProfile: () => (converted ? route.profile.protocol === 'claude' : kind === 'claude'),
    isOpenAIProfile: () =>
      converted ? !['claude', 'gemini'].includes(route.profile.protocol) : kind !== 'claude',
    resolveProfileProtocolVersion: () => null,
    parseTargetUrl,
    logModelMapping() {},
    shouldConvertClaudeMessagesToOpenAI: () => false,
    shouldConvertResponsesToOpenAIChat: () => !native,
    logRequestEnd(_method, _path, _start, status, extra) {
      requestEnds.push({ status, extra });
      if (reportingFailure && extra?.type === 'context_recovery_http')
        throw new Error('Synthetic outcome reporting failure');
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
    handleClaudeMessagesToOpenAIChat() {
      forbiddenCalls++;
      throw new Error('Unexpected legacy Claude conversion');
    },
    handleOpenAIResponsesToOpenAIChat(_req, res, current) {
      calls++;
      if (forwardFailure) throw new Error('synthetic-private-error');
      const body = JSON.parse(current.buffer.toString());
      if (responseFactory) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(responseFactory(body)));
        return;
      }
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
    handler(req, res, { protocol: kind === 'claude' ? 'claude' : 'openai-' + kind })
  );
  return {
    server,
    setRoute(value) {
      route = value;
    },
    calls: () => calls,
    forbiddenCalls: () => forbiddenCalls,
    requestEnds,
    recoveryDiagnostics: () =>
      diagnostics.inspect({ appSettings: { contextRecoveryEnabled: recovery } }),
    setRecovery(value) {
      recovery = value;
    },
  };
}

test('actual core refuses blocked recovery admission before ordinary HTTP forwarding', async (t) => {
  for (const code of [
    'context_binding_unavailable',
    'context_recovery_busy',
    'context_recovery_storage_unavailable',
    'context_recovery_binding_changed',
  ]) {
    const runtime = createContextRecoverySessions();
    runtime.beginAsync = async () => ({ ok: false, code });
    const fixture = coreFixture({ recovery: true, recoverySessions: runtime });
    fixture.server.listen(0, '127.0.0.1');
    await once(fixture.server, 'listening');
    t.after(async () => {
      await runtime.shutdownAsync();
      fixture.server.closeAllConnections();
      await new Promise((resolve) => fixture.server.close(resolve));
    });
    const response = await fetch(
      'http://127.0.0.1:' + fixture.server.address().port + '/v1/responses',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'synthetic',
          previous_response_id: 'mixed-parent',
          input: [
            {
              type: 'function_call_output',
              call_id: 'external-pending',
              output: 'synthetic-private-output',
            },
          ],
        }),
        signal: AbortSignal.timeout(10000),
      }
    );
    assert.equal(response.status, 503, code);
    assert.deepEqual((await response.json()).error, {
      type: 'service_unavailable',
      code: 'context_recovery_unavailable',
      message: 'Context recovery is temporarily unavailable.',
    });
    assert.equal(fixture.calls(), 0);
    assert.equal(fixture.forbiddenCalls(), 0);
    assert.equal(fixture.requestEnds.length, 1);
    assert.equal(fixture.requestEnds[0].extra.type, 'context_recovery_admission_unavailable');
  }
});

for (const storageMode of ['memory', 'encrypted-worker']) {
  test(
    'actual core HTTP automatically adopts a unique stored continuation into a fresh lifecycle owner: ' +
      storageMode,
    {
      timeout: storageMode === 'memory' ? 10000 : 30000,
      skip: storageMode === 'encrypted-worker' && process.platform !== 'win32',
    },
    async (t) => {
      const trace = createRecoveryFixtureTiming();
      const loop = monitorEventLoopDelay({ resolution: 20 });
      loop.enable();
      t.after(() => {
        loop.disable();
        t.diagnostic(
          JSON.stringify({
            storageMode,
            phases: trace.snapshot(),
            eventLoopMaxMs: Math.floor(loop.max / 1e6),
          })
        );
      });
      const observeStartup = ({ phase }) => trace.mark(phase);
      const { DatabaseSync } = require('node:sqlite');
      const { randomBytes } = require('node:crypto');
      const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
      const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
      const directory =
        storageMode === 'encrypted-worker'
          ? fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-core-physical-reopen-'))
          : undefined;
      const database = storageMode === 'memory' ? new DatabaseSync(':memory:') : undefined;
      let engine = database
        ? createRecoverySqliteStore({
            database,
            dataKey: randomBytes(32).toString('base64'),
          })
        : await require('../lib/proxy/context-recovery-storage').openContextRecoveryStorage({
            directory,
            onStartup: observeStartup,
          });
      trace.mark('opened');
      const owners = [],
        fixtures = [],
        captured = [];
      let publication;
      function owner() {
        const execute = (command) => trace.run(command.operation, () => engine.execute(command));
        if (supportsRecoveryScan(engine.execute)) declareRecoveryScan(execute);
        const lifecycle = createContextRecoveryLifecycle({
          storage: {
            execute,
            close() {},
          },
        });
        owners.push(lifecycle);
        const begin = lifecycle.sessions.beginAsync;
        lifecycle.sessions.beginAsync = async (...args) => {
          const capability = await begin(...args);
          if (capability.ok) {
            captured.push(capability);
            const complete = capability.completeObservedAsync;
            capability.completeObservedAsync = async (...output) => {
              const result = await complete(...output);
              publication?.(result);
              return result;
            };
          }
          return capability;
        };
        return lifecycle;
      }
      const external = [
        {
          type: 'function_call',
          id: 'fc-restored',
          call_id: 'call-restored',
          name: 'lookup',
          arguments: '{}',
        },
      ];
      const answer = [
        {
          type: 'message',
          id: 'msg-restored',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        },
      ];
      const original = '只读恢复的新合成原文🙂\r\n';
      let requestIndex = 0;
      async function start(lifecycle) {
        assert.deepEqual(await lifecycle.configureAsync(true), { ok: true });
        const fixture = coreFixture({
          recovery: true,
          recoveryLifecycle: lifecycle,
          responseFactory(body) {
            return {
              object: 'response',
              status: 'completed',
              id: body.input.length === 1 ? 'response-root' : 'response-child',
              output: body.input.length === 1 ? external : answer,
            };
          },
        });
        fixtures.push(fixture);
        fixture.server.listen(0, '127.0.0.1');
        await once(fixture.server, 'listening');
        return async (input) => {
          const phase = ['first', 'capture', 'resume'][requestIndex++];
          assert.ok(phase);
          trace.mark(phase + '_start');
          const acknowledged = new Promise((resolve) => {
            publication = resolve;
          });
          const signal = AbortSignal.timeout(5000);
          let response;
          try {
            response = await fetch(
              'http://127.0.0.1:' + fixture.server.address().port + '/v1/responses',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model: 'model', input }),
                signal,
              }
            );
          } catch (error) {
            trace.mark(phase + (signal.aborted ? '_aborted' : '_failed'));
            throw error;
          }
          trace.mark(phase + '_headers');
          assert.equal(response.status, 200);
          await response.json();
          trace.mark(phase + '_body');
          assert.deepEqual(await acknowledged, { ok: true });
          trace.mark(phase + '_committed');
        };
      }
      try {
        const first = owner();
        const send = await start(first);
        const history = [{ role: 'user', content: 'fresh' }];
        await send(history);
        const capturedHistory = [
          ...history,
          ...external,
          { type: 'function_call_output', call_id: 'call-restored', output: original },
        ];
        await send(capturedHistory);
        assert.equal(captured.at(-1).inspect().visibleSources, 1);
        const saved = exportContextRecoveryRoot(first.sessions, captured[0].snapshotId);
        assert.deepEqual(await first.shutdownAsync(), { ok: true });
        if (storageMode === 'encrypted-worker') {
          await engine.close();
          assert.equal(
            fs
              .readFileSync(path.join(directory, 'checkpoint.sqlite'))
              .includes(Buffer.from(original)),
            false
          );
          engine =
            await require('../lib/proxy/context-recovery-storage').openContextRecoveryStorage({
              directory,
              onStartup: observeStartup,
            });
          trace.mark('reopened');
        }
        const second = owner();
        const continueRequest = await start(second);
        assert.equal(second.sessions.inspect().roots, 0);
        await continueRequest([
          ...capturedHistory,
          ...answer,
          { role: 'user', content: 'continue' },
        ]);
        const restored = captured.at(-1);
        assert.equal(restored.reason, 'observed_continuation');
        assert.equal(second.sessions.inspect().roots, 1);
        const resumed = exportContextRecoveryRoot(second.sessions, saved.rootId);
        assert.equal(resumed.expiresAt, saved.expiresAt);
        assert.deepEqual(resumed.budget, saved.budget);
        const index = JSON.parse(
          (await restored.replyAsync('hpm_list_retained_evidence', {})).text
        );
        assert.equal(index.sources.length, 1);
        const source = index.sources[0];
        const read = await restored.replyAsync('hpm_read_retained_evidence', {
          sourceId: source.sourceId,
          digest: source.digest,
        });
        assert.equal(read.ok, true);
        assert.equal(JSON.parse(read.text).page.text, original);
        assert.equal(
          trace.snapshot().filter((row) => row.phase === 'storage_scan_start').length,
          5
        );
        assert.equal(
          trace.snapshot().filter((row) => row.phase === 'storage_catalog_start').length,
          0
        );
      } finally {
        for (const fixture of fixtures) {
          fixture.server.closeAllConnections();
          await new Promise((resolve) => fixture.server.close(resolve));
        }
        for (const lifecycle of owners) await lifecycle.shutdownAsync();
        await engine.close();
        database?.close();
        if (directory) {
          const targetPath = path.resolve(directory);
          assert.equal(path.dirname(targetPath), path.resolve(os.tmpdir()));
          assert.ok(path.basename(targetPath).startsWith('hpm-core-physical-reopen-'));
          fs.rmSync(targetPath, { recursive: true, force: true });
        }
      }
    }
  );
}

test(
  'actual core HTTP rechecks authorization after storage loading and never forwards a revoked request',
  { timeout: 5000 },
  async () => {
    const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
    let release,
      entered,
      armed = false;
    const resume = new Promise((resolve) => {
      release = resolve;
    });
    const loading = new Promise((resolve) => {
      entered = resolve;
    });
    const owner = createContextRecoveryLifecycle({
      storage: {
        async execute(command) {
          assert.equal(command.operation, 'catalog');
          if (armed) {
            entered();
            await resume;
          }
          return [];
        },
        close() {},
      },
    });
    assert.deepEqual(await owner.configureAsync(true), { ok: true });
    const fixture = coreFixture({ recovery: true, recoveryLifecycle: owner });
    try {
      fixture.server.listen(0, '127.0.0.1');
      await once(fixture.server, 'listening');
      armed = true;
      const response = fetch(
        'http://127.0.0.1:' + fixture.server.address().port + '/v1/responses',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'model', input: [{ role: 'user', content: 'fresh' }] }),
          signal: AbortSignal.timeout(3000),
        }
      );
      await loading;
      fixture.setRecovery(false);
      release();
      const result = await response;
      assert.equal(result.status, 403);
      assert.equal((await result.json()).error.code, 'context_recovery_authorization_changed');
      assert.equal(fixture.calls(), 0);
      assert.equal(owner.sessions.inspect().roots, 0);
    } finally {
      release();
      fixture.server.closeAllConnections();
      await new Promise((resolve) => fixture.server.close(resolve));
      await owner.shutdownAsync();
    }
  }
);

test(
  'unqualified recovery leaves ordinary forwarding available; async forwarding failures are safe and never retried',
  { timeout: 5000 },
  async () => {
    for (const failForward of [false, true]) {
      const runtime = createContextRecoverySessions();
      const fixture = coreFixture({
        recovery: true,
        recoverySessions: runtime,
        forwardFailure: failForward,
        resolveCredentials: async (value) => value,
        responseFactory() {
          return { object: 'response', status: 'completed', output: [] };
        },
      });
      try {
        fixture.server.listen(0, '127.0.0.1');
        await once(fixture.server, 'listening');
        const response = await fetch(
          'http://127.0.0.1:' + fixture.server.address().port + '/v1/responses',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'model', input: [{ role: 'user', content: 'fresh' }] }),
            signal: AbortSignal.timeout(3000),
          }
        );
        assert.equal(response.status, failForward ? 502 : 200);
        const body = await response.json();
        if (failForward) {
          assert.equal(body.error.code, 'request_forward_unavailable');
          assert.equal(JSON.stringify(body).includes('synthetic-private-error'), false);
        }
        assert.equal(fixture.calls(), 1);
        assert.equal(runtime.inspect().roots, 0);
      } finally {
        fixture.server.closeAllConnections();
        await new Promise((resolve) => fixture.server.close(resolve));
        await runtime.shutdownAsync();
      }
    }
  }
);

test('actual core HTTP prospectively retains exact results without a token or installed plugin', async (t) => {
  const runtime = createContextRecoverySessions();
  const sessions = [];
  const policyChanges = [];
  const wrapper = {
    configure(value) {
      policyChanges.push(value);
      return runtime.configure(value);
    },
    configureAsync: (...args) => runtime.configureAsync(...args),
    shutdownAsync: (...args) => runtime.shutdownAsync(...args),
    inspect: () => runtime.inspect(),
    begin(...args) {
      const session = runtime.begin(...args);
      sessions.push(session);
      return session;
    },
    async beginAsync(...args) {
      const session = await runtime.beginAsync(...args);
      sessions.push(session);
      return session;
    },
  };
  const output = [
    {
      type: 'function_call',
      id: 'fc-fixture',
      call_id: 'call-fixture',
      name: 'lookup',
      arguments: '{}',
    },
  ];
  const fixture = coreFixture({
    recovery: true,
    recoverySessions: wrapper,
    responseFactory(body) {
      return {
        object: 'response',
        id: body.input.length === 1 ? 'response-first' : 'response-next',
        status: 'completed',
        output:
          body.input.length === 1
            ? output
            : [
                {
                  type: 'message',
                  id: 'msg-final',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'done' }],
                },
              ],
      };
    },
  });
  fixture.server.listen(0, '127.0.0.1');
  await once(fixture.server, 'listening');
  t.after(async () => {
    runtime.close();
    fixture.server.closeAllConnections();
    await new Promise((resolve) => fixture.server.close(resolve));
  });
  const endpoint = 'http://127.0.0.1:' + fixture.server.address().port + '/v1/responses';
  const input = [{ role: 'user', content: 'fresh question' }];
  const send = (body) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'model', ...body }),
    });
  const first = await send({ input });
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).output, output);
  const original = '新鲜原文🙂\n完整结果';
  const second = await send({
    input: [
      ...input,
      ...output,
      { type: 'function_call_output', call_id: 'call-fixture', output: original },
    ],
  });
  assert.equal(second.status, 200);
  await second.json();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].reason, 'observed_continuation');
  const index = JSON.parse(sessions[1].reply('hpm_list_retained_evidence', {}).text);
  assert.equal(index.sources.length, 1);
  const source = index.sources[0];
  const recovered = JSON.parse(
    sessions[1].reply('hpm_read_retained_evidence', {
      sourceId: source.sourceId,
      digest: source.digest,
    }).text
  );
  assert.equal(recovered.page.text, original);
  assert.equal(recovered.verification, 'not_verified');
  assert.deepEqual(policyChanges, [true]);
  fixture.setRecovery(false);
  const third = await send({ input });
  await third.json();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].reply('hpm_list_retained_evidence', {}).ok, false);
  assert.deepEqual(policyChanges, [true, false]);
});

test(
  'actual core HTTP observes replacement sessions after a real encrypted runtime mode change',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async (t) => {
    const started = performance.now();
    const phases = [];
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    const phase = (name) => {
      if (phases.length < 32)
        phases.push({ phase: name, elapsedMs: Math.floor(performance.now() - started) });
    };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-core-storage-policy-'));
    const dataDirectory = path.join(directory, 'custom', 'runtime');
    const runtime = createContextRecoveryRuntime({ dataDirectory });
    const counts = [];
    function observe() {
      const sessions = runtime.sessions;
      const begin = sessions.begin;
      const count = { calls: 0 };
      counts.push(count);
      sessions.begin = (...args) => {
        phase('session_begin');
        count.calls++;
        const result = begin(...args);
        phase('session_begin_returned');
        return result;
      };
    }
    observe();
    const fixture = coreFixture({
      recovery: true,
      recoveryLifecycle: runtime,
      responseFactory: () => ({
        object: 'response',
        id: 'fresh-response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg-final',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
        ],
      }),
    });
    try {
      fixture.server.listen(0, '127.0.0.1');
      await once(fixture.server, 'listening');
      phase('http_listening');
      async function send() {
        phase('request_started');
        const response = await fetch(
          'http://127.0.0.1:' + fixture.server.address().port + '/v1/responses',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'model',
              input: [{ role: 'user', content: 'fresh question' }],
            }),
            signal: AbortSignal.timeout(5000),
          }
        );
        phase('response_headers');
        assert.equal(response.status, 200);
        await response.json();
        phase('response_complete');
      }
      await send();
      assert.equal(counts[0].calls, 1);
      assert.equal(fs.existsSync(dataDirectory), false);
      const prior = runtime.sessions;
      phase('mode_switch_started');
      runtime.configureSettings({
        appSettings: { contextRecoveryEnabled: true, contextRecoveryPersistenceEnabled: true },
      });
      assert.deepEqual(await runtime.ready(), { ok: true });
      phase('mode_switch_ready');
      assert.equal(prior.inspect().closed, true);
      observe();
      await send();
      assert.equal(counts[0].calls, 1);
      assert.equal(counts[1].calls, 1);
      assert.equal(fixture.recoveryDiagnostics().storage, 'persistent');
      assert.ok(
        fs.statSync(path.join(dataDirectory, 'context-recovery-v1', 'checkpoint.sqlite')).isFile()
      );
    } finally {
      loop.disable();
      t.diagnostic(JSON.stringify({ phases, eventLoopMaxMs: Math.floor(loop.max / 1e6) }));
      fixture.server.closeAllConnections();
      await new Promise((resolve) => fixture.server.close(resolve));
      await runtime.shutdownAsync();
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      assert.ok(path.basename(target).startsWith('hpm-core-storage-policy-'));
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
);

test('actual core HTTP privately recovers evidence and publishes once; live revocation stops continuation', async (t) => {
  const { beginContextRecoveryRequest } = require('../lib/proxy/context-recovery-protocol');
  for (const { revoked, stream, official = false, credentialsRevoked = false } of [
    { revoked: false, stream: false },
    { revoked: false, stream: true },
    { revoked: true, stream: false },
    { revoked: false, stream: false, official: true },
    { revoked: false, stream: true, official: true },
    { revoked: false, stream: false, official: true, credentialsRevoked: true },
  ]) {
    const runtime = createContextRecoverySessions();
    runtime.configure(true);
    const history = [{ role: 'user', content: 'fixture question' }];
    const call = {
      type: 'function_call',
      id: 'fc-original',
      call_id: 'call-original',
      name: 'lookup',
      arguments: '{}',
    };
    let rounds = 0;
    let upstreamFailure;
    const credentialDir = official
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-official-core-'))
      : null;
    const credentialFile = credentialDir ? path.join(credentialDir, 'auth.json') : null;
    if (credentialFile) {
      fs.writeFileSync(
        credentialFile,
        JSON.stringify({ tokens: { access_token: 'eyJ.synthetic.fixture' } })
      );
      t.after(() => fs.rmSync(credentialDir, { recursive: true, force: true }));
    }
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks));
          assert.equal(req.headers['x-hpm-evidence-token'], undefined);
          if (official) {
            assert.equal(req.url, '/backend-api/codex/responses');
            assert.equal(body.stream, true);
            assert.equal(body.store, false);
            assert.equal(body.instructions, '');
          }
          let output;
          if (rounds === 0)
            output = [
              {
                type: 'function_call',
                id: 'fc-list',
                call_id: 'call-list',
                name: 'hpm_list_retained_evidence',
                arguments: '{}',
              },
            ];
          else if (rounds === 1) {
            const source = JSON.parse(body.input.at(-1).output).sources[0];
            output = [
              {
                type: 'function_call',
                id: 'fc-read',
                call_id: 'call-read',
                name: 'hpm_read_retained_evidence',
                arguments: JSON.stringify({ sourceId: source.sourceId, digest: source.digest }),
              },
            ];
          } else {
            if (rounds === 2)
              assert.equal(JSON.parse(body.input.at(-1).output).page.text, '原文🙂');
            else {
              assert.equal(rounds, 3);
              assert.ok(body.input.at(-1).content.includes('原文🙂'));
              assert.doesNotMatch(JSON.stringify(body.input), /call-list|call-read/);
            }
            output = [
              {
                type: 'message',
                id: 'msg-final',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'finished', annotations: [] }],
              },
            ];
          }
          rounds++;
          if (revoked) fixture.setRecovery(false);
          if (credentialsRevoked) fs.writeFileSync(credentialFile, '{}');
          const response = {
            id: 'response-' + rounds,
            status: 'completed',
            output,
            usage: { input_tokens: 2, output_tokens: 1 },
          };
          if (official) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            // The real backend may hold HTTP open after its complete SSE block.
            res.write('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n');
          } else {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(response));
          }
        } catch (error) {
          upstreamFailure = error;
          res.writeHead(500);
          res.end();
        }
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const nativePrepared = {
      profile: {
        id: 'native-fixture',
        protocol: 'openai',
        targetUrl:
          'http://127.0.0.1:' + upstream.address().port + (official ? '/backend-api/codex' : '/v1'),
      },
      authMode: official ? 'official-login' : 'api-key',
      ...(official ? { authProvider: 'openai' } : {}),
      rewriteTo: '-',
    };
    const liveProfile = official
      ? { ...nativePrepared.profile, apiKey: 'PROXY_MANAGED' }
      : undefined;
    const resolver = official
      ? require('../lib/proxy/auth-resolver').createAuthResolver({
          officialLoginProvider: () => 'openai',
          inferOfficialProfileAuthMode: () => 'official-login',
          configuredAuthMode: () => '',
          isRedactedSecret: (value) => !value || value === 'PROXY_MANAGED',
          decryptKey: (value) => value,
          shouldUseChatGPTBackendForOfficialLogin: () => false,
          PROFILES: () => [liveProfile],
          codexAuthPath: credentialFile,
        })
      : null;
    const resolveCredentials = resolver
      ? (value) =>
          resolver.resolveOfficialCredentials({ ...value, profile: { ...liveProfile } }, {})
      : undefined;
    if (resolveCredentials) Object.assign(nativePrepared, await resolveCredentials(nativePrepared));
    const seed = beginContextRecoveryRequest(runtime, {
      auth: { ok: true, enabled: true, key: { id: 'fixture-owner' } },
      kind: 'responses',
      prepared: nativePrepared,
      buffer: Buffer.from(JSON.stringify({ model: 'model', input: history })),
    });
    assert.equal(seed.ok, true);
    assert.equal(
      seed.complete(
        [call],
        [{ callId: call.call_id, toolName: call.name, arguments: {}, completed: true, output: '' }],
        'response-original'
      ).ok,
      true
    );
    const fixture = coreFixture({
      recovery: true,
      recoverySessions: runtime,
      native: true,
      liveProfile,
      resolveCredentials,
    });
    fixture.setRoute(nativePrepared);
    fixture.server.listen(0, '127.0.0.1');
    await once(fixture.server, 'listening');
    t.after(async () => {
      runtime.close();
      for (const server of [fixture.server, upstream]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
    const result = await fetch(
      'http://127.0.0.1:' + fixture.server.address().port + '/v1/responses',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'model',
          stream,
          input: [
            ...history,
            call,
            { type: 'function_call_output', call_id: call.call_id, output: '原文🙂' },
          ],
        }),
        signal: AbortSignal.timeout(5000),
      }
    );
    const wire = Buffer.from(await result.text());
    const body =
      stream && !revoked && !credentialsRevoked
        ? require('../lib/proxy/context-recovery-protocol').decodeContextRecoveryEnvelope(
            'responses',
            wire,
            true
          )
        : JSON.parse(wire);
    if (upstreamFailure) throw upstreamFailure;
    assert.equal(result.status, revoked || credentialsRevoked ? 502 : 200);
    assert.equal(rounds, revoked || credentialsRevoked ? 1 : 4);
    assert.equal(fixture.requestEnds.length, 1);
    assert.equal(fixture.requestEnds[0].status, result.status);
    if (revoked || credentialsRevoked) assert.equal(body.error.code, 'context_recovery_failed');
    else {
      assert.equal(body.output[0].content[0].text, 'finished');
      assert.equal(body.usage.input_tokens, 8);
      assert.equal(body.usage.output_tokens, 4);
      assert.doesNotMatch(JSON.stringify(body), /hpm_(?:list|read)_retained_evidence|原文/);
    }
  }
});

for (const { kind, upstreamKind, official = false } of [
  { kind: 'chat', upstreamKind: 'gemini' },
  { kind: 'responses', upstreamKind: 'gemini' },
  { kind: 'claude', upstreamKind: 'gemini' },
  { kind: 'chat', upstreamKind: 'claude' },
  { kind: 'responses', upstreamKind: 'claude' },
  { kind: 'responses', upstreamKind: 'chat' },
  { kind: 'claude', upstreamKind: 'chat' },
  { kind: 'chat', upstreamKind: 'responses' },
  { kind: 'claude', upstreamKind: 'responses' },
  { kind: 'chat', upstreamKind: 'responses', official: true },
  { kind: 'claude', upstreamKind: 'responses', official: true },
]) {
  test(
    'actual core converted ' +
      kind +
      '->' +
      upstreamKind +
      (official ? ' official' : ' API') +
      ' recovery preserves hidden history and client JSON/SSE with revocation',
    async (t) => {
      const {
        beginContextRecoveryRequest,
        decodeContextRecoveryEnvelope,
      } = require('../lib/proxy/context-recovery-protocol');
      const forwardingKeys = ['TARGET', 'TARGET_PORT', 'API_KEY'];
      const forwardingEnvironment = forwardingKeys.map((key) => process.env[key]);
      for (const key of forwardingKeys) delete process.env[key];
      t.after(() => {
        forwardingKeys.forEach((key, index) => {
          if (forwardingEnvironment[index] === undefined) delete process.env[key];
          else process.env[key] = forwardingEnvironment[index];
        });
      });
      for (const {
        stream,
        revoked,
        failed,
        mixed,
        upstreamSse,
        cancelled,
        credentialsRevoked,
        opaque,
      } of [
        { stream: false, revoked: false },
        { stream: true, revoked: false },
        { stream: false, revoked: true },
        { stream: true, failed: true },
        { stream: false, mixed: true },
        { stream: true, upstreamSse: true },
        { stream: false, cancelled: true },
        ...(official ? [{ stream: false, credentialsRevoked: true }] : []),
        ...(upstreamKind !== 'chat' ? [{ stream: true, opaque: true }] : []),
      ]) {
        const clientController = new globalThis.AbortController();
        let resolveUpstreamClosed;
        const upstreamClosed = new Promise((resolve) => {
          resolveUpstreamClosed = resolve;
        });
        const runtime = createContextRecoverySessions();
        runtime.configure(true);
        const historyKey = kind === 'responses' ? 'input' : 'messages';
        const tools =
          kind === 'responses'
            ? [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }]
            : kind === 'chat'
              ? [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
              : [{ name: 'lookup', input_schema: { type: 'object' } }];
        const history = [{ role: 'user', content: 'fresh' }];
        const original = '转换原文🙂';
        const originalCall =
          kind === 'responses'
            ? { type: 'function_call', call_id: 'original-call', name: 'lookup', arguments: '{}' }
            : kind === 'chat'
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      type: 'function',
                      id: 'original-call',
                      function: { name: 'lookup', arguments: '{}' },
                    },
                  ],
                }
              : {
                  role: 'assistant',
                  content: [{ type: 'tool_use', id: 'original-call', name: 'lookup', input: {} }],
                };
        const originalResult =
          kind === 'responses'
            ? { type: 'function_call_output', call_id: 'original-call', output: original }
            : kind === 'chat'
              ? { role: 'tool', tool_call_id: 'original-call', content: original }
              : {
                  role: 'user',
                  content: [
                    { type: 'tool_result', tool_use_id: 'original-call', content: original },
                  ],
                };
        let rounds = 0;
        let upstreamFailure;
        const upstream = http.createServer((req, res) => {
          res.once('close', resolveUpstreamClosed);
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks));
              assert.equal(
                req.url,
                upstreamKind === 'chat'
                  ? '/v1/chat/completions'
                  : upstreamKind === 'gemini'
                    ? '/v1beta/models/vendor%2Fmodel:generateContent'
                    : upstreamKind === 'claude'
                      ? '/v1/messages'
                      : official
                        ? '/backend-api/codex/responses'
                        : '/v1/responses'
              );
              assert.equal(
                upstreamKind === 'gemini'
                  ? req.headers['x-goog-api-key']
                  : upstreamKind === 'claude'
                    ? req.headers['x-api-key']
                    : req.headers.authorization,
                ['claude', 'gemini'].includes(upstreamKind)
                  ? 'synthetic-conversion-key'
                  : official
                    ? 'Bearer eyJ.synthetic.conversion'
                    : 'Bearer synthetic-conversion-key'
              );
              if (upstreamKind === 'claude') {
                assert.equal(req.headers.authorization, undefined);
                assert.equal(req.headers['anthropic-version'], '2023-06-01');
              }
              assert.equal(
                body.stream,
                upstreamKind === 'gemini' ? undefined : upstreamKind === 'responses'
              );
              assert.equal(body.model, upstreamKind === 'gemini' ? undefined : 'vendor/model');
              if (upstreamKind === 'gemini') assert.equal(req.headers.authorization, undefined);
              if (upstreamKind === 'responses') {
                assert.equal(body.store, false);
                assert.equal(body.instructions, '');
                assert.ok(body.tools.every((tool) => tool.strict === false));
              }
              const stage = rounds % 4;
              assert.equal(
                (upstreamKind === 'gemini' ? body.tools[0].functionDeclarations : body.tools).some(
                  (tool) =>
                    (upstreamKind === 'chat' ? tool.function.name : tool.name) ===
                    'hpm_read_retained_evidence'
                ),
                stage < 3
              );
              const upstreamHistory =
                upstreamKind === 'gemini'
                  ? body.contents
                  : upstreamKind === 'responses'
                    ? body.input
                    : body.messages;
              const resultText = () =>
                upstreamKind === 'chat'
                  ? upstreamHistory.at(-1).content
                  : upstreamKind === 'gemini'
                    ? upstreamHistory.at(-1).parts.at(-1).functionResponse.response.content
                    : upstreamKind === 'claude'
                      ? upstreamHistory.at(-1).content.at(-1).content
                      : upstreamHistory.at(-1).output;
              if (mixed && stage < 3) {
                assert.ok(
                  (upstreamKind === 'gemini'
                    ? body.tools[0].functionDeclarations
                    : body.tools
                  ).every(
                    (tool) =>
                      (upstreamKind === 'chat' ? tool.function.name : tool.name) !== 'lookup'
                  )
                );
                assert.doesNotMatch(JSON.stringify(upstreamHistory), /external-deferred/);
              }
              let name;
              let args;
              if (stage === 0) {
                if (rounds === 4)
                  assert.match(JSON.stringify(upstreamHistory), /hpm_read_retained_evidence/);
                name = 'hpm_list_retained_evidence';
                args = {};
              } else if (stage === 1) {
                const source = JSON.parse(resultText()).sources[0];
                name = 'hpm_read_retained_evidence';
                args = { sourceId: source.sourceId, digest: source.digest };
              } else if (stage === 2) assert.equal(JSON.parse(resultText()).page.text, original);
              else {
                assert.doesNotMatch(
                  JSON.stringify(upstreamHistory),
                  /hpm_list_retained_evidence|hpm_read_retained_evidence/
                );
                assert.ok(
                  JSON.stringify(upstreamHistory).includes(JSON.stringify(original).slice(1, -1))
                );
                if (mixed) {
                  name = 'lookup';
                  args = { exact: '原参数🙂' };
                }
              }
              const message = name
                ? {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: stage === 3 ? 'external-deferred' : 'internal-' + rounds,
                        type: 'function',
                        function: { name, arguments: JSON.stringify(args) },
                      },
                    ],
                  }
                : { role: 'assistant', content: 'finished' };
              rounds++;
              if (cancelled) {
                clientController.abort();
                return;
              }
              if (revoked) fixture.setRecovery(false);
              if (credentialsRevoked) fs.writeFileSync(credentialFile, '{}');
              if (upstreamKind === 'gemini') {
                const parts = name
                  ? message.tool_calls.map((tool) => ({
                      functionCall: {
                        id: tool.id,
                        name: tool.function.name,
                        args: JSON.parse(tool.function.arguments),
                      },
                    }))
                  : [{ text: 'finished' }];
                if (opaque)
                  parts.unshift({ thought: true, text: 'opaque', thoughtSignature: 'signed' });
                const response = {
                  candidates: [
                    {
                      content: { role: 'model', parts },
                      finishReason: failed ? 'MAX_TOKENS' : 'STOP',
                    },
                  ],
                  usageMetadata: {
                    promptTokenCount: 2,
                    candidatesTokenCount: 1,
                    totalTokenCount: 3,
                  },
                };
                res.writeHead(200, {
                  'content-type': upstreamSse ? 'text/event-stream' : 'application/json',
                });
                res.end(
                  upstreamSse
                    ? 'data: ' + JSON.stringify(response) + '\n\n'
                    : JSON.stringify(response)
                );
                return;
              }
              if (upstreamKind === 'claude') {
                const content = name
                  ? message.tool_calls.map((tool) => ({
                      type: 'tool_use',
                      id: tool.id,
                      name: tool.function.name,
                      input: JSON.parse(tool.function.arguments),
                    }))
                  : [{ type: 'text', text: 'finished' }];
                if (opaque)
                  content.unshift({ type: 'thinking', thinking: 'opaque', signature: 'signed' });
                const response = {
                  id: 'msg-' + rounds,
                  type: 'message',
                  role: 'assistant',
                  model: body.model,
                  content,
                  stop_reason: failed ? 'max_tokens' : name ? 'tool_use' : 'end_turn',
                  usage: { input_tokens: 2, output_tokens: 1 },
                };
                res.writeHead(200, {
                  'content-type': upstreamSse ? 'text/event-stream' : 'application/json',
                });
                if (upstreamSse) {
                  const events = [
                    {
                      type: 'message_start',
                      message: { ...response, content: [], stop_reason: null },
                    },
                  ];
                  content.forEach((block, index) =>
                    events.push(
                      { type: 'content_block_start', index, content_block: block },
                      { type: 'content_block_stop', index }
                    )
                  );
                  events.push(
                    {
                      type: 'message_delta',
                      delta: { stop_reason: response.stop_reason },
                      usage: { output_tokens: 1 },
                    },
                    { type: 'message_stop' }
                  );
                  res.end(
                    events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('')
                  );
                } else res.end(JSON.stringify(response));
                return;
              }
              if (upstreamKind === 'responses') {
                const output = name
                  ? message.tool_calls.map((tool) => ({
                      type: 'function_call',
                      id: 'fc-' + tool.id,
                      call_id: tool.id,
                      name: tool.function.name,
                      arguments: tool.function.arguments,
                      status: 'completed',
                    }))
                  : [
                      {
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [{ type: 'output_text', text: 'finished', annotations: [] }],
                      },
                    ];
                const response = {
                  id: 'resp-' + rounds,
                  status: failed ? 'incomplete' : 'completed',
                  model: body.model,
                  created_at: 1700000000,
                  output,
                  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
                };
                if (opaque)
                  response.output.unshift({
                    type: 'reasoning',
                    encrypted_content: 'opaque-native-state',
                  });
                res.writeHead(200, {
                  'content-type':
                    official || upstreamSse ? 'text/event-stream' : 'application/json',
                });
                if (official)
                  res.write(
                    'data: ' +
                      JSON.stringify({
                        type: failed ? 'response.incomplete' : 'response.completed',
                        response,
                      }) +
                      '\n\n'
                  );
                else
                  res.end(
                    upstreamSse
                      ? 'data: ' +
                          JSON.stringify({
                            type: failed ? 'response.incomplete' : 'response.completed',
                            response,
                          }) +
                          '\n\n'
                      : JSON.stringify(response)
                  );
                return;
              }
              res.writeHead(200, {
                'content-type': upstreamSse ? 'text/event-stream' : 'application/json',
              });
              if (upstreamSse) {
                res.end(
                  'data: ' +
                    JSON.stringify({
                      id: 'chatcmpl-' + rounds,
                      object: 'chat.completion.chunk',
                      model: body.model,
                      created: 1700000000,
                      choices: [
                        { index: 0, delta: message, finish_reason: name ? 'tool_calls' : 'stop' },
                      ],
                      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
                    }) +
                    '\n\ndata: [DONE]\n\n'
                );
                return;
              }
              res.end(
                JSON.stringify({
                  id: 'chatcmpl-' + rounds,
                  model: body.model,
                  created: 1700000000,
                  choices: [
                    {
                      index: 0,
                      message,
                      finish_reason: failed ? 'length' : name ? 'tool_calls' : 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
                })
              );
            } catch (error) {
              upstreamFailure = error;
              res.writeHead(500);
              res.end();
            }
          });
        });
        upstream.listen(0, '127.0.0.1');
        await once(upstream, 'listening');
        const routePrepared = {
          profile: {
            id: 'converted-' + kind,
            protocol: ['claude', 'gemini'].includes(upstreamKind) ? upstreamKind : 'openai',
            ...(upstreamKind === 'responses' ? { api: 'openai-responses' } : {}),
            apiKey: 'synthetic-conversion-key',
            targetUrl:
              'http://127.0.0.1:' +
              upstream.address().port +
              (official ? '/backend-api/codex' : '/v1'),
          },
          authMode: official ? 'official-login' : 'api-key',
          ...(official ? { authProvider: 'openai' } : {}),
          rewriteTo: 'vendor/model',
        };
        const credentialDirectory = official
          ? fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-conversion-auth-'))
          : null;
        const credentialFile = official ? path.join(credentialDirectory, 'auth.json') : null;
        const liveProfile = official
          ? { ...routePrepared.profile, apiKey: 'PROXY_MANAGED' }
          : undefined;
        if (official)
          fs.writeFileSync(
            credentialFile,
            JSON.stringify({ tokens: { access_token: 'eyJ.synthetic.conversion' } })
          );
        const resolver = official
          ? require('../lib/proxy/auth-resolver').createAuthResolver({
              officialLoginProvider: () => 'openai',
              inferOfficialProfileAuthMode: () => 'official-login',
              configuredAuthMode: () => '',
              isRedactedSecret: (value) => !value || value === 'PROXY_MANAGED',
              decryptKey: (value) => value,
              shouldUseChatGPTBackendForOfficialLogin: () => false,
              PROFILES: () => [liveProfile],
              codexAuthPath: credentialFile,
            })
          : null;
        const resolveCredentials = official
          ? (value) =>
              resolver.resolveOfficialCredentials({ ...value, profile: { ...liveProfile } }, {})
          : undefined;
        if (official) Object.assign(routePrepared, await resolveCredentials(routePrepared));
        const fixture = coreFixture({
          converted: true,
          kind,
          recovery: true,
          recoverySessions: runtime,
          liveProfile,
          resolveCredentials,
        });
        fixture.setRoute(routePrepared);
        t.after(async () => {
          runtime.close();
          for (const server of [fixture.server, upstream]) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
          }
          if (credentialFile) fs.unlinkSync(credentialFile);
          if (credentialDirectory) fs.rmdirSync(credentialDirectory);
        });
        const seed = beginContextRecoveryRequest(runtime, {
          auth: { ok: true, enabled: true, key: { id: 'fixture-owner' } },
          kind,
          prepared: routePrepared,
          buffer: Buffer.from(JSON.stringify({ model: 'model', tools, [historyKey]: history })),
        });
        assert.equal(seed.ok, true);
        assert.equal(
          seed.complete(
            [originalCall],
            [
              {
                callId: 'original-call',
                toolName: 'lookup',
                arguments: {},
                completed: true,
                output: '',
              },
            ]
          ).ok,
          true
        );
        fixture.server.listen(0, '127.0.0.1');
        await once(fixture.server, 'listening');
        let historyNow = [...history, originalCall, originalResult];
        for (
          let turn = 0;
          turn < (revoked || failed || mixed || cancelled || credentialsRevoked || opaque ? 1 : 2);
          turn++
        ) {
          const pendingResult = fetch(
            'http://127.0.0.1:' +
              fixture.server.address().port +
              (kind === 'responses'
                ? '/v1/responses'
                : kind === 'chat'
                  ? '/v1/chat/completions'
                  : '/v1/messages'),
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model: 'model',
                [historyKey]: historyNow,
                tools,
                stream,
                ...(kind === 'claude' ? { max_tokens: 256 } : {}),
              }),
              signal: cancelled
                ? AbortSignal.any([clientController.signal, AbortSignal.timeout(5000)])
                : AbortSignal.timeout(5000),
            }
          );
          if (cancelled) {
            await assert.rejects(pendingResult, { name: 'AbortError' });
            await upstreamClosed;
            assert.equal(rounds, 1);
            assert.equal(fixture.calls(), 0);
            break;
          }
          const result = await pendingResult;
          const wire = Buffer.from(await result.text());
          if (upstreamFailure) throw upstreamFailure;
          assert.equal(
            result.status,
            revoked || failed || credentialsRevoked || opaque ? 502 : 200,
            JSON.stringify({ stream, revoked, failed, mixed, upstreamSse, rounds }) +
              wire.toString()
          );
          assert.equal(fixture.calls(), 0);
          assert.equal(fixture.requestEnds.length, turn + 1);
          if (revoked || failed || credentialsRevoked || opaque) {
            assert.equal(rounds, 1);
            assert.equal(JSON.parse(wire).error.code, 'context_recovery_failed');
            break;
          }
          const final = decodeContextRecoveryEnvelope(kind, wire, stream);
          assert.doesNotMatch(wire.toString(), /hpm_(?:list|read)_retained_evidence|转换原文/);
          assert.equal(kind === 'chat' ? final.usage.prompt_tokens : final.usage.input_tokens, 8);
          assert.equal(
            kind === 'chat' ? final.usage.completion_tokens : final.usage.output_tokens,
            4
          );
          const output =
            kind === 'responses'
              ? final.output
              : kind === 'chat'
                ? [final.choices[0].message]
                : [{ role: 'assistant', content: final.content }];
          if (mixed) {
            const external =
              kind === 'responses'
                ? output[0]
                : kind === 'chat'
                  ? output[0].tool_calls[0]
                  : output[0].content[0];
            assert.equal(
              kind === 'responses' ? external.call_id : external.id,
              'external-deferred'
            );
            assert.equal(
              kind === 'responses'
                ? external.arguments
                : kind === 'chat'
                  ? external.function.arguments
                  : JSON.stringify(external.input),
              '{"exact":"原参数🙂"}'
            );
          } else
            assert.equal(
              kind === 'chat' ? output[0].content : output[0].content[0].text,
              'finished'
            );
          assert.equal(rounds, (turn + 1) * 4);
          historyNow = [...historyNow, ...output, { role: 'user', content: 'continue' }];
        }
      }
    }
  );
}

for (const kind of ['chat', 'claude']) {
  test(
    'actual core ' + kind + ' hides recovery across JSON/SSE turns and live revocation',
    async (t) => {
      const {
        beginContextRecoveryRequest,
        decodeContextRecoveryEnvelope,
      } = require('../lib/proxy/context-recovery-protocol');
      for (const { stream, revoked } of [
        { stream: false, revoked: false },
        { stream: true, revoked: false },
        { stream: false, revoked: true },
      ]) {
        const runtime = createContextRecoverySessions();
        runtime.configure(true);
        const original = '完整工具结果🙂\r\n保留原文';
        const history = [{ role: 'user', content: 'fresh question' }];
        const call = (id, name, args) =>
          kind === 'chat'
            ? {
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              }
            : { type: 'tool_use', id, name, input: args };
        const assistant = (tool) =>
          kind === 'chat'
            ? { role: 'assistant', content: null, tool_calls: [tool] }
            : { role: 'assistant', content: [tool] };
        const originalCall = assistant(call('original-call', 'lookup', {}));
        const originalResult =
          kind === 'chat'
            ? { role: 'tool', tool_call_id: 'original-call', content: original }
            : {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'original-call', content: original }],
              };
        const resultText = (body) => {
          const item = body.messages.at(-1);
          return kind === 'chat' ? item.content : item.content[0].content;
        };
        let rounds = 0;
        let upstreamFailure;
        const upstream = http.createServer((req, res) => {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks));
              assert.equal(req.url, kind === 'chat' ? '/v1/chat/completions' : '/v1/messages');
              assert.equal(req.headers['x-hpm-evidence-token'], undefined);
              const names = (body.tools ?? []).map((tool) =>
                kind === 'chat' ? tool.function.name : tool.name
              );
              const stage = rounds % 4;
              assert.equal(names.includes('hpm_read_retained_evidence'), stage < 3);
              let tool;
              if (stage === 0) {
                if (rounds === 4) {
                  const hidden = JSON.stringify(body.messages);
                  assert.match(hidden, /hpm_list_retained_evidence/);
                  assert.match(hidden, /hpm_read_retained_evidence/);
                }
                tool = call('list-' + rounds, 'hpm_list_retained_evidence', {});
              } else if (stage === 1) {
                const source = JSON.parse(resultText(body)).sources[0];
                assert.ok(source);
                tool = call('read-' + rounds, 'hpm_read_retained_evidence', {
                  sourceId: source.sourceId,
                  digest: source.digest,
                });
              } else if (stage === 2)
                assert.equal(JSON.parse(resultText(body)).page.text, original);
              else {
                assert.ok(
                  body.messages.at(-1).content.includes(JSON.stringify(original).slice(1, -1))
                );
                assert.doesNotMatch(
                  JSON.stringify(body.messages),
                  /hpm_list_retained_evidence|hpm_read_retained_evidence/
                );
              }
              const message = tool
                ? assistant(tool)
                : kind === 'chat'
                  ? { role: 'assistant', content: 'finished' }
                  : { role: 'assistant', content: [{ type: 'text', text: 'finished' }] };
              rounds++;
              if (revoked) fixture.setRecovery(false);
              const response =
                kind === 'chat'
                  ? {
                      id: 'chat-' + rounds,
                      object: 'chat.completion',
                      model: 'model',
                      choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
                      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
                    }
                  : {
                      ...message,
                      id: 'msg-' + rounds,
                      type: 'message',
                      model: 'model',
                      stop_reason: tool ? 'tool_use' : 'end_turn',
                      stop_sequence: null,
                      usage: { input_tokens: 2, output_tokens: 1 },
                    };
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify(response));
            } catch (error) {
              upstreamFailure = error;
              res.writeHead(500);
              res.end();
            }
          });
        });
        upstream.listen(0, '127.0.0.1');
        await once(upstream, 'listening');
        const nativePrepared = {
          profile: {
            id: 'native-' + kind,
            protocol: kind === 'claude' ? 'claude' : 'openai',
            targetUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
          },
          authMode: 'api-key',
          rewriteTo: '-',
        };
        const fixture = coreFixture({
          recovery: true,
          recoverySessions: runtime,
          native: true,
          kind,
        });
        fixture.setRoute(nativePrepared);
        t.after(async () => {
          runtime.close();
          for (const server of [fixture.server, upstream]) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
          }
        });
        const seed = beginContextRecoveryRequest(runtime, {
          auth: { ok: true, enabled: true, key: { id: 'fixture-owner' } },
          kind,
          prepared: nativePrepared,
          buffer: Buffer.from(JSON.stringify({ model: 'model', messages: history })),
        });
        assert.equal(seed.ok, true);
        assert.equal(
          seed.complete(
            [originalCall],
            [
              {
                callId: 'original-call',
                toolName: 'lookup',
                arguments: {},
                completed: true,
                output: '',
              },
            ]
          ).ok,
          true
        );
        fixture.server.listen(0, '127.0.0.1');
        await once(fixture.server, 'listening');
        let messages = [...history, originalCall, originalResult];
        for (let turn = 0; turn < (revoked ? 1 : 2); turn++) {
          const result = await fetch(
            'http://127.0.0.1:' +
              fixture.server.address().port +
              (kind === 'chat' ? '/v1/chat/completions' : '/v1/messages'),
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model: 'model',
                messages,
                stream,
                ...(kind === 'claude' ? { max_tokens: 256 } : {}),
              }),
              signal: AbortSignal.timeout(5000),
            }
          );
          const wire = Buffer.from(await result.text());
          if (upstreamFailure) throw upstreamFailure;
          assert.equal(result.status, revoked ? 502 : 200, wire.toString());
          assert.equal(fixture.requestEnds.length, turn + 1);
          assert.equal(fixture.requestEnds.at(-1).status, result.status);
          if (revoked) {
            assert.equal(JSON.parse(wire).error.code, 'context_recovery_failed');
            assert.equal(rounds, 1);
            break;
          }
          const body = decodeContextRecoveryEnvelope(kind, wire, stream);
          assert.doesNotMatch(wire.toString(), /hpm_(?:list|read)_retained_evidence|完整工具结果/);
          const finalMessage =
            kind === 'chat'
              ? body.choices[0].message
              : { role: 'assistant', content: body.content };
          assert.equal(
            kind === 'chat' ? finalMessage.content : finalMessage.content[0].text,
            'finished'
          );
          assert.equal(kind === 'chat' ? body.usage.prompt_tokens : body.usage.input_tokens, 8);
          assert.equal(
            kind === 'chat' ? body.usage.completion_tokens : body.usage.output_tokens,
            4
          );
          assert.equal(rounds, (turn + 1) * 4);
          messages = [...messages, finalMessage, { role: 'user', content: 'continue' }];
        }
      }
    }
  );
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

for (const official of [false, true]) {
  test(
    'actual core preserves canonical compaction and original evidence after three replacements: ' +
      (official ? 'official-login' : 'API'),
    async (t) => {
      const { beginContextRecoveryRequest } = require('../lib/proxy/context-recovery-protocol');
      const runtime = createContextRecoverySessions();
      runtime.configure(true);
      const tools = [
        { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
      ];
      const originalInput = [{ role: 'user', content: 'question' }];
      const originalCall = {
        type: 'function_call',
        id: 'fc-source',
        call_id: 'call-source',
        name: 'lookup',
        arguments: '{}',
      };
      let compactions = 0;
      let generations = 0;
      let round = 0;
      let failure;
      let canonicalWire;
      let window;
      const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks));
            assert.equal(req.headers['x-hpm-evidence-token'], undefined);
            if (
              req.url ===
              (official ? '/backend-api/codex/responses/compact' : '/v1/responses/compact')
            ) {
              assert.equal(body.tools, undefined);
              compactions++;
              round = 0;
              window = [
                { role: 'user', content: 'retained-' + compactions, extra: 'provider-field' },
                {
                  type: 'compaction',
                  id: 'cmp-' + compactions,
                  encrypted_content: 'opaque-fixture-' + compactions,
                },
              ];
              canonicalWire = JSON.stringify(
                {
                  object: 'response.compaction',
                  id: 'compact-' + compactions,
                  created_at: 1,
                  output: window,
                  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
                  unknown: { preserve: true },
                },
                null,
                2
              );
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(canonicalWire);
              return;
            }
            assert.equal(req.url, official ? '/backend-api/codex/responses' : '/v1/responses');
            if (official) {
              assert.equal(body.stream, true);
              assert.equal(body.store, false);
            }
            generations++;
            let output;
            if (round === 0) {
              assert.deepEqual(body.input, window);
              output = [
                {
                  type: 'function_call',
                  id: 'fc-list-' + compactions,
                  call_id: 'list-' + compactions,
                  name: 'hpm_list_retained_evidence',
                  arguments: '{}',
                },
              ];
            } else if (round === 1) {
              const index = JSON.parse(body.input.at(-1).output);
              assert.equal(index.sources.length, 1);
              const source = index.sources[0];
              output = [
                {
                  type: 'function_call',
                  id: 'fc-read-' + compactions,
                  call_id: 'read-' + compactions,
                  name: 'hpm_read_retained_evidence',
                  arguments: JSON.stringify({ sourceId: source.sourceId, digest: source.digest }),
                },
              ];
            } else {
              if (round === 2)
                assert.equal(JSON.parse(body.input.at(-1).output).page.text, '完整原文🙂');
              else {
                assert.equal(round, 3);
                assert.ok(body.input.at(-1).content.includes('完整原文🙂'));
                assert.doesNotMatch(
                  JSON.stringify(body.input),
                  /hpm_list_retained_evidence|hpm_read_retained_evidence/
                );
              }
              output = [
                {
                  type: 'message',
                  id: 'answer-' + compactions,
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'done-' + compactions }],
                },
              ];
            }
            round++;
            const response = {
              id: 'response-' + compactions + '-' + round,
              status: 'completed',
              output,
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            if (official) {
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              res.write(
                'data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n'
              );
            } else {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify(response));
            }
          } catch (error) {
            failure = error;
            res.writeHead(500);
            res.end();
          }
        });
      });
      upstream.listen(0, '127.0.0.1');
      await once(upstream, 'listening');
      const route = {
        profile: {
          id: 'compact-fixture',
          protocol: 'openai-responses',
          targetUrl:
            'http://127.0.0.1:' +
            upstream.address().port +
            (official ? '/backend-api/codex' : '/v1'),
        },
        authMode: official ? 'official-login' : 'api-key',
        ...(official ? { authProvider: 'openai' } : {}),
        rewriteTo: '-',
      };
      if (official)
        require('../lib/proxy/context-recovery-auth').bindRecoveryOfficialCredentials(
          route,
          route.profile
        );
      const seeded = beginContextRecoveryRequest(runtime, {
        auth: { ok: true, enabled: true, key: { id: 'fixture-owner' } },
        kind: 'responses',
        prepared: route,
        buffer: Buffer.from(JSON.stringify({ model: 'model', tools, input: originalInput })),
      });
      assert.equal(
        seeded.complete(
          [originalCall],
          [
            {
              callId: originalCall.call_id,
              toolName: originalCall.name,
              arguments: {},
              completed: true,
              output: '',
            },
          ]
        ).ok,
        true
      );
      const fixture = coreFixture({ native: true, recovery: true, recoverySessions: runtime });
      fixture.setRoute(route);
      fixture.server.listen(0, '127.0.0.1');
      await once(fixture.server, 'listening');
      t.after(async () => {
        runtime.close();
        for (const server of [fixture.server, upstream]) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      });
      const endpoint = 'http://127.0.0.1:' + fixture.server.address().port + '/v1/responses';
      let history = [
        ...originalInput,
        originalCall,
        { type: 'function_call_output', call_id: originalCall.call_id, output: '完整原文🙂' },
      ];
      for (let iteration = 0; iteration < 3; iteration++) {
        const compact = await fetch(endpoint + '/compact', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'model', input: history }),
          signal: AbortSignal.timeout(5000),
        });
        const received = await compact.text();
        if (failure) throw failure;
        assert.equal(compact.status, 200, received);
        assert.equal(received, canonicalWire);
        const next = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'model',
            tools,
            input: JSON.parse(received).output,
            stream: false,
          }),
          signal: AbortSignal.timeout(5000),
        });
        const answer = await next.json();
        if (failure) throw failure;
        assert.equal(next.status, 200, JSON.stringify(answer));
        assert.equal(answer.output[0].content[0].text, 'done-' + (iteration + 1));
        history = [...JSON.parse(received).output, ...answer.output];
      }
      assert.equal(compactions, 3);
      assert.equal(generations, 12);
      assert.equal(fixture.requestEnds.length, 6);
    }
  );
}

async function persistentWbipcCoreOwner(directory, diagnostic) {
  const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
  const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
  const { createObservedStorageWorker } = require('./helpers/recovery-owner-stage-probe');
  const storage = await openContextRecoveryStorage({
    directory,
    WorkerType: createObservedStorageWorker(diagnostic),
  });
  const contract = require('../lib/proxy/context-recovery-storage-contract');
  const execute = storage.execute;
  let combinedAdmissions = 0;
  let combinedPublications = 0;
  storage.execute = async (request) => {
    const started = performance.now();
    const combinedPublication =
      request.admission &&
      request.reference.metadata.budget.calls === request.admission.metadata.budget.calls;
    try {
      const result = await execute(request);
      if (request.admission) combinedAdmissions++;
      if (combinedPublication) combinedPublications++;
      return result;
    } finally {
      diagnostic({
        phase: 'storage',
        operation: request.operation,
        ...(request.admission ? { combinedAdmission: true } : {}),
        ...(combinedPublication ? { combinedPublication: true } : {}),
        elapsedMs: Math.round(performance.now() - started),
      });
    }
  };
  for (const capability of [
    'RecoveryScan',
    'RecoverySourcePages',
    'RecoveryReaderSettlement',
    'RecoveryReferenceWrites',
    'RecoveryReferenceStates',
    'RecoveryReferenceAdmission',
    'RecoveryReferenceScan',
    'RecoveryReadSettlement',
  ]) {
    if (contract['supports' + capability](execute))
      contract['declare' + capability](storage.execute);
  }
  const lifecycle = createContextRecoveryLifecycle({ storage });
  try {
    assert.deepEqual(await lifecycle.configureAsync(true), { ok: true });
  } catch (error) {
    await lifecycle.shutdownAsync();
    throw error;
  }
  const sessions = lifecycle.sessions;
  const completed = [];
  const pending = new Map();
  const begin = sessions.beginAsync;
  sessions.beginAsync = async (...args) => {
    const started = performance.now();
    const view = await begin(...args);
    diagnostic({ phase: 'beginAsync', elapsedMs: Math.round(performance.now() - started) });
    if (view.ok) {
      for (const name of ['replyAsync', 'completeAsync', 'startPublicationAsync']) {
        const method = view[name];
        view[name] = async (...values) => {
          const phaseStarted = performance.now();
          try {
            return await method(...values);
          } finally {
            diagnostic({ phase: name, elapsedMs: Math.round(performance.now() - phaseStarted) });
          }
        };
      }
      const finish = view.finishPublicationAsync;
      view.finishPublicationAsync = async (...values) => {
        const phaseStarted = performance.now();
        const result = await finish(...values);
        diagnostic({
          phase: 'finishPublicationAsync',
          elapsedMs: Math.round(performance.now() - phaseStarted),
        });
        completed.push(result);
        pending.get(completed.length)?.(result);
        return result;
      };
    }
    return view;
  };
  return {
    sessions,
    lifecycle,
    combinedAdmissions: () => combinedAdmissions,
    combinedPublications: () => combinedPublications,
    waitForPublication(index, signal) {
      if (completed.length >= index) return Promise.resolve(completed[index - 1]);
      return new Promise((resolve, reject) => {
        const done = (value) => {
          cleanup();
          resolve(value);
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const cleanup = () => {
          pending.delete(index);
          signal.removeEventListener('abort', abort);
        };
        pending.set(index, done);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  };
}

for (const kind of ['chat', 'responses', 'claude']) {
  test(
    'actual core ' +
      kind +
      ' WBIPC recovery has exclusive ownership and live credential revocation',
    async (t) => {
      const {
        beginContextRecoveryRequest,
        decodeContextRecoveryEnvelope,
        decodeContextRecoveryResponse,
      } = require('../lib/proxy/context-recovery-protocol');
      const { createAuthResolver } = require('../lib/proxy/auth-resolver');
      const environment = ['TARGET', 'TARGET_PORT', 'API_KEY'];
      const previous = environment.map((key) => process.env[key]);
      environment.forEach((key) => delete process.env[key]);
      t.after(() =>
        environment.forEach((key, index) => {
          if (previous[index] === undefined) delete process.env[key];
          else process.env[key] = previous[index];
        })
      );
      for (const mode of [
        'json',
        'sse',
        'mixed',
        'revoked',
        'credentials',
        'endpoint',
        'pipe',
        'failed',
        'opaque',
        'legacy-artifact',
        'legacy-discovery',
        'reporting',
        'cancelled',
        'long-json',
        'long-sse',
        'long-failed',
        'long-persistent',
      ]) {
        let runtime = createContextRecoverySessions();
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-wbipc-core-'));
        const persistentDirectory = path.join(directory, 'context');
        const { createOwnerDiagnosticScope } = require('./helpers/recovery-owner-stage-probe');
        const nextOwnerDiagnostic = createOwnerDiagnosticScope((ownerEpoch, value) =>
          t.diagnostic(JSON.stringify({ kind, mode, ...value, ownerEpoch }))
        );
        let persistent =
          mode === 'long-persistent'
            ? await persistentWbipcCoreOwner(persistentDirectory, nextOwnerDiagnostic())
            : null;
        if (persistent) {
          runtime.close();
          runtime = persistent.sessions;
        } else runtime.configure(true);
        const credentialFile = path.join(directory, 'auth.info');
        fs.writeFileSync(
          credentialFile,
          JSON.stringify({
            auth: {
              accessToken: { $wbEncrypted: 1, envelope: 'synthetic-envelope-only' },
              domain: 'www.workbuddy.cn',
            },
            account: { uid: 'synthetic-wbipc-owner' },
          })
        );
        const liveProfile = {
          id: 'wbipc-' + kind,
          protocol: 'workbuddy',
          targetUrl: 'https://www.workbuddy.cn/v2',
          apiKey: 'PROXY_MANAGED',
        };
        const resolver = createAuthResolver({
          officialLoginProvider: () => 'workbuddy',
          inferOfficialProfileAuthMode: () => 'official-login',
          configuredAuthMode: () => '',
          isRedactedSecret: (value) => !value || value === 'PROXY_MANAGED',
          decryptKey: (value) => value,
          PROFILES: () => [liveProfile],
          workbuddyAuthPath: credentialFile,
        });
        const resolveCredentials = (value) =>
          resolver.resolveOfficialCredentials({ ...value, profile: { ...liveProfile } }, {});
        const route = await resolveCredentials({ profile: liveProfile, rewriteTo: 'fixture' });
        const historyKey = kind === 'responses' ? 'input' : 'messages';
        const history = [{ role: 'user', content: 'fresh' }];
        const tools =
          kind === 'responses'
            ? [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }]
            : kind === 'chat'
              ? [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
              : [{ name: 'lookup', input_schema: { type: 'object' } }];
        const longWindow = mode.startsWith('long-');
        const original = 'WBIPC精确原文🙂' + (longWindow ? 'x'.repeat(600000) : '');
        const recovered = longWindow
          ? Buffer.from(original).subarray(0, 1024).toString('utf8')
          : original;
        const call =
          kind === 'responses'
            ? { type: 'function_call', call_id: 'source-call', name: 'lookup', arguments: '{}' }
            : kind === 'chat'
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'source-call',
                      type: 'function',
                      function: { name: 'lookup', arguments: '{}' },
                    },
                  ],
                }
              : {
                  role: 'assistant',
                  content: [{ type: 'tool_use', id: 'source-call', name: 'lookup', input: {} }],
                };
        const output =
          kind === 'responses'
            ? { type: 'function_call_output', call_id: 'source-call', output: original }
            : kind === 'chat'
              ? { role: 'tool', tool_call_id: 'source-call', content: original }
              : {
                  role: 'user',
                  content: [{ type: 'tool_result', tool_use_id: 'source-call', content: original }],
                };
        const controller = new globalThis.AbortController();
        let endpoint = { endpoint: 'fixture-wbipc', ticket: 'synthetic-ticket-only' };
        let requests = 0;
        let handshakes = 0;
        let upstreamFailure;
        let closed;
        const socketClosed = new Promise((resolve) => {
          closed = resolve;
        });
        const sockets = [];
        const wbipc = {
          readEndpoint: () => endpoint,
          connect(target) {
            assert.equal(target, 'fixture-wbipc');
            handshakes++;
            let response;
            const socket = new FakeWbipcSocket('synthetic-ticket-only', target, (params) => {
              try {
                requests++;
                assert.equal(params.path, '/v2/chat/completions');
                assert.deepEqual(Object.keys(params.headers).sort(), ['accept', 'content-type']);
                const body = JSON.parse(Buffer.from(params.body_b64, 'base64'));
                assert.equal(body.model, 'fixture');
                assert.equal(body.stream, false);
                assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 384 * 1024);
                assert.ok(
                  require('../lib/proxy/inline-media').estimateTokensForValue(body) <= 96 * 1024
                );
                const step = (requests - 1) % 4;
                if (longWindow) {
                  const retained = body.messages.find(
                    (item) => item.tool_call_id === 'source-call'
                  );
                  assert.ok(retained);
                  assert.ok(Buffer.byteLength(retained.content) < 1024);
                  assert.ok(
                    step === 3
                      ? retained.content.startsWith('[Earlier tool output retained;')
                      : retained.content.includes('retainedToolOutput')
                  );
                }
                const calls = [];
                if (step === 0) {
                  assert.ok(
                    body.tools.some((tool) => tool.function.name === 'hpm_list_retained_evidence')
                  );
                  if (requests > 3)
                    assert.ok(
                      body.messages.some(
                        (item) =>
                          item.role === 'tool' &&
                          item.content.includes('tool_data_not_instructions')
                      )
                    );
                  calls.push({
                    id: 'list-' + requests,
                    type: 'function',
                    function: { name: 'hpm_list_retained_evidence', arguments: '{}' },
                  });
                } else if (step === 1) {
                  const index = JSON.parse(body.messages.at(-1).content);
                  calls.push({
                    id: 'read-' + requests,
                    type: 'function',
                    function: {
                      name: 'hpm_read_retained_evidence',
                      arguments: JSON.stringify({
                        sourceId: index.sources[0].sourceId,
                        digest: index.sources[0].digest,
                        ...(longWindow ? { limitBytes: 1024 } : {}),
                      }),
                    },
                  });
                } else if (step === 2)
                  assert.equal(JSON.parse(body.messages.at(-1).content).page.text, recovered);
                else {
                  assert.ok(
                    body.messages.at(-1).content.includes(JSON.stringify(recovered).slice(1, -1))
                  );
                  assert.doesNotMatch(
                    JSON.stringify(body.messages),
                    /hpm_list_retained_evidence|hpm_read_retained_evidence/
                  );
                  if (mode === 'mixed')
                    calls.push({
                      id: 'external-deferred',
                      type: 'function',
                      function: { name: 'lookup', arguments: '{"exact":"原参数🙂"}' },
                    });
                }
                const message = {
                  role: 'assistant',
                  content: calls.length ? null : 'done',
                  ...(calls.length ? { tool_calls: calls } : {}),
                };
                if (mode === 'opaque') message.reasoning_content = 'unsupported-private-state';
                if (mode === 'legacy-artifact' || mode === 'legacy-discovery')
                  message.tool_calls = [
                    {
                      id: 'legacy-must-not-execute',
                      type: 'function',
                      function: {
                        name:
                          mode === 'legacy-artifact'
                            ? 'hpm_read_context_artifact'
                            : 'hpm_discover_tools',
                        arguments: '{}',
                      },
                    },
                  ];
                response = {
                  id: 'wbipc-response-' + requests,
                  choices: [
                    { index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' },
                  ],
                  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
                };
                if (mode === 'revoked') fixture.setRecovery(false);
                if (mode === 'credentials') fs.writeFileSync(credentialFile, '{}');
                if (mode === 'endpoint')
                  endpoint = { ...endpoint, ticket: 'rotated-synthetic-ticket' };
                if (mode === 'cancelled') controller.abort();
              } catch (error) {
                upstreamFailure = error;
              }
            });
            sockets.push(socket);
            socket.once('close', closed);
            const send = socket.send.bind(socket);
            socket.send = (frame) => {
              if (frame.result?.channel && mode === 'pipe')
                endpoint = { ...endpoint, ticket: 'changed-during-pipe' };
              if (frame.result?.body_b64) {
                if (mode === 'cancelled') return;
                frame.result.body_b64 = Buffer.from(JSON.stringify(response || {})).toString(
                  'base64'
                );
                if (mode === 'failed' || mode === 'long-failed' || upstreamFailure)
                  frame.result.status = 500;
              }
              send(frame);
            };
            return socket;
          },
        };
        const makeFixture = () =>
          coreFixture({
            converted: true,
            kind,
            recovery: true,
            recoverySessions: runtime,
            recoveryLifecycle: persistent?.lifecycle,
            liveProfile,
            resolveCredentials,
            wbipc,
            reportingFailure: mode === 'reporting',
          });
        let fixture = makeFixture();
        fixture.setRoute(route);
        t.after(async () => {
          if (persistent) await persistent.lifecycle.shutdownAsync();
          else runtime.close();
          fixture.server.closeAllConnections();
          await new Promise((resolve) => fixture.server.close(resolve));
          fs.unlinkSync(credentialFile);
          if (mode === 'long-persistent') {
            assert.equal(path.dirname(path.resolve(persistentDirectory)), path.resolve(directory));
            assert.ok(path.basename(directory).startsWith('hpm-wbipc-core-'));
            fs.rmSync(persistentDirectory, { recursive: true, force: true });
          }
          fs.rmdirSync(directory);
        });
        const seedOptions = {
          auth: { ok: true, enabled: true, key: { id: 'fixture-owner' } },
          kind,
          prepared: route,
          buffer: Buffer.from(JSON.stringify({ model: 'model', tools, [historyKey]: history })),
        };
        const seed = persistent
          ? await require('../lib/proxy/context-recovery-protocol').beginContextRecoveryRequestAsync(
              runtime,
              seedOptions,
              () => true
            )
          : beginContextRecoveryRequest(runtime, seedOptions);
        assert.equal(seed.ok, true, mode);
        assert.equal(
          (
            await (persistent ? seed.completeObservedAsync : seed.complete)(
              [call],
              [
                {
                  callId: 'source-call',
                  toolName: 'lookup',
                  arguments: {},
                  completed: true,
                  output: '',
                },
              ]
            )
          ).ok,
          true
        );
        fixture.server.listen(0, '127.0.0.1');
        await once(fixture.server, 'listening');
        let historyNow = [...history, call, output];
        const stream = mode === 'sse' || mode === 'long-sse';
        const repeated = [
          'json',
          'sse',
          'reporting',
          'long-json',
          'long-sse',
          'long-persistent',
        ].includes(mode);
        const success = [
          'json',
          'sse',
          'mixed',
          'reporting',
          'long-json',
          'long-sse',
          'long-persistent',
        ].includes(mode);
        let savedRoot;
        for (let turn = 0; turn < (repeated ? 2 : 1); turn++) {
          const requestStarted = performance.now();
          const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
          const pending = fetch(
            'http://127.0.0.1:' +
              fixture.server.address().port +
              (kind === 'responses'
                ? '/v1/responses'
                : kind === 'chat'
                  ? '/v1/chat/completions'
                  : '/v1/messages'),
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model: 'model',
                [historyKey]: historyNow,
                tools,
                stream,
                ...(kind === 'claude' ? { max_tokens: 256 } : {}),
              }),
              signal: requestSignal,
            }
          ).catch((error) => {
            t.diagnostic(
              JSON.stringify({
                kind,
                mode,
                turn,
                phase: 'request_failed',
                elapsedMs: Math.round(performance.now() - requestStarted),
                requests,
                handshakes,
                roots: runtime.inspect().roots,
              })
            );
            throw error;
          });
          if (mode === 'cancelled') {
            await assert.rejects(pending, { name: 'AbortError' });
            await socketClosed;
          } else {
            const result = await pending;
            const phaseDiagnostic = (phase) =>
              t.diagnostic(
                JSON.stringify({
                  kind,
                  mode,
                  turn,
                  phase,
                  elapsedMs: Math.round(performance.now() - requestStarted),
                })
              );
            phaseDiagnostic('headers_received');
            let wire;
            phaseDiagnostic('body_start');
            try {
              wire = Buffer.from(await result.text());
              phaseDiagnostic('body_end');
            } catch (error) {
              phaseDiagnostic('body_failed');
              throw error;
            }
            if (upstreamFailure) throw upstreamFailure;
            assert.equal(
              result.status,
              success ? 200 : 502,
              kind + ':' + mode + ':' + wire.toString()
            );
            if (persistent) {
              phaseDiagnostic('publication_wait_start');
              try {
                assert.deepEqual(await persistent.waitForPublication(1, requestSignal), {
                  ok: true,
                });
                phaseDiagnostic('publication_wait_end');
              } catch (error) {
                phaseDiagnostic('publication_wait_failed');
                throw error;
              }
              await new Promise(setImmediate);
            }
            assert.equal(fixture.requestEnds.length, persistent ? 1 : turn + 1);
            assert.doesNotMatch(
              wire.toString(),
              /hpm_(?:list|read)_retained_evidence|WBIPC精确原文|synthetic-ticket|synthetic-envelope/
            );
            if (!success) assert.equal(JSON.parse(wire).error.code, 'context_recovery_failed');
            else {
              const response = decodeContextRecoveryEnvelope(kind, wire, stream);
              assert.equal(
                kind === 'chat' ? response.usage.prompt_tokens : response.usage.input_tokens,
                8
              );
              const decoded = decodeContextRecoveryResponse(kind, wire, stream);
              if (mode === 'mixed') {
                const external = decoded.calls[0];
                assert.equal(external.callId, 'external-deferred');
                assert.equal(JSON.stringify(external.arguments), '{"exact":"原参数🙂"}');
              }
              historyNow = [
                ...historyNow,
                ...decoded.output,
                { role: 'user', content: 'continue' },
              ];
            }
          }
          assert.equal(fixture.calls(), 0, 'old artifact handler must not own this request');
          assert.equal(fixture.forbiddenCalls(), 0, 'legacy transport/conversion must not run');
          if (mode !== 'cancelled' && !persistent) {
            const counters = fixture.recoveryDiagnostics().counters[kind];
            assert.equal(counters.bound, turn + 1);
            assert.equal(counters.completed, success ? turn + 1 : 0);
            assert.equal(counters.failed, success ? 0 : 1);
          }
          if (persistent && turn === 0) {
            assert.ok(persistent.combinedAdmissions() > 0);
            assert.ok(persistent.combinedPublications() > 0);
            savedRoot = exportContextRecoveryRootMetadata(runtime, seed.snapshotId).metadata;
            assert.ok(Number.isSafeInteger(savedRoot.expiresAt));
            assert.ok(savedRoot.expiresAt > Date.now());
            assert.equal(savedRoot.ledger.sources[0].bytes, Buffer.byteLength(original));
            assert.deepEqual(await persistent.lifecycle.shutdownAsync(), { ok: true });
            fixture.server.closeAllConnections();
            await new Promise((resolve) => fixture.server.close(resolve));
            assert.equal(
              fs
                .readFileSync(path.join(persistentDirectory, 'checkpoint.sqlite'))
                .includes(Buffer.from(original)),
              false
            );
            persistent = await persistentWbipcCoreOwner(persistentDirectory, nextOwnerDiagnostic());
            runtime = persistent.sessions;
            assert.equal(runtime.inspect().roots, 0);
            fixture = makeFixture();
            fixture.setRoute(route);
            fixture.server.listen(0, '127.0.0.1');
            await once(fixture.server, 'listening');
          }
        }
        if (persistent) {
          assert.ok(persistent.combinedAdmissions() > 0);
          assert.ok(persistent.combinedPublications() > 0);
          const restored = exportContextRecoveryRootMetadata(runtime, seed.snapshotId).metadata;
          assert.equal(restored.expiresAt, savedRoot.expiresAt);
          assert.equal(restored.rootId, savedRoot.rootId);
          assert.equal(restored.budget.calls, savedRoot.budget.calls + 2);
          assert.equal(restored.budget.successfulReads, savedRoot.budget.successfulReads + 1);
          assert.equal(restored.ledger.sources[0].sourceId, savedRoot.ledger.sources[0].sourceId);
          assert.equal(restored.ledger.sources[0].digest, savedRoot.ledger.sources[0].digest);
          assert.equal(restored.ledger.sources[0].bytes, Buffer.byteLength(original));
          assert.equal(runtime.inspect().roots, 1);
        }
        assert.equal(requests, repeated ? 8 : mode === 'mixed' ? 4 : mode === 'pipe' ? 0 : 1, mode);
        assert.equal(handshakes, mode === 'pipe' ? 1 : requests, mode);
        assert.ok(sockets.every((socket) => socket.destroyed));
        if (mode === 'long-failed') {
          const retry = beginContextRecoveryRequest(runtime, {
            auth: { ok: true, enabled: true, key: { id: 'fixture-owner' } },
            kind,
            prepared: route,
            buffer: Buffer.from(
              JSON.stringify({ model: 'model', tools, [historyKey]: [...history, call, output] })
            ),
          });
          assert.equal(retry.ok, true, retry.code);
          const source = JSON.parse(retry.reply('hpm_list_retained_evidence', {}).text).sources[0];
          assert.equal(source.bytes, Buffer.byteLength(original));
          assert.equal(
            JSON.parse(
              retry.reply('hpm_read_retained_evidence', {
                sourceId: source.sourceId,
                digest: source.digest,
                limitBytes: 1024,
              }).text
            ).page.text,
            recovered
          );
          retry.abort();
        }
      }
    }
  );
}
