'use strict';
// Pure protocol emulator: no sockets, process, SQLite, DPAPI or model request.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const {
  createN09BusinessAdapter,
} = require('../../scripts/context-hosted/n09-business/business-adapter.js');
const {
  runCommittedObservedKill,
} = require('../../scripts/context-hosted/n09-snapshot/committed-observed-driver.js');
const {
  runClearAfterAck,
  runDurableSaveOrRevokeAfterAck,
} = require('../../scripts/context-hosted/n09-ipc/driver.js');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const bad = { message: 'n09_business_adapter_failed' };
function fixture(mutation = () => {}, onPhase) {
  const ownedRoot = path.join(os.tmpdir(), 'n09-business-pure');
  const options = {
    ownedRoot,
    install: path.join(ownedRoot, 'payload'),
    manifestSha256: 'a'.repeat(64),
  };
  const proof = Object.freeze({ pure: true });
  const state = {
    pid: 101,
    configured: 0,
    created: 0,
    stopped: 0,
    closed: 0,
    sent: 0,
    nativeReadObserved: 0,
    rootId: 'hbs_' + 'b'.repeat(32),
    expiresAt: 10000,
    calls: 0,
    returnedBytes: 0,
    revision: 1,
    cleared: false,
    events: [],
    config: undefined,
    original: undefined,
  };
  const identity = () => ({
    pid: state.pid,
    manifestSha256: options.manifestSha256,
    entryPort: 12346,
    configDir: path.join(ownedRoot, 'config'),
    runtimeDir: path.join(ownedRoot, 'runtime'),
  });
  const sourceReceipt = () => ({
    sourceId: 'hce_' + 'c'.repeat(32),
    digest: sha(state.original),
    bytes: Buffer.byteLength(state.original),
    callId: 'hpa_' + sha('synthetic-capture-snapshot\0' + state.originalCallId),
    toolName: 'n09_original',
    argumentsDigest: sha('{}'),
    expiresAt: state.expiresAt + 1,
    trust: 'tool_data_not_instructions',
  });
  const trusted = {
    isVerifiedNetworkProof: (value) => value === proof,
    createLifecycle: () => {
      state.created++;
      return {
        startLifecycle: async () => identity(),
        configureSyntheticBusiness: async (_identity, config) => {
          state.config = config;
          state.configured++;
          return { configured: true };
        },
        attestSyntheticBusiness: async () => ({ ready: true, syntheticBusinessConfigured: true }),
        ...(state.diagnostic === undefined ? {} : { readRecoveryFailurePhase: state.diagnostic }),
        stopLifecycle: async (owner) => {
          state.events.push('kill');
          state.rejectPending?.(new Error('synthetic_forced_kill'));
          state.ackCommand = undefined;
          state.stopped++;
          return {
            pid: owner.pid,
            treeEmpty: true,
            shutdownInvoked: false,
            semantics: 'forced_cleanup',
          };
        },
        restartLifecycle: async () => {
          state.pid++;
          return identity();
        },
        getClearCapability: () => async () => {
          state.cleared = true;
          return { kind: 'host-clear-completed', durableBoundary: 'await-clearAsync' };
        },
        getHostAckClient: () => ({
          submit(command) {
            state.events.push('submit');
            state.ackCommand = command;
            if (command.operation === 'revoke-bound-root') state.cleared = true;
          },
          readArmed() {
            state.events.push('armed');
            return true;
          },
          readReceipt() {
            const command = state.ackCommand;
            if (command.operation === 'arm-save' && state.revision <= command.minRevision)
              return null;
            const saving = command.operation === 'arm-save';
            const receipt = {
              version: 1,
              pid: state.pid,
              epoch: 'f'.repeat(32),
              sequence: 1,
              kind: saving ? 'host-save-completed' : 'host-revoke-completed',
              durableBoundary: saving ? 'await-reference-save' : 'await-revokeAsync',
              rootId: state.rootId,
              expiresAt: state.expiresAt,
              revision: state.revision,
              calls: state.calls,
              returnedBytes: state.returnedBytes,
              revisionSource: 'validated-reference-save',
              evidenceLevel: 'observer-boundary-only',
              liveDaemonProved: false,
            };
            mutation('ack', receipt, state);
            state.events.push('ack');
            return receipt;
          },
          close() {},
        }),
        setCombination: async () => ({ savedConfigVerified: true }),
        close: async () => {
          state.rejectPending?.(new Error('synthetic_owner_close'));
          state.closed++;
        },
      };
    },
    createSnapshots: () => ({
      read: () => {
        state.events.push('snapshot');
        mutation('snapshot', undefined, state);
        return {
          present: true,
          evidenceLevel: 'committed-metadata-only',
          hostDurableAck: false,
          rootId: state.rootId,
          expiresAt: state.expiresAt,
          calls: state.calls,
          returnedBytes: state.returnedBytes,
          revision: state.revision,
          capturedEvidence: state.original
            ? [{ capturedCallId: state.originalCallId, source: sourceReceipt() }]
            : [],
        };
      },
      close() {},
    }),
    createBusinessClient: (input) => async () => {
      state.sent++;
      const body = JSON.parse(input.templates.continuation);
      const native = async (request) => {
        let result;
        const response = {
          destroyed: false,
          headersSent: false,
          writeHead(status) {
            assert.equal(status, 200);
            this.headersSent = true;
          },
          end(bytes) {
            result = JSON.parse(bytes);
          },
        };
        const incoming = {
          path: '/v1/responses',
          authorization: 'Bearer ' + state.config.upstreamKey,
          bytes: Buffer.from(JSON.stringify(request)),
          response,
        };
        mutation('upstream', incoming, state);
        await adapter.onBusinessRequest(incoming);
        assert.ok(result);
        return result;
      };
      let result;
      const isContinuation =
        body.input[0]?.role === 'user' &&
        body.input[0].content?.[0]?.text?.includes('hpm-codex-summary:');
      if (isContinuation && !state.cleared) {
        const refusal = () => ({ status: 502, bytes: Buffer.from('{}') });
        if (state.refuseAfter === 0) return refusal();
        const tools = [
          { type: 'function', name: 'hpm_list_retained_evidence' },
          { type: 'function', name: 'hpm_read_retained_evidence' },
        ];
        let request = { ...body, tools };
        result = await native(request);
        if (state.refuseAfter === 1) return refusal();
        assert.equal(result.output[0].name, 'hpm_list_retained_evidence');
        const source = sourceReceipt();
        request = {
          ...request,
          input: [
            ...request.input,
            result.output[0],
            {
              type: 'function_call_output',
              call_id: result.output[0].call_id,
              output: JSON.stringify({ ok: true, sources: [source] }),
            },
          ],
        };
        mutation('list', source, state);
        // Apply list mutation to the actual serialized result, too.
        request.input.at(-1).output = JSON.stringify({ ok: true, sources: [source] });
        result = await native(request);
        if (state.refuseAfter === 2) return refusal();
        assert.equal(result.output[0].name, 'hpm_read_retained_evidence');
        const page = {
          text: state.original,
          encoding: 'utf8',
          offsetBytes: 0,
          endOffsetBytes: source.bytes,
          nextOffsetBytes: null,
          totalBytes: source.bytes,
          digest: source.digest,
          chunkDigest: source.digest,
        };
        const read = {
          ok: true,
          source,
          page,
          observation: 'client_reported',
          verification: 'not_verified',
        };
        mutation('read', read, state);
        request = {
          ...request,
          input: [
            ...request.input,
            result.output[0],
            {
              type: 'function_call_output',
              call_id: result.output[0].call_id,
              output: JSON.stringify(read),
            },
          ],
        };
        result = await native(request);
        if (state.refuseAfter === 3) return refusal();
        state.nativeReadObserved++;
        assert.equal(result.output[0].type, 'message');
        const publicBody = {
          ...body,
          tools: [],
          input: [
            ...body.input,
            { role: 'user', content: [{ type: 'input_text', text: state.original }] },
          ],
        };
        mutation('public', publicBody, state);
        result = await native(publicBody);
        if (state.refuseAfter === 4) return refusal();
        state.calls += 2;
        state.returnedBytes += source.bytes;
        state.revision++;
      } else {
        const output = body.input.find((item) => item.type === 'function_call_output');
        if (output) {
          state.original = output.output;
          state.originalCallId = output.call_id;
        }
        result = await native(body);
        if (body.tools.length === 0 && !isContinuation) {
          result.output[0].content[0].text +=
            '\n<!-- hpm-codex-summary:hcr1_' + 'd'.repeat(48) + '_' + 'e'.repeat(64) + '_1 -->';
        }
      }
      mutation('reply', result, state);
      if (state.ackCommand?.operation === 'arm-save' && state.holdSave) {
        state.events.push('http-pending');
        await new Promise((_resolve, reject) => {
          state.rejectPending = reject;
        });
      }
      return { status: state.replyStatus ?? 200, bytes: Buffer.from(JSON.stringify(result)) };
    },
  };
  const adapter = createN09BusinessAdapter(options, {
    ...trusted,
    ...(onPhase ? { onPhase } : {}),
  });
  return { adapter, options, proof, state, trusted };
}
test('502 diagnostics preserve failure and cleanup while exposing only fixed stage numbers', async () => {
  for (const diagnostic of [
    async () => 220,
    async () => 'PRIVATE',
    async () => {
      throw Error('PRIVATE');
    },
  ]) {
    const phases = [];
    const f = fixture(
      (_at, _value, state) => {
        state.refuseAfter = 4;
      },
      (phase) => phases.push(phase)
    );
    f.state.diagnostic = diagnostic;
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runCommittedObservedKill(f.adapter), {
      message: 'n09_committed_observed_kill_failed',
    });
    assert.equal(phases.includes(216), true);
    assert.ok([220, 224].includes(phases.at(-1)));
    assert.equal(f.state.closed, 1);
    assert.doesNotMatch(JSON.stringify(phases), /PRIVATE/);
  }
});

