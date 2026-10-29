'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  bindRecoveryWbipcCredentials,
  recoveryWbipcCredentialsAllowed,
  recoveryWbipcCredentialScope,
  recoveryOfficialCredentialsAllowed,
  createRecoveryWbipcCredentialGuard,
} = require('../lib/proxy/context-recovery-auth');
const { tryHandleContextRecoveryWbipc } = require('../lib/proxy/context-recovery-wbipc-entry');
const { createRecoveryHttpAuthorization } = require('../lib/proxy/context-recovery-http-entry');
const { createAuthResolver } = require('../lib/proxy/auth-resolver');
const { beginContextRecoveryRequest } = require('../lib/proxy/context-recovery-protocol');
const { createContextRecoverySessions } = require('../lib/proxy/context-recovery-sessions');
const { recoveryConverters } = require('./helpers/recovery-converters');

const profile = {
  id: 'wbipc',
  protocol: 'workbuddy',
  apiKey: 'PROXY_MANAGED',
  targetUrl: 'https://www.workbuddy.cn/v2',
};
const prepared = () => ({
  profile: { ...profile, apiKey: null },
  authMode: 'official-login',
  authProvider: 'workbuddy',
  workbuddyAuth: { accessToken: null, accessTokenEncrypted: true, uid: 'fixture-owner' },
  rewriteTo: 'fixture',
});

function fixture(kind = 'chat') {
  const value = prepared();
  bindRecoveryWbipcCredentials(value, profile, () => true);
  const body = {
    model: 'fixture',
    ...(kind === 'responses'
      ? { input: [{ role: 'user', content: 'hello' }] }
      : { messages: [{ role: 'user', content: 'hello' }] }),
    ...(kind === 'claude' ? { max_tokens: 50 } : {}),
  };
  value.buffer = Buffer.from(JSON.stringify(body));
  let plans = 0;
  let detached = 0;
  return {
    options: {
      label:
        kind === 'chat'
          ? 'chat->wbipc'
          : kind === 'responses'
            ? 'responses->chat'
            : 'claude->openai',
      prepared: value,
      target: { protocol: 'https:', hostname: 'www.workbuddy.cn', path: '/v2' },
      requestOptions: { hostname: 'www.workbuddy.cn', port: 443 },
      clientReq: { headers: {} },
      converters: recoveryConverters(),
      authorized: () => true,
      wbipc: {
        readEndpoint: () => ({ endpoint: 'fixture-pipe', ticket: 'synthetic-ticket' }),
        connect() {
          throw new Error('Must not connect during qualification');
        },
      },
      session: {
        ok: true,
        inspect: () => ({ visibleSources: 1 }),
        recovery() {
          plans++;
          return { ok: false, code: 'context_recovery_controls_unsupported' };
        },
      },
      observer: {
        detach() {
          detached++;
          return true;
        },
      },
      stream: false,
    },
    counts: () => ({ plans, detached }),
    body,
  };
}

