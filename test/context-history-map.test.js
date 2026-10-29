'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContextHistoryMap,
  exportContextHistoryMap,
  restoreContextHistoryMap,
  restoreContextHistoryRoots,
} = require('../lib/proxy/context-history-map');
const { createContextBindingRegistry } = require('../lib/proxy/context-binding');
const {
  parsePublicWindow,
  publicWindowFrontiers,
  historyEntryBytes,
} = require('../lib/proxy/context-public-window');
const { createHash } = require('node:crypto');
const { normalizeRecoveryStateData } = require('../lib/proxy/context-recovery-state-data');
const { createContextRecoveryCoordinator } = require('../lib/proxy/context-recovery-coordinator');
const { fingerprintContextData } = require('../lib/proxy/context-recovery-fingerprint');
const {
  createContextEvidenceTools,
  LIST_EVIDENCE_TOOL: LIST,
} = require('../lib/proxy/context-evidence-tools');
const plain = (value) => JSON.parse(JSON.stringify(value));
const scope = { principal: 'a', protocol: 'chat', target: 'a', policy: 'a' };
const user = (content) => ({ role: 'user', content });
const answer = (content) => ({ role: 'assistant', content });
const hidden = (id, content) => [
  {
    role: 'assistant',
    tool_calls: [
      { id, type: 'function', function: { name: 'hpm_read_retained_evidence', arguments: '{}' } },
    ],
  },
  { role: 'tool', tool_call_id: id, content },
];
function commit(map, parent, history, tail, output = [answer('done')]) {
  const prepared = map.prepare({
    scope,
    ...(parent ? { parent } : {}),
    clientHistory: history,
    hiddenTail: tail,
  });
  assert.equal(prepared.ok, true);
  const result = map.commit(prepared.token, output);
  assert.equal(result.ok, true);
  return result.snapshot;
}

test('Responses public references preserve hosted/private positions once across commit, chained rebuild and restore', () => {
  const owner = { ...scope, protocol: 'responses' };
  const search = {
    type: 'web_search_call',
    id: 'search',
    status: 'completed',
    action: { type: 'search', query: 'owned' },
    opaque: ['exact🙂'],
  };
  const message = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'exact 中文' }],
  };
  const call = { type: 'function_call', call_id: 'private', name: LIST, arguments: '{}' };
  const result = { type: 'function_call_output', call_id: 'private', output: 'exact original' };
  const history = [user('owned')];
  const tail = [search, call, message, result];
  const output = [search, message];
  for (const windowed of [false, true]) {
    const map = createContextHistoryMap({ now: () => 100 });
    const seed = 'a'.repeat(64);
    const publicWindow = {
      scope: seed,
      frontier: publicWindowFrontiers(seed, history).at(-1),
      count: history.length,
      publishedFrontier: null,
    };
    const staged = map.prepare({
      scope: owner,
      clientHistory: history,
      hiddenTail: tail,
      publicReferences: [
        { historyIndex: 0, outputIndex: 0 },
        { historyIndex: 2, outputIndex: 1 },
      ],
      ...(windowed ? { publicWindow } : {}),
    });
    assert.equal(staged.ok, true);
    assert.equal(map.commit(staged.token, output).ok, true);
    const publicHistory = [...history, ...output, user('next')];
    assert.deepEqual(
      plain(
        map.rebuild({ scope: owner, snapshot: staged.token, clientHistory: publicHistory }).history
      ),
      [...history, ...tail, user('next')]
    );
    const state = exportContextHistoryMap(map, owner, [staged.token]);
    assert.equal(state.format, 3);
    assert.equal(JSON.stringify(state).includes('exact 中文'), false);
    assert.equal(state.entries[0].tail[0].digest, fingerprintContextData(search));
    const restored = restoreContextHistoryMap({ scope: owner, now: () => 101 }, state);
    const snapshot = restored.snapshots.get(state.tips[0]);
    assert.deepEqual(
      plain(
        restored.historyMap.rebuild({ scope: owner, snapshot, clientHistory: publicHistory })
          .history
      ),
      [...history, ...tail, user('next')]
    );
    const nextTail = [
      { ...call, call_id: 'next-private' },
      { ...result, call_id: 'next-private' },
    ];
    const next = restored.historyMap.prepare({
      scope: owner,
      parent: snapshot,
      clientHistory: publicHistory,
      hiddenTail: nextTail,
      ...(windowed
        ? {
            publicWindow: {
              ...publicWindow,
              count: publicHistory.length,
              frontier: publicWindowFrontiers(seed, publicHistory).at(-1),
            },
          }
        : {}),
    });
    assert.equal(next.ok, true);
    {
      assert.equal(restored.historyMap.commit(next.token, [message]).ok, true);
      assert.deepEqual(
        plain(
          restored.historyMap.rebuild({
            scope: owner,
            snapshot: next.token,
            clientHistory: [...publicHistory, message],
          }).history
        ),
        [...history, ...tail, user('next'), ...nextTail, message]
      );
    }
    const altered = plain(publicHistory);
    altered[1].opaque = ['tampered'];
    assert.equal(
      restored.historyMap.rebuild({ scope: owner, snapshot, clientHistory: altered }).ok,
      false
    );
    for (const mutate of [
      (state) => {
        state.format = 2;
      },
      (state) => {
        state.entries[0].tail[0].index = 2;
      },
      (state) => {
        state.entries[0].tail[0].digest = 'x';
      },
      (state) => {
        state.entries[0].tail[2].index = 0;
      },
    ]) {
      const bad = plain(state);
      mutate(bad);
      assert.throws(() => restoreContextHistoryMap({ scope: owner, now: () => 101 }, bad));
    }
    restored.historyMap.close();
    map.close();
  }
});