test('denied-receipt HTTP failure replaces completed configuration phase and preserves forced cleanup', async () => {
  const phases = [];
  const f = fixture(
    (stage, _value, state) => {
      if (stage === 'reply' && state.cleared) state.replyStatus = 503;
    },
    (phase) => phases.push(phase)
  );
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runClearAfterAck(f.adapter));
  assert.equal(phases.at(-1), 170);
  assert.equal(f.state.sent, 5);
  assert.equal(f.state.stopped, 2);
  assert.equal(f.state.closed, 1);
});

test('denied receipt distinguishes malformed envelope and wrong public answer without logging content', async () => {
  for (const expected of [225, 226]) {
    const phases = [];
    const f = fixture(
      (stage, value, state) => {
        if (stage !== 'reply' || !state.cleared) return;
        if (expected === 225) value.status = 'incomplete';
        else value.output[0].content[0].text = 'PRIVATE';
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runClearAfterAck(f.adapter));
    assert.equal(phases.at(-1), expected);
    assert.equal(f.state.sent, 5);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
    assert.doesNotMatch(JSON.stringify(phases), /PRIVATE/);
  }
});

test('successful denied receipt finishes all reply and no-replay assertions', async () => {
  const phases = [];
  const f = fixture(undefined, (phase) => phases.push(phase));
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await runClearAfterAck(f.adapter);
  assert.deepEqual(phases.slice(-5), [225, 226, 227, 228, 229]);
});

test('public generation before an observed read has a separate safe failure class', async () => {
  const phases = [];
  const f = fixture(
    (stage, incoming) => {
      if (stage !== 'upstream') return;
      const body = JSON.parse(incoming.bytes);
      if (!body.tools?.some((tool) => tool.name === 'hpm_list_retained_evidence')) return;
      body.tools = [];
      incoming.bytes = Buffer.from(JSON.stringify(body));
    },
    (phase) => phases.push(phase)
  );
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runCommittedObservedKill(f.adapter));
  assert.equal(phases.at(-1), 230);
  assert.equal(f.state.stopped, 2);
  assert.equal(f.state.closed, 1);
  assert.doesNotMatch(JSON.stringify(phases), /PRIVATE/);
});