test('WBIPC provenance is provider-specific, requires an explicit guard and survives only trusted spreads', () => {
  const p = prepared();
  assert.equal(recoveryWbipcCredentialsAllowed(p, profile), false);
  bindRecoveryWbipcCredentials(p, profile);
  assert.equal(recoveryWbipcCredentialsAllowed(p, profile), false);
  bindRecoveryWbipcCredentials(p, profile, () => true);
  assert.equal(recoveryWbipcCredentialsAllowed({ ...p }, { ...profile }), true);
  assert.equal(recoveryOfficialCredentialsAllowed(p, profile), false);
  assert.equal(recoveryWbipcCredentialsAllowed(JSON.parse(JSON.stringify(p)), profile), false);
  assert.match(recoveryWbipcCredentialScope(p), /^[a-f0-9]{64}$/);
  for (const update of [
    { profile: { ...p.profile, apiKey: 'plaintext' } },
    { profile: { ...p.profile, protocol: 'openai' } },
    { authProvider: 'openai' },
    { authMode: 'api-key' },
    { workbuddyAuth: { ...p.workbuddyAuth, uid: 'another-owner' } },
    { workbuddyAuth: { ...p.workbuddyAuth, accessTokenEncrypted: false } },
    { workbuddyAuth: { ...p.workbuddyAuth, accessToken: 'plaintext' } },
  ])
    assert.equal(recoveryWbipcCredentialsAllowed({ ...p, ...update }, profile), false);
  assert.equal(
    recoveryWbipcCredentialsAllowed(p, { ...profile, targetUrl: 'https://changed/v2' }),
    false
  );
  for (const guard of [
    () => false,
    () => 'true',
    () => {
      throw new Error('private');
    },
  ]) {
    const q = bindRecoveryWbipcCredentials(prepared(), profile, guard);
    assert.equal(recoveryWbipcCredentialsAllowed(q), false);
  }
  let getters = 0;
  const accessor = {
    ...prepared(),
    workbuddyAuth: {
      get accessTokenEncrypted() {
        getters++;
        return true;
      },
    },
  };
  bindRecoveryWbipcCredentials(accessor, profile, () => true);
  assert.equal(recoveryWbipcCredentialsAllowed(accessor), false);
  assert.equal(getters, 0);
  assert.equal(recoveryWbipcCredentialScope(null), null);
});

