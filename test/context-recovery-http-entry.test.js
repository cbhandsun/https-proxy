'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const {
  blocksRecoveryAdmission,
  permitsOrdinaryRecoveryControls,
} = require('../lib/proxy/context-recovery-rejection');
const { tryHandleContextRecoveryHttp } = require('../lib/proxy/context-recovery-http-entry');
const {
  nativeRecoveryProviderAllowed,
  createRecoveryHttpAuthorization,
} = require('../lib/proxy/context-recovery-http-entry');
const auth = { ok: true, enabled: true, key: { id: 'fixture-owner' } };
const profile = {
  id: 'profile',
  protocol: 'openai',
  targetUrl: 'https://api.openai.com/v1',
  apiKey: 'fixture-only',
};

test('HTTP recovery provider capability requires verified HTTPS host, path, port and authentication mode', () => {
  const base = {
    kind: 'responses',
    target: { protocol: 'https:', hostname: 'api.openai.com' },
    path: '/v1/responses',
    prepared: { profile, authMode: 'api-key' },
    requestOptions: { hostname: 'api.openai.com', port: 443 },
  };
  assert.equal(nativeRecoveryProviderAllowed(base), true);
  assert.equal(
    nativeRecoveryProviderAllowed({ ...base, kind: 'chat', path: '/v1/chat/completions' }),
    true
  );
  assert.equal(
    nativeRecoveryProviderAllowed({
      ...base,
      kind: 'claude',
      path: '/v1/messages',
      target: { protocol: 'https:', hostname: 'api.anthropic.com' },
      requestOptions: { hostname: 'api.anthropic.com', port: 443 },
    }),
    true
  );
  for (const patch of [
    { target: { protocol: 'http:', hostname: 'api.openai.com' } },
    { path: '/v1/responses/compact' },
    { path: '/backend-api/codex/responses' },
    { kind: 'unknown' },
    { prepared: { authMode: 'official-login' } },
    { requestOptions: { hostname: '127.0.0.1', port: 443 } },
    { requestOptions: { hostname: 'api.openai.com', port: 8443 } },
  ])
    assert.equal(nativeRecoveryProviderAllowed({ ...base, ...patch }), false);
});

test('native Claude recovery admits exact beta paths and the configured DeepSeek Claude protocol', () => {
  const base = {
    kind: 'claude',
    target: { protocol: 'https:', hostname: 'api.deepseek.com' },
    path: '/anthropic/v1/messages?beta=true',
    prepared: { profile: { ...profile, protocol: 'claude' }, authMode: 'api-key' },
    requestOptions: { hostname: 'api.deepseek.com', port: 443 },
  };
  assert.equal(nativeRecoveryProviderAllowed(base), true);
  assert.equal(nativeRecoveryProviderAllowed({ ...base, path: '/anthropic/v1/messages' }), true);
  const anthropic = {
    ...base,
    target: { protocol: 'https:', hostname: 'api.anthropic.com' },
    requestOptions: { hostname: 'api.anthropic.com', port: 443 },
    path: '/v1/messages?beta=true',
  };
  assert.equal(nativeRecoveryProviderAllowed(anthropic), true);
  let touched = false;
  const executable = {
    toString() {
      touched = true;
      return base.path;
    },
  };
  for (const path of [
    undefined,
    null,
    [],
    executable,
    '',
    'x'.repeat(65536),
    '/v1/messages',
    '/anthropic/v1/messages/',
    '/anthropic/v1/messages?beta=false',
    '/anthropic/v1/messages?beta=true&other=true',
    '/anthropic/v1/messages?beta=true#extra',
    '/anthropic/v1/messages?beta=%74rue',
    '/anthropic/v1/messages?beta=true\n',
  ])
    assert.equal(nativeRecoveryProviderAllowed({ ...base, path }), false);
  assert.equal(touched, false);
  for (const path of ['/v1/messages?beta=false', '/v1/messages?beta=true&other=true'])
    assert.equal(nativeRecoveryProviderAllowed({ ...anthropic, path }), false);
  for (const patch of [
    { kind: 'responses' },
    { target: { protocol: 'http:', hostname: 'api.deepseek.com' } },
    { target: { protocol: 'https:', hostname: 'api.deepseek.com.evil.invalid' } },
    { requestOptions: { hostname: '127.0.0.1', port: 443 } },
    { requestOptions: { hostname: 'api.deepseek.com', port: 8443 } },
    { prepared: { profile, authMode: 'api-key' } },
    { prepared: { authMode: 'api-key' } },
    { prepared: { profile: base.prepared.profile, authMode: 'official-login' } },
    { prepared: { profile: base.prepared.profile, authMode: 'none' } },
  ])
    assert.equal(nativeRecoveryProviderAllowed({ ...base, ...patch }), false);
});