test('synthetic public recovery output supports JSON and complete Responses SSE encoding', async () => {
  const {
    encodeContextRecoveryClientWire,
  } = require('../../lib/proxy/context-recovery-client-wire');
  const { decodeContextRecoveryResponse } = require('../../lib/proxy/context-recovery-protocol');
  let checked = 0;
  const f = fixture((at, response) => {
    if (at !== 'reply' || !response.output[0]?.content?.[0]?.text?.startsWith('N09_RECOVERY_OK '))
      return;
    for (const stream of [false, true]) {
      const encoded = encodeContextRecoveryClientWire(
        'responses',
        response,
        [response.usage],
        stream
      );
      const decoded = decodeContextRecoveryResponse('responses', encoded.wire, stream);
      assert.deepEqual(JSON.parse(JSON.stringify(decoded.output)), response.output);
    }
    checked++;
  });
  f.adapter.bindVerifiedNetworkProof(f.proof);
  try {
    await runCommittedObservedKill(f.adapter);
    assert.equal(checked, 1);
  } finally {
    await f.adapter.close();
  }
});
test('seed observer separates HTTP completion, protocol validation and metadata snapshot without removing work', async () => {
  const phases = [],
    f = fixture(undefined, (phase) => phases.push(phase));
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const owner = await f.adapter.startFreshBusinessHost();
  const result = await f.adapter.seedThroughBusinessHttp(owner);
  assert.deepEqual(phases, [109, 110, 111, 131, 132, 133, 134, 135, 136, 137, 138]);
  assert.equal(f.state.sent, 3);
  assert.equal(result.rootId, f.state.rootId);
  await f.adapter.killOwnedJob(owner);
  await f.adapter.close();
  assert.equal(f.state.stopped, 1);
  assert.equal(f.state.closed, 1);
});

