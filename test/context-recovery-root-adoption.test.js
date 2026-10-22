'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
  adoptContextRecoveryRoots,
  attachContextRecoveryStorage,
} = require('../lib/proxy/context-recovery-sessions');
const {
  createContextHistoryMap,
  prepareContextHistoryAdoption,
} = require('../lib/proxy/context-history-map');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../lib/proxy/context-evidence-tools');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { createRecoveryRootStorage } = require('../lib/proxy/context-recovery-root-storage');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, createHash } = require('node:crypto');

const error = { code: 'invalid_context_recovery_root_state' };
const user = (content) => ({ role: 'user', content });
const answer = [{ role: 'assistant', content: 'done' }];
const text = 'exact 原文\r\né🙂';
function fixture(label, { now = () => 100, privateHistory = false } = {}) {
  const sessions = createContextRecoverySessions({ now });
  sessions.configure(true);
  const binding = { principal: 'owner', protocol: 'chat', target: 'target' };
  const history = [user(label)];
  const tool = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: label, type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  };
  const root = sessions.begin({ ...binding, history });
  assert.equal(
    root.complete(
      [tool],
      [
        {
          callId: label,
          toolName: 'lookup',
          arguments: {},
          output: '',
          completed: true,
        },
      ],
      label + '-first'
    ).ok,
    true
  );
  const messages = [...history, tool, { role: 'tool', tool_call_id: label, content: text }];
  const child = sessions.begin({ ...binding, history: messages }, [
    { callId: label, output: text },
  ]);
  const receipt = JSON.parse(child.reply(LIST, {}).text).sources[0];
  let output = answer;
  if (privateHistory) {
    const run = child.recovery({ model: 'synthetic', messages });
    assert.equal(run.ok, true);
    assert.equal(
      run.accept({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: label + '-read',
                  type: 'function',
                  function: {
                    name: READ,
                    arguments: JSON.stringify({
                      sourceId: receipt.sourceId,
                      digest: receipt.digest,
                    }),
                  },
                },
              ],
            },
          },
        ],
      }).mode,
      'continue'
    );
    const result = run.accept({ choices: [{ finish_reason: 'stop', message: answer[0] }] });
    assert.equal(result.mode, 'release');
    output = result.output;
  }
  assert.equal(child.complete(output, [], label + '-finished').ok, true);
  const request = { ...binding, history: [...messages, ...output, user('continue')] };
  const state = exportContextRecoveryRoot(sessions, root.snapshotId);
  return { sessions, root, child, binding, request, state, receipt };
}
const candidate = (f) => ({ binding: f.request, state: f.state });
const read = (session, f) =>
  JSON.parse(
    session.reply(READ, {
      sourceId: f.receipt.sourceId,
      digest: f.receipt.digest,
    }).text
  ).page.text;

test('atomic adoption preserves online and pending capabilities, private history and original budgets', () => {
  const live = fixture('online', { privateHistory: true });
  const offline = fixture('offline', { privateHistory: true });
  try {
    const pending = live.sessions.begin(live.request);
    assert.deepEqual(adoptContextRecoveryRoots(live.sessions, [candidate(offline)]), {
      ok: true,
      rootIds: [offline.state.rootId],
    });
    offline.sessions.close();
    assert.equal(read(live.child, live), text);
    assert.equal(read(pending, live), text);
    assert.equal(pending.complete(answer, [], 'pending-finished').ok, true);
    const imported = live.sessions.begin(offline.request);
    assert.equal(imported.reason, 'observed_continuation');
    const run = imported.recovery({ model: 'synthetic', messages: offline.request.history });
    assert.equal(run.ok, true);
    assert.ok(
      run.initialRequest.messages.some(
        (item) => item.role === 'tool' && item.content.includes(text)
      )
    );
    const before = exportContextRecoveryRoot(live.sessions, offline.state.rootId);
    assert.deepEqual(before.budget, offline.state.budget);
    assert.equal(before.expiresAt, offline.state.expiresAt);
    assert.equal(read(imported, offline), text);
    assert.equal(live.child.reply(READ, offline.receipt).ok, false);
  } finally {
    live.sessions.close();
    offline.sessions.close();
  }
});