test('HTTP recovery authorization pins owner, complete live profile, environment and feature permission', () => {
  for (const mutate of [
    (scope) => {
      scope.enabled = false;
    },
    (scope) => {
      scope.allowed = false;
    },
    (scope) => {
      scope.auth = { ...auth, key: { id: 'other-owner' } };
    },
    (scope) => {
      scope.auth = { ...auth, key: { id: 'fixture-owner', allowedProfileIds: ['changed'] } };
    },
    (scope) => {
      scope.profile = { ...profile, apiKey: 'rotated-fixture' };
    },
    (scope) => {
      scope.profile = { ...profile, protocol: 'claude' };
    },
    (scope) => {
      scope.profile = { ...profile, targetUrl: 'https://different.invalid' };
    },
    (scope) => {
      scope.profile = { ...profile, timeout: 12 };
    },
    (scope) => {
      scope.profile = undefined;
    },
    (scope) => {
      scope.environment.target = 'different.invalid';
    },
  ]) {
    const scope = {
      enabled: true,
      allowed: true,
      auth,
      profile: { ...profile },
      environment: { target: null, port: null, key: null },
    };
    const permitted = createRecoveryHttpAuthorization(() => scope, auth, { profile });
    assert.equal(permitted(), true);
    mutate(scope);
    assert.equal(permitted(), false);
  }
  assert.equal(
    createRecoveryHttpAuthorization(
      () => {
        throw new Error('private config detail');
      },
      auth,
      { profile }
    )(),
    false
  );
  assert.equal(
    createRecoveryHttpAuthorization(
      () => ({
        enabled: true,
        allowed: true,
        auth: { ok: true, enabled: false },
        profile,
        environment: {},
      }),
      { ok: true, enabled: false },
      { profile }
    )(),
    false
  );
});

function entryFixture(mode = 'success') {
  let allowed = mode !== 'unauthorized';
  const response = {
    id: 'fixture-response',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'final' }],
      },
    ],
  };
  const counts = { abort: 0, complete: 0, withdraw: 0, requests: 0 };
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
    res.headersSent = true;
  };
  res.end = (wire) => {
    if (mode === 'write-error' && res.statusCode === 200) throw new Error('private write error');
    res.wire = wire;
    res.writableEnded = true;
    if (mode === 'close-after-commit') res.emit('close');
    else res.emit('finish');
  };
  res.destroy = () => {
    res.destroyed = true;
    res.emit('close');
  };
  let resolve;
  const outcome = new Promise((done) => {
    resolve = done;
  });
  const session = {
    ok: true,
    inspect: () => ({ visibleSources: 1 }),
    recovery: () => ({
      ok: true,
      initialRequest: {},
      cancel() {
        counts.abort++;
      },
      accept: () => ({ ok: true, mode: 'release', response, usage: [{}], rounds: 1, calls: 0 }),
    }),
    complete() {
      counts.complete++;
      if (mode === 'revoke-on-commit') allowed = false;
      return { ok: mode !== 'commit-error' };
    },
    abort() {
      counts.abort++;
    },
    withdraw() {
      counts.withdraw++;
    },
  };
  const transport = {
    request(options, receive) {
      counts.requests++;
      const upstreamReq = new EventEmitter();
      upstreamReq.destroy = () => {};
      upstreamReq.end = () =>
        queueMicrotask(() => {
          if (mode === 'cancel') {
            req.aborted = true;
            req.emit('aborted');
            return;
          }
          const incoming = new EventEmitter();
          incoming.headers = { 'content-type': 'application/json' };
          incoming.statusCode = mode === 'upstream-error' ? 503 : 200;
          incoming.complete = true;
          incoming.destroy = () => {};
          receive(incoming);
          incoming.emit('data', Buffer.from(JSON.stringify(response)));
          incoming.emit('end');
        });
      return upstreamReq;
    },
  };
  const options = {
    kind: 'responses',
    session,
    observer: { detach: () => true },
    clientReq: req,
    clientRes: res,
    prepared: { buffer: Buffer.from('{}') },
    transport,
    requestOptions: { headers: {} },
    authorized: () => allowed,
    stream: false,
    setActive() {},
    onOutcome: resolve,
  };
  return { options, counts, outcome, req, res };
}