test('public references reject malformed, executable, duplicate, wrong-protocol and altered publication inputs', () => {
  const owner = { ...scope, protocol: 'responses' };
  const message = { type: 'message', role: 'assistant', content: [] };
  const tail = [
    { type: 'function_call', call_id: 'p', name: LIST, arguments: '{}' },
    message,
    { type: 'function_call_output', call_id: 'p', output: '' },
  ];
  const map = createContextHistoryMap({ now: () => 1 });
  let accessed = 0;
  const executable = {
    get historyIndex() {
      accessed++;
      return 1;
    },
    outputIndex: 0,
  };
  for (const publicReferences of [
    null,
    {},
    [null],
    [executable],
    [{ historyIndex: -1, outputIndex: 0 }],
    [{ historyIndex: 1, outputIndex: 128 }],
    [{ historyIndex: 0, outputIndex: 0 }],
    [{ historyIndex: 1, outputIndex: 0, extra: 1 }],
    Array(129).fill({ historyIndex: 1, outputIndex: 0 }),
    [
      { historyIndex: 1, outputIndex: 0 },
      { historyIndex: 1, outputIndex: 1 },
    ],
  ]) {
    assert.equal(
      map.prepare({ scope: owner, clientHistory: [], hiddenTail: tail, publicReferences }).ok,
      false
    );
  }
  assert.equal(accessed, 0);
  assert.equal(
    map.prepare({
      scope: owner,
      clientHistory: [],
      hiddenTail: [...tail, message],
      publicReferences: [
        { historyIndex: 1, outputIndex: 0 },
        { historyIndex: 3, outputIndex: 0 },
      ],
    }).ok,
    false
  );
  assert.equal(
    map.prepare({ scope, clientHistory: [], hiddenTail: hidden('a', ''), publicReferences: [] }).ok,
    false
  );
  for (const output of [[], [{ ...message, extra: true }]]) {
    const staged = map.prepare({
      scope: owner,
      clientHistory: [],
      hiddenTail: tail,
      publicReferences: [{ historyIndex: 1, outputIndex: 0 }],
    });
    assert.equal(staged.ok, true);
    assert.equal(map.commit(staged.token, output).ok, false);
  }
  assert.equal(map.inspect().entries, 0);
  map.close();
});

test('cumulative public window boundaries reject executable, malformed, extreme and unavailable metadata', () => {
  const owner = { ...scope, protocol: 'responses' };
  const tail = [
    { type: 'function_call', call_id: 'p', name: LIST, arguments: '{}' },
    { type: 'function_call_output', call_id: 'p', output: 'exact🙂\r\n' },
  ];
  const seed = 'a'.repeat(64);
  const valid = { scope: seed, frontier: seed, count: 0, publishedFrontier: null };
  let executed = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'frontier', {
    enumerable: true,
    get() {
      executed++;
      return seed;
    },
  });
  const invalid = [
    null,
    [],
    {},
    accessor,
    { ...valid, count: -1 },
    { ...valid, count: 16385 },
    { ...valid, count: Infinity },
    { ...valid, count: '0' },
    { ...valid, scope: 'x' },
    { ...valid, publishedFrontier: seed },
    { ...valid, extra: true },
  ];
  const map = createContextHistoryMap({ now: () => 100 });
  for (const publicWindow of invalid) {
    assert.throws(() => parsePublicWindow(publicWindow, false));
    assert.equal(
      map.prepare({ scope: owner, clientHistory: [], hiddenTail: tail, publicWindow }).ok,
      false
    );
  }
  assert.equal(executed, 0);
  assert.equal(map.inspect().entries, 0);
  const overflow = map.prepare({
    scope: owner,
    clientHistory: [],
    hiddenTail: tail,
    publicWindow: { ...valid, count: 16384 },
  });
  assert.equal(overflow.ok, true);
  assert.equal(map.commit(overflow.token, [answer('overflow')]).ok, false);
  assert.equal(map.inspect().entries, 0);
  const empty = map.prepare({
    scope: owner,
    clientHistory: [],
    hiddenTail: tail,
    publicWindow: valid,
  });
  assert.equal(empty.ok, true);
  const output = [{ type: 'message', role: 'assistant', id: 'm_empty', content: [] }];
  const committed = map.commit(empty.token, output);
  assert.equal(committed.ok, true);
  assert.deepEqual(
    plain(
      map.rebuild({ scope: owner, snapshot: committed.snapshot, clientHistory: output }).history
    ),
    [...tail, ...output]
  );
  assert.equal(
    map.rebuild({ scope: owner, snapshot: committed.snapshot, clientHistory: [] }).ok,
    false
  );
  const exported = exportContextHistoryMap(map, owner, [committed.snapshot]);
  assert.equal(exported.format, 2);
  assert.equal(
    exported.entries[0].window.publishedFrontier,
    publicWindowFrontiers(seed, output)[0]
  );
  const restored = restoreContextHistoryMap({ scope: owner, now: () => 101 }, exported);
  assert.deepEqual(
    plain(
      restored.historyMap.rebuild({
        scope: owner,
        snapshot: restored.snapshots.get(exported.tips[0]),
        clientHistory: output,
      }).history
    ),
    [...tail, ...output]
  );
  for (const mutated of [
    { ...plain(exported), format: 3 },
    { ...plain(exported), entries: [], tips: [] },
  ])
    assert.throws(() => restoreContextHistoryMap({ scope: owner, now: () => 101 }, mutated));
  const registry = createContextBindingRegistry({ now: () => 100 });
  assert.equal(registry.publicWindow({}), null);
  const bound = registry.begin({ principal: 'a', target: 'a', protocol: 'responses', history: [] });
  assert.equal(registry.publicWindow(bound.token).count, 0);
  assert.equal(registry.commit(bound.token, output, 'bound').ok, true);
  assert.equal(registry.publicWindow(bound.token), null);
  registry.close();
  restored.historyMap.close();
  map.close();
});

