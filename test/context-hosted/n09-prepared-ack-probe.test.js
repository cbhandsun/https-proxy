'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreparedAckProbe,
} = require('../../scripts/context-hosted/n09-business/prepared-ack-probe');
const config = { pid: 123, rootId: 'hbs_' + 'a'.repeat(32), expiresAt: 1000, revision: 7 };
const observed = { generation: 1, callOrdinal: 1, activeCount: 0, status: 'completed' };
const safe = { message: 'n09_prepared_ack_probe_failed' };
function fixture(overrides = {}, baseline = observed, options = config, transition = 'prepared') {
  let target,
    releases = 0,
    closes = 0;
  const signal = (kind) => ({
    version: 1,
    pid: options.pid,
    epoch: 'b'.repeat(32),
    challenge: 'c'.repeat(32),
    ...target,
    kind,
    callOrdinal:
      kind === 'armed'
        ? baseline.callOrdinal
        : baseline.callOrdinal +
          (['prepared', 'sending', 'transport-finished'].indexOf(transition) + 1),
    holdChallenge: kind === 'armed' ? '' : 'd'.repeat(32),
    revision: target.expectedRevision + (kind === 'armed' ? 0 : 1),
  });
  const control = {
    arm: async (value) => {
      target = value;
      return signal('armed');
    },
    waitHeld: async () => signal('held'),
    release() {
      releases++;
    },
    waitReleased: async () => signal('released'),
    close() {
      closes++;
    },
    ...overrides,
  };
  return {
    probe: createPreparedAckProbe(options, baseline, control, transition),
    releases: () => releases,
    closes: () => closes,
  };
}

