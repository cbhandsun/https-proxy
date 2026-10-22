'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { selectContextBinding } = require('../lib/proxy/context-binding-selection');
const {
  createContextBindingRegistry,
  exportContextBindingRegistry,
  restoreContextBindingRegistry,
  probeContextBindingRegistry,
} = require('../lib/proxy/context-binding');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
  probeContextRecoveryRoots,
  adoptContextRecoveryRoots,
} = require('../lib/proxy/context-recovery-sessions');

const user = (content) => ({ role: 'user', content });
const answer = (content = 'answer') => ({ role: 'assistant', id: 'msg_' + content, content });
const request = (history = [user('question')], extra = {}) => ({
  principal: 'owner',
  protocol: 'responses',
  target: 'target',
  history,
  ...extra,
});
function fixture(history = [user('question')], { now = () => 100, registry } = {}) {
  registry ??= createContextBindingRegistry({ now });
  const input = request(history);
  const root = registry.begin(input);
  assert.equal(registry.commit(root.token, [answer()], 'response').ok, true);
  const next = request([...history, answer(), user('continue')]);
  return { registry, input, root, next };
}
function candidate(f, now = () => 100) {
  return restoreContextBindingRegistry(
    { binding: f.input, now },
    exportContextBindingRegistry(f.registry, f.root.snapshotId)
  ).registry;
}
function sessionFixture(history = [user('question')], now = () => 100) {
  const sessions = createContextRecoverySessions({ now });
  sessions.configure(true);
  const input = request(history);
  const root = sessions.begin(input);
  assert.equal(root.complete([answer()], [], 'response').ok, true);
  return {
    sessions,
    root,
    input,
    next: request([...history, answer(), user('continue')]),
    state: exportContextRecoveryRoot(sessions, root.snapshotId),
  };
}
const wrapper = (f) => ({ binding: f.input, state: f.state });

test('Claude retained receipts prefer only unique observed descendants and reject conflicts', () => {
  const receipt = 'hcs1_' + 'a'.repeat(48) + '_' + 'b'.repeat(64) + '_1';
  const data = {
    protocol: 'claude',
    scope: 'scope',
    previousResponseId: receipt,
    prefixes: ['new-window'],
  };
  const root = { id: 'summary', parentId: null, publishedFrontier: 'summary-window' };
  const child = { id: 'child', parentId: root.id, publishedFrontier: 'new-window' };
  const unrelated = { id: 'other', parentId: null, publishedFrontier: 'other-window' };
  const snapshots = new Map([root, child, unrelated].map((item) => [item.id, item]));
  const key = createHash('sha256')
    .update('scope\0' + receipt)
    .digest('hex');
  const responses = new Map([[key, new Set([root.id])]]);
  const select = (ids, overrides = {}) =>
    selectContextBinding(
      data,
      {
        snapshots,
        responses,
        windows: new Map(ids === null ? [] : [['new-window', new Set(ids)]]),
        ...overrides,
      },
      false
    );
  assert.equal(select(null).parent, root);
  assert.equal(select([root.id]).observedSummaryDescendant, false);
  assert.equal(select([child.id]).parent, child);
  assert.equal(select([child.id]).observedSummaryDescendant, true);
  for (const ids of [[unrelated.id], [child.id, unrelated.id], [child.id, root.id]])
    assert.equal(select(ids).code, 'context_binding_conflict');
  assert.equal(
    select([child.id], { responses: new Map() }).code,
    'context_binding_previous_unavailable'
  );
  assert.equal(
    select([child.id], { responses: new Map([[key, new Set([root.id, unrelated.id])]]) }).code,
    'context_binding_conflict'
  );
});

test('joint binding probe selects offline candidates without claims, import or pending quota expenditure', () => {
  const target = fixture([user('online')], {
    registry: createContextBindingRegistry({ now: () => 100, maxSnapshots: 2 }),
  });
  const offline = fixture();
  const restored = candidate(offline);
  try {
    const pending = target.registry.begin(target.next);
    const before = target.registry.inspect();
    for (let index = 0; index < 20; index++) {
      const result = probeContextBindingRegistry(target.registry, offline.next, [restored]);
      assert.equal(result.reason, 'observed_continuation');
      assert.equal(result.rootSnapshotId, offline.root.snapshotId);
      assert.equal(result.parentSnapshotId, offline.root.snapshotId);
      assert.deepEqual(Object.keys(result).sort(), [
        'ok',
        'parentSnapshotId',
        'policyFingerprint',
        'reason',
        'rootSnapshotId',
      ]);
    }
    assert.deepEqual(target.registry.inspect(), before);
    assert.equal(target.registry.begin(target.next).code, 'context_binding_quota');
    assert.equal(target.registry.rollback(pending.token), true);
    assert.equal(target.registry.begin(target.next).parentSnapshotId, target.root.snapshotId);
    assert.equal(restored.inspect().snapshots, 1);
  } finally {
    target.registry.close();
    offline.registry.close();
    restored.close();
  }
});