test('rebuild inserts exact hidden exchanges while preserving the public input and suffix', () => {
  const map = createContextHistoryMap();
  const tail = hidden('i1', '原文🙂');
  const snapshot = commit(map, null, [user('first')], tail);
  const client = [user('first'), answer('done'), user('next')];
  const result = map.rebuild({ scope, snapshot, clientHistory: client });
  assert.deepEqual(plain(result.history), [user('first'), ...tail, answer('done'), user('next')]);
  result.history[1].tool_calls[0].id = 'mutated';
  assert.equal(
    map.rebuild({ scope, snapshot, clientHistory: client }).history[1].tool_calls[0].id,
    'i1'
  );
  assert.deepEqual(client, [user('first'), answer('done'), user('next')]);
});

test('immutable sibling branches inherit only ancestor exchanges and never future sibling data', () => {
  const map = createContextHistoryMap();
  const initial = [user('first')];
  const root = commit(map, null, initial, hidden('root', 'common'));
  const history = [...initial, answer('done'), user('next')];
  const left = commit(map, root, history, hidden('left', 'only-left'));
  const right = commit(map, root, history, hidden('right', 'only-right'));
  for (const [snapshot, included, excluded] of [
    [left, 'only-left', 'only-right'],
    [right, 'only-right', 'only-left'],
  ]) {
    const rebuilt = map.rebuild({ scope, snapshot, clientHistory: [...history, answer('done')] });
    assert.equal(rebuilt.ok, true);
    assert.match(JSON.stringify(rebuilt.history), new RegExp(included));
    assert.doesNotMatch(JSON.stringify(rebuilt.history), new RegExp(excluded));
  }
});

test('scope changes, edited histories, missing output and forged tokens never inherit hidden state', () => {
  const map = createContextHistoryMap();
  const snapshot = commit(map, null, [user('a')], hidden('i', 'private'));
  for (const history of [[user('a')], [user('b'), answer('done')], []])
    assert.equal(map.rebuild({ scope, snapshot, clientHistory: history }).ok, false);
  for (const key of ['principal', 'protocol', 'target', 'policy']) {
    const foreign = { ...scope, [key]: key === 'protocol' ? 'responses' : 'other' };
    assert.equal(
      map.rebuild({ scope: foreign, snapshot, clientHistory: [user('a'), answer('done')] }).ok,
      false
    );
  }
  assert.equal(map.rebuild({ scope, snapshot: {}, clientHistory: [] }).ok, false);
  assert.equal(createContextHistoryMap().rebuild({ scope, snapshot, clientHistory: [] }).ok, false);
});

test('prepare and commit are distinct, abort releases reservations and double commit fails', () => {
  const map = createContextHistoryMap();
  const prepared = map.prepare({
    scope,
    clientHistory: [user('a')],
    hiddenTail: hidden('i', 'data'),
  });
  assert.equal(
    map.rebuild({ scope, snapshot: prepared.token, clientHistory: [user('a')] }).ok,
    false
  );
  assert.equal(map.commit(prepared.token, []).ok, false);
  assert.equal(map.inspect().entries, 0);
  const other = map.prepare({ scope, clientHistory: [], hiddenTail: hidden('i2', 'data') });
  map.abort(other.token);
  assert.equal(map.inspect().retainedBytes, 0);
  assert.equal(map.commit(other.token, [answer('done')]).ok, false);
  const token = commit(map, null, [], hidden('i3', 'data'));
  map.abort(token);
  assert.equal(map.inspect().entries, 1);
  assert.equal(map.commit(token, [answer('twice')]).ok, false);
});