test('actual resolver credential guard binds the exact parsed source and isolates account rotation in session targets', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-wbipc-provenance-'));
  const file = path.join(directory, 'auth.info');
  t.after(() => {
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  const write = (owner) =>
    fs.writeFileSync(
      file,
      JSON.stringify({
        auth: {
          accessToken: { $wbEncrypted: 1, envelope: 'synthetic-' + owner },
          domain: 'www.workbuddy.cn',
        },
        account: { uid: owner },
      })
    );
  write('one');
  const resolver = createAuthResolver({
    officialLoginProvider: () => 'workbuddy',
    inferOfficialProfileAuthMode: () => 'official-login',
    configuredAuthMode: () => '',
    isRedactedSecret: (value) => !value || value === 'PROXY_MANAGED',
    decryptKey: (value) => value,
    PROFILES: () => [profile],
    workbuddyAuthPath: file,
  });
  const p = await resolver.resolveOfficialCredentials(
    { profile: { ...profile }, rewriteTo: 'fixture' },
    {}
  );
  assert.equal(recoveryWbipcCredentialsAllowed(p, profile), true);
  const scope = {
    enabled: true,
    allowed: true,
    auth: { ok: true, enabled: true, key: { id: 'entry-owner' } },
    profile,
    environment: {},
  };
  const allowed = createRecoveryHttpAuthorization(() => scope, scope.auth, p);
  assert.equal(allowed(), true);
  const runtime = createContextRecoverySessions();
  runtime.configure(true);
  t.after(() => runtime.close());
  const body = Buffer.from(
    JSON.stringify({ model: 'fixture', input: [{ role: 'user', content: 'same text' }] })
  );
  const first = beginContextRecoveryRequest(runtime, {
    auth: scope.auth,
    kind: 'responses',
    prepared: p,
    buffer: body,
  });
  assert.equal(first.ok, true);
  const call = { type: 'function_call', call_id: 'rotation-call', name: 'lookup', arguments: '{}' };
  assert.equal(
    first.complete(
      [call],
      [{ callId: 'rotation-call', toolName: 'lookup', arguments: {}, completed: true, output: '' }]
    ).ok,
    true
  );
  const continuation = Buffer.from(
    JSON.stringify({
      model: 'fixture',
      input: [
        ...JSON.parse(body).input,
        call,
        { type: 'function_call_output', call_id: 'rotation-call', output: 'account-one-only🙂' },
      ],
    })
  );
  const sameAccount = beginContextRecoveryRequest(runtime, {
    auth: scope.auth,
    kind: 'responses',
    prepared: p,
    buffer: continuation,
  });
  assert.equal(sameAccount.ok, true);
  assert.equal(sameAccount.reason, 'observed_continuation');
  assert.equal(sameAccount.inspect().visibleSources, 1);
  const before = recoveryWbipcCredentialScope(p);
  const mismatched = createRecoveryWbipcCredentialGuard(file, { raw: { forged: true } });
  assert.equal(mismatched(), false);
  write('two');
  assert.equal(allowed(), false);
  assert.equal(recoveryWbipcCredentialsAllowed(p), false);
  const second = await resolver.resolveOfficialCredentials(
    { profile: { ...profile }, rewriteTo: 'fixture' },
    {}
  );
  assert.equal(recoveryWbipcCredentialsAllowed(second), true);
  assert.notEqual(recoveryWbipcCredentialScope(second), before);
  const request = beginContextRecoveryRequest(runtime, {
    auth: scope.auth,
    kind: 'responses',
    prepared: second,
    buffer: continuation,
  });
  assert.equal(request.ok, true);
  assert.notEqual(request.reason, 'observed_continuation');
  assert.equal(request.inspect().visibleSources, 0);
  const oldInfo = { raw: JSON.parse(fs.readFileSync(file, 'utf8')) };
  assert.equal(createRecoveryWbipcCredentialGuard(file, oldInfo)(), true);
  fs.writeFileSync(file, 'x'.repeat(128 * 1024 + 1));
  assert.equal(createRecoveryWbipcCredentialGuard(file, oldInfo)(), false);
  fs.writeFileSync(file, '{');
  assert.equal(createRecoveryWbipcCredentialGuard(file, oldInfo)(), false);
});

test('WBIPC admission rejects unknown identity, host/path/port, policy, discovery and executable input before recovery ownership', () => {
  for (const mutate of [
    (o) => {
      o.label = 'images->wbipc';
    },
    (o) => {
      o.apiKey = 'inbound-key';
    },
    (o) => {
      o.prepared = JSON.parse(JSON.stringify(o.prepared));
      o.prepared.buffer = Buffer.from('{}');
    },
    (o) => {
      o.prepared.activePromptPreset = {};
    },
    (o) => {
      o.prepared.promptPreset = {};
    },
    (o) => {
      o.prepared.profile.optimizeContext = true;
    },
    (o) => {
      o.target.protocol = 'http:';
    },
    (o) => {
      o.target.hostname = 'evilworkbuddy.cn';
      o.requestOptions.hostname = 'evilworkbuddy.cn';
    },
    (o) => {
      o.target.path = '/v2/../v2';
    },
    (o) => {
      o.requestOptions.hostname = 'redirect';
    },
    (o) => {
      o.requestOptions.port = 444;
    },
    (o) => {
      o.clientReq.headers['content-encoding'] = 'gzip';
    },
    (o) => {
      o.clientReq.headers['x-hpm-tool-discovery'] = 'hpm-function-discovery-v1';
    },
    (o) => {
      o.prepared.buffer = 'bad';
    },
    (o) => {
      o.prepared.buffer = Buffer.alloc(3 * 1024 * 1024);
    },
    (o) => {
      o.prepared.buffer = Buffer.from([255]);
    },
    (o) => {
      o.prepared.buffer = Buffer.from('{');
    },
    (o) => {
      o.wbipc.readEndpoint = () => null;
    },
    (o) => {
      o.authorized = () => false;
    },
    (o) => {
      o.protocolOptions = { workbuddyTargetBodyBytes: 384 * 1024 + 1 };
    },
  ]) {
    const f = fixture();
    mutate(f.options);
    assert.equal(tryHandleContextRecoveryWbipc(f.options), false);
    assert.deepEqual(f.counts(), { plans: 0, detached: 0 });
  }
});

test('three WBIPC client protocols reach shared admission without entering a legacy loop', () => {
  for (const kind of ['chat', 'responses', 'claude']) {
    const f = fixture(kind);
    assert.equal(tryHandleContextRecoveryWbipc(f.options), false);
    assert.deepEqual(f.counts(), { plans: 1, detached: 0 });
  }
});

test('three WBIPC protocols own failed recovery preparation without invoking legacy or native dispatch', async () => {
  for (const kind of ['chat', 'responses', 'claude']) {
    const f = fixture(kind);
    let aborts = 0,
      active = 0,
      finish;
    const outcome = new Promise((resolve) => {
      finish = resolve;
    });
    const req = new EventEmitter();
    req.headers = {};
    const res = new EventEmitter();
    res.writeHead = (status) => {
      res.statusCode = status;
      res.headersSent = true;
    };
    res.end = (wire) => {
      res.wire = wire;
      res.writableEnded = true;
      res.emit('finish');
    };
    res.destroy = () => {
      res.destroyed = true;
      res.emit('close');
    };
    Object.assign(f.options, {
      clientReq: req,
      clientRes: res,
      setActive() {
        active++;
      },
      onOutcome: finish,
    });
    f.options.session.recovery = () => ({ ok: false, code: 'context_recovery_busy' });
    f.options.session.abort = () => {
      aborts++;
    };
    assert.equal(tryHandleContextRecoveryWbipc(f.options), true, kind);
    assert.equal((await outcome).ok, false);
    assert.equal(active, 1);
    assert.equal(aborts, 1);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.wire).error.code, 'context_recovery_failed');
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
    assert.equal(res.listenerCount('error'), 0);
    assert.deepEqual(f.counts(), { plans: 0, detached: 1 });
  }
});