test('online/offline and offline/offline equal anchors stay ambiguous; explicit conflicting aliases do not bypass ambiguity', () => {
  const target = fixture();
  const offline = fixture();
  const other = fixture();
  const empty = createContextBindingRegistry({ now: () => 100 });
  const restored = candidate(offline),
    second = candidate(other);
  try {
    for (const [registry, sources] of [
      [target.registry, [restored]],
      [empty, [restored, second]],
    ]) {
      const result = probeContextBindingRegistry(registry, offline.next, sources);
      assert.equal(result.reason, 'ambiguous_continuation');
      assert.equal(result.parentSnapshotId, null);
      assert.equal(result.rootSnapshotId, null);
    }
    const uniqueAlias = fixture();
    const unique = uniqueAlias.registry.begin(request([user('alias-only')]));
    assert.equal(
      uniqueAlias.registry.commit(unique.token, [answer('distinct')], 'unique').ok,
      true
    );
    assert.equal(
      probeContextBindingRegistry(
        uniqueAlias.registry,
        {
          ...offline.next,
          previousResponseId: 'unique',
        },
        [restored]
      ).code,
      'context_binding_conflict'
    );
    uniqueAlias.registry.close();
    assert.equal(target.registry.inspect().snapshots, 1);
    assert.equal(empty.inspect().snapshots, 0);
  } finally {
    target.registry.close();
    offline.registry.close();
    other.registry.close();
    empty.close();
    restored.close();
    second.close();
  }
});

test('longest observed frontier wins jointly and ambiguous deeper frontiers never fall back to an online ancestor', () => {
  const target = fixture();
  const history = [...target.input.history, answer(), user('extra')];
  const offline = fixture(history);
  const other = fixture(history);
  const restored = candidate(offline),
    second = candidate(other);
  try {
    assert.equal(
      probeContextBindingRegistry(target.registry, offline.next, [restored]).rootSnapshotId,
      offline.root.snapshotId
    );
    const ambiguous = probeContextBindingRegistry(target.registry, offline.next, [
      restored,
      second,
    ]);
    assert.equal(ambiguous.reason, 'ambiguous_continuation');
    assert.equal(ambiguous.parentSnapshotId, null);
    assert.equal(target.registry.begin(target.next).parentSnapshotId, target.root.snapshotId);
  } finally {
    target.registry.close();
    offline.registry.close();
    other.registry.close();
    restored.close();
    second.close();
  }
});

test('scope, explicit ID and compaction policies use the same selector as actual begin', () => {
  const policy = { instructions: 'same', tools: [{ name: 'lookup' }] };
  const f = fixture();
  const empty = createContextBindingRegistry({ now: () => 100 });
  const restored = candidate(f);
  try {
    for (const extra of [
      { principal: 'other' },
      { protocol: 'chat' },
      { target: 'other' },
      { policy },
    ])
      assert.equal(
        probeContextBindingRegistry(empty, { ...f.next, ...extra }, [restored]).reason,
        'isolated_request'
      );
    assert.equal(
      probeContextBindingRegistry(empty, { ...f.next, previousResponseId: 'missing' }, [restored])
        .code,
      'context_binding_previous_unavailable'
    );
    const withPolicy = f.registry.begin(request([user('policy')], { policy }));
    assert.equal(f.registry.commit(withPolicy.token, [answer('policy')]).ok, true);
    const compact = request([user('policy'), answer('policy')], {
      policy: { instructions: 'same' },
    });
    const probe = probeContextBindingRegistry(f.registry, compact, [], true);
    const actual = f.registry.beginCompaction(compact);
    assert.equal(probe.parentSnapshotId, actual.parentSnapshotId);
    assert.equal(probe.policyFingerprint, actual.policyFingerprint);
    assert.equal(probe.reason, 'observed_continuation');
    assert.equal(
      probeContextBindingRegistry(f.registry, { ...compact, protocol: 'chat' }, [], true).code,
      'context_binding_compaction_unsupported'
    );
  } finally {
    f.registry.close();
    empty.close();
    restored.close();
  }
});

