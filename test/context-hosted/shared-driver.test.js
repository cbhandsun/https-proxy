'use strict';

// Authored review-only tests. Do not run until root grants the idle queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runN08Driver } = require('../../scripts/context-hosted/shared/driver.js');
const {
  BARRIERS,
  MUTATIONS,
  ack,
  createResponseHold,
  checkAdmissionEvidence,
  checkWithdrawal,
} = require('../../scripts/context-hosted/shared/boundary.js');
const owner = (index) => ({
  pid: index + 1,
  manifestSha256: 'a'.repeat(64),
  nonce: index.toString(16).padStart(32, '0'),
});
const denied = () => ({
  status: 503,
  bytes: Buffer.from('{"error":{"code":"context_recovery_unavailable"}}'),
});
const ordinary = () => ({
  status: 200,
  bytes: Buffer.from(
    JSON.stringify({
      id: 'n08-ordinary-default',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'N08_ORDINARY_DEFAULT_OK' }],
        },
      ],
    })
  ),
});
const admission = () => ({
  enhanced: denied(),
  ordinary: ordinary(),
  enhancedPrivateDispatchDelta: 0,
  oldRootPrivateRequestDelta: 0,
  enhancedDefaultDispatchDelta: 0,
  ordinaryDefaultDispatchDelta: 1,
});
const snapshot = () => ({
  rootId: 'b'.repeat(64),
  expiresAt: 100000,
  readerCalls: 1,
  readerBytes: 100,
});
const withdrawn = (identity = owner(1)) => ({
  response: { status: 502, bytes: Buffer.from('{"error":{"code":"context_recovery_failed"}}') },
  ownerStatus: { ...identity, alive: true },
  externalToolReplays: 0,
  oldRootPrivateRequestDelta: 0,
  inFlightDefaultDispatchDelta: 0,
  before: snapshot(),
  after: snapshot(),
});

for (const barrier of BARRIERS)
  test('upstream hold is single-use and gated by completed mutation: ' + barrier, async () => {
    const identity = owner(1);
    const events = [];
    const hold = createResponseHold(
      { owner: identity, barrier, mutation: 'disable' },
      {
        deliver() {
          events.push('deliver');
          return true;
        },
        cancel() {
          events.push('cancel');
          return true;
        },
      }
    );
    await assert.rejects(hold.release(), /n08_boundary_rejected/);
    const arrival = {
      nonce: identity.nonce,
      ordinal: 1,
      readToolCalls: barrier === BARRIERS[0] ? 1 : 0,
      finalTextItems: barrier === BARRIERS[1] ? 1 : 0,
      publicWrites: 0,
    };
    assert.equal(hold.arrive(arrival).stage, 'upstream-response-held');
    assert.throws(() => hold.arrive(arrival), /n08_boundary_rejected/);
    await assert.rejects(hold.release(), /n08_boundary_rejected/);
    assert.throws(
      () => hold.mutationApplied(ack(owner(2), barrier, 'disable', 'mutation-applied')),
      /n08_boundary_rejected/
    );
    hold.mutationApplied(ack(identity, barrier, 'disable', 'mutation-applied'));
    assert.equal((await hold.release()).stage, 'response-released');
    await assert.rejects(hold.release(), /n08_boundary_rejected/);
    await hold.cancel();
    await hold.cancel();
    assert.deepEqual(events, ['deliver', 'cancel']);
  });

test('response holds reject crossed phases, public writes, foreign owners and capability failures', async () => {
  for (const patch of [
    { ordinal: 2 },
    { nonce: 'f'.repeat(32) },
    { readToolCalls: 0 },
    { finalTextItems: 1 },
    { publicWrites: 1 },
  ]) {
    const hold = createResponseHold(
      { owner: owner(1), barrier: BARRIERS[0], mutation: MUTATIONS[0] },
      { deliver: () => true, cancel: () => true }
    );
    assert.throws(
      () =>
        hold.arrive({
          nonce: owner(1).nonce,
          ordinal: 1,
          readToolCalls: 1,
          finalTextItems: 0,
          publicWrites: 0,
          ...patch,
        }),
      /n08_boundary_rejected/
    );
  }
  const hold = createResponseHold(
    { owner: owner(1), barrier: BARRIERS[0], mutation: MUTATIONS[0] },
    {
      deliver: () => {
        throw new Error('PRIVATE_MARKER');
      },
      cancel: () => false,
    }
  );
  hold.arrive({
    nonce: owner(1).nonce,
    ordinal: 1,
    readToolCalls: 1,
    finalTextItems: 0,
    publicWrites: 0,
  });
  hold.mutationApplied(ack(owner(1), BARRIERS[0], MUTATIONS[0], 'mutation-applied'));
  await assert.rejects(hold.release(), /^Error: n08_boundary_rejected$/);
  await assert.rejects(hold.cancel(), /^Error: n08_boundary_rejected$/);
});