test('HTTP failure diagnostics distinguish fixed transaction stages without changing cleanup or exposing errors', async () => {
  const {
    contextRecoveryDiagnostics: diagnostics,
  } = require('../lib/proxy/context-recovery-diagnostics');
  const cases = [
    [
      'httpPreparationFailed',
      'success',
      (session) => {
        session.recovery = () => {
          throw Error('PRIVATE_STAGE_SENTINEL');
        };
      },
    ],
    ['httpRunFailed', 'upstream-error', () => {}],
    [
      'httpEncodingFailed',
      'success',
      (session) => {
        const recovery = session.recovery;
        session.recovery = () => {
          const run = recovery();
          const accept = run.accept;
          run.accept = () => ({ ...accept(), usage: [] });
          return run;
        };
      },
    ],
    ['httpPrepareFailed', 'commit-error', () => {}],
    [
      'httpSendingFailed',
      'success',
      (session) => {
        session.startPublicationAsync = async () => {
          throw Error('PRIVATE_STAGE_SENTINEL');
        };
      },
    ],
    ['httpPublishingFailed', 'write-error', () => {}],
    [
      'httpFinishFailed',
      'success',
      (session) => {
        session.finishPublicationAsync = async () => {
          throw Error('PRIVATE_STAGE_SENTINEL');
        };
      },
    ],
  ];
  diagnostics.configure(true);
  try {
    for (const [event, mode, mutate] of cases) {
      const before = diagnostics.inspect({}).counters.responses;
      const f = entryFixture(mode);
      mutate(f.options.session);
      assert.equal(tryHandleContextRecoveryHttp(f.options), true);
      assert.equal((await f.outcome).ok, false);
      const after = diagnostics.inspect({}).counters.responses;
      for (const [name] of cases)
        assert.equal(after[name] - before[name], name === event ? 1 : 0, event + ':' + name);
      assert.equal(f.counts.abort + f.counts.withdraw > 0, true);
      assert.doesNotMatch(
        JSON.stringify(diagnostics.inspect({})) + String(f.res.wire),
        /PRIVATE_STAGE_SENTINEL/
      );
    }
  } finally {
    diagnostics.configure(false);
  }
});

test('HTTP entry takes long-history admission from its session capability', async () => {
  const body = {
    input: Array.from({ length: 3 }, () => ({ role: 'user', content: 'x'.repeat(900 * 1024) })),
  };
  for (const historyFormat of [2, 3]) {
    const f = entryFixture();
    f.options.session.historyFormat = historyFormat;
    f.options.prepared.buffer = Buffer.from(JSON.stringify(body));
    const handled = tryHandleContextRecoveryHttp(f.options);
    assert.equal(handled, historyFormat === 3);
    if (handled) {
      await f.outcome;
      assert.equal(f.counts.complete, 1);
      assert.equal(f.counts.requests, 1);
      assert.equal(f.res.statusCode, 200);
    } else assert.equal(f.counts.requests, 0);
  }
});

