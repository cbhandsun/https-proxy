'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createContextHistoryMap,
  exportContextHistoryMap,
  restoreContextHistoryMap,
  restoreContextHistoryRoots,
} = require('../lib/proxy/context-history-map');
const {
  createContextBindingRegistry,
  exportContextBindingRegistry,
  restoreContextBindingRegistry,
  restoreContextBindingRoots,
} = require('../lib/proxy/context-binding');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');

const plain = (value) => JSON.parse(JSON.stringify(value));
const historyFailure = { code: 'invalid_context_history_state' };
const bindingFailure = { code: 'invalid_context_binding_state' };
const user = (content) => ({ role: 'user', content });
const answer = (content, id = 'msg_answer') => ({ role: 'assistant', content, id });
const scope = (protocol = 'chat', principal = 'owner') => ({
  principal,
  protocol,
  target: 'target',
  policy: 'policy',
});
const binding = (history = [user('public_sensitive_marker')], extra = {}) => ({
  principal: 'owner',
  protocol: 'responses',
  target: 'target',
  history,
  policy: { instructions: 'policy' },
  ...extra,
});
const hidden = (protocol, id, text = '私有原文🙂\r\n') =>
  protocol === 'chat'
    ? [
        {
          role: 'assistant',
          tool_calls: [
            {
              id,
              type: 'function',
              function: { name: 'hpm_read_retained_evidence', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: id, content: text },
      ]
    : protocol === 'responses'
      ? [
          {
            type: 'function_call',
            call_id: id,
            name: 'hpm_read_retained_evidence',
            arguments: '{}',
          },
          { type: 'function_call_output', call_id: id, output: text },
        ]
      : [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'opaque', signature: 'synthetic-signature' },
              { type: 'tool_use', id, name: 'hpm_read_retained_evidence', input: {} },
            ],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
        ];
function commitHistory(map, currentScope, parent, history, id, text) {
  const staged = map.prepare({
    scope: currentScope,
    ...(parent ? { parent } : {}),
    clientHistory: history,
    hiddenTail: hidden(currentScope.protocol, id, text),
  });
  assert.equal(staged.ok, true);
  const result = map.commit(staged.token, [answer('done')]);
  assert.equal(result.ok, true);
  return result.snapshot;
}
function bindingFixture() {
  let time = 100;
  const options = { now: () => time };
  const registry = createContextBindingRegistry(options);
  const input = binding();
  const root = registry.begin(input);
  assert.equal(registry.commit(root.token, [answer('root')], 'root-response').ok, true);
  return {
    registry,
    root,
    input,
    options,
    setTime(value) {
      time = value;
    },
  };
}

for (const protocol of ['chat', 'responses', 'claude'])
  test(
    protocol + ': committed private history roundtrip uses fresh tokens and exact exchanges',
    () => {
      let time = 100;
      const currentScope = scope(protocol);
      const map = createContextHistoryMap({ now: () => time });
      let restored;
      try {
        const initial = [user('public_sensitive_marker')];
        const root = commitHistory(map, currentScope, null, initial, 'root');
        const state = exportContextHistoryMap(map, currentScope, [root]);
        assert.doesNotMatch(JSON.stringify(state), /public_sensitive_marker/);
        time = 200;
        restored = restoreContextHistoryMap({ scope: currentScope, now: () => time }, plain(state));
        const token = restored.snapshots.get(state.tips[0]);
        assert.notEqual(token, root);
        const history = [...initial, answer('done'), user('next')];
        assert.deepEqual(
          plain(
            restored.historyMap.rebuild({
              scope: currentScope,
              snapshot: token,
              clientHistory: history,
            }).history
          ),
          [...initial, ...hidden(protocol, 'root'), answer('done'), user('next')]
        );
        for (const forged of [root, state.tips[0], {}, plain(token)])
          assert.equal(
            restored.historyMap.rebuild({
              scope: currentScope,
              snapshot: forged,
              clientHistory: history,
            }).ok,
            false
          );
        const second = commitHistory(restored.historyMap, currentScope, token, history, 'second');
        const saved = exportContextHistoryMap(restored.historyMap, currentScope, [second]);
        assert.equal(saved.entries.length, 2);
        assert.equal(saved.entries[1].expiresAt, state.entries[0].expiresAt);
        state.entries[0].tail[0].role = 'system';
        assert.equal(
          restored.historyMap.rebuild({
            scope: currentScope,
            snapshot: token,
            clientHistory: history,
          }).ok,
          true
        );
      } finally {
        restored?.historyMap.close();
        map.close();
      }
    }
  );

test('history exports omit unrelated branches and refuse pending, discarded, foreign and closed capabilities', () => {
  const map = createContextHistoryMap();
  try {
    const initial = [user('first')],
      currentScope = scope();
    const root = commitHistory(map, currentScope, null, initial, 'root');
    const history = [...initial, answer('done'), user('next')];
    const left = commitHistory(map, currentScope, root, history, 'left', 'left-only');
    const right = commitHistory(map, currentScope, root, history, 'right', 'right-only');
    const selected = exportContextHistoryMap(map, currentScope, [left]);
    assert.equal(selected.entries.length, 2);
    assert.doesNotMatch(JSON.stringify(selected), /right-only/);
    const pending = map.prepare({
      scope: currentScope,
      clientHistory: [],
      hiddenTail: hidden('chat', 'pending'),
    });
    assert.throws(
      () => exportContextHistoryMap(map, currentScope, [pending.token]),
      historyFailure
    );
    assert.throws(
      () => exportContextHistoryMap(map, scope('chat', 'foreign'), [root]),
      historyFailure
    );
    map.discard(root);
    for (const token of [root, left, right])
      assert.throws(() => exportContextHistoryMap(map, currentScope, [token]), historyFailure);
    map.close();
    assert.throws(() => exportContextHistoryMap(map, currentScope, []), historyFailure);
    assert.throws(() => exportContextHistoryMap({}, currentScope, []), historyFailure);
  } finally {
    map.close();
  }
});

test('restored history preserves sibling and owner isolation, revocation, expiry and the monotonic clock', () => {
  let time = 100;
  const map = createContextHistoryMap({ now: () => time });
  let restored;
  try {
    const initial = [user('first')],
      currentScope = scope();
    const root = commitHistory(map, currentScope, null, initial, 'root');
    const history = [...initial, answer('done'), user('next')];
    const left = commitHistory(map, currentScope, root, history, 'left', 'left-only');
    const right = commitHistory(map, currentScope, root, history, 'right', 'right-only');
    const state = exportContextHistoryMap(map, currentScope, [left, right]);
    restored = restoreContextHistoryMap({ scope: currentScope, now: () => time }, state);
    for (const [index, included, excluded] of [
      [0, 'left-only', 'right-only'],
      [1, 'right-only', 'left-only'],
    ]) {
      const result = restored.historyMap.rebuild({
        scope: currentScope,
        snapshot: restored.snapshots.get(state.tips[index]),
        clientHistory: [...history, answer('done')],
      });
      assert.equal(result.ok, true);
      assert.match(JSON.stringify(result.history), new RegExp(included));
      assert.doesNotMatch(JSON.stringify(result.history), new RegExp(excluded));
    }
    for (const key of ['principal', 'target', 'policy', 'protocol'])
      assert.throws(
        () =>
          restoreContextHistoryMap(
            { scope: { ...currentScope, [key]: key === 'protocol' ? 'responses' : 'foreign' } },
            state
          ),
        historyFailure
      );
    restored.historyMap.revoke(currentScope);
    assert.equal(
      restored.historyMap.rebuild({
        scope: currentScope,
        snapshot: restored.snapshots.get(state.tips[0]),
        clientHistory: [...history, answer('done')],
      }).ok,
      false
    );
    restored.historyMap.close();
    time = state.entries[0].expiresAt;
    restored = restoreContextHistoryMap({ scope: currentScope, now: () => time }, state);
    assert.equal(restored.snapshots.size, 0);
    assert.equal(restored.historyMap.inspect().entries, 0);
    restored.historyMap.close();
    time = 99;
    assert.throws(
      () => restoreContextHistoryMap({ scope: currentScope, now: () => time }, state),
      historyFailure
    );
    assert.throws(
      () =>
        restoreContextHistoryMap(
          {
            scope: currentScope,
            now: () => {
              throw new Error('secret');
            },
          },
          state
        ),
      historyFailure
    );
  } finally {
    restored?.historyMap.close();
    map.close();
  }
});

test('malformed history states reject unsafe tails, orphan chains, inconsistent bytes and unreachable extras', () => {
  const map = createContextHistoryMap({ now: () => 100 });
  try {
    const root = commitHistory(map, scope(), null, [user('first')], 'root');
    const original = plain(exportContextHistoryMap(map, scope(), [root]));
    const mutations = [
      (s) => {
        s.version = 2;
      },
      (s) => {
        s.kind = 'foreign';
      },
      (s) => {
        s.owner = '0'.repeat(64);
      },
      (s) => {
        s.observedAt = -1;
      },
      (s) => {
        s.entries[0].id = 'forged';
      },
      (s) => {
        s.entries[0].parentId = s.entries[0].id;
      },
      (s) => {
        s.entries[0].createdAt++;
      },
      (s) => {
        s.entries[0].expiresAt++;
      },
      (s) => {
        s.entries[0].offset = -1;
      },
      (s) => {
        s.entries[0].prefix = [];
      },
      (s) => {
        s.entries[0].prefix[0] = 'not-a-hash';
      },
      (s) => {
        s.entries[0].bytes++;
      },
      (s) => {
        s.entries[0].tail[0].role = 'system';
      },
      (s) => {
        s.entries[0].tail[0].tool_calls[0].function.name = 'external';
      },
      (s) => {
        s.entries[0].tail.pop();
      },
      (s) => {
        s.entries[0].tail[1].tool_call_id = 'orphan';
      },
      (s) => {
        s.tips = [];
      },
      (s) => {
        s.tips = ['hph_' + 'f'.repeat(32)];
      },
      (s) => {
        s.entries.push(plain(s.entries[0]));
      },
      (s) => {
        s.extra = 'secret';
      },
    ];
    for (const mutate of mutations) {
      const state = plain(original);
      mutate(state);
      assert.throws(
        () => restoreContextHistoryMap({ scope: scope(), now: () => 100 }, state),
        historyFailure
      );
    }
    for (const state of [
      null,
      [],
      {},
      { ...original, entries: new Array(257).fill(original.entries[0]) },
    ])
      assert.throws(() => restoreContextHistoryMap({ scope: scope() }, state), historyFailure);
    assert.equal(
      map.rebuild({
        scope: scope(),
        snapshot: root,
        clientHistory: [user('first'), answer('done')],
      }).ok,
      true
    );
  } finally {
    map.close();
  }
});

test('history restore validates child ancestry, exact prefix continuity and complete private tool pairs', () => {
  const map = createContextHistoryMap({ now: () => 100 });
  try {
    const root = commitHistory(map, scope(), null, [user('first')], 'root');
    const child = commitHistory(
      map,
      scope(),
      root,
      [user('first'), answer('done'), user('second')],
      'child'
    );
    const original = plain(exportContextHistoryMap(map, scope(), [child]));
    for (const mutate of [
      (s) => {
        s.entries[1].prefix[0] = '0'.repeat(64);
      },
      (s) => {
        s.entries[1].offset = 0;
      },
      (s) => {
        s.entries[1].expiresAt--;
      },
      (s) => {
        s.entries[1].tail[0].tool_calls[0].function.name = 'external-tool';
      },
      (s) => {
        s.entries[1].tail[1].tool_call_id = 'orphan';
      },
      (s) => {
        s.entries[1].tail.pop();
      },
      (s) => {
        s.entries[1].tail[0].tool_calls[0].id = 'root';
        s.entries[1].tail[1].tool_call_id = 'root';
      },
    ]) {
      const state = plain(original);
      mutate(state);
      // Keep the envelope consistent so rejection actually exercises ancestry
      // and tool-pair validation instead of stopping at a stale byte count.
      for (const entry of state.entries)
        entry.bytes =
          Buffer.byteLength(JSON.stringify(entry.tail)) + entry.prefix.length * 64 + 256;
      assert.throws(
        () => restoreContextHistoryMap({ scope: scope(), now: () => 100 }, state),
        historyFailure
      );
    }
    const extras = plain(original);
    const unused = { ...plain(extras.entries[0]), id: 'hph_' + 'a'.repeat(32) };
    extras.entries.push(unused);
    assert.throws(
      () => restoreContextHistoryMap({ scope: scope(), now: () => 100 }, extras),
      historyFailure
    );
  } finally {
    map.close();
  }
});

test('history restore rejects executable data and enforces global quotas across restored roots', () => {
  const map = createContextHistoryMap({ now: () => 100 });
  let restored,
    invoked = 0;
  try {
    const roots = [];
    for (const principal of ['one', 'two']) {
      const currentScope = scope('chat', principal);
      const token = commitHistory(
        map,
        currentScope,
        null,
        [],
        'private-' + principal,
        'x'.repeat(1100000)
      );
      roots.push({
        scope: currentScope,
        state: exportContextHistoryMap(map, currentScope, [token]),
      });
    }
    restored = restoreContextHistoryRoots({ now: () => 100 }, roots);
    assert.equal(restored.historyMap.inspect().entries, 2);
    const first = restored.snapshots.get(roots[0].state.tips[0]);
    assert.equal(
      restored.historyMap.rebuild({
        scope: roots[1].scope,
        snapshot: first,
        clientHistory: [answer('done')],
      }).ok,
      false
    );
    const extra = restored.historyMap.prepare({
      scope: scope(),
      clientHistory: [],
      hiddenTail: hidden('chat', 'extra', 'x'.repeat(2000000)),
    });
    assert.equal(extra.code, 'context_history_quota');
    const another = createContextHistoryMap({ now: () => 100 });
    try {
      const more = [];
      for (const principal of ['three', 'four']) {
        const currentScope = scope('chat', principal);
        const token = commitHistory(
          another,
          currentScope,
          null,
          [],
          'private-' + principal,
          'x'.repeat(1100000)
        );
        more.push({
          scope: currentScope,
          state: exportContextHistoryMap(another, currentScope, [token]),
        });
      }
      assert.throws(
        () => restoreContextHistoryRoots({ now: () => 100 }, [...roots, ...more]),
        historyFailure
      );
    } finally {
      another.close();
    }
    assert.throws(
      () => restoreContextHistoryRoots({ now: () => 100 }, [roots[0], roots[0]]),
      historyFailure
    );
    assert.throws(
      () => restoreContextHistoryRoots({}, new Array(5).fill(roots[0])),
      historyFailure
    );
    const accessor = Object.defineProperty(plain(roots[0].state), 'entries', {
      enumerable: true,
      get() {
        invoked++;
        return [];
      },
    });
    assert.throws(
      () => restoreContextHistoryMap({ scope: roots[0].scope }, accessor),
      historyFailure
    );
    assert.throws(
      () =>
        restoreContextHistoryMap(
          {
            get scope() {
              invoked++;
              return scope();
            },
          },
          roots[0].state
        ),
      historyFailure
    );
    const tokens = [];
    Object.defineProperty(tokens, '0', {
      enumerable: true,
      get() {
        invoked++;
        return first;
      },
    });
    assert.throws(
      () => exportContextHistoryMap(restored.historyMap, roots[0].scope, tokens),
      historyFailure
    );
    assert.equal(invoked, 0);
  } finally {
    restored?.historyMap.close();
    map.close();
  }
});

test('binding root restore preserves full-window, explicit-response, sibling and withdrawal semantics', () => {
  const f = bindingFixture();
  let restored;
  try {
    const left = f.registry.begin(binding([user('left')], { previousResponseId: 'root-response' }));
    f.registry.commit(left.token, [answer('left', 'left-anchor')], 'left-response');
    const right = f.registry.begin(
      binding([user('right')], { previousResponseId: 'root-response' })
    );
    f.registry.commit(right.token, [answer('right', 'right-anchor')], 'right-response');
    const pending = f.registry.begin(
      binding([user('pending')], { previousResponseId: 'left-response' })
    );
    const state = exportContextBindingRegistry(f.registry, f.root.snapshotId);
    assert.equal(state.snapshots.length, 3);
    assert.doesNotMatch(
      JSON.stringify(state),
      /public_sensitive_marker|left-response|right-response/
    );
    restored = restoreContextBindingRegistry({ binding: f.input, ...f.options }, state);
    assert.notEqual(restored.snapshots.get(f.root.snapshotId), f.root.token);
    assert.equal(restored.registry.ancestors(f.root.token).ok, false);
    assert.equal(restored.registry.ancestors(pending.token).ok, false);
    const next = restored.registry.begin(
      binding([...f.input.history, answer('root'), user('next')])
    );
    assert.equal(next.parentSnapshotId, f.root.snapshotId);
    const child = restored.registry.begin(
      binding([user('child')], { previousResponseId: 'left-response' })
    );
    assert.deepEqual(restored.registry.ancestors(child.token).snapshotIds, [
      left.snapshotId,
      f.root.snapshotId,
    ]);
    restored.registry.rollback(child.token);
    assert.deepEqual(restored.registry.withdraw(restored.snapshots.get(left.snapshotId)), [
      left.snapshotId,
    ]);
    assert.equal(
      restored.registry.begin(binding([user('again')], { previousResponseId: 'left-response' }))
        .code,
      'context_binding_previous_unavailable'
    );
    assert.equal(
      restored.registry.begin(binding([user('again')], { previousResponseId: 'right-response' }))
        .parentSnapshotId,
      right.snapshotId
    );
  } finally {
    restored?.registry.close();
    f.registry.close();
  }
});

test('native compaction and plain-text identity rules survive binding export and restore unchanged', () => {
  const f = bindingFixture();
  let restored;
  try {
    const full = [...f.input.history, answer('root')];
    const compact = f.registry.beginCompaction(binding(full));
    const canonical = [
      { type: 'compaction', encrypted_content: 'opaque-synthetic-bytes' },
      { role: 'assistant', content: 'retained' },
    ];
    assert.equal(f.registry.commitCompaction(compact.token, canonical).ok, true);
    const state = exportContextBindingRegistry(f.registry, f.root.snapshotId);
    restored = restoreContextBindingRegistry({ binding: f.input, ...f.options }, state);
    const next = restored.registry.begin(binding([...canonical, user('next')]));
    assert.equal(next.parentSnapshotId, compact.snapshotId);
    const plain = restored.registry.begin(
      binding([user('short')], { previousResponseId: 'root-response' })
    );
    assert.equal(
      restored.registry.commit(plain.token, [{ role: 'assistant', content: 'plain-only' }]).ok,
      true
    );
    assert.equal(
      restored.registry.begin(
        binding([user('short'), { role: 'assistant', content: 'plain-only' }])
      ).parentSnapshotId,
      null
    );
    assert.deepEqual(canonical[0], {
      type: 'compaction',
      encrypted_content: 'opaque-synthetic-bytes',
    });
  } finally {
    restored?.registry.close();
    f.registry.close();
  }
});

test('multiple restored binding roots preserve ambiguity and do not reset the global snapshot quota', () => {
  const f = bindingFixture();
  let restored;
  try {
    const other = f.registry.begin(f.input);
    f.registry.commit(other.token, [answer('root')], 'root-response');
    const roots = [f.root, other].map((root) => ({
      binding: f.input,
      state: exportContextBindingRegistry(f.registry, root.snapshotId),
    }));
    restored = restoreContextBindingRoots({ ...f.options, maxSnapshots: 3 }, roots);
    const ambiguous = restored.registry.begin(binding([...f.input.history, answer('root')]));
    assert.equal(ambiguous.reason, 'ambiguous_continuation');
    assert.equal(ambiguous.parentSnapshotId, null);
    assert.equal(restored.registry.begin(f.input).code, 'context_binding_quota');
    assert.throws(() => restoreContextBindingRoots({ maxSnapshots: 1 }, roots), bindingFailure);
    assert.throws(() => restoreContextBindingRoots({}, [roots[0], roots[0]]), bindingFailure);
    assert.throws(
      () => restoreContextBindingRoots({}, new Array(5).fill(roots[0])),
      bindingFailure
    );
  } finally {
    restored?.registry.close();
    f.registry.close();
  }
});

test('binding restore checks current policy and ownership, never detaches expired roots or renews TTL', () => {
  const f = bindingFixture();
  let restored;
  try {
    f.setTime(200);
    const child = f.registry.begin(
      binding([user('child')], { previousResponseId: 'root-response' })
    );
    f.registry.commit(child.token, [answer('child')], 'child-response');
    const state = exportContextBindingRegistry(f.registry, f.root.snapshotId);
    for (const current of [
      { ...f.input, principal: 'foreign' },
      { ...f.input, target: 'foreign' },
      { ...f.input, protocol: 'chat' },
      { ...f.input, policy: { instructions: 'changed' } },
    ])
      assert.throws(
        () => restoreContextBindingRegistry({ binding: current }, state),
        bindingFailure
      );
    f.setTime(state.snapshots[0].expiresAt);
    restored = restoreContextBindingRegistry({ binding: f.input, ...f.options }, state);
    assert.equal(restored.snapshots.size, 0);
    assert.equal(
      restored.registry.begin(binding([user('next')], { previousResponseId: 'child-response' }))
        .code,
      'context_binding_previous_unavailable'
    );
    restored.registry.close();
    f.setTime(199);
    assert.throws(
      () => restoreContextBindingRegistry({ binding: f.input, ...f.options }, state),
      bindingFailure
    );
    assert.throws(
      () => restoreContextBindingRegistry({ binding: f.input, now: null }, state),
      bindingFailure
    );
  } finally {
    restored?.registry.close();
    f.registry.close();
  }
});

test('binding restore rejects malformed fingerprints, pending state, cycles, unknown fields and executable input', () => {
  const f = bindingFixture();
  let invoked = 0;
  try {
    const original = plain(exportContextBindingRegistry(f.registry, f.root.snapshotId));
    const mutations = [
      (s) => {
        s.version++;
      },
      (s) => {
        s.rootId = 'forged';
      },
      (s) => {
        s.snapshots = [];
      },
      (s) => {
        s.snapshots[0].committed = false;
      },
      (s) => {
        s.snapshots[0].parentId = s.rootId;
      },
      (s) => {
        s.snapshots[0].frontier = 'bad';
      },
      (s) => {
        s.snapshots[0].publishedContinuityFrontier = null;
      },
      (s) => {
        s.snapshots[0].scope = '0'.repeat(64);
      },
      (s) => {
        s.snapshots[0].protocol = 'claude';
      },
      (s) => {
        s.snapshots[0].responseKey = 'bad';
      },
      (s) => {
        s.snapshots[0].count = -1;
      },
      (s) => {
        s.snapshots[0].bytes = 0;
      },
      (s) => {
        s.snapshots[0].createdAt++;
      },
      (s) => {
        s.snapshots[0].expiresAt++;
      },
      (s) => {
        s.snapshots[0].anchoredPrefix = true;
      },
      (s) => {
        s.snapshots[0].extra = true;
      },
      (s) => {
        s.snapshots.push(plain(s.snapshots[0]));
      },
    ];
    for (const mutate of mutations) {
      const state = plain(original);
      mutate(state);
      assert.throws(
        () => restoreContextBindingRegistry({ binding: f.input, ...f.options }, state),
        bindingFailure
      );
    }
    const accessor = Object.defineProperty(plain(original), 'snapshots', {
      enumerable: true,
      get() {
        invoked++;
        return [];
      },
    });
    assert.throws(
      () => restoreContextBindingRegistry({ binding: f.input }, accessor),
      bindingFailure
    );
    assert.throws(
      () =>
        restoreContextBindingRegistry(
          {
            get binding() {
              invoked++;
              return f.input;
            },
          },
          original
        ),
      bindingFailure
    );
    assert.equal(invoked, 0);
    assert.throws(() => exportContextBindingRegistry({}, f.root.snapshotId), bindingFailure);
    f.registry.close();
    assert.throws(
      () => exportContextBindingRegistry(f.registry, f.root.snapshotId),
      bindingFailure
    );
  } finally {
    f.registry.close();
  }
});

test('empty restore batches create empty registries and maps without manufacturing authority', () => {
  const bindings = restoreContextBindingRoots({}, []);
  const histories = restoreContextHistoryRoots({}, []);
  try {
    assert.equal(bindings.snapshots.size, 0);
    assert.equal(bindings.registry.inspect().snapshots, 0);
    assert.equal(histories.snapshots.size, 0);
    assert.equal(histories.historyMap.inspect().entries, 0);
    assert.equal(
      histories.historyMap.rebuild({
        scope: scope(),
        snapshot: 'hph_' + 'a'.repeat(32),
        clientHistory: [],
      }).ok,
      false
    );
  } finally {
    bindings.registry.close();
    histories.historyMap.close();
  }
});

test(
  'actual encrypted worker reopen restores committed binding and private-history capabilities together',
  { timeout: 120000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-branch-state-test-'));
    const registry = createContextBindingRegistry();
    const map = createContextHistoryMap();
    const input = binding();
    const currentScope = scope('responses');
    const root = registry.begin(input);
    registry.commit(root.token, [answer('done')], 'root-response');
    const token = commitHistory(map, currentScope, null, input.history, 'private');
    let storage, restoredBinding, restoredHistory;
    try {
      if (process.platform !== 'win32') {
        await assert.rejects(
          openContextRecoveryStorage({ directory: path.join(directory, 'context') }),
          { code: 'context_recovery_storage_unavailable' }
        );
        return;
      }
      const state = {
        binding: exportContextBindingRegistry(registry, root.snapshotId),
        history: exportContextHistoryMap(map, currentScope, [token]),
      };
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'context') });
      const storeScope = 'd'.repeat(64);
      await storage.execute({
        operation: 'save',
        scope: storeScope,
        expectedRevision: 0,
        expiresAt: Date.now() + 120000,
        state,
      });
      registry.close();
      map.close();
      await storage.close();
      storage = undefined;
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'context') });
      const saved = (await storage.execute({ operation: 'load', scope: storeScope })).state;
      restoredBinding = restoreContextBindingRegistry({ binding: input }, saved.binding);
      restoredHistory = restoreContextHistoryMap({ scope: currentScope }, saved.history);
      const history = [...input.history, answer('done'), user('next')];
      assert.equal(
        restoredBinding.registry.begin(binding(history)).parentSnapshotId,
        root.snapshotId
      );
      assert.equal(restoredBinding.registry.ancestors(root.token).ok, false);
      const result = restoredHistory.historyMap.rebuild({
        scope: currentScope,
        snapshot: restoredHistory.snapshots.get(saved.history.tips[0]),
        clientHistory: history,
      });
      assert.deepEqual(plain(result.history), [
        ...input.history,
        ...hidden('responses', 'private'),
        answer('done'),
        user('next'),
      ]);
    } finally {
      registry.close();
      map.close();
      restoredBinding?.registry.close();
      restoredHistory?.historyMap.close();
      try {
        await storage?.close();
      } finally {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('hpm-branch-state-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
);