test('cancellation while delivery is pending cannot produce a released ACK', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const hold = createResponseHold(
    { owner: owner(1), barrier: BARRIERS[0], mutation: MUTATIONS[0] },
    { deliver: () => pending, cancel: () => true }
  );
  hold.arrive({
    nonce: owner(1).nonce,
    ordinal: 1,
    readToolCalls: 1,
    finalTextItems: 0,
    publicWrites: 0,
  });
  hold.mutationApplied(ack(owner(1), BARRIERS[0], MUTATIONS[0], 'mutation-applied'));
  const released = hold.release();
  await hold.cancel();
  finish(true);
  await assert.rejects(released, /n08_boundary_rejected/);
});

test('enhanced rejection and ordinary default forwarding are independent requirements', () => {
  checkAdmissionEvidence(admission());
  const fallback = admission();
  fallback.enhanced = ordinary();
  fallback.enhancedDefaultDispatchDelta = 1;
  checkAdmissionEvidence(fallback);
  for (const mutate of [
    (value) => {
      value.enhanced = ordinary();
    },
    (value) => {
      value.enhanced = { status: 0, bytes: Buffer.alloc(0) };
    },
    (value) => {
      value.enhanced.bytes = Buffer.from('{"error":{"code":"unrelated_failure"}}');
    },
    (value) => {
      value.ordinary = denied();
    },
    (value) => {
      value.ordinaryDefaultDispatchDelta = 0;
    },
    (value) => {
      value.enhancedPrivateDispatchDelta = 1;
    },
    (value) => {
      value.oldRootPrivateRequestDelta = 1;
    },
    (value) => {
      value.ordinary.bytes = Buffer.from('{"id":"wrong-default"}');
    },
    (value) => {
      value.ordinary.bytes = Buffer.alloc(262145);
    },
  ]) {
    const value = admission();
    mutate(value);
    assert.throws(() => checkAdmissionEvidence(value), /n08_boundary_rejected/);
  }
});

test('withdrawal hides raw and escaped private markers and preserves cumulative policy', () => {
  checkWithdrawal(withdrawn(), owner(1));
  const fallback = withdrawn();
  fallback.response = ordinary();
  fallback.inFlightDefaultDispatchDelta = 1;
  checkWithdrawal(fallback, owner(1));
  for (const mutate of [
    (value) => {
      value.externalToolReplays = 1;
    },
    (value) => {
      value.after.expiresAt++;
    },
    (value) => {
      value.oldRootPrivateRequestDelta = 1;
    },
    (value) => {
      value.ownerStatus.alive = false;
    },
    (value) => {
      value.ownerStatus.pid++;
    },
    (value) => {
      value.after.rootId = 'c'.repeat(64);
    },
    (value) => {
      value.after.readerCalls--;
    },
    (value) => {
      value.after.readerBytes = 0;
    },
    (value) => {
      value.after.readerBytes = Infinity;
    },
    (value) => {
      value.response = ordinary();
    },
    (value) => {
      value.response.bytes = Buffer.from('{"error":"N08_PRIVATE_CONTENT"}');
    },
    (value) => {
      value.response.bytes = Buffer.from('{"error":"\\u004e08_PRIVATE_CONTENT"}');
    },
    (value) => {
      value.response.bytes = Buffer.from('{"error":"\\u004e08_PRIVATE_CONTENT","error":"safe"}');
    },
    (value) => {
      value.response.bytes = Buffer.from('{"error":"hpm_read_retained_evidence"}');
    },
    (value) => {
      value.response.bytes = Buffer.from([255]);
    },
  ]) {
    const value = withdrawn();
    mutate(value);
    assert.throws(() => checkWithdrawal(value, owner(1)), /n08_boundary_rejected/);
  }
});