test('Chat WBIPC controls, tools and complete history are validated without protocol coercion', () => {
  for (const change of [
    { model: '' },
    { stream: 'false' },
    { tool_choice: 'required' },
    { parallel_tool_calls: 'false' },
    { service_tier: 'invalid' },
    { max_tokens: 1, max_completion_tokens: 1 },
    { max_tokens: 0 },
    { max_completion_tokens: 1.5 },
    { temperature: -1 },
    { top_p: 1.1 },
    { unknown: true },
    { messages: [] },
    { tools: [{}] },
    {
      tools: [
        { type: 'function', function: { name: 'hpm_read_context_artifact', parameters: {} } },
      ],
    },
    { tools: [{ type: 'function', function: { name: 'hpm_discover_tools', parameters: {} } }] },
  ]) {
    const f = fixture();
    f.options.prepared.buffer = Buffer.from(JSON.stringify({ ...f.body, ...change }));
    assert.equal(tryHandleContextRecoveryWbipc(f.options), false);
    assert.deepEqual(f.counts(), { plans: 0, detached: 0 });
  }
  const f = fixture();
  f.options.prepared.buffer = Buffer.from(
    JSON.stringify({
      ...f.body,
      temperature: 0,
      top_p: 1,
      parallel_tool_calls: false,
      service_tier: 'default',
      max_tokens: 50,
    })
  );
  assert.equal(tryHandleContextRecoveryWbipc(f.options), false);
  assert.deepEqual(f.counts(), { plans: 1, detached: 0 });
});

test('WBIPC format3 admission accepts long aggregate history only under owner format while preserving per-message bounds', () => {
  for (const kind of ['chat', 'responses', 'claude']) {
    const f = fixture(kind);
    const key = kind === 'responses' ? 'input' : 'messages';
    const body = {
      ...f.body,
      [key]: Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(500000) })),
    };
    f.options.prepared.buffer = Buffer.from(JSON.stringify(body));
    assert.equal(tryHandleContextRecoveryWbipc(f.options), false);
    assert.deepEqual(f.counts(), { plans: 0, detached: 0 });
    f.options.session.historyFormat = 3;
    assert.equal(tryHandleContextRecoveryWbipc(f.options), false);
    assert.deepEqual(f.counts(), { plans: 1, detached: 0 });
    body[key] = [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }];
    f.options.prepared.buffer = Buffer.from(JSON.stringify(body));
    assert.equal(tryHandleContextRecoveryWbipc(f.options), false);
    assert.deepEqual(f.counts(), { plans: 1, detached: 0 });
  }
});
