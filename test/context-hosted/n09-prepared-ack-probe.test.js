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