test('HTTP defaults to isolated generation and rejects unproven public ancestry only after cleanup', async () => {
  for (const mode of ['clean', 'cleanup-failed', 'revoked']) {
    const f = entryFixture();
    f.options.prepared.buffer = Buffer.from(
      JSON.stringify({ input: [], previous_response_id: 'unknown-parent' })
    );
    f.options.session.recovery = (body, controls) => {
      assert.deepEqual(controls, { publicGeneration: 'isolated' });
      assert.equal(body.previous_response_id, 'unknown-parent');
      return { ok: false, code: 'context_recovery_public_history_unavailable' };
    };
    f.options.session.abort = () => {
      f.counts.abort++;
      if (mode === 'cleanup-failed') throw new Error('private-cleanup-marker');
      if (mode === 'revoked') f.options.authorized = () => false;
    };
    if (mode === 'revoked') {
      let allowed = true;
      f.options.authorized = () => allowed;
      f.options.session.abort = () => {
        f.counts.abort++;
        allowed = false;
      };
    }
    assert.equal(tryHandleContextRecoveryHttp(f.options), true);
    const outcome = await f.outcome;
    assert.equal(outcome.ok, false);
    assert.equal(f.counts.requests, 0);
    assert.equal(f.counts.complete, 0);
    assert.equal(f.counts.abort, 1);
    assert.equal(outcome.statusCode, mode === 'clean' ? 400 : 502);
    assert.doesNotMatch(f.res.wire, /unknown-parent|private-cleanup-marker/);
    if (mode === 'clean')
      assert.equal(JSON.parse(f.res.wire).error.code, 'previous_response_not_found');
  }
});

test('HTTP private continuation projects only a cleaned authorized cache miss and never commits or leaks the provider error', async () => {
  for (const mode of ['cache-miss', 'cleanup-failed', 'revoked', 'no-previous', 'wrong-code']) {
    const f = entryFixture();
    const body = {
      input: [],
      ...(mode === 'no-previous' ? {} : { previous_response_id: 'public-parent' }),
    };
    f.options.prepared.buffer = Buffer.from(JSON.stringify(body));
    f.options.session.recovery = () => ({
      ok: true,
      initialRequest: body,
      cancel() {},
      accept() {
        throw new Error('must not accept a cache miss');
      },
    });
    f.options.dispatch = async () => {
      f.counts.requests++;
      return {
        statusCode: 400,
        stream: false,
        wire: Buffer.from(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: mode === 'wrong-code' ? 'other_error' : 'previous_response_not_found',
              param: 'previous_response_id',
              message: 'private-response-id raw-content-and-auth-marker',
            },
          })
        ),
      };
    };
    if (mode === 'revoked') {
      let allowed = true;
      f.options.authorized = () => allowed;
      const original = f.options.dispatch;
      f.options.dispatch = async (...args) => {
        const result = await original(...args);
        allowed = false;
        return result;
      };
    }
    if (mode === 'cleanup-failed')
      f.options.session.abort = () => {
        f.counts.abort++;
        throw new Error('private cleanup');
      };
    assert.equal(tryHandleContextRecoveryHttp(f.options), true);
    const outcome = await f.outcome;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.statusCode, mode === 'cache-miss' ? 400 : 502, mode);
    assert.equal(f.res.statusCode, mode === 'cache-miss' ? 400 : 502, mode);
    assert.equal(f.counts.complete, 0);
    assert.equal(f.counts.withdraw, 0);
    assert.equal(f.counts.abort, 1);
    assert.equal(f.counts.requests, 1);
    assert.doesNotMatch(f.res.wire, /private-response-id|raw-content-and-auth-marker/);
    if (mode === 'cache-miss') {
      assert.equal(JSON.parse(f.res.wire).error.code, 'previous_response_not_found');
      assert.equal(JSON.parse(f.res.wire).error.param, 'previous_response_id');
      assert.equal(f.res.headers['cache-control'], 'no-store');
    }
    assert.equal(f.req.listenerCount('aborted'), 0);
    assert.equal(f.res.listenerCount('close'), 0);
    assert.equal(f.res.listenerCount('error'), 0);
  }
});

test('HTTP entry owns one final publication and withdraws committed state on write failure or close', async () => {
  for (const mode of [
    'success',
    'write-error',
    'close-after-commit',
    'revoke-on-commit',
    'commit-error',
    'upstream-error',
    'unauthorized',
    'cancel',
  ]) {
    const f = entryFixture(mode);
    assert.equal(tryHandleContextRecoveryHttp(f.options), true);
    const outcome = await f.outcome;
    assert.equal(outcome.ok, mode === 'success', mode);
    assert.equal(
      f.counts.withdraw,
      ['write-error', 'close-after-commit', 'revoke-on-commit'].includes(mode) ? 1 : 0,
      mode
    );
    if (mode === 'success') {
      assert.equal(f.counts.complete, 1);
      assert.equal(f.res.statusCode, 200);
    } else if (['upstream-error', 'unauthorized', 'commit-error'].includes(mode))
      assert.equal(f.res.statusCode, 502);
    assert.equal(f.req.listenerCount('aborted'), 0);
    assert.equal(f.res.listenerCount('close'), 0);
    assert.equal(f.res.listenerCount('error'), 0);
    assert.doesNotMatch(JSON.stringify(outcome), /private/);
  }
});

