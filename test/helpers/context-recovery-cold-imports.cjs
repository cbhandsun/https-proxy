'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const cold = new Set([
  'context-recovery-coordinator',
  'context-recovery-turn',
  'context-recovery-tool-catalog',
  'context-recovery-hosted-output',
  'context-recovery-root-checkpoint',
  'context-recovery-root-reader',
  'context-recovery-root-storage',
  'context-recovery-storage-startup',
  'context-recovery-root-publication',
  'context-recovery-root-adoption',
  'context-recovery-root-selection',
  'context-recovery-root-loading',
  'context-recovery-root-state',
]);
const original = Module._load;
const loaded = [];
const mode = process.argv[2];
let failedLoads = 0;
Module._load = function (request, parent) {
  const name = path.basename(request).replace(/\.js$/, '');
  if (cold.has(name)) {
    if (mode === 'memory') throw Error('cold_module_on_memory_path');
    if (mode === 'coordinatorFailure' && name === 'context-recovery-coordinator') {
      failedLoads++;
      throw Error('PRIVATE_COORDINATOR_LOAD_FAILURE');
    }
    if (mode === 'failure' && name === 'context-recovery-root-loading') {
      failedLoads++;
      throw Error('PRIVATE_MODULE_LOAD_FAILURE');
    }
    if (!require.cache[Module._resolveFilename(request, parent)]) loaded.push(name);
  }
  return original.apply(this, arguments);
};

async function main() {
  assert.equal(process.argv.length, 3);
  assert.ok(['memory', 'admission', 'export', 'failure', 'coordinatorFailure'].includes(mode));
  const api = require('../../lib/proxy/context-recovery-sessions');
  assert.deepEqual(loaded, []);
  const sessions = api.createContextRecoverySessions({ now: () => 1000 });
  const request = {
    principal: 'owner',
    protocol: 'chat',
    target: 'target',
    history: [{ role: 'user', content: 'q' }],
  };
  assert.deepEqual(await sessions.beginAsync(null, [], null), {
    ok: false,
    code: 'context_recovery_storage_unavailable',
  });
  assert.deepEqual(loaded, []);
  assert.throws(() => api.exportContextRecoveryRoot({}, 'missing'), {
    code: 'invalid_context_recovery_root_state',
  });
  assert.deepEqual(loaded, []);
  assert.deepEqual(await sessions.configureAsync(true), { ok: true });
  assert.deepEqual(loaded, []);
  if (mode === 'memory' || mode === 'coordinatorFailure') {
    const {
      LIST_EVIDENCE_TOOL: LIST,
      READ_EVIDENCE_TOOL: READ,
    } = require('../../lib/proxy/context-evidence-tools');
    const tool = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'external', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    };
    const first = sessions.begin(request);
    assert.equal(
      first.complete(
        [tool],
        [{ callId: 'external', toolName: 'lookup', arguments: {}, output: '', completed: true }],
        'first'
      ).ok,
      true
    );
    const text = 'synthetic original 🙂\r\nexact';
    const next = sessions.begin(
      {
        ...request,
        history: [
          ...request.history,
          tool,
          { role: 'tool', tool_call_id: 'external', content: text },
        ],
      },
      [{ callId: 'external', output: text }]
    );
    const source = JSON.parse(next.reply(LIST, {}).text).sources[0];
    assert.equal(
      JSON.parse(next.reply(READ, { sourceId: source.sourceId, digest: source.digest }).text).page
        .text,
      text
    );
    if (mode === 'coordinatorFailure') {
      const before = next.inspect().readers;
      assert.deepEqual(
        next.recovery({
          model: 'fixture',
          messages: [
            ...request.history,
            tool,
            { role: 'tool', tool_call_id: 'external', content: text },
          ],
          tools: [{ type: 'function', function: { name: 'lookup' } }],
        }),
        {
          ok: false,
          code: 'context_recovery_request_unsupported',
        }
      );
      assert.equal(failedLoads, 1);
      assert.deepEqual(next.inspect().readers, before);
      next.abort();
      assert.deepEqual(await sessions.shutdownAsync(), { ok: true });
      process.stdout.write('cold_boundary_verified');
      return;
    }
    assert.equal(
      (await next.completeObservedAsync([{ role: 'assistant', content: 'done' }], [])).ok,
      true
    );
    assert.deepEqual(await sessions.revokeAsync('owner'), { ok: true });
    assert.deepEqual(await sessions.configureAsync(false), { ok: true });
    assert.deepEqual(await sessions.shutdownAsync(), { ok: true });
  } else if (mode === 'admission') {
    for (let index = 0; index < 2; index++) {
      const next = await sessions.beginAsync(
        { ...request, history: [{ role: 'user', content: 'q-' + index }] },
        [],
        () => true
      );
      assert.equal(next.ok, true);
      assert.equal(next.complete([{ role: 'assistant', content: 'done' }], []).ok, true);
    }
    assert.equal(loaded.filter((name) => name === 'context-recovery-root-loading').length, 1);
    for (const name of [
      'context-recovery-root-reader',
      'context-recovery-root-storage',
      'context-recovery-root-publication',
      'context-recovery-storage-startup',
    ])
      assert.equal(loaded.includes(name), false);
    assert.deepEqual(await sessions.shutdownAsync(), { ok: true });
  } else if (mode === 'export') {
    const first = sessions.begin(request);
    assert.equal(first.complete([{ role: 'assistant', content: 'done' }], [], 'response').ok, true);
    const state = api.exportContextRecoveryRoot(sessions, first.snapshotId);
    assert.equal(state.version, 10);
    assert.equal(state.expiresAt, 86401000);
    const restored = api.restoreContextRecoverySessions({ now: () => 1000 }, [
      { binding: request, state },
    ]);
    assert.equal(api.exportContextRecoveryRoot(restored, state.rootId).expiresAt, state.expiresAt);
    assert.equal(loaded.filter((name) => name === 'context-recovery-root-state').length, 1);
    assert.deepEqual(await restored.shutdownAsync(), { ok: true });
    assert.deepEqual(await sessions.shutdownAsync(), { ok: true });
  } else {
    const unavailable = { ok: false, code: 'context_recovery_storage_unavailable' };
    assert.deepEqual(await sessions.beginAsync(request, [], () => true), unavailable);
    assert.equal(sessions.inspect().closed, true);
    assert.equal(sessions.inspect().roots, 0);
    assert.deepEqual(await sessions.beginAsync(request, [], () => true), unavailable);
    assert.deepEqual(await sessions.configureAsync(true), unavailable);
    assert.deepEqual(await sessions.shutdownAsync(), unavailable);
    assert.equal(failedLoads, 1);
  }
  if (mode === 'memory') assert.deepEqual(loaded, []);
  process.stdout.write('cold_boundary_verified');
}
main()
  .catch(() => {
    process.stderr.write('cold_import_fixture_failed');
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = original;
  });