test('expiry, revocation, backward clocks and close invalidate all dependent capabilities', () => {
  let time = 100;
  const map = createContextHistoryMap({ now: () => time });
  const root = commit(map, null, [], hidden('i', 'data'));
  time += 1000;
  const child = commit(map, root, [answer('done')], hidden('j', 'data'));
  time = 100 + 30 * 60 * 1000;
  assert.equal(
    map.rebuild({ scope, snapshot: child, clientHistory: [answer('done'), answer('done')] }).ok,
    false
  );
  assert.equal(map.inspect().retainedBytes, 0);
  time++;
  commit(map, null, [], hidden('k', 'data'));
  map.revoke(scope);
  assert.equal(map.inspect().entries, 0);
  commit(map, null, [], hidden('l', 'data'));
  time--;
  assert.equal(map.inspect().closed, true);
  assert.equal(map.inspect().retainedBytes, 0);
  map.close();
});

test('bounds, elevated roles, accessors and invalid scopes fail without preserving public content', () => {
  const map = createContextHistoryMap();
  const base = { scope, clientHistory: [user('a')], hiddenTail: hidden('i', 'data') };
  let invoked = false;
  for (const patch of [
    { scope: { ...scope, extra: 'bad' } },
    { hiddenTail: [] },
    { hiddenTail: [{ role: 'system', content: 'override' }] },
    { hiddenTail: [{ role: 'developer', content: 'override' }] },
    { hiddenTail: [answer('x'.repeat(2 * 1024 * 1024))] },
    {
      clientHistory: [
        {
          get role() {
            invoked = true;
            return 'user';
          },
        },
      ],
    },
    { clientHistory: Array.from({ length: 16385 }, () => user('x')) },
    { parent: {} },
  ])
    assert.equal(map.prepare({ ...base, ...patch }).ok, false);
  assert.equal(invoked, false);
  assert.equal(map.inspect().entries, 0);
  assert.throws(() => createContextHistoryMap({ now: 3 }));
  const bad = createContextHistoryMap({
    now: () => {
      throw new Error('secret');
    },
  });
  assert.equal(bad.prepare(base).ok, false);
  assert.doesNotMatch(JSON.stringify(bad.inspect()), /secret/);
});

test('versioned private history supports 100 recovery rounds without upgrading legacy chains', () => {
  const map = createContextHistoryMap({ now: () => 1000, ttlMs: 86400000, capacityVersion: 2 });
  const rootId = 'hbs_' + 'a'.repeat(32);
  let history = [user('owned')];
  let parent;
  for (let round = 0; round < 100; round++) {
    const prepared = map.prepare({
      scope,
      rootId,
      historyVersion: 3,
      clientHistory: history,
      hiddenTail: hidden('daily-' + round, 'exact-' + round),
      ...(parent ? { parent } : {}),
    });
    assert.equal(prepared.ok, true, 'daily recovery round ' + (round + 1));
    const result = map.commit(prepared.token, [answer('done-' + round)]);
    assert.equal(result.ok, true);
    parent = result.snapshot;
    history = [...history, answer('done-' + round), user('continue')];
  }
  const state = exportContextHistoryMap(map, scope, [parent]);
  assert.equal(state.version, 3);
  assert.equal(state.rootId, rootId);
  const restored = restoreContextHistoryMap({ scope, now: () => 2000 }, plain(state));
  const rebuilt = restored.historyMap.rebuild({
    scope,
    snapshot: restored.snapshots.get(state.tips[0]),
    clientHistory: history,
  });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.history.filter((item) => item.role === 'tool').length, 100);
  assert.deepEqual(
    rebuilt.history.filter((item) => item.role === 'tool').map((item) => item.content),
    Array.from({ length: 100 }, (_, index) => 'exact-' + index)
  );
  assert.equal(
    exportContextHistoryMap(restored.historyMap, scope, [restored.snapshots.get(state.tips[0])])
      .entries[0].expiresAt,
    86401000
  );
  restored.historyMap.close();
  map.close();
});

