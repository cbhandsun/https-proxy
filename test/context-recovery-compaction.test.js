'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const { createContextBindingRegistry } = require('../lib/proxy/context-binding');
const {
  createContextRecoverySessions,
  attachContextRecoveryStorage,
  exportContextRecoveryRoot,
} = require('../lib/proxy/context-recovery-sessions');
const {
  guardNativeCompactionResponse,
} = require('../lib/proxy/handlers/native-compaction-response');
const { beginContextRecoveryRequest } = require('../lib/proxy/context-recovery-protocol');
const {
  createRecoveryCompactionPublication,
  nativeRecoveryCompactionProviderAllowed,
} = require('../lib/proxy/context-recovery-compaction');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');
const scope = { principal: 'owner', protocol: 'responses', target: 'target' };
const user = (content) => ({ role: 'user', content });
const policy = {
  instructions: 'stable policy',
  system: null,
  tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
  toolChoice: null,
};
const compactPolicy = { ...policy, tools: null };
const call = {
  type: 'function_call',
  id: 'fc-original',
  call_id: 'original',
  name: 'lookup',
  arguments: '{}',
};
const canonical = (id) => ({
  id: 'compact-' + id,
  object: 'response.compaction',
  created_at: 1,
  output: [
    user('retained-' + id),
    {
      type: 'compaction',
      id: 'opaque-' + id,
      encrypted_content: 'provider-fixture-' + id,
      unknown: { preserved: true },
    },
  ],
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
});
const generation = (id, calls = []) => ({
  id: 'response-' + id,
  status: 'completed',
  output: calls.length
    ? calls
    : [
        {
          type: 'message',
          id: 'message-' + id,
          role: 'assistant',
          content: [{ type: 'output_text', text: 'final' }],
        },
      ],
  usage: {},
});

test('compaction binds observed input with omitted tool schemas while ordinary requests remain full-policy scoped', () => {
  const registry = createContextBindingRegistry();
  const input = [user('question')];
  const root = registry.begin({ ...scope, policy, history: input });
  registry.commit(root.token, [call]);
  const compact = registry.beginCompaction({
    ...scope,
    policy: compactPolicy,
    history: [...input, call],
  });
  assert.equal(compact.parentSnapshotId, root.snapshotId);
  const result = canonical('one');
  assert.equal(registry.commitCompaction(compact.token, result.output).ok, true);
  assert.equal(
    registry.begin({ ...scope, policy, history: result.output }).parentSnapshotId,
    compact.snapshotId
  );
  assert.equal(
    registry.begin({ ...scope, policy: compactPolicy, history: result.output }).parentSnapshotId,
    null
  );
  assert.equal(
    registry.begin({ ...scope, policy, history: result.output.slice(1) }).parentSnapshotId,
    null
  );
  assert.deepEqual(result, canonical('one'));
  assert.equal(
    registry.beginCompaction({
      ...scope,
      policy: { ...policy, tools: [] },
      history: [...input, call],
    }).code,
    'context_binding_compaction_policy_conflict'
  );
  registry.withdraw(compact.token);
  assert.equal(registry.begin({ ...scope, policy, history: result.output }).parentSnapshotId, null);
});