test('prepared probe preserves maximum exact revision and emits no durable ACK claim', async () => {
  const f = fixture(
    {},
    { ...observed, generation: 16, callOrdinal: 1023 },
    { ...config, revision: Number.MAX_SAFE_INTEGER - 1, expiresAt: Number.MAX_SAFE_INTEGER }
  );
  await f.probe.arm();
  const held = await f.probe.waitHeld();
  assert.equal(held.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(held.hostAckDelivered, false);
  assert.deepEqual(await f.probe.release(), { released: true, hostAckDelivered: false });
  f.probe.close();
  f.probe.close();
  assert.equal(f.releases(), 1);
  assert.equal(f.closes(), 1);
});

test('empty, unsafe and extreme checkpoint or observation is rejected before releasing', () => {
  for (const value of [
    null,
    {},
    { ...config, pid: 0 },
    { ...config, revision: 0 },
    { ...config, revision: Number.MAX_SAFE_INTEGER },
    { ...config, expiresAt: Infinity },
    { ...config, rootId: '../private' },
  ])
    assert.throws(() => fixture({}, observed, value), safe);
  for (const patch of [
    { generation: 0 },
    { generation: 17 },
    { callOrdinal: 0 },
    { callOrdinal: 1024 },
    { activeCount: 1 },
    { status: 'pending' },
  ])
    assert.throws(() => fixture({}, { ...observed, ...patch }), safe);
});

test('getters and Proxy traps are never invoked; unknown thenables cannot arm', async () => {
  let touched = 0;
  const getter = { ...config };
  Object.defineProperty(getter, 'rootId', {
    enumerable: true,
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  assert.throws(() => fixture({}, observed, getter), safe);
  assert.throws(
    () =>
      fixture(
        {},
        new Proxy(observed, {
          ownKeys() {
            touched++;
          },
        })
      ),
    safe
  );
  const f = fixture({
    arm: () => ({
      then() {
        touched++;
      },
    }),
  });
  await assert.rejects(f.probe.arm(), safe);
  await assert.rejects(f.probe.release(), safe);
  f.probe.close();
  assert.equal(touched, 0);
  assert.equal(f.releases(), 0);
});

test('close during a pending authenticated reply prevents completion and never sends release', async () => {
  let settle;
  const f = fixture({
    arm: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  });
  const pending = assert.rejects(f.probe.arm(), safe);
  f.probe.close();
  settle({});
  await pending;
  assert.equal(f.releases(), 0);
});

test('close failure is fixed and sticky without another cleanup invocation', () => {
  let closes = 0;
  const f = fixture({
    close() {
      closes++;
      throw Error('PRIVATE');
    },
  });
  assert.throws(() => f.probe.close(), safe);
  assert.throws(() => f.probe.close(), safe);
  assert.equal(closes, 1);
});

test('sending has its own exact two-version and ordinal headroom while unsupported targets reject', async () => {
  const f = fixture(
    {},
    { ...observed, callOrdinal: 1022 },
    { ...config, revision: Number.MAX_SAFE_INTEGER - 2 },
    'sending'
  );
  await f.probe.arm();
  const held = await f.probe.waitHeld();
  assert.equal(held.boundary, 'sending-durable-store-before-host-ack');
  assert.equal(held.expectedRevision, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(held.revision, Number.MAX_SAFE_INTEGER);
  await f.probe.release();
  f.probe.close();
  for (const transition of [null, '', 'uncertain', {}, 'unknown'])
    assert.throws(() => fixture({}, observed, config, transition), safe);
  assert.throws(
    () => fixture({}, observed, { ...config, revision: Number.MAX_SAFE_INTEGER - 1 }, 'sending'),
    safe
  );
  assert.throws(() => fixture({}, { ...observed, callOrdinal: 1023 }, config, 'sending'), safe);
});

test('finished target reserves three exact revisions and both predecessor ordinals', async () => {
  const f = fixture(
    {},
    { ...observed, callOrdinal: 1021 },
    { ...config, revision: Number.MAX_SAFE_INTEGER - 3 },
    'transport-finished'
  );
  await f.probe.arm();
  const held = await f.probe.waitHeld();
  assert.equal(held.boundary, 'transport-finished-durable-store-before-host-ack');
  assert.equal(held.revision, Number.MAX_SAFE_INTEGER);
  await f.probe.release();
  f.probe.close();
  assert.throws(
    () =>
      fixture(
        {},
        observed,
        { ...config, revision: Number.MAX_SAFE_INTEGER - 2 },
        'transport-finished'
      ),
    safe
  );
  assert.throws(
    () => fixture({}, { ...observed, callOrdinal: 1022 }, config, 'transport-finished'),
    safe
  );
});

function terminalFixture(transition, change = (_kind, value) => value) {
  const delta = transition === 'withdrawn' ? 2 : 3;
  let target,
    triggerReleases = 0,
    releases = 0;
  const line = (kind) =>
    change(kind, {
      version: 1,
      pid: config.pid,
      epoch: 'b'.repeat(32),
      challenge: 'c'.repeat(32),
      ...target,
      kind,
      callOrdinal:
        observed.callOrdinal +
        (kind === 'armed-cancel' ? 0 : kind === 'trigger-held' ? delta - 1 : delta),
      holdChallenge:
        kind === 'armed-cancel' ? '' : kind === 'trigger-held' ? 'e'.repeat(32) : 'd'.repeat(32),
      revision: config.revision + delta - (kind === 'held' || kind === 'released' ? 0 : 1),
    });
  const control = {
    arm: async () => {
      throw Error('wrong route');
    },
    armCancellation: async (value) => {
      target = value;
      return line('armed-cancel');
    },
    waitTriggerHeld: async () => line('trigger-held'),
    releaseTrigger() {
      triggerReleases++;
    },
    waitHeld: async () => line('held'),
    release() {
      releases++;
    },
    waitReleased: async () => line('released'),
    close() {},
  };
  return {
    probe: createPreparedAckProbe(config, observed, control, transition),
    triggerReleases: () => triggerReleases,
    releases: () => releases,
    delta,
  };
}
test('terminal probes bind cancellation evidence between predecessor and final exact ACK', async () => {
  for (const transition of ['withdrawn', 'uncertain']) {
    const f = terminalFixture(transition);
    await f.probe.arm();
    const trigger = await f.probe.waitTriggerHeld();
    assert.equal(trigger.revision, config.revision + f.delta - 1);
    assert.equal(trigger.terminalDurableAck, false);
    await f.probe.releaseTrigger({ cancelled: true, clientTransportClosed: true, publicBytes: 0 });
    const held = await f.probe.waitHeld();
    assert.equal(held.revision, config.revision + f.delta);
    assert.equal(held.hostAckDelivered, false);
    await f.probe.release();
    assert.equal(f.triggerReleases(), 1);
    assert.equal(f.releases(), 1);
    f.probe.close();
  }
});
test('terminal probes reject skipped cancellation, false witnesses, revision drift and nonce reuse', async () => {
  const skipped = terminalFixture('withdrawn');
  await skipped.probe.arm();
  await assert.rejects(skipped.probe.waitHeld(), safe);
  for (const witness of [
    null,
    {},
    { cancelled: false, clientTransportClosed: true, publicBytes: 0 },
    { cancelled: true, clientTransportClosed: false, publicBytes: 0 },
    { cancelled: true, clientTransportClosed: true, publicBytes: 1 },
  ]) {
    const f = terminalFixture('withdrawn');
    await f.probe.arm();
    await f.probe.waitTriggerHeld();
    await assert.rejects(f.probe.releaseTrigger(witness), safe);
    assert.equal(f.triggerReleases(), 0);
  }
  for (const patch of [{ revision: 99 }, { callOrdinal: 1 }, { holdChallenge: 'e'.repeat(32) }]) {
    const f = terminalFixture('uncertain', (kind, value) =>
      kind === 'held' ? { ...value, ...patch } : value
    );
    await f.probe.arm();
    await f.probe.waitTriggerHeld();
    await f.probe.releaseTrigger({ cancelled: true, clientTransportClosed: true, publicBytes: 0 });
    await assert.rejects(f.probe.waitHeld(), safe);
    assert.equal(f.releases(), 0);
  }
});
test('fulfilled signal data with a later then getter is rejected without executing it', async () => {
  let touched = 0;
  const f = fixture({
    arm(value) {
      const data = {
        version: 1,
        pid: 123,
        epoch: 'b'.repeat(32),
        challenge: 'c'.repeat(32),
        ...value,
        kind: 'armed',
        holdChallenge: '',
        revision: value.expectedRevision,
      };
      const pending = Promise.resolve(data);
      Object.defineProperty(data, 'then', {
        get() {
          touched++;
          throw Error('PRIVATE');
        },
      });
      return pending;
    },
  });
  await assert.rejects(f.probe.arm(), safe);
  assert.equal(touched, 0);
});

test('publication routes keep cancellation separate from completed public transport and reject non-enum inputs', () => {
  const {
    publicationTransitionRoute,
  } = require('../../scripts/context-hosted/n09-business/publication-transition-route');
  for (const transition of [
    'prepared',
    'sending',
    'transport-finished',
    'withdrawn',
    'uncertain',
  ]) {
    const route = publicationTransitionRoute(transition);
    assert.equal(Object.isFrozen(route), true);
    assert.equal(route.publicTransportCompleted, transition === 'transport-finished');
    assert.equal(route.cancellation, ['withdrawn', 'uncertain'].includes(transition));
  }
  let touched = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        touched++;
        throw Error('private');
      },
    }
  );
  for (const value of [
    undefined,
    null,
    '',
    'finished',
    '__proto__',
    'constructor',
    'uncertain\n',
    'x'.repeat(100000),
    3,
    hostile,
  ]) {
    assert.throws(() => publicationTransitionRoute(value), {
      message: 'n09_publication_transition_rejected',
    });
  }
  assert.equal(touched, 0);
});