for (const protocol of ['chat', 'responses', 'claude']) {
  for (const version of [2, 3]) {
    test(`${protocol}: private v${version} call boundary survives refusal, restore and absolute expiry`, () => {
      let time = 1000;
      const map = createContextHistoryMap({ now: () => time, ttlMs: 86400000, capacityVersion: 2 });
      const owner = { ...scope, protocol };
      const rootId = 'hbs_' + 'b'.repeat(32);
      const maximum = version === 3 ? 1024 : 64;
      const batch = version === 3 ? 256 : 32;
      let history = [user('owned')];
      let parent;
      const tail = (start, count) => {
        const calls = Array.from({ length: count }, (_, index) => {
          const id = 'boundary-' + (start + index);
          if (protocol === 'responses')
            return [
              { type: 'function_call', call_id: id, name: LIST, arguments: '{}' },
              { type: 'function_call_output', call_id: id, output: 'exact-' + id },
            ];
          if (protocol === 'claude')
            return [
              { role: 'assistant', content: [{ type: 'tool_use', id, name: LIST, input: {} }] },
              {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: id, content: 'exact-' + id }],
              },
            ];
          return hidden(id, 'exact-' + id);
        });
        return calls.flat();
      };
      const prepare = (hiddenTail, extra = {}) =>
        map.prepare({
          scope: owner,
          rootId,
          historyVersion: version,
          clientHistory: history,
          hiddenTail,
          ...(parent ? { parent } : {}),
          ...extra,
        });
      try {
        for (let start = 0; start < maximum; start += batch) {
          const staged = prepare(tail(start, batch));
          assert.equal(staged.ok, true);
          const output = [answer('done-' + start)];
          const committed = map.commit(staged.token, output);
          assert.equal(committed.ok, true);
          parent = committed.snapshot;
          history = [...history, ...output, user('continue')];
          time++;
        }
        const before = map.inspect();
        assert.equal(prepare(tail(maximum, 1)).ok, false);
        assert.equal(prepare(tail(0, 1)).ok, false);
        assert.equal(
          prepare(tail(maximum, 1), { historyVersion: version === 3 ? 2 : 3 }).ok,
          false
        );
        assert.deepEqual(map.inspect(), before);
        const state = plain(exportContextHistoryMap(map, owner, [parent]));
        assert.ok(state.entries.every((entry) => entry.expiresAt === 86401000));
        const restored = restoreContextHistoryMap({ scope: owner, now: () => time }, state);
        try {
          const snapshot = restored.snapshots.get(state.tips[0]);
          const rebuilt = restored.historyMap.rebuild({
            scope: owner,
            snapshot,
            clientHistory: history,
          });
          assert.equal(rebuilt.ok, true);
          const results = rebuilt.history.flatMap((item) =>
            protocol === 'responses'
              ? item.type === 'function_call_output'
                ? [item.output]
                : []
              : protocol === 'claude'
                ? (Array.isArray(item.content) ? item.content : [])
                    .filter((block) => block.type === 'tool_result')
                    .map((block) => block.content)
                : item.role === 'tool'
                  ? [item.content]
                  : []
          );
          assert.deepEqual(
            results,
            Array.from({ length: maximum }, (_, index) => 'exact-boundary-' + index)
          );
          time = 86400999;
          assert.equal(
            restored.historyMap.rebuild({ scope: owner, snapshot, clientHistory: history }).ok,
            true
          );
          time++;
          assert.equal(
            restored.historyMap.rebuild({ scope: owner, snapshot, clientHistory: history }).ok,
            false
          );
          assert.equal(restored.historyMap.inspect().entries, 0);
          assert.equal(restored.historyMap.inspect().retainedBytes, 0);
        } finally {
          restored.historyMap.close();
        }
      } finally {
        map.close();
      }
    });
  }
}

test('four private roots each retain 1024 calls and reject a fifth root without losing ownership', () => {
  const map = createContextHistoryMap({ now: () => 1000, ttlMs: 86400000, capacityVersion: 2 });
  const roots = [];
  try {
    for (let root = 0; root < 4; root++) {
      const owner = { ...scope, protocol: 'responses', target: 'root-' + root };
      const rootId = 'hbs_' + root.toString(16).padStart(32, '0');
      let history = [user('owned-' + root)];
      let parent;
      for (let batch = 0; batch < 2; batch++) {
        const hiddenTail = Array.from({ length: 512 }, (_, index) => {
          const callId = 'root-' + root + '-call-' + (batch * 512 + index);
          return [
            { type: 'function_call', call_id: callId, name: LIST, arguments: '{}' },
            { type: 'function_call_output', call_id: callId, output: 'exact-' + callId },
          ];
        }).flat();
        const staged = map.prepare({
          scope: owner,
          rootId,
          historyVersion: 3,
          clientHistory: history,
          hiddenTail,
          ...(parent ? { parent } : {}),
        });
        assert.equal(staged.ok, true);
        const output = [answer('done-' + batch)];
        const committed = map.commit(staged.token, output);
        assert.equal(committed.ok, true);
        parent = committed.snapshot;
        history = [...history, ...output, user('continue')];
      }
      roots.push({ owner, rootId, history, parent });
    }
    const before = map.inspect();
    assert.equal(before.entries, 8);
    assert.deepEqual(
      map.prepare({
        scope,
        rootId: 'hbs_' + 'f'.repeat(32),
        historyVersion: 3,
        clientHistory: [],
        hiddenTail: hidden('fifth', 'refused'),
      }),
      { ok: false, code: 'context_history_quota' }
    );
    assert.deepEqual(map.inspect(), before);
    for (const [index, root] of roots.entries()) {
      const rebuilt = map.rebuild({
        scope: root.owner,
        snapshot: root.parent,
        clientHistory: root.history,
      });
      assert.equal(rebuilt.ok, true);
      assert.deepEqual(
        rebuilt.history
          .filter((item) => item.type === 'function_call_output')
          .map((item) => item.output),
        Array.from({ length: 1024 }, (_, call) => 'exact-root-' + index + '-call-' + call)
      );
      assert.equal(
        map.rebuild({
          scope: roots[(index + 1) % 4].owner,
          snapshot: root.parent,
          clientHistory: root.history,
        }).ok,
        false
      );
      const state = plain(exportContextHistoryMap(map, root.owner, [root.parent]));
      assert.equal(state.rootId, root.rootId);
      const restored = restoreContextHistoryMap({ scope: root.owner, now: () => 2000 }, state);
      try {
        const recovered = restored.historyMap.rebuild({
          scope: root.owner,
          snapshot: restored.snapshots.get(state.tips[0]),
          clientHistory: root.history,
        });
        assert.equal(recovered.ok, true);
        assert.deepEqual(plain(recovered.history), plain(rebuilt.history));
      } finally {
        restored.historyMap.close();
      }
    }
  } finally {
    map.close();
  }
  assert.equal(map.inspect().entries, 0);
  assert.equal(map.inspect().retainedBytes, 0);
});