test('duplicate admission cannot replace a live root or reset its spent budget', () => {
  const live = fixture('online');
  const offline = fixture('offline');
  try {
    adoptContextRecoveryRoots(live.sessions, [candidate(offline)]);
    assert.equal(read(live.sessions.begin(offline.request), offline), text);
    const before = exportContextRecoveryRoot(live.sessions, offline.state.rootId);
    assert.throws(() => adoptContextRecoveryRoots(live.sessions, [candidate(offline)]), error);
    assert.deepEqual(exportContextRecoveryRoot(live.sessions, offline.state.rootId), before);
    assert.equal(read(live.child, live), text);
  } finally {
    live.sessions.close();
    offline.sessions.close();
  }
});

test('malformed batches, getters and empty or expired imports never partially change online state', () => {
  const live = fixture('online');
  const offline = fixture('offline');
  let ran = 0;
  try {
    const before = exportContextRecoveryRoot(live.sessions, live.state.rootId);
    const malformed = globalThis.structuredClone(candidate(offline));
    malformed.state.history.entries.push({ id: 'invalid' });
    for (const input of [
      null,
      {},
      [candidate(offline), malformed],
      [
        {
          get state() {
            ran++;
            return offline.state;
          },
          binding: offline.request,
        },
      ],
    ]) {
      assert.throws(() => adoptContextRecoveryRoots(live.sessions, input), error);
      assert.equal(live.sessions.inspect().roots, 1);
      assert.deepEqual(exportContextRecoveryRoot(live.sessions, live.state.rootId), before);
    }
    assert.equal(ran, 0);
    assert.deepEqual(adoptContextRecoveryRoots(live.sessions, []), { ok: true, rootIds: [] });
    const later = createContextRecoverySessions({ now: () => offline.state.expiresAt });
    later.configure(true);
    assert.deepEqual(adoptContextRecoveryRoots(later, [candidate(offline)]), {
      ok: true,
      rootIds: [],
    });
    assert.equal(later.inspect().roots, 0);
    later.close();
    assert.throws(() => adoptContextRecoveryRoots({}, [candidate(offline)]), error);
    live.sessions.configure(false);
    assert.throws(() => adoptContextRecoveryRoots(live.sessions, [candidate(offline)]), error);
  } finally {
    live.sessions.close();
    offline.sessions.close();
  }
});

test('root and pending-binding quotas fail before mutation and never evict a live conversation', () => {
  for (const kind of ['roots', 'bindings']) {
    const live = fixture('online');
    const offline = fixture('offline');
    try {
      if (kind === 'roots') {
        for (let index = 0; index < 3; index++) {
          const session = live.sessions.begin({
            ...live.binding,
            history: [user('separate-' + index)],
          });
          assert.equal(session.complete(answer).ok, true);
        }
      } else {
        for (let index = 0; index < 2046; index++)
          assert.equal(live.sessions.begin(live.request).ok, true);
      }
      const before = live.sessions.inspect();
      assert.throws(() => adoptContextRecoveryRoots(live.sessions, [candidate(offline)]), error);
      assert.deepEqual(live.sessions.inspect(), before);
      assert.equal(read(live.child, live), text);
    } finally {
      live.sessions.close();
      offline.sessions.close();
    }
  }
});

test('history adoption capacity and uncommitted-source failures leave existing mappings usable', () => {
  const scope = { principal: 'owner', protocol: 'chat', target: 'target', policy: 'policy' };
  const history = [user('question')];
  const tail = (content, id) => [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: READ, arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: id, content },
  ];
  const target = createContextHistoryMap({ now: () => 100 });
  const source = createContextHistoryMap({ now: () => 100 });
  try {
    const large = [];
    for (let index = 0; index < 3; index++) {
      const entry = target.prepare({
        scope,
        clientHistory: history,
        hiddenTail: tail('x'.repeat(1280 * 1024), 'large-' + index),
      });
      assert.equal(entry.ok, true);
      assert.equal(target.commit(entry.token, answer).ok, true);
      large.push(entry);
    }
    const small = source.prepare({
      scope,
      clientHistory: history,
      hiddenTail: tail('y'.repeat(512 * 1024), 'small'),
    });
    assert.equal(small.ok, true);
    assert.throws(() => prepareContextHistoryAdoption(target, source), {
      code: 'invalid_context_history_state',
    });
    assert.equal(source.commit(small.token, answer).ok, true);
    const before = target.inspect();
    assert.throws(() => prepareContextHistoryAdoption(target, source), {
      code: 'invalid_context_history_state',
    });
    assert.deepEqual(target.inspect(), before);
    assert.equal(
      target.rebuild({ scope, snapshot: large[0].token, clientHistory: [...history, ...answer] })
        .ok,
      true
    );
  } finally {
    target.close();
    source.close();
  }
});