test('compaction rejects ambiguous, foreign, edited, unobserved, plain-text and unsupported inputs', () => {
  const registry = createContextBindingRegistry();
  const input = [user('question')];
  const root = registry.begin({ ...scope, policy, history: input });
  registry.commit(root.token, [call]);
  const compact = { ...scope, policy: compactPolicy, history: [...input, call] };
  for (const patch of [
    { principal: 'foreign' },
    { target: 'different' },
    { policy: { ...compactPolicy, instructions: 'changed' } },
    { history: [user('edited'), call] },
  ])
    assert.equal(
      registry.beginCompaction({ ...compact, ...patch }).code,
      'context_binding_compaction_unobserved'
    );
  assert.equal(
    registry.beginCompaction({ ...compact, protocol: 'chat' }).code,
    'context_binding_compaction_unsupported'
  );
  assert.equal(
    registry.beginCompaction({ ...compact, previousResponseId: 'response' }).code,
    'context_binding_compaction_unsupported'
  );
  assert.equal(registry.beginCompaction({ ...compact, history: [] }).ok, false);
  assert.equal(registry.beginCompaction({ ...compact, history: 'invalid' }).ok, false);
  const textRoot = registry.begin({ ...scope, policy, history: [user('plain')] });
  registry.commit(textRoot.token, [{ role: 'assistant', content: 'identical' }]);
  assert.equal(
    registry.beginCompaction({
      ...compact,
      history: [user('plain'), { role: 'assistant', content: 'identical' }],
    }).ok,
    false
  );
  const otherPolicy = registry.begin({
    ...scope,
    policy: { ...policy, tools: [] },
    history: input,
  });
  registry.commit(otherPolicy.token, [call]);
  assert.equal(registry.beginCompaction(compact).code, 'context_binding_compaction_ambiguous');
  registry.close();
  assert.equal(registry.beginCompaction(compact).ok, false);
});

test('three canonical replacements retain exact evidence and reset old private history without changing opaque blocks', () => {
  const runtime = createContextRecoverySessions();
  runtime.configure(true);
  let history = [user('question')];
  const root = runtime.begin({ ...scope, policy, history });
  assert.equal(
    root.complete(
      [call],
      [{ callId: call.call_id, toolName: call.name, arguments: {}, completed: true, output: '' }]
    ).ok,
    true
  );
  history = [
    ...history,
    call,
    { type: 'function_call_output', call_id: call.call_id, output: '原文🙂\nexact' },
  ];
  const captured = runtime.begin({ ...scope, policy, history }, [
    { callId: call.call_id, output: '原文🙂\nexact' },
  ]);
  const initial = captured.recovery({
    input: history,
    instructions: policy.instructions,
    tools: policy.tools,
  });
  assert.equal(
    initial.accept(
      generation('list', [
        {
          type: 'function_call',
          id: 'fc-private-old',
          call_id: 'private-old',
          name: LIST,
          arguments: '{}',
        },
      ])
    ).mode,
    'continue'
  );
  const released = initial.accept(generation('initial'));
  assert.equal(captured.complete(released.output).ok, true);
  history = [...history, ...released.output];
  for (let iteration = 0; iteration < 3; iteration++) {
    const compact = runtime.beginCompaction({ ...scope, policy: compactPolicy, history });
    assert.equal(compact.ok, true);
    assert.equal(compact.complete([]).code, 'context_recovery_compaction_request');
    assert.equal(compact.recovery({ input: history }).code, 'context_recovery_compaction_request');
    const response = canonical(String(iteration));
    const before = JSON.stringify(response);
    assert.equal(compact.completeCompaction({}).code, 'context_recovery_compaction_invalid');
    assert.equal(compact.completeCompaction(response).ok, true);
    assert.equal(compact.completeCompaction(response).ok, false);
    history = response.output;
    const next = runtime.begin({ ...scope, policy, history });
    assert.equal(next.inspect().visibleSources, 1);
    const index = JSON.parse(next.reply(LIST, {}).text);
    assert.equal(
      JSON.parse(
        next.reply(READ, { sourceId: index.sources[0].sourceId, digest: index.sources[0].digest })
          .text
      ).page.text,
      '原文🙂\nexact'
    );
    const run = next.recovery({
      input: history,
      instructions: policy.instructions,
      tools: policy.tools,
    });
    assert.equal(run.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(run.initialRequest.input)), history);
    assert.doesNotMatch(JSON.stringify(run.initialRequest.input), /private-old/);
    const answer = run.accept(generation('after-' + iteration));
    assert.equal(next.complete(answer.output).ok, true);
    history = [...history, ...answer.output];
    assert.equal(JSON.stringify(response), before);
  }
  runtime.close();
});