test('four full private roots restore 2048 actual entries and 32 MiB without losing exact results', (t) => {
  const map = createContextHistoryMap({
    now: () => 1000,
    ttlMs: 86400000,
    capacityVersion: 2,
    maximumTips: 512,
  });
  const roots = [];
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  let restored;
  try {
    for (let root = 0; root < 4; root++) {
      const owner = { ...scope, target: 'full-root-' + root };
      const rootId = 'hbs_' + root.toString(16).padStart(32, '0');
      const history = [user('owned-' + root)];
      const tips = [];
      const expected = [];
      for (let index = 0; index < 512; index++) {
        const id = 'root-' + root + '-entry-' + String(index).padStart(4, '0');
        const empty = [...hidden(id + '-a', ''), ...hidden(id + '-b', '')];
        const remaining = 16384 - historyEntryBytes(empty, ['a'.repeat(64), 'b'.repeat(64)]);
        const a = (id + '-a:').padEnd(Math.floor(remaining / 2), 'a');
        const b = (id + '-b:').padEnd(remaining - a.length, 'b');
        const staged = map.prepare({
          scope: owner,
          rootId,
          historyVersion: 3,
          clientHistory: history,
          hiddenTail: [...hidden(id + '-a', a), ...hidden(id + '-b', b)],
        });
        assert.equal(staged.ok, true);
        const committed = map.commit(staged.token, [answer('done')]);
        assert.equal(committed.ok, true);
        tips.push(committed.snapshot);
        expected.push([sha(a), sha(b)]);
      }
      roots.push({
        scope: owner,
        state: plain(exportContextHistoryMap(map, owner, tips)),
        history: [...history, answer('done')],
        expected,
      });
    }
    assert.equal(map.inspect().entries, 2048);
    assert.equal(map.inspect().retainedBytes, 32 * 1024 * 1024);
    for (const root of roots) {
      assert.equal(root.state.entries.length, 512);
      assert.equal(
        root.state.entries.reduce((bytes, entry) => bytes + entry.bytes, 0),
        8 * 1024 * 1024
      );
    }
    const batch = roots.map(({ scope: owner, state }) => ({ scope: owner, state }));
    const nodes = (value) =>
      1 +
      (value && typeof value === 'object'
        ? Object.values(value).reduce((count, item) => count + nodes(item), 0)
        : 0);
    const encodedBytes = Buffer.byteLength(JSON.stringify(batch));
    assert.ok(encodedBytes < 48 * 1024 * 1024);
    assert.ok(nodes(batch) > 65536);
    assert.ok(roots.every((root) => nodes(root.state) < 65536));
    assert.throws(() => normalizeRecoveryStateData(batch, 48 * 1024 * 1024));
    t.diagnostic(
      JSON.stringify({
        roots: 4,
        entries: 2048,
        retainedBytes: 32 * 1024 * 1024,
        encodedBytes,
        batchNodes: nodes(batch),
        perRootNodes: roots.map((root) => nodes(root.state)),
      })
    );
    restored = restoreContextHistoryRoots(
      { now: () => 2000, capacityVersion: 2, maximumTips: 512 },
      batch
    );
    assert.equal(restored.historyMap.inspect().entries, 2048);
    assert.equal(restored.historyMap.inspect().retainedBytes, 32 * 1024 * 1024);
    for (const root of roots) {
      for (const [index, id] of root.state.tips.entries()) {
        const rebuilt = restored.historyMap.rebuild({
          scope: root.scope,
          snapshot: restored.snapshots.get(id),
          clientHistory: root.history,
        });
        assert.equal(rebuilt.ok, true);
        assert.deepEqual(
          rebuilt.history.filter((item) => item.role === 'tool').map((item) => sha(item.content)),
          root.expected[index]
        );
      }
    }
  } finally {
    restored?.historyMap.close();
    map.close();
  }
});