test('every seed observer failure remains fixed and retains forced owned cleanup', async () => {
  for (let rejected = 131; rejected <= 138; rejected++) {
    const phases = [],
      f = fixture(undefined, (phase) => {
        phases.push(phase);
        if (phase === rejected) throw new Error('PRIVATE_SENTINEL');
      });
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const owner = await f.adapter.startFreshBusinessHost();
    await assert.rejects(f.adapter.seedThroughBusinessHttp(owner), bad);
    assert.equal(phases.at(-1), rejected);
    await f.adapter.killOwnedJob(owner);
    await f.adapter.close();
    assert.equal(f.state.stopped, 1);
    assert.equal(f.state.closed, 1);
  }
});

test('business startup observer reports only fixed phases and propagates to lifecycle', async () => {
  const f = fixture();
  const phases = [];
  const onPhase = (phase) => phases.push(phase);
  const adapter = createN09BusinessAdapter(f.options, {
    ...f.trusted,
    onPhase,
    createLifecycle(input, dependencies) {
      assert.equal(dependencies.onPhase, onPhase);
      return f.trusted.createLifecycle(input, dependencies);
    },
  });
  adapter.bindVerifiedNetworkProof(f.proof);
  await adapter.startFreshBusinessHost();
  assert.deepEqual(phases, [109, 110, 111]);
  assert.equal(f.state.configured, 1);
  await adapter.close();
  assert.equal(f.state.closed, 1);
});

