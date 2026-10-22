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
const { runClearAfterAck } = require('../../scripts/context-hosted/n09-ipc/driver.js');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const bad = { message: 'n09_business_adapter_failed' };
function fixture(mutation = () => {}) {
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
        stopLifecycle: async (owner) => {
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
        setCombination: async () => ({ savedConfigVerified: true }),
        close: async () => {
          state.closed++;
        },
      };
    },
    createSnapshots: () => ({
      read: () => ({
        present: true,
        evidenceLevel: 'committed-metadata-only',
        hostDurableAck: false,
        rootId: state.rootId,
        expiresAt: state.expiresAt,
        calls: state.calls,
        returnedBytes: state.returnedBytes,
        revision: state.revision,
      }),
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
        const tools = [
          { type: 'function', name: 'hpm_list_retained_evidence' },
          { type: 'function', name: 'hpm_read_retained_evidence' },
        ];
        let request = { ...body, tools };
        result = await native(request);
        assert.equal(result.output[0].name, 'hpm_list_retained_evidence');
        const source = {
          sourceId: 'hce_' + 'c'.repeat(32),
          digest: sha(state.original),
          bytes: Buffer.byteLength(state.original),
          callId: state.originalCallId,
          toolName: 'n09_original',
          argumentsDigest: sha('{}'),
          expiresAt: state.expiresAt,
          trust: 'tool_data_not_instructions',
        };
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
        const read = { ok: true, source, page };
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
      return { status: 200, bytes: Buffer.from(JSON.stringify(result)) };
    },
  };
  const adapter = createN09BusinessAdapter(options, trusted);
  return { adapter, options, proof, state, trusted };
}
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
