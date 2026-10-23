'use strict';
// Pure in-memory store: no worker, filesystem, native helper or model request.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContextRecoverySessions,
  attachContextRecoveryStorage,
  acquireContextRecoveryRoot,
} = require('../lib/proxy/context-recovery-sessions');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const entered = deferred(),
    hold = deferred(),
    records = new Map();
  let delayed = true,
    rejectSave = false;
  const store = {
    execute(q) {
      if (q.operation === 'catalog') return [];
      if (q.operation === 'load') return globalThis.structuredClone(records.get(q.scope) ?? null);
      if (q.operation !== 'save') throw Error('synthetic_operation_rejected');
      const commit = () => {
        if (rejectSave) throw Error('PRIVATE_SENTINEL');
        const revision = q.expectedRevision + 1;
        records.set(q.scope, {
          revision,
          createdAt: 100,
          expiresAt: q.expiresAt,
          state: globalThis.structuredClone(q.state),
        });
        return { revision };
      };
      if (delayed) {
        entered.resolve();
        return hold.promise.then(commit);
      }
      return commit();
    },
  };
  const runtime = createContextRecoverySessions({ now: () => 100 });
  runtime.configure(true);
  attachContextRecoveryStorage(runtime, store);
  const u = { role: 'user', content: 'synthetic' },
    call = { type: 'function_call', name: 'lookup', call_id: 'external', arguments: '{}' };
  const binding = { principal: 'owner', protocol: 'responses', target: 'target' };
  const first = runtime.begin({ ...binding, history: [u] });
  const publication = first.completeObservedAsync(
    [call],
    [{ callId: 'external', toolName: 'lookup', arguments: {}, completed: true, output: '' }],
    'root-response'
  );
  return {
    runtime,
    first,
    entered,
    publication,
    input: {
      ...binding,
      history: [
        u,
        call,
        { type: 'function_call_output', call_id: 'external', output: 'synthetic tool result' },
      ],
    },
    results: [{ callId: 'external', output: 'synthetic tool result' }],
    release(fail = false) {
      rejectSave = fail;
      delayed = false;
      hold.resolve();
    },
    async close() {
      delayed = false;
      hold.resolve();
      await publication;
      await runtime.closeAsync();
    },
  };
}
for (const outcome of ['success', 'revoked', 'storage-failed']) {
  test('continuation waits for its observed publication: ' + outcome, async () => {
    const f = fixture();
    let allowed = true,
      settled = false;
    try {
      await f.entered.promise;
      const next = f.runtime
        .beginAsync(f.input, f.results, () => allowed)
        .then((value) => {
          settled = true;
          return value;
        });
      await tick();
      assert.equal(settled, false, 'response observation must finish before same-root admission');
      if (outcome === 'revoked') allowed = false;
      f.release(outcome === 'storage-failed');
      const result = await next;
      assert.equal(result.ok, outcome === 'success');
      if (!result.ok) assert.equal(result.code, 'context_recovery_storage_unavailable');
      assert.equal((await f.publication).ok, outcome !== 'storage-failed');
    } finally {
      await f.close();
    }
  });
}
test('unrelated principal can start while another observed publication is pending', async () => {
  const f = fixture();
  try {
    await f.entered.promise;
    const other = await f.runtime.beginAsync(
      { ...f.input, principal: 'other', history: [{ role: 'user', content: 'independent' }] },
      [],
      () => true
    );
    assert.equal(other.ok, true);
  } finally {
    await f.close();
  }
});

test('active recovery ownership still rejects admission as busy without retry', async () => {
  const f = fixture();
  let lease;
  try {
    await f.entered.promise;
    f.release();
    await f.publication;
    lease = acquireContextRecoveryRoot(f.runtime, f.first.snapshotId);
    const result = await f.runtime.beginAsync(f.input, f.results, () => true);
    assert.deepEqual(result, { ok: false, code: 'context_recovery_busy' });
  } finally {
    lease?.release();
    await f.close();
  }
});