test('business startup observer rejects invalid dependencies without executing proxies', () => {
  const f = fixture();
  let traps = 0;
  const proxy = new Proxy(() => {}, {
    get() {
      traps++;
      throw new Error('private');
    },
  });
  for (const onPhase of [null, 0, '', {}, proxy]) {
    assert.throws(() => createN09BusinessAdapter(f.options, { ...f.trusted, onPhase }), bad);
  }
  assert.equal(traps, 0);
  assert.equal(f.state.created, 0);
});

test('business startup observer failures are sanitized and retain owned cleanup at each phase', async () => {
  for (const rejected of [109, 110, 111]) {
    const f = fixture();
    const phases = [];
    const adapter = createN09BusinessAdapter(f.options, {
      ...f.trusted,
      onPhase(phase) {
        phases.push(phase);
        if (phase === rejected) throw new Error('PRIVATE_OBSERVER_SENTINEL');
      },
    });
    adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(adapter.startFreshBusinessHost(), bad);
    assert.deepEqual(
      phases,
      [109, 110, 111].filter((phase) => phase <= rejected)
    );
    await adapter.close();
    assert.equal(f.state.closed, rejected === 109 ? 0 : 1);
  }
});

test('passive construction and branded proof gate prevent premature spawn/HTTP', async () => {
  const f = fixture();
  assert.equal(f.state.created, 0);
  assert.equal(f.state.sent, 0);
  await assert.rejects(f.adapter.startFreshBusinessHost(), bad);
  assert.throws(() => f.adapter.bindVerifiedNetworkProof({ pure: true }), bad);
  f.adapter.bindVerifiedNetworkProof(f.proof);
  assert.throws(() => f.adapter.bindVerifiedNetworkProof(f.proof), bad);
  await f.adapter.close();
});

for (const operation of ['save', 'revoke']) {
  test(`signed ${operation} path integrates business driver and kills before draining pending HTTP`, async () => {
    const f = fixture();
    assert.equal(typeof f.adapter.existingHostDurableAckCapability(operation), 'function');
    assert.equal(f.state.created, 0);
    assert.equal(f.state.sent, 0);
    f.state.holdSave = operation === 'save';
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const result = await runDurableSaveOrRevokeAfterAck(f.adapter, operation);
    assert.equal(result.adapterDurableAckObserved, true);
    assert.equal(result.liveDaemonProved, false);
    assert.equal(result.n09Complete, false);
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.stopped, 2);
    const ackIndex = f.state.events.indexOf('ack');
    assert.equal(f.state.events[ackIndex + 1], 'kill');
    assert.equal(f.state.nativeReadObserved, operation === 'save' ? 3 : 1);
    if (operation === 'save') {
      assert.ok(f.state.events.indexOf('armed') < f.state.events.indexOf('http-pending'));
    } else {
      assert.equal(f.state.sent, 9); // seed 3 + initial read 1 + denied 5; no revoke HTTP
      assert.equal(f.state.events.includes('armed'), false);
    }
  });
}

test('invalid final durable ACK fails driver and still terminates pending business work', async () => {
  const f = fixture((at, receipt) => {
    if (at === 'ack') receipt.pid = 999;
  });
  f.state.holdSave = true;
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'save'), {
    message: 'n09_ack_kill_failed',
  });
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.stopped, 1);
});

test('business response failure before final ACK cannot be hidden by receipt polling', async () => {
  const f = fixture((at, value, state) => {
    if (
      at === 'reply' &&
      state.ackCommand &&
      value.output[0]?.content?.[0]?.text?.startsWith('N09_RECOVERY_OK')
    )
      value.status = 'failed';
  });
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'save'), {
    message: 'n09_ack_kill_failed',
  });
  assert.equal(f.state.events.includes('ack'), false);
  assert.equal(f.state.stopped, 1);
  assert.equal(f.state.closed, 1);
});