test('batch history admission rejects malformed envelopes and late invalid roots without executing hooks', () => {
  const map = createContextHistoryMap({ now: () => 1000 });
  const token = commit(map, null, [user('owned')], hidden('owned-call', 'exact'));
  const wrapper = { scope, state: plain(exportContextHistoryMap(map, scope, [token])) };
  let invoked = 0;
  const accessor = (key, value) =>
    Object.defineProperty(value, key, {
      enumerable: true,
      get() {
        invoked++;
        return wrapper;
      },
    });
  const badScope = accessor('policy', { ...scope });
  const badState = accessor('version', { ...wrapper.state });
  const badArray = accessor('0', [wrapper]);
  const hiddenSlot = Object.defineProperty([wrapper], '0', { enumerable: false });
  const inherited = Object.create(wrapper);
  try {
    const empty = restoreContextHistoryRoots({ now: () => 2000 }, []);
    assert.equal(empty.historyMap.inspect().entries, 0);
    empty.historyMap.close();
    for (const input of [
      null,
      {},
      new Array(1),
      badArray,
      hiddenSlot,
      Object.assign([wrapper], { extra: true }),
      Array(5).fill(wrapper),
      [inherited],
      [null],
      [{}],
      [{ scope }],
      [{ ...wrapper, extra: true }],
      [accessor('scope', { ...wrapper })],
      [accessor('state', { ...wrapper })],
      [{ ...wrapper, scope: badScope }],
      [{ ...wrapper, state: badState }],
      [wrapper, { ...wrapper, state: { ...wrapper.state, version: 4 } }],
      [wrapper, wrapper],
    ])
      assert.throws(() => restoreContextHistoryRoots({ now: () => 2000 }, input), {
        code: 'invalid_context_history_state',
      });
    assert.equal(invoked, 0);
    let clockReads = 0;
    assert.throws(() =>
      restoreContextHistoryRoots(
        {
          now() {
            clockReads++;
            return 2000;
          },
        },
        [wrapper, { ...wrapper, state: { ...wrapper.state, version: 4 } }]
      )
    );
    assert.equal(clockReads, 0);
    assert.equal(map.inspect().entries, 1);
    assert.equal(
      map.rebuild({ scope, snapshot: token, clientHistory: [user('owned'), answer('done')] }).ok,
      true
    );
  } finally {
    map.close();
  }
});

test('legacy history batches retain shared node admission and mixed roots keep their original expiry', () => {
  const map = createContextHistoryMap({ now: () => 1000, ttlMs: 86400000, capacityVersion: 2 });
  const legacy = [];
  let mixed;
  try {
    for (let index = 0; index < 2; index++) {
      const owner = { ...scope, target: 'legacy-' + index };
      const tail = hidden('legacy-' + index, 'exact');
      tail[0].opaque = Array(33000).fill(0);
      const staged = map.prepare({
        scope: owner,
        historyVersion: 2,
        clientHistory: [],
        hiddenTail: tail,
      });
      assert.equal(staged.ok, true);
      const committed = map.commit(staged.token, [answer('done')]);
      assert.equal(committed.ok, true);
      const state = plain(exportContextHistoryMap(map, owner, [committed.snapshot]));
      const single = restoreContextHistoryMap({ scope: owner, now: () => 2000 }, state);
      single.historyMap.close();
      legacy.push({ scope: owner, state });
    }
    assert.throws(() => restoreContextHistoryRoots({ now: () => 2000 }, legacy));
    const roots = [];
    for (const version of [1, 2, 3]) {
      const owner = { ...scope, target: 'mixed-' + version };
      const staged = map.prepare({
        scope: owner,
        historyVersion: version,
        ...(version === 3 ? { rootId: 'hbs_' + 'e'.repeat(32) } : {}),
        ttlMs: version === 1 ? 1800000 : 86400000,
        clientHistory: [],
        hiddenTail: hidden('mixed-' + version, 'exact-' + version),
      });
      assert.equal(staged.ok, true);
      const committed = map.commit(staged.token, [answer('done')]);
      assert.equal(committed.ok, true);
      roots.push({
        scope: owner,
        state: plain(exportContextHistoryMap(map, owner, [committed.snapshot])),
      });
    }
    mixed = restoreContextHistoryRoots({ now: () => 2000 }, roots);
    assert.equal(mixed.historyMap.inspect().entries, 3);
    for (const root of roots) {
      const snapshot = mixed.snapshots.get(root.state.tips[0]);
      const exported = exportContextHistoryMap(mixed.historyMap, root.scope, [snapshot]);
      assert.equal(exported.version, root.state.version);
      assert.equal(exported.entries[0].expiresAt, root.state.entries[0].expiresAt);
      assert.equal(exported.entries[0].expiresAt, root.state.version === 1 ? 1801000 : 86401000);
    }
  } finally {
    mixed?.historyMap.close();
    map.close();
  }
});