test('compaction publication requires live permission and withdraws committed state on publication failure', () => {
  for (const mode of ['success', 'abort', 'before', 'after', 'failed']) {
    const counts = { complete: 0, abort: 0, withdraw: 0 };
    const session = {
      completeCompaction() {
        counts.complete++;
        return { ok: mode !== 'failed' };
      },
      abort() {
        counts.abort++;
      },
      withdraw() {
        counts.withdraw++;
      },
    };
    const publish = createRecoveryCompactionPublication(
      session,
      () => mode !== 'before' && !(mode === 'after' && counts.complete)
    );
    const accepted = publish.beforePublish(canonical('publication'));
    assert.equal(accepted, ['success', 'abort'].includes(mode));
    if (mode === 'success') publish.complete();
    publish.abort();
    publish.abort();
    assert.equal(counts.withdraw, ['abort', 'after'].includes(mode) ? 1 : 0);
    assert.equal(counts.abort, ['before', 'failed'].includes(mode) ? 1 : 0);
    assert.equal(publish.beforePublish(canonical('late')), false);
  }
});

test('compaction protocol boundary selects only a native Responses compact capability', () => {
  const options = {
    auth: { ok: true, enabled: true, key: { id: 'owner' } },
    kind: 'responses',
    prepared: {
      profile: { id: 'profile', protocol: 'openai', targetUrl: 'https://api.openai.com/v1' },
    },
    buffer: Buffer.from(JSON.stringify({ model: 'fixture', input: [user('q')] })),
    compaction: true,
  };
  let seen;
  const runtime = {
    beginCompaction(input) {
      seen = input;
      return { ok: true };
    },
  };
  assert.equal(beginContextRecoveryRequest(runtime, options).ok, true);
  assert.equal(seen.protocol, 'responses');
  for (const patch of [{ kind: 'chat' }, { compaction: 'true' }])
    assert.equal(beginContextRecoveryRequest(runtime, { ...options, ...patch }).ok, false);
  const native = {
    kind: 'responses',
    path: '/v1/responses/compact',
    target: { protocol: 'https:', hostname: 'api.openai.com' },
    requestOptions: { hostname: 'api.openai.com', port: 443 },
    prepared: { authMode: 'api-key' },
  };
  assert.equal(nativeRecoveryCompactionProviderAllowed(native), true);
  assert.equal(
    nativeRecoveryCompactionProviderAllowed({ ...native, path: '/v1/responses' }),
    false
  );
  assert.equal(nativeRecoveryCompactionProviderAllowed({ ...native, kind: 'chat' }), false);
});