test('passively acquired ACK callable sanitizes late precondition failures', async () => {
  const f = fixture((at, _value, state) => {
    if (at === 'snapshot' && state.rejectSnapshot) throw new Error('PRIVATE_precondition');
  });
  const capability = f.adapter.existingHostDurableAckCapability('save');
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const owner = await f.adapter.startFreshBusinessHost();
  await f.adapter.seedThroughBusinessHttp(owner);
  await f.adapter.readThroughBusinessHttp(owner);
  f.state.rejectSnapshot = true;
  await assert.rejects(capability(owner), bad);
  assert.equal(f.state.events.includes('submit'), false);
  await f.adapter.close();
});
test('full pure committed-observed orchestration verifies READ sha, receipt binding and no original replay', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const result = await runCommittedObservedKill(f.adapter);
  assert.equal(result.sequence, 'committed-observed-kill');
  assert.equal(result.liveDaemonProved, false);
  assert.equal(f.state.nativeReadObserved, 1);
  assert.equal(f.state.configured, 1);
  assert.equal(f.state.stopped, 2);
  assert.equal(f.state.closed, 1);
  const observed = f.adapter.inspectBusinessEvidence();
  assert.equal(observed.seeded, true);
  assert.equal(observed.validatedReadCount, 1);
  assert.equal(observed.publicGenerationCount, 1);
  assert.equal(observed.clearAckCount, 0);
  assert.equal(observed.externalToolExecutions, 1);
});
test('existing clear ACK driver reuses actual business methods and four policy combinations', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const result = await runClearAfterAck(f.adapter);
  assert.equal(result.adapterClearBoundaryObserved, true);
  assert.equal(result.liveDaemonProved, false);
  assert.equal(f.state.nativeReadObserved, 1);
  assert.equal(f.state.cleared, true);
  assert.equal(f.state.configured, 1);
  assert.equal(f.state.closed, 1);
  const observed = f.adapter.inspectBusinessEvidence();
  assert.equal(observed.seeded, true);
  assert.equal(observed.validatedReadCount, 1);
  assert.equal(observed.publicGenerationCount, 1);
  assert.equal(observed.clearAckCount, 1);
  assert.equal(observed.externalToolExecutions, 1);
});
for (const fault of [
  'authorization',
  'list-digest',
  'read-sha',
  'read-source',
  'read-empty',
  'read-range',
  'public-missing',
  'public-tool',
]) {
  test(`reject ${fault} with fixed error and owned cleanup`, async () => {
    const f = fixture((at, value) => {
      if (fault === 'authorization' && at === 'upstream') value.authorization = 'Bearer PRIVATE';
      if (fault === 'list-digest' && at === 'list') value.digest = '0'.repeat(64);
      if (fault === 'read-sha' && at === 'read') value.page.text = 'PRIVATE';
      if (fault === 'read-source' && at === 'read') value.source.sourceId = 'hce_' + 'f'.repeat(32);
      if (fault === 'read-empty' && at === 'read') value.page.text = '';
      if (fault === 'read-range' && at === 'read')
        value.page.endOffsetBytes = Number.MAX_SAFE_INTEGER;
      if (fault === 'public-missing' && at === 'public') value.input = [];
      if (
        fault === 'public-tool' &&
        at === 'reply' &&
        value.output[0]?.content?.[0]?.text?.startsWith('N09_RECOVERY_OK')
      )
        value.output = [{ type: 'function_call', name: 'n09_original' }];
    });
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runCommittedObservedKill(f.adapter), {
      message: 'n09_committed_observed_kill_failed',
    });
    assert.equal(f.state.closed, 1);
  });
}
test('constructor and identity getters/proxies do not run', async () => {
  const f = fixture();
  let traps = 0;
  assert.throws(
    () =>
      createN09BusinessAdapter({
        ...f.options,
        get install() {
          traps++;
          return f.options.install;
        },
      }),
    bad
  );
  assert.throws(
    () =>
      createN09BusinessAdapter(f.options, {
        get spawn() {
          traps++;
          return () => {};
        },
      }),
    bad
  );
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const identity = await f.adapter.startFreshBusinessHost();
  assert.throws(
    () =>
      f.adapter.readCommittedSnapshot(
        new Proxy(identity, {
          get() {
            traps++;
            return undefined;
          },
        })
      ),
    bad
  );
  assert.equal(traps, 0);
  await f.adapter.close();
});
test('upstream oversized, invalid UTF8 and invalid JSON fail without response writes', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await f.adapter.startFreshBusinessHost();
  for (const bytes of [Buffer.alloc(262145), Buffer.from([255]), Buffer.from('{')]) {
    const response = {
      destroyed: false,
      headersSent: false,
      writeHead() {
        throw new Error('unexpected-write');
      },
      end() {},
    };
    await assert.rejects(
      f.adapter.onBusinessRequest({
        path: '/v1/responses',
        authorization: 'Bearer ' + f.state.config.upstreamKey,
        bytes,
        response,
      }),
      bad
    );
  }
  await f.adapter.close();
});