test('clock callback reentry cannot start requests or duplicate adoption during the synchronous transaction', () => {
  const offline = fixture('offline');
  let armed = false;
  let checked = false;
  const target = fixture('online', {
    now: () => {
      if (armed) {
        armed = false;
        assert.equal(target.sessions.begin(target.request).code, 'context_recovery_busy');
        assert.throws(
          () => adoptContextRecoveryRoots(target.sessions, [candidate(offline)]),
          error
        );
        checked = true;
      }
      return 100;
    },
  });
  try {
    armed = true;
    adoptContextRecoveryRoots(target.sessions, [candidate(offline)]);
    assert.equal(checked, true);
    assert.equal(target.sessions.inspect().roots, 2);
  } finally {
    target.sessions.close();
    offline.sessions.close();
  }
});

test('expiry and principal revocation during final admission checks cannot revive the candidate', () => {
  for (const action of ['expire', 'revoke']) {
    const offline = fixture('offline');
    let armed = false;
    let calls = 0;
    let time = 100;
    let triggered = false;
    const sessions = createContextRecoverySessions({
      now: () => {
        if (armed && ++calls === 7) {
          triggered = true;
          if (action === 'expire') time = offline.state.expiresAt;
          else sessions.revoke('owner');
        }
        return time;
      },
    });
    sessions.configure(true);
    try {
      armed = true;
      assert.throws(() => adoptContextRecoveryRoots(sessions, [candidate(offline)]), error);
      assert.equal(triggered, true);
      assert.equal(sessions.inspect().roots, 0);
    } finally {
      sessions.close();
      offline.sessions.close();
    }
  }
});

test('adopted roots use the existing durable owner for budget CAS and publication', async () => {
  const live = fixture('online');
  const offline = fixture('offline');
  const database = new DatabaseSync(':memory:');
  const store = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  try {
    attachContextRecoveryStorage(live.sessions, store);
    adoptContextRecoveryRoots(live.sessions, [candidate(offline)]);
    const session = live.sessions.begin(offline.request);
    const result = await session.replyAsync(READ, {
      sourceId: offline.receipt.sourceId,
      digest: offline.receipt.digest,
    });
    assert.equal(JSON.parse(result.text).page.text, text);
    assert.equal((await session.completeObservedAsync(answer, [], 'restored-finished')).ok, true);
    const scope = createHash('sha256')
      .update('hpm/recovery-root/v1\0' + offline.state.rootId)
      .digest('hex');
    const record = store.execute({ operation: 'load', scope });
    assert.equal(record.state.root.budget.calls, offline.state.budget.calls + 1);
    assert.equal(record.expiresAt, offline.state.expiresAt);
    assert.ok(
      record.state.publications.some(
        (item) => item.snapshotId === session.snapshotId && item.state === 'transport-finished'
      )
    );
    assert.equal((await live.sessions.revokeAsync('owner')).ok, true);
    assert.throws(() => adoptContextRecoveryRoots(live.sessions, [candidate(offline)]), error);
    assert.equal(live.sessions.inspect().roots, 0);
  } finally {
    await live.sessions.shutdownAsync();
    offline.sessions.close();
    store.close();
    database.close();
  }
});

test('denial-index enrollment never authorizes admission of a persistently revoked offline root', async () => {
  const root = {
    rootId: 'hbs_' + 'a'.repeat(32),
    principal: 'owner',
    createdAt: 100,
    expiresAt: 1000,
  };
  const storage = createRecoveryRootStorage({
    execute: (request) => ({ revoked: request.entries.length }),
  });
  try {
    storage.registerRoot(root);
    storage.admitRoot(root);
    assert.equal((await storage.revokePrincipal('owner')).ok, true);
    // Denial registration remains idempotent, but cannot become read admission.
    storage.registerRoot(root);
    assert.throws(() => storage.admitRoot(root), { code: 'context_recovery_storage_unavailable' });
    storage.close();
    assert.throws(() => storage.admitRoot(root), { code: 'context_recovery_storage_unavailable' });
  } finally {
    storage.close();
  }
});