test('HTTP entry leaves unsupported and untouched requests to ordinary observation', () => {
  const patches = [
    { session: null },
    { observer: null },
    { stream: undefined },
    { prepared: { buffer: Buffer.from('invalid') } },
    { prepared: { buffer: Buffer.from([255]) } },
    { requestOptions: { headers: { 'content-encoding': 'gzip' } } },
  ];
  for (const patch of patches) {
    const f = entryFixture();
    assert.equal(tryHandleContextRecoveryHttp({ ...f.options, ...patch }), false);
    assert.equal(f.counts.requests, 0);
    assert.equal(f.counts.abort, 0);
  }
  const noSources = entryFixture();
  noSources.options.session.inspect = () => ({ visibleSources: 0 });
  assert.equal(tryHandleContextRecoveryHttp(noSources.options), false);
  const controls = entryFixture();
  controls.options.session.recovery = () => ({
    ok: false,
    code: 'context_recovery_controls_unsupported',
  });
  assert.equal(tryHandleContextRecoveryHttp(controls.options), false);
});

test('HTTP entry owns an admitted local summary even before the first evidence source', async () => {
  const f = entryFixture();
  f.options.session.inspect = () => ({ visibleSources: 0, localSummary: true });
  assert.equal(tryHandleContextRecoveryHttp(f.options), true);
  await f.outcome;
  assert.equal(f.res.statusCode, 200);
  assert.equal(f.counts.complete, 1);
});

test('HTTP setup exceptions and observer ownership failures terminate without ordinary forwarding', async () => {
  for (const mode of ['recovery-throw', 'dispatch-throw', 'detach-failed']) {
    const f = entryFixture();
    if (mode === 'recovery-throw')
      f.options.session.recovery = () => {
        throw new Error('synthetic-private-result');
      };
    if (mode === 'dispatch-throw')
      f.options.conversion = {
        createDispatch() {
          throw new Error('synthetic-private-result');
        },
      };
    if (mode === 'detach-failed') f.options.observer.detach = () => false;
    assert.equal(tryHandleContextRecoveryHttp(f.options), true, mode);
    assert.equal((await f.outcome).ok, false);
    assert.equal(f.counts.requests, 0);
    assert.equal(f.counts.abort, 1);
    assert.equal(f.res.statusCode, 502);
    assert.equal(f.res.wire.includes('synthetic-private-result'), false);
  }
});

test('admission rejection and unsupported controls use only fixed data descriptors', () => {
  for (const code of [
    'context_recovery_busy',
    'context_recovery_storage_unavailable',
    'context_recovery_binding_changed',
    'context_recovery_scope_unavailable',
    'context_recovery_source_conflict',
    'context_recovery_ambiguous',
    'context_recovery_disabled',
    'context_binding_conflict',
    'context_binding_ancestor_unavailable',
    'invalid_recovery_results',
  ]) {
    assert.equal(blocksRecoveryAdmission({ ok: false, code }), true);
    assert.equal(blocksRecoveryAdmission({ ok: true, code }), false);
    assert.equal(permitsOrdinaryRecoveryControls({ ok: false, code }), false);
  }
  for (const code of [
    'context_recovery_controls_unsupported',
    'context_recovery_tools_unsupported',
    'context_recovery_tool_collision',
  ]) {
    assert.equal(permitsOrdinaryRecoveryControls({ ok: false, code }), true);
    const f = entryFixture();
    f.options.session.recovery = () => ({ ok: false, code });
    assert.equal(tryHandleContextRecoveryHttp(f.options), false);
    assert.equal(f.counts.requests, 0);
    assert.equal(f.counts.abort, 0);
  }
  let ran = 0;
  const getters = {
    get ok() {
      ran++;
      return false;
    },
    get code() {
      ran++;
      return 'context_recovery_busy';
    },
  };
  for (const input of [
    undefined,
    null,
    false,
    '',
    [],
    {},
    { ok: false },
    { ok: false, code: 'x'.repeat(100000) },
    getters,
    Object.create({ ok: false, code: 'context_recovery_busy' }),
  ]) {
    assert.equal(blocksRecoveryAdmission(input), false);
    assert.equal(permitsOrdinaryRecoveryControls(input), false);
  }
  assert.equal(ran, 0);
  for (const code of [
    'context_binding_previous_unavailable',
    'context_recovery_identity_unavailable',
    'context_recovery_request_unsupported',
    'context_recovery_quota',
  ])
    assert.equal(blocksRecoveryAdmission({ ok: false, code }), false);
});