test('invalid, oversized, cancelled, expired and revoked checkpoints never become readable aliases', () => {
  for (const mode of ['cancel', 'expiry', 'revoke', 'disable', 'close', 'withdraw-root', 'valid']) {
    let now = 1;
    const runtime = createContextRecoverySessions({ now: () => now });
    runtime.configure(true);
    const history = [user('question')];
    const root = runtime.begin({ ...scope, policy, history });
    root.complete([call]);
    const compact = runtime.beginCompaction({
      ...scope,
      policy: compactPolicy,
      history: [...history, call],
    });
    assert.equal(root.completeCompaction(canonical('invalid-mode')).ok, false);
    let getters = 0;
    const hostile = {
      get output() {
        getters++;
        return [];
      },
    };
    for (const invalid of [
      null,
      [],
      {},
      hostile,
      { ...canonical('bad'), output: [] },
      { ...canonical('big'), extra: 'x'.repeat(2 * 1024 * 1024) },
    ])
      assert.equal(compact.completeCompaction(invalid).code, 'context_recovery_compaction_invalid');
    assert.equal(getters, 0);
    if (mode === 'cancel') compact.abort();
    if (mode === 'expiry') now += 24 * 60 * 60 * 1000;
    if (mode === 'revoke') runtime.revoke(scope.principal);
    if (mode === 'disable') runtime.configure(false);
    if (mode === 'close') runtime.close();
    if (mode === 'withdraw-root') root.withdraw();
    const response = canonical(mode);
    assert.equal(compact.completeCompaction(response).ok, mode === 'valid');
    if (mode === 'valid') {
      compact.withdraw();
      assert.equal(
        runtime.begin({ ...scope, policy, history: response.output }).inspect().visibleSources,
        0
      );
    }
    runtime.close();
  }
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function durableCompactionFixture(worker = null) {
  const records = new Map();
  const revoked = new Set();
  const requests = [];
  let hook;
  let now = 100;
  const runtime = createContextRecoverySessions({ now: worker ? Date.now : () => now });
  runtime.configure(true);
  attachContextRecoveryStorage(runtime, {
    execute(request) {
      requests.push(globalThis.structuredClone(request));
      const next = () => {
        if (worker) return worker.execute(request);
        if (request.operation === 'revoke-all') {
          for (const key of records.keys()) revoked.add(key);
          return { revoked: records.size };
        }
        if (request.operation === 'revoke-scopes') {
          for (const entry of request.entries) revoked.add(entry.scope);
          return { revoked: request.entries.length };
        }
        const previous = records.get(request.scope);
        if (request.operation === 'load')
          return globalThis.structuredClone(revoked.has(request.scope) ? null : (previous ?? null));
        assert.equal(request.operation, 'save');
        assert.equal(revoked.has(request.scope), false);
        assert.equal(request.expectedRevision, previous?.revision ?? 0);
        const revision = request.expectedRevision + 1;
        records.set(request.scope, {
          revision,
          createdAt: previous?.createdAt ?? now,
          expiresAt: request.expiresAt,
          state: globalThis.structuredClone(request.state),
        });
        return { revision };
      };
      return hook ? hook(request, next) : next();
    },
  });
  let history = [user('question')];
  const root = runtime.begin({ ...scope, policy, history });
  assert.equal(
    (
      await root.completeObservedAsync(
        [call],
        [{ callId: call.call_id, toolName: call.name, arguments: {}, completed: true, output: '' }]
      )
    ).ok,
    true
  );
  history = [
    ...history,
    call,
    { type: 'function_call_output', call_id: call.call_id, output: '原文\r\nélève🙂' },
  ];
  const captured = runtime.begin({ ...scope, policy, history }, [
    { callId: call.call_id, output: '原文\r\nélève🙂' },
  ]);
  const answer = generation('capture').output;
  assert.equal((await captured.completeObservedAsync(answer)).ok, true);
  history = [...history, ...answer];
  return {
    runtime,
    root,
    requests,
    history,
    latest: () => [...records.values()][0],
    readable: () => !revoked.has([...records.keys()][0]),
    hook: (value) => {
      hook = value;
    },
    expire: () => {
      now += 24 * 60 * 60 * 1000;
    },
    start(input = history, id = 'durable') {
      const compact = runtime.beginCompaction({ ...scope, policy: compactPolicy, history: input });
      assert.equal(compact.ok, true);
      const response = canonical(id);
      const exactWire = Buffer.from(JSON.stringify(response, null, 2) + '\r\n');
      const publication = createRecoveryCompactionPublication(compact, () => allowed);
      const upstream = new EventEmitter();
      const downstream = new EventEmitter();
      upstream.headers = { 'content-type': 'application/json' };
      upstream.destroy = () => upstream.emit('close');
      let allowed = true;
      let complete = 0;
      const outcome = deferred();
      const failures = [];
      downstream.writeHead = (statusCode) => {
        downstream.statusCode = statusCode;
        downstream.headersSent = true;
      };
      downstream.end = (wire) => {
        downstream.wire = Buffer.from(wire);
        downstream.writableEnded = true;
        downstream.emit('finish');
        downstream.emit('close');
      };
      downstream.destroy = () => {
        downstream.destroyed = true;
        downstream.emit('close');
      };
      // Same ordering as the composition root: close is registered first.
      downstream.once('close', () => publication.close());
      guardNativeCompactionResponse({
        proxyRes: upstream,
        clientRes: downstream,
        headers: {},
        statusCode: 200,
        maxBytes: 8192,
        sendJsonError(res, status, body) {
          res.writeHead(status);
          res.end(JSON.stringify(body));
        },
        beforePublishAsync: (body) => publication.beforePublishAsync(body),
        afterFinishAsync: () => publication.completeAsync(),
        publicationAllowed: () => publication.isAuthorized(),
        onComplete() {
          publication.complete();
          complete++;
          outcome.resolve(true);
        },
        onFailure(code) {
          failures.push(code);
          void publication.abortAsync();
          outcome.resolve(false);
        },
      });
      return {
        compact,
        publication,
        upstream,
        downstream,
        response,
        exactWire,
        failures,
        done: outcome.promise,
        complete: () => complete,
        revoke: () => {
          allowed = false;
        },
        send() {
          upstream.emit('data', exactWire);
          upstream.emit('end');
          upstream.emit('close');
        },
      };
    },
  };
}
function holdCompaction(f, snapshotId, phase, afterWrite = false) {
  const reached = deferred(),
    release = deferred();
  let held = false;
  f.hook((request, next) => {
    if (
      !held &&
      request.operation === 'save' &&
      request.state.publications.some(
        (entry) => entry.snapshotId === snapshotId && entry.state === phase
      )
    ) {
      held = true;
      const result = afterWrite ? next() : undefined;
      reached.resolve();
      return release.promise.then(() => (afterWrite ? result : next()));
    }
    return next();
  });
  return { reached: reached.promise, release: release.resolve };
}

test('durable compaction waits at every publication ACK and normal finish-close preserves exact wire', async () => {
  for (const phase of ['prepared', 'sending', 'transport-finished']) {
    const f = await durableCompactionFixture();
    try {
      const p = f.start();
      const hold = holdCompaction(f, p.compact.snapshotId, phase);
      p.send();
      await hold.reached;
      assert.equal(p.complete(), 0);
      assert.equal(p.downstream.wire !== undefined, phase === 'transport-finished');
      assert.equal(p.compact.completeCompaction(p.response).code, 'context_recovery_busy');
      assert.throws(() => exportContextRecoveryRoot(f.runtime, f.root.snapshotId));
      hold.release();
      await flush();
      assert.equal(p.complete(), 1);
      assert.deepEqual(p.failures, []);
      assert.deepEqual(p.downstream.wire, p.exactWire);
      assert.equal(
        f.latest().state.publications.find((entry) => entry.snapshotId === p.compact.snapshotId)
          .state,
        'transport-finished'
      );
      const next = f.runtime.begin({ ...scope, policy, history: p.response.output });
      assert.equal(next.inspect().visibleSources, 1);
      assert.equal(
        p.compact.completeCompaction(p.response).code,
        'context_recovery_async_required'
      );
    } finally {
      f.runtime.close();
    }
  }
});

test('three durable canonical replacements preserve exact evidence, consumed budget, TTL and opaque windows', async () => {
  const f = await durableCompactionFixture();
  try {
    let history = f.history;
    const expiry = f.latest().expiresAt;
    for (let i = 0; i < 3; i++) {
      const p = f.start(history, String(i));
      const before = globalThis.structuredClone(p.response);
      p.send();
      await flush();
      assert.equal(p.complete(), 1);
      assert.deepEqual(p.response, before);
      assert.deepEqual(p.downstream.wire, p.exactWire);
      history = p.response.output;
      const next = f.runtime.begin({ ...scope, policy, history });
      const index = JSON.parse((await next.replyAsync(LIST, {})).text);
      const page = JSON.parse(
        (
          await next.replyAsync(READ, {
            sourceId: index.sources[0].sourceId,
            digest: index.sources[0].digest,
          })
        ).text
      );
      assert.equal(page.page.text, '原文\r\nélève🙂');
      const run = next.recovery({
        input: history,
        instructions: policy.instructions,
        tools: policy.tools,
      });
      assert.deepEqual(JSON.parse(JSON.stringify(run.initialRequest.input)), history);
      const result = await run.acceptAsync(generation('after-' + i));
      assert.equal((await next.completeObservedAsync(result.output)).ok, true);
      history = [...history, ...result.output];
      const state = exportContextRecoveryRoot(f.runtime, f.root.snapshotId);
      assert.deepEqual(JSON.parse(JSON.stringify(state.budget)), f.latest().state.root.budget);
      assert.equal(state.budget.calls, 2 * (i + 1));
      assert.equal(state.budget.successfulReads, i + 1);
      assert.equal(f.latest().expiresAt, expiry);
    }
  } finally {
    f.runtime.close();
  }
});

test('compaction cancellation and authorization changes at each durable ACK never publish success', async () => {
  for (const phase of ['prepared', 'sending', 'transport-finished']) {
    for (const mode of ['cancel', 'auth']) {
      const f = await durableCompactionFixture();
      try {
        const p = f.start();
        const hold = holdCompaction(f, p.compact.snapshotId, phase);
        p.send();
        await hold.reached;
        if (mode === 'auth') p.revoke();
        else if (phase === 'transport-finished') p.downstream.emit('error', new Error('SECRET'));
        else p.downstream.destroy();
        hold.release();
        await flush();
        await p.publication.abortAsync();
        assert.equal(p.complete(), 0);
        assert.equal(p.failures.length, 1);
        assert.equal(
          p.downstream.wire?.equals(p.exactWire) ?? false,
          phase === 'transport-finished'
        );
        const state = f
          .latest()
          .state.publications.find((entry) => entry.snapshotId === p.compact.snapshotId).state;
        assert.equal(state, phase === 'sending' ? 'uncertain' : 'withdrawn');
        const next = f.runtime.begin({ ...scope, policy, history: p.response.output });
        assert.equal(next.inspect().visibleSources, 0);
      } finally {
        f.runtime.close();
      }
    }
  }
});

test('compaction storage rejection, malformed ACK and partial writes have no retry or memory fallback', async () => {
  for (const mode of ['throw', 'ack', 'write']) {
    const f = await durableCompactionFixture();
    try {
      const p = f.start();
      let attempted = 0;
      if (mode === 'write')
        p.downstream.end = () => {
          throw new Error('SECRET');
        };
      else
        f.hook((request, next) => {
          if (request.operation === 'save') {
            attempted++;
            if (mode === 'throw') throw new Error('SECRET');
            return { revision: -1 };
          }
          return next();
        });
      p.send();
      await flush();
      await p.publication.abortAsync();
      assert.equal(p.complete(), 0);
      assert.equal(p.failures.length, 1);
      assert.doesNotMatch(p.downstream.wire?.toString() ?? '', /SECRET|native-fixture/);
      if (mode !== 'write') assert.equal(attempted, 1);
      assert.equal(
        f.runtime.begin({ ...scope, policy, history: p.response.output }).inspect().visibleSources,
        0
      );
    } finally {
      f.runtime.close();
    }
  }
});

test('compaction pending persistence cannot revive after root revocation, disable, expiry or close', async () => {
  for (const mode of ['revoke', 'disable', 'expiry', 'close']) {
    const f = await durableCompactionFixture();
    try {
      const p = f.start();
      const hold = holdCompaction(f, p.compact.snapshotId, 'prepared', true);
      p.send();
      await hold.reached;
      if (mode === 'revoke') f.runtime.revoke(scope.principal);
      if (mode === 'disable') f.runtime.configure(false);
      if (mode === 'expiry') f.expire();
      if (mode === 'close') f.runtime.close();
      hold.release();
      await flush();
      await p.publication.abortAsync();
      assert.equal(p.complete(), 0);
      assert.equal(p.failures.length, 1);
      assert.equal(p.downstream.wire?.equals(p.exactWire) ?? false, false);
      if (mode === 'expiry')
        assert.equal(
          f.latest().state.publications.find((entry) => entry.snapshotId === p.compact.snapshotId)
            .state,
          'withdrawn'
        );
      else {
        const result =
          mode === 'close'
            ? await f.runtime.closeAsync()
            : mode === 'disable'
              ? await f.runtime.configureAsync(false)
              : await f.runtime.revokeAsync(scope.principal);
        assert.equal(result.ok, true);
        assert.equal(f.readable(), false);
      }
    } finally {
      f.runtime.close();
    }
  }
});

function removeCompactionDirectory(directory) {
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('hpm-compaction-publication-')
  )
    throw new Error('Unsafe synthetic cleanup target');
  fs.rmSync(target, { recursive: true, force: true });
}

test('durable compaction validates unknown data without executing getters and uses private snapshot identity', async () => {
  const f = await durableCompactionFixture();
  try {
    const p = f.start();
    let executed = 0;
    const hostile = {
      get output() {
        executed++;
        return [];
      },
    };
    const before = f.requests.length;
    for (const input of [
      undefined,
      null,
      [],
      {},
      hostile,
      { ...canonical('bad'), output: [] },
      { ...canonical('huge'), extra: 'x'.repeat(2 * 1024 * 1024) },
    ])
      assert.equal((await p.compact.completeCompactionAsync(input)).ok, false);
    assert.equal(f.requests.length, before);
    assert.equal(executed, 0);
    const originalId = p.compact.snapshotId;
    p.compact.snapshotId = f.root.snapshotId;
    p.send();
    assert.equal(await p.done, true);
    assert.equal(
      f.latest().state.publications.find((entry) => entry.snapshotId === originalId).state,
      'transport-finished'
    );
    assert.equal(
      f.latest().state.publications.find((entry) => entry.snapshotId === f.root.snapshotId).state,
      'transport-finished'
    );
    assert.deepEqual(p.downstream.wire, p.exactWire);
  } finally {
    f.runtime.close();
  }
});
test(
  'actual encrypted worker reopens completed compaction journal, original, budget and original TTL',
  { timeout: 30000, skip: process.platform !== 'win32' },
  async (t) => {
    const started = Date.now();
    const mark = (phase) =>
      t.diagnostic(JSON.stringify({ phase, elapsedMs: Date.now() - started }));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-compaction-publication-'));
    const store = path.join(directory, 'store');
    let storage, f;
    try {
      storage = await openContextRecoveryStorage({
        directory: store,
        onStartup: ({ phase }) => mark('initial_' + phase),
      });
      mark('seed_started');
      f = await durableCompactionFixture(storage);
      mark('seed_finished');
      const p = f.start();
      p.send();
      assert.equal(await p.done, true);
      mark('compaction_published');
      assert.deepEqual(p.downstream.wire, p.exactWire);
      const next = f.runtime.begin({ ...scope, policy, history: p.response.output });
      const index = JSON.parse((await next.replyAsync(LIST, {})).text);
      const page = JSON.parse(
        (
          await next.replyAsync(READ, {
            sourceId: index.sources[0].sourceId,
            digest: index.sources[0].digest,
          })
        ).text
      );
      assert.equal(page.page.text, '原文\r\nélève🙂');
      mark('original_read');
      const root = exportContextRecoveryRoot(f.runtime, f.root.snapshotId);
      const storageScope = f.requests.at(-1).scope;
      assert.equal((await f.runtime.shutdownAsync()).ok, true);
      mark('session_shutdown');
      await storage.close();
      mark('first_worker_closed');
      storage = undefined;
      assert.equal(
        fs
          .readFileSync(path.join(store, 'checkpoint.sqlite'))
          .includes(Buffer.from('原文\r\nélève🙂')),
        false
      );
      storage = await openContextRecoveryStorage({
        directory: store,
        onStartup: ({ phase }) => mark('reopen_' + phase),
      });
      const record = await storage.execute({ operation: 'load', scope: storageScope });
      assert.equal(
        record.state.publications.find((entry) => entry.snapshotId === p.compact.snapshotId).state,
        'transport-finished'
      );
      assert.equal(record.state.root.ledger.sources[0].output, '原文\r\nélève🙂');
      assert.deepEqual(
        JSON.parse(JSON.stringify(record.state.root.budget)),
        JSON.parse(JSON.stringify(root.budget))
      );
      assert.equal(record.state.root.budget.calls, 2);
      assert.equal(record.state.root.budget.successfulReads, 1);
      assert.equal(record.expiresAt, root.expiresAt);
      assert.equal(record.state.root.expiresAt, root.expiresAt);
      assert.equal((await storage.execute({ operation: 'inspect' })).records, 1);
      mark('reopen_verified');
    } finally {
      mark('cleanup_started');
      f?.runtime.close();
      try {
        await storage?.close();
      } finally {
        removeCompactionDirectory(directory);
        mark('cleanup_finished');
      }
    }
  }
);