test('probe rejects raw lookups, duplicate candidates and executable containers without invoking getters', () => {
  const f = fixture();
  const restored = candidate(f);
  let ran = 0;
  try {
    const getter = [];
    Object.defineProperty(getter, '0', {
      enumerable: true,
      get() {
        ran++;
        return restored;
      },
    });
    const error = { code: 'invalid_context_binding_state' };
    for (const sources of [
      null,
      {},
      [{}],
      [f.registry],
      [restored, restored],
      new Array(1),
      getter,
      new Array(5).fill(restored),
    ])
      assert.throws(() => probeContextBindingRegistry(f.registry, f.next, sources), error);
    assert.throws(() => probeContextBindingRegistry(f.registry, f.next, [restored]), error);
    assert.throws(() => probeContextBindingRegistry({}, f.next), error);
    assert.throws(() => probeContextBindingRegistry(f.registry, f.next, [], 1), error);
    assert.equal(
      probeContextBindingRegistry(f.registry, {
        get history() {
          ran++;
          return [];
        },
      }).code,
      'invalid_context_binding'
    );
    assert.equal(ran, 0);
    f.registry.close();
    assert.equal(
      probeContextBindingRegistry(f.registry, f.next).code,
      'context_binding_unavailable'
    );
  } finally {
    f.registry.close();
    restored.close();
  }
});

test('owner-level selection validates complete candidates but never adopts roots, spends budget or changes online/pending state', () => {
  const online = sessionFixture([user('online')]);
  const offline = sessionFixture();
  try {
    const pending = online.sessions.begin(online.next);
    const before = online.sessions.inspect();
    const root = exportContextRecoveryRoot(online.sessions, online.state.rootId);
    const result = probeContextRecoveryRoots(online.sessions, offline.next, [wrapper(offline)]);
    assert.equal(result.location, 'offline');
    assert.equal(result.rootId, offline.state.rootId);
    assert.equal(result.reason, 'observed_continuation');
    assert.deepEqual(online.sessions.inspect(), before);
    assert.deepEqual(exportContextRecoveryRoot(online.sessions, online.state.rootId), root);
    assert.equal(pending.complete([answer('pending')]).ok, true);
    assert.throws(() => exportContextRecoveryRoot(online.sessions, offline.state.rootId), {
      code: 'invalid_context_recovery_root_state',
    });
    adoptContextRecoveryRoots(online.sessions, [wrapper(offline)]);
    const selected = probeContextRecoveryRoots(online.sessions, offline.next);
    assert.equal(selected.location, 'online');
    assert.equal(selected.rootId, offline.state.rootId);
    assert.equal(online.sessions.begin(offline.next).reason, 'observed_continuation');
  } finally {
    online.sessions.close();
    offline.sessions.close();
  }
});

test('owner-level ambiguity, malformed association, expiry and revocation cannot publish candidate authority', () => {
  const online = sessionFixture();
  const offline = sessionFixture();
  try {
    const before = online.sessions.inspect();
    const selected = probeContextRecoveryRoots(online.sessions, offline.next, [wrapper(offline)]);
    assert.equal(selected.reason, 'ambiguous_continuation');
    assert.equal(selected.location, null);
    assert.deepEqual(online.sessions.inspect(), before);
    const corrupt = globalThis.structuredClone(wrapper(offline));
    corrupt.state.snapshots[0].calls.push({ callId: 'invalid' });
    assert.throws(() => probeContextRecoveryRoots(online.sessions, offline.next, [corrupt]), {
      code: 'invalid_context_recovery_root_state',
    });
    assert.throws(() => probeContextRecoveryRoots({}, offline.next), {
      code: 'invalid_context_recovery_root_state',
    });
    const expired = createContextRecoverySessions({ now: () => offline.state.expiresAt });
    expired.configure(true);
    assert.equal(
      probeContextRecoveryRoots(expired, offline.next, [wrapper(offline)]).reason,
      'isolated_request'
    );
    assert.equal(expired.inspect().roots, 0);
    expired.close();
    let armed = false;
    const target = createContextRecoverySessions({
      now: () => {
        if (armed) {
          armed = false;
          target.revoke('owner');
        }
        return 100;
      },
    });
    target.configure(true);
    armed = true;
    assert.throws(() => probeContextRecoveryRoots(target, offline.next, [wrapper(offline)]), {
      code: 'invalid_context_recovery_root_state',
    });
    assert.equal(target.inspect().roots, 0);
    target.close();
  } finally {
    online.sessions.close();
    offline.sessions.close();
  }
});