test('HTTP recovery preparation failures cannot fall through with missing private results', async () => {
  for (const code of [
    'context_recovery_busy',
    'context_recovery_continuation_unsupported',
    'context_recovery_history_conflict',
  ]) {
    const f = entryFixture();
    f.options.session.recovery = () => ({ ok: false, code });
    assert.equal(tryHandleContextRecoveryHttp(f.options), true, code);
    assert.equal((await f.outcome).ok, false);
    assert.equal(f.counts.requests, 0);
    assert.equal(f.counts.abort, 1);
    assert.equal(f.res.statusCode, 502);
    assert.equal(JSON.stringify(f.res.wire).includes(code), false);
  }
});

test('published recovery stays committed when the outcome reporter throws', async () => {
  const f = entryFixture();
  const outcomes = [];
  f.options.onOutcome = (result) => {
    outcomes.push(result);
    if (outcomes.length === 1) throw new Error('private reporting error');
  };
  assert.equal(tryHandleContextRecoveryHttp(f.options), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcomes.length, 1, 'one publication must have one terminal outcome');
  assert.equal(outcomes[0].ok, true);
  assert.equal(f.counts.complete, 1);
  assert.equal(f.counts.withdraw, 0, 'reporting failure must not revoke published history');
  assert.equal(f.counts.abort, 0);
  assert.equal(f.counts.requests, 1);
  assert.equal(f.res.statusCode, 200);
  assert.equal(f.req.listenerCount('aborted'), 0);
  assert.equal(f.res.listenerCount('close'), 0);
});

test('outcome reporter failures cannot interrupt failed publication, response cleanup or create rejected background work', async () => {
  const { contextRecoveryDiagnostics } = require('../lib/proxy/context-recovery-diagnostics');
  contextRecoveryDiagnostics.configure(true);
  const failures = () => contextRecoveryDiagnostics.inspect({}).counters.responses.reportingFailed;
  const before = failures();
  let attempts = 0;
  for (const mode of ['success', 'upstream-error', 'write-error', 'cancel']) {
    for (const asynchronous of [false, true]) {
      const f = entryFixture(mode);
      const outcomes = [];
      f.options.onOutcome = (result) => {
        outcomes.push(result);
        if (asynchronous) return Promise.reject(new Error('private-report-token'));
        throw new Error('private-report-token');
      };
      assert.equal(tryHandleContextRecoveryHttp(f.options), true);
      await new Promise((resolve) => setImmediate(resolve));
      attempts++;
      assert.equal(outcomes.length, 1, mode);
      assert.equal(outcomes[0].ok, mode === 'success');
      assert.equal(f.counts.withdraw, mode === 'write-error' ? 1 : 0);
      assert.equal(f.counts.requests, 1, 'reporting must never retry the model request');
      if (mode === 'upstream-error') {
        assert.equal(f.res.statusCode, 502);
        assert.equal(JSON.parse(f.res.wire).error.code, 'context_recovery_failed');
      }
      assert.equal(f.req.listenerCount('aborted'), 0);
      assert.equal(f.res.listenerCount('close'), 0);
      assert.equal(f.res.listenerCount('error'), 0);
      assert.doesNotMatch(JSON.stringify(outcomes), /private-report-token/);
    }
  }
  assert.equal(failures() - before, attempts);
});