test('quota rejects new state without evicting live references', () => {
  const map = createContextHistoryMap();
  const root = commit(map, null, [], hidden('root', 'keep'));
  let denied = false;
  for (let i = 0; i < 8; i++) {
    const prepared = map.prepare({
      scope,
      clientHistory: [],
      hiddenTail: hidden(`i${i}`, 'x'.repeat(1024 * 1024)),
    });
    if (!prepared.ok) {
      denied = true;
      break;
    }
    assert.equal(map.commit(prepared.token, [answer('done')]).ok, true);
  }
  assert.equal(denied, true);
  assert.equal(map.rebuild({ scope, snapshot: root, clientHistory: [answer('done')] }).ok, true);
  assert.ok(map.inspect().retainedBytes <= map.inspect().maxBytes);
});

for (const protocol of ['chat', 'responses', 'claude']) {
  test(`${protocol}: coordinator exchanges survive next-turn reconstruction without client tool leakage`, () => {
    const map = createContextHistoryMap();
    const owner = { ...scope, protocol };
    const history = [user('continue')];
    const readers = createContextEvidenceTools({
      list: () => ({ ok: true, sources: [], nextAfterSourceId: null }),
      read: () => ({ ok: false }),
    });
    const session = {
      definitions: readers.definitions,
      inspect: () => ({ active: true }),
      reply: readers.reply,
    };
    const body = protocol === 'responses' ? { input: history } : { messages: history };
    const coordinator = createContextRecoveryCoordinator({ kind: protocol, body, session });
    let internal;
    let final;
    let clientOutput;
    if (protocol === 'chat') {
      internal = {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                { id: 'i', type: 'function', function: { name: LIST, arguments: '{}' } },
              ],
            },
          },
        ],
      };
      final = { choices: [{ finish_reason: 'stop', message: answer('done') }] };
      clientOutput = [final.choices[0].message];
    } else if (protocol === 'responses') {
      internal = {
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'i', name: LIST, arguments: '{}' }],
      };
      final = {
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        ],
      };
      clientOutput = final.output;
    } else {
      internal = {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'i', name: LIST, input: {} }],
      };
      final = {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
      };
      clientOutput = [{ role: 'assistant', content: final.content }];
    }
    assert.equal(coordinator.accept(internal).mode, 'continue');
    const released = coordinator.accept(final);
    assert.equal(released.mode, 'release');
    assert.doesNotMatch(JSON.stringify(released.response), /hpm_list_retained_evidence/);
    const prepared = map.prepare({
      scope: owner,
      clientHistory: history,
      hiddenTail: released.history.slice(history.length),
    });
    assert.equal(prepared.ok, true);
    const committed = map.commit(prepared.token, clientOutput);
    assert.equal(committed.ok, true);
    const publicNext = [...history, ...clientOutput, user('next')];
    const rebuilt = map.rebuild({
      scope: owner,
      snapshot: committed.snapshot,
      clientHistory: publicNext,
    });
    assert.equal(rebuilt.ok, true);
    assert.match(JSON.stringify(rebuilt.history), /hpm_list_retained_evidence/);
    assert.match(JSON.stringify(rebuilt.history), /nextAfterSourceId/);
    assert.deepEqual(plain(rebuilt.history.at(-1)), user('next'));
    assert.doesNotMatch(JSON.stringify(publicNext), /hpm_list_retained_evidence/);
  });
}

test('private tails reject external calls, orphan results, raw user text and reused ancestor IDs', () => {
  for (const protocol of ['chat', 'responses', 'claude']) {
    const map = createContextHistoryMap();
    const owner = { ...scope, protocol };
    const bad =
      protocol === 'chat'
        ? [
            [{ role: 'tool', tool_call_id: 'missing', content: 'x' }],
            [hidden('i', 'x')[0]],
            [
              {
                role: 'assistant',
                tool_calls: [{ id: 'i', type: 'function', function: { name: 'shell' } }],
              },
            ],
            [user('private user text')],
          ]
        : protocol === 'responses'
          ? [
              [{ type: 'function_call_output', call_id: 'missing', output: 'x' }],
              [{ type: 'function_call', call_id: 'i', name: 'shell' }],
              [{ type: 'custom_tool_call', name: 'shell' }],
              [user('private user text')],
            ]
          : [
              [
                {
                  role: 'user',
                  content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }],
                },
              ],
              [{ role: 'assistant', content: [{ type: 'tool_use', id: 'i', name: 'shell' }] }],
              [{ role: 'user', content: [{ type: 'text', text: 'private user text' }] }],
              [user('private user text')],
            ];
    for (const tail of bad)
      assert.equal(map.prepare({ scope: owner, clientHistory: [], hiddenTail: tail }).ok, false);
    assert.equal(map.inspect().retainedBytes, 0);
  }
  const map = createContextHistoryMap();
  const parent = commit(map, null, [], hidden('i', 'x'));
  assert.equal(
    map.prepare({
      scope,
      parent,
      clientHistory: [answer('done')],
      hiddenTail: hidden('i', 'again'),
    }).ok,
    false
  );
});