test('N09 rejected tool-result HTTP status retains fixed classification and owned cleanup', async () => {
  for (const [status, expected] of [
    [400, 162],
    [401, 163],
    [403, 164],
    [409, 165],
    [413, 166],
    [429, 167],
    [500, 168],
    [502, 169],
    [503, 170],
    [504, 171],
    [418, 172],
  ]) {
    const phases = [];
    const f = fixture(
      (kind, _value, state) => {
        if (kind === 'reply' && state.sent === 2) state.replyStatus = status;
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const owner = await f.adapter.startFreshBusinessHost();
    await assert.rejects(f.adapter.seedThroughBusinessHttp(owner), bad);
    assert.equal(phases.at(-1), status === 502 ? 211 : expected);
    assert.equal(f.state.sent, 2);
    await f.adapter.killOwnedJob(owner);
    await f.adapter.close();
    assert.equal(f.state.stopped, 1);
    assert.equal(f.state.closed, 1);
  }
});

test('N09 restarted recovery HTTP refusal reports its fixed status and never retries business', async () => {
  for (const [status, expected] of [
    [401, 163],
    [403, 164],
    [502, 169],
    [503, 170],
    [504, 171],
  ]) {
    const phases = [];
    const f = fixture(
      (kind, _value, state) => {
        if (kind === 'reply' && state.sent === 4) state.replyStatus = status;
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runCommittedObservedKill(f.adapter),
      /^Error: n09_committed_observed_kill_failed$/
    );
    assert.equal(phases.at(-1), status === 502 ? 216 : expected);
    assert.equal(f.state.sent, 4);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
  }
});

test('N09 502 progress distinguishes every recovery boundary without retry or content disclosure', async () => {
  for (let after = 0; after <= 4; after++) {
    const phases = [];
    const f = fixture(undefined, (phase) => phases.push(phase));
    f.state.refuseAfter = after;
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runCommittedObservedKill(f.adapter),
      /^Error: n09_committed_observed_kill_failed$/
    );
    assert.deepEqual(phases.slice(-2), [169, 212 + after]);
    assert.equal(f.state.sent, 4);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
  }
});

test('synthetic upstream failures expose only their fixed request, index, page or public boundary and retain cleanup', async () => {
  for (const expected of [196, 197, 203, 231]) {
    const phases = [];
    const f = fixture(
      (kind, incoming, state) => {
        if (kind !== 'upstream' || state.sent !== 4) return;
        const body = JSON.parse(incoming.bytes);
        if (expected === 196) body.instructions = 'PRIVATE_INVALID';
        if (expected === 197 || expected === 203) {
          const prefix = expected === 197 ? 'n09_list_' : 'n09_read_';
          const item = body.input.find(
            (value) => value.type === 'function_call_output' && value.call_id.startsWith(prefix)
          );
          if (item) {
            const value = JSON.parse(item.output);
            if (expected === 197) value.sources = [];
            else value.page.text = 'PRIVATE_INVALID';
            item.output = JSON.stringify(value);
          }
        }
        if (
          expected === 231 &&
          !body.tools.some((tool) => tool.name === 'hpm_list_retained_evidence')
        )
          body.input = [{ role: 'user', content: 'PRIVATE_INVALID' }];
        incoming.bytes = Buffer.from(JSON.stringify(body));
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runCommittedObservedKill(f.adapter),
      /^Error: n09_committed_observed_kill_failed$/
    );
    assert.equal(phases.at(-1), expected);
    assert.equal(f.state.sent, 4);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
    assert.equal(JSON.stringify(phases).includes('PRIVATE'), false);
  }
});

test('restart index must preserve the exact authenticated source receipt, including scoped call ID and expiry', async () => {
  for (const key of [
    'sourceId',
    'callId',
    'expiresAt',
    'argumentsDigest',
    'digest',
    'bytes',
    'toolName',
  ]) {
    const phases = [];
    const f = fixture(
      (kind, incoming, state) => {
        if (kind !== 'upstream' || state.sent !== 4) return;
        const body = JSON.parse(incoming.bytes);
        const item = body.input.find(
          (value) => value.type === 'function_call_output' && value.call_id.startsWith('n09_list_')
        );
        if (!item) return;
        const value = JSON.parse(item.output);
        const source = value.sources[0];
        if (key === 'expiresAt' || key === 'bytes') source[key]++;
        else if (key === 'callId') source[key] = state.originalCallId;
        else if (key === 'sourceId') source[key] = 'hce_' + 'd'.repeat(32);
        else if (key === 'toolName') source[key] = 'other';
        else source[key] = 'd'.repeat(64);
        item.output = JSON.stringify(value);
        incoming.bytes = Buffer.from(JSON.stringify(body));
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runCommittedObservedKill(f.adapter),
      /^Error: n09_committed_observed_kill_failed$/
    );
    assert.equal(phases.at(-1), 197, key);
    assert.equal(f.state.sent, 4);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
  }
});

test('read refusal diagnostics distinguish fixed error categories, malformed envelopes and valid partial pages without exposing replies', async () => {
  for (const [expected, error] of [
    [201],
    [203],
    [205],
    [206, 'context_evidence_unavailable'],
    [206, 'context_recovery_storage_unavailable'],
    [207, 'context_artifact_budget_exceeded'],
    [207, 'evidence_read_budget_exceeded'],
    [208, 'context_artifact_invalid_range'],
    [209, 'PRIVATE_INVALID'],
  ]) {
    const phases = [];
    const f = fixture(
      (kind, incoming, state) => {
        if (kind !== 'upstream' || state.sent !== 4) return;
        const body = JSON.parse(incoming.bytes);
        const item = body.input.find(
          (value) => value.type === 'function_call_output' && value.call_id.startsWith('n09_read_')
        );
        if (!item) return;
        const value = JSON.parse(item.output);
        if (expected === 203) delete value.page.chunkDigest;
        if (expected === 205) {
          value.page.text = value.page.text.slice(0, 10);
          value.page.endOffsetBytes = 10;
          value.page.nextOffsetBytes = 10;
          value.page.chunkDigest = sha(value.page.text);
        }
        item.output =
          expected === 201
            ? 'PRIVATE_INVALID'
            : JSON.stringify(error ? { ok: false, error } : value);
        incoming.bytes = Buffer.from(JSON.stringify(body));
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runCommittedObservedKill(f.adapter),
      /^Error: n09_committed_observed_kill_failed$/
    );
    assert.equal(phases.at(-1), expected);
    assert.equal(f.state.sent, 4);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
    assert.equal(JSON.stringify(phases).includes('PRIVATE'), false);
  }
});