test('recovery dispatch construction failure owns the rejection and aborts the unpublished plan', async () => {
  for (const patch of [
    { dispatch: {} },
    {
      conversion: {
        createDispatch() {
          throw new Error('private construction error');
        },
      },
    },
    { transport: null },
  ]) {
    const f = entryFixture();
    let detached = 0;
    f.options.observer.detach = () => {
      detached++;
      return true;
    };
    assert.equal(tryHandleContextRecoveryHttp({ ...f.options, ...patch }), true);
    assert.equal((await f.outcome).ok, false);
    assert.equal(detached, 1);
    assert.equal(f.counts.abort, 1);
    assert.equal(f.counts.requests, 0);
  }
});

test('core composition keeps private HTTP execution modules cold', { timeout: 10000 }, () => {
  const core = require.resolve('../lib/proxy/core-request-handler');
  const entry = require.resolve('../lib/proxy/context-recovery-http-entry');
  const cached = new Map([core, entry].map((file) => [file, require.cache[file]]));
  const cold = new Set([
    'context-recovery-runner',
    'context-recovery-progress',
    'context-recovery-http-dispatch',
    'context-recovery-client-wire',
    'context-recovery-hosted-output',
  ]);
  const load = Module._load;
  let freshEntry = false;
  try {
    for (const file of cached.keys()) delete require.cache[file];
    Module._load = function (request) {
      const name = request.split(/[\\/]/).at(-1).replace(/\.js$/, '');
      assert.equal(cold.has(name), false, 'private HTTP execution loaded at startup');
      const result = Reflect.apply(load, this, arguments);
      if (name === 'context-recovery-http-entry') freshEntry = true;
      return result;
    };
    const { createCoreRequestHandler } = require(core);
    assert.equal(typeof createCoreRequestHandler({ getRuntimeState: () => ({}) }), 'function');
    assert.equal(freshEntry, true, 'the HTTP boundary must be evaluated again');
    assert.notEqual(require.cache[entry], cached.get(entry));
  } finally {
    Module._load = load;
    for (const [file, previous] of cached) {
      if (previous === undefined) delete require.cache[file];
      else require.cache[file] = previous;
    }
  }
});

test('private HTTP first-load failures are owned, sanitized and never forwarded', async () => {
  const load = Module._load;
  for (const name of [
    'context-recovery-http-dispatch',
    'context-recovery-runner',
    'context-recovery-client-wire',
  ]) {
    const f = entryFixture();
    let attempts = 0;
    Module._load = function (request) {
      if (request === './' + name) {
        attempts++;
        throw new Error('PRIVATE_MODULE_LOAD_TOKEN');
      }
      return Reflect.apply(load, this, arguments);
    };
    try {
      assert.equal(tryHandleContextRecoveryHttp({ ...f.options, stream: null }), false);
      assert.equal(attempts, 0, 'ineligible request must not load execution modules');
      assert.equal(tryHandleContextRecoveryHttp(f.options), true);
      const outcome = await f.outcome;
      assert.equal(attempts, 1, name);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.statusCode, 502);
      assert.equal(f.res.statusCode, 502);
      assert.equal(outcome.rounds, name === 'context-recovery-client-wire' ? 1 : 0);
      assert.deepEqual(outcome.usage, name === 'context-recovery-client-wire' ? [{}] : []);
      assert.equal(f.counts.complete, 0);
      assert.equal(f.counts.withdraw, 0);
      assert.equal(f.counts.abort, 1);
      assert.equal(f.counts.requests, name === 'context-recovery-client-wire' ? 1 : 0);
      assert.doesNotMatch(f.res.wire, /PRIVATE_MODULE_LOAD_TOKEN/);
      assert.equal(f.req.listenerCount('aborted'), 0);
      assert.equal(f.res.listenerCount('close'), 0);
      assert.equal(f.res.listenerCount('error'), 0);
    } finally {
      Module._load = load;
    }
  }
  const recovered = entryFixture();
  assert.equal(tryHandleContextRecoveryHttp(recovered.options), true);
  assert.equal((await recovered.outcome).ok, true);
  assert.equal(recovered.counts.requests, 1);
  assert.equal(recovered.counts.complete, 1);
});
