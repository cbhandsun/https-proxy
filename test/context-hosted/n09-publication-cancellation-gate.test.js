'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPublicationCancellationGate,
} = require('../../scripts/context-hosted/n09-business/publication-cancellation-gate');
const safe = { message: 'n09_publication_cancellation_gate_failed' };
const base = {
  generation: 1,
  callOrdinal: 2,
  rootId: 'hbs_' + 'a'.repeat(32),
  expiresAt: 86400001,
  expectedRevision: 5,
  transition: 'withdrawn',
};
function fixture(patch = {}) {
  let time = 0,
    polls = 0;
  const receipts = [];
  const observed = {
    ...base,
    callOrdinal: 3,
    expectedRevision: 4,
    transition: 'prepared',
    activeCount: 0,
    operation: 'save-reference-state',
    status: 'completed',
  };
  const config = {
    inspect: () => observed,
    publish: (v) => {
      receipts.push(v);
    },
    released: () => ++polls === 3,
    pause: async (ms) => {
      time += ms;
    },
    now: () => time,
    ...patch,
  };
  const gate = createPublicationCancellationGate(config);
  return {
    gate,
    observed,
    receipts,
    time: () => time,
    setTime: (v) => {
      time = v;
    },
  };
}
test('withdrawn gate pauses only after genuine prepared metadata, without returning a token or terminal proof', async () => {
  const f = fixture();
  assert.equal(await f.gate.afterPublicationAction(null), undefined);
  f.gate.arm(base);
  assert.equal(await f.gate.afterPublicationAction('prepare'), undefined);
  assert.equal(f.time(), 20);
  assert.equal(f.receipts.length, 1);
  assert.equal(Object.isFrozen(f.receipts[0]), true);
  assert.deepEqual(f.receipts[0], { ...base, callOrdinal: 3, revision: 5 });
  assert.deepEqual(f.gate.inspect(), { state: 'released', daemonQualified: false });
  assert.equal(await f.gate.afterPublicationAction('withdraw'), undefined);
  assert.throws(() => f.gate.arm(base), safe);
});
test('uncertain gate requires completed prepared then sending and holds before any public write', async () => {
  const f = fixture();
  f.gate.arm({ ...base, transition: 'uncertain', expectedRevision: 6 });
  await f.gate.afterPublicationAction('prepare');
  assert.equal(f.receipts.length, 0);
  assert.equal(f.time(), 0);
  Object.assign(f.observed, { transition: 'sending', expectedRevision: 5, callOrdinal: 4 });
  await f.gate.afterPublicationAction('sending');
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].revision, 6);
  assert.equal(f.time(), 20);
});
for (const patch of [
  { generation: 2 },
  { callOrdinal: 2 },
  { callOrdinal: 1025 },
  { rootId: 'hbs_' + 'b'.repeat(32) },
  { expiresAt: 2 },
  { expectedRevision: 3 },
  { expectedRevision: 5 },
  { activeCount: 1 },
  { operation: 'load' },
  { transition: 'sending' },
  { status: 'pending' },
]) {
  test(
    'predecessor mismatch is sticky and publishes nothing: ' +
      Object.keys(patch)[0] +
      '=' +
      Object.values(patch)[0],
    async () => {
      const f = fixture();
      Object.assign(f.observed, patch);
      f.gate.arm(base);
      await assert.rejects(f.gate.afterPublicationAction('prepare'), safe);
      assert.equal(f.receipts.length, 0);
      assert.equal(f.gate.inspect().state, 'failed');
      await assert.rejects(f.gate.afterPublicationAction('prepare'), safe);
    }
  );
}
test('skipped or repeated uncertain predecessors cannot publish a cancellation gate', async () => {
  for (const action of ['sending', 'finished', 'withdraw', null, {}, 'public']) {
    const f = fixture();
    f.gate.arm({ ...base, transition: 'uncertain', expectedRevision: 6 });
    await assert.rejects(f.gate.afterPublicationAction(action), safe);
    assert.equal(f.receipts.length, 0);
  }
  const f = fixture();
  f.gate.arm({ ...base, transition: 'uncertain', expectedRevision: 6 });
  await f.gate.afterPublicationAction('prepare');
  await assert.rejects(f.gate.afterPublicationAction('prepare'), safe);
  assert.equal(f.receipts.length, 0);
});
test('close rejects an active native promise wait and never authorizes release', async () => {
  const f = fixture({ released: () => false, pause: () => new Promise(() => {}) });
  f.gate.arm(base);
  const pending = f.gate.afterPublicationAction('prepare');
  assert.equal(f.gate.inspect().state, 'holding');
  f.gate.close();
  await assert.rejects(pending, safe);
  assert.equal(f.gate.inspect().state, 'closed');
  await assert.rejects(f.gate.afterPublicationAction('prepare'), safe);
});
test('real deadline bounds even a pause promise that never resolves', async () => {
  const f = fixture({
    released: () => {
      f.setTime(4990);
      return false;
    },
    pause: () => new Promise(() => {}),
  });
  f.gate.arm(base);
  await assert.rejects(f.gate.afterPublicationAction('prepare'), safe);
  assert.equal(f.gate.inspect().state, 'failed');
});
test('the original five seconds includes publishing, polling and clock rollback', async () => {
  for (const patch of [
    (f) => ({
      publish: () => {
        f.setTime(5000);
      },
    }),
    (f) => ({
      released: () => {
        f.setTime(5000);
        return true;
      },
    }),
    (f) => ({
      pause: async () => {
        f.setTime(5000);
      },
    }),
    (f) => ({
      released: () => {
        f.setTime(-1);
        return true;
      },
    }),
  ]) {
    const callbacks = {};
    const f = fixture({
      publish(v) {
        if (callbacks.publish) return callbacks.publish(v);
        f.receipts.push(v);
      },
      released: () => (callbacks.released ? callbacks.released() : false),
      pause: async (ms) => {
        if (callbacks.pause) return callbacks.pause(ms);
        f.setTime(f.time() + ms);
      },
    });
    Object.assign(callbacks, patch(f));
    f.gate.arm(base);
    await assert.rejects(f.gate.afterPublicationAction('prepare'), safe);
    assert.equal(f.gate.inspect().state, 'failed');
  }
});
test('invalid input, exhausted ordinals and hostile descriptors are refused without hooks', () => {
  let touched = 0;
  const getter = Object.defineProperty({ ...base }, 'generation', {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  for (const value of [
    null,
    {},
    [],
    proxy.proxy,
    getter,
    { ...base, transition: 'prepared' },
    { ...base, generation: 0 },
    { ...base, generation: 17 },
    { ...base, callOrdinal: 1023 },
    { ...base, expectedRevision: 1 },
    { ...base, expectedRevision: Number.MAX_SAFE_INTEGER },
    { ...base, expiresAt: NaN },
    { ...base, rootId: '' },
    { ...base, rootId: base.rootId + '\n' },
  ]) {
    const f = fixture();
    assert.throws(() => f.gate.arm(value), safe);
    assert.equal(f.receipts.length, 0);
  }
  assert.equal(touched, 0);
});
test('exceptions, promises and thenables in synchronous observers do not escape or grant release', async () => {
  let touched = 0;
  const hostile = {
    get then() {
      touched++;
      throw Error('PRIVATE');
    },
  };
  for (const patch of [
    {
      inspect: () => {
        throw Error('PRIVATE');
      },
    },
    { inspect: () => Promise.reject(Error('PRIVATE')) },
    { publish: () => Promise.reject(Error('PRIVATE')) },
    { publish: () => false },
    { released: () => hostile },
    { pause: () => hostile },
    { pause: () => Promise.resolve(false) },
    { now: () => Infinity },
  ]) {
    const f = fixture(patch);
    f.gate.arm(base);
    await assert.rejects(f.gate.afterPublicationAction('prepare'), safe);
    assert.equal(f.gate.inspect().state, 'failed');
  }
  assert.equal(touched, 0);
});
test('swallowed reentrancy cannot release the outer waiter', async () => {
  let nested;
  const f = fixture({
    publish() {
      nested = f.gate.afterPublicationAction('prepare');
      nested.catch(() => {});
    },
  });
  f.gate.arm(base);
  await assert.rejects(f.gate.afterPublicationAction('prepare'), safe);
  await assert.rejects(nested, safe);
  assert.equal(f.gate.inspect().state, 'failed');
});

test('configuration callbacks cannot be missing, proxied, generators or asynchronous in synchronous slots', () => {
  let touched = 0;
  const config = { inspect() {}, publish() {}, released() {}, pause: async () => {}, now: () => 0 };
  const getter = Object.defineProperty({ ...config }, 'publish', {
    get() {
      touched++;
      return () => {};
    },
  });
  for (const input of [
    null,
    {},
    [],
    getter,
    { ...config, inspect: async () => ({}) },
    { ...config, pause: function* () {} },
    {
      ...config,
      now: new Proxy(() => 0, {
        apply() {
          touched++;
        },
      }),
    },
  ])
    assert.throws(() => createPublicationCancellationGate(input), safe);
  assert.equal(touched, 0);
});

test(
  'a frozen injected clock cannot keep a native pause loop alive past five real seconds',
  { timeout: 15000 },
  async () => {
    const f = fixture({
      now: () => 0,
      released: () => false,
      pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    f.gate.arm(base);
    await assert.rejects(f.gate.afterPublicationAction('prepare'), safe);
    assert.equal(f.gate.inspect().state, 'failed');
  }
);

test('native promises with own then or constructor hooks are refused without executing either', async () => {
  let touched = 0;
  for (const property of ['then', 'constructor']) {
    const f = fixture({
      pause() {
        const pending = Promise.resolve();
        Object.defineProperty(pending, property, {
          get() {
            touched++;
            throw Error('PRIVATE');
          },
        });
        return pending;
      },
    });
    f.gate.arm(base);
    await assert.rejects(f.gate.afterPublicationAction('prepare'), safe);
    assert.equal(f.gate.inspect().state, 'failed');
  }
  assert.equal(touched, 0);
});