function fixture(change = () => {}) {
  let index = 0,
    scenario;
  const events = [];
  function receipt(identity, stage) {
    const result = ack(identity, scenario.barrier, scenario.mutation, stage);
    events.push(stage);
    return result;
  }
  return {
    events,
    adapter: {
      startCase(input) {
        scenario = input;
        return owner(++index);
      },
      beginRecovery: (identity) => receipt(identity, 'recovery-started'),
      waitUpstreamHold: (identity) => receipt(identity, 'upstream-response-held'),
      applyMutation: (identity) => receipt(identity, 'mutation-applied'),
      probeAdmissions() {
        const value = admission();
        change(value);
        return value;
      },
      releaseUpstreamHold: (identity) => receipt(identity, 'response-released'),
      observeWithdrawal: (identity) => withdrawn(identity),
      stop: (identity) => receipt(identity, 'tree-empty'),
      closeSession(session) {
        events.push('session-' + session + '-closed');
        return true;
      },
    },
  };
}
test('six cases reuse two original controller sessions without claiming daemon proof', async () => {
  const f = fixture();
  const result = await runN08Driver(f.adapter);
  assert.equal(result.cases.length, 6);
  assert.deepEqual(
    result.cases.map((item) => [item.session, item.label]),
    [
      [0, '00'],
      [0, '01'],
      [0, '10'],
      [1, '00'],
      [1, '01'],
      [1, '10'],
    ]
  );
  assert.equal(result.liveDaemonProved, false);
  assert.equal(result.n08Qualified, false);
  assert.equal(f.events.filter((event) => event === 'tree-empty').length, 6);
  assert.equal(f.events.at(-1), 'session-1-closed');
});
test('failed evidence stops the case and closes its controller session before rejecting', async () => {
  const f = fixture((value) => {
    value.ordinary = denied();
  });
  await assert.rejects(runN08Driver(f.adapter), /^Error: n08_driver_rejected$/);
  assert.deepEqual(f.events.slice(-2), ['tree-empty', 'session-0-closed']);
  assert.equal(f.events.includes('response-released'), false);
});
test('malformed and accessor adapters fail without invoking getters', async () => {
  let touched = false;
  for (const value of [
    null,
    [],
    {},
    { ...fixture().adapter, extra: true },
    Object.defineProperty(fixture().adapter, 'stop', {
      enumerable: true,
      get() {
        touched = true;
        throw new Error('PRIVATE_MARKER');
      },
    }),
  ])
    await assert.rejects(runN08Driver(value), /n08_driver_rejected/);
  assert.equal(touched, false);
});
for (const method of [
  'beginRecovery',
  'waitUpstreamHold',
  'applyMutation',
  'releaseUpstreamHold',
  'stop',
])
  test('foreign owner ACK rejects and closes the session: ' + method, async () => {
    const f = fixture();
    const original = f.adapter[method];
    f.adapter[method] = (identity) => ({ ...original(identity), nonce: 'f'.repeat(32) });
    await assert.rejects(runN08Driver(f.adapter), /n08_driver_rejected/);
    assert.equal(f.events.at(-1), 'session-0-closed');
    assert.equal(f.events.includes('tree-empty'), true);
  });
test('reused owner nonce, failed session close and malformed start cannot be successful', async () => {
  for (const mode of ['nonce', 'close', 'start']) {
    const f = fixture();
    const start = f.adapter.startCase;
    if (mode === 'nonce')
      f.adapter.startCase = (input) => ({ ...start(input), nonce: 'f'.repeat(32) });
    if (mode === 'close') f.adapter.closeSession = () => false;
    if (mode === 'start') f.adapter.startCase = () => ({ pid: NaN });
    await assert.rejects(runN08Driver(f.adapter), /n08_driver_rejected/);
    if (mode === 'start') assert.equal(f.events.at(-1), 'session-0-closed');
  }
});
test('hostile proxy metadata failures are sanitized before exposing a boundary error', async () => {
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('PRIVATE_MARKER');
      },
    }
  );
  assert.throws(() => checkAdmissionEvidence(hostile), /^Error: n08_boundary_rejected$/);
  await assert.rejects(runN08Driver(hostile), /^Error: n08_driver_rejected$/);
});
