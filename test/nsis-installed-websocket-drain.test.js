'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createInstalledWebSocketDrain,
  parseInstalledWebSocketDrainEvidence,
} = require('../scripts/lib/nsis-installed-websocket-drain');
const options = () => ({
  client: 'codex',
  mode: 'default',
  model: 'hpm-installed-codex',
  entryToken: 'hpm-synthetic-' + 'a'.repeat(32),
  upstreamToken: 'hpm-upstream-' + 'b'.repeat(32),
});
const evidence = () => ({
  protocol: 'responses',
  unauthorizedUpgradeRefused: true,
  partialFrames: 5,
  terminalFrames: 0,
  clientClosed: true,
  upstreamClosed: true,
});

test('close evidence requires exact observed prefix, no terminal event and both closed peers', () => {
  assert.deepEqual(parseInstalledWebSocketDrainEvidence(evidence()), evidence());
  let reads = 0;
  const getter = Object.defineProperty({ ...evidence() }, 'clientClosed', {
    enumerable: true,
    get() {
      reads++;
      throw Error('PRIVATE_SENTINEL');
    },
  });
  const proxy = new Proxy(evidence(), {
    get() {
      reads++;
      throw Error('PRIVATE_SENTINEL');
    },
    ownKeys() {
      reads++;
      throw Error('PRIVATE_SENTINEL');
    },
  });
  for (const input of [
    null,
    [],
    {},
    '',
    getter,
    proxy,
    { ...evidence(), extra: true },
    ...[0, 4, 6, -1, Number.MAX_SAFE_INTEGER, NaN, Infinity, '5'].map((partialFrames) => ({
      ...evidence(),
      partialFrames,
    })),
    ...[1, -1, NaN, '0'].map((terminalFrames) => ({ ...evidence(), terminalFrames })),
    ...[false, null, 'true', 1].flatMap((value) => [
      { ...evidence(), clientClosed: value },
      { ...evidence(), upstreamClosed: value },
    ]),
    { ...evidence(), protocol: 'realtime' },
    { ...evidence(), unauthorizedUpgradeRefused: false },
  ])
    assert.throws(() => parseInstalledWebSocketDrainEvidence(input));
  assert.equal(reads, 0);
});

test('empty, unsupported, executable or real-provider probe inputs are rejected before network use', () => {
  let reads = 0;
  const getter = Object.defineProperty({ ...options() }, 'entryToken', {
    enumerable: true,
    get() {
      reads++;
      throw Error('PRIVATE_SENTINEL');
    },
  });
  for (const input of [
    null,
    {},
    [],
    getter,
    new Proxy(options(), {}),
    { ...options(), client: 'claude' },
    { ...options(), model: 'gpt-real' },
    { ...options(), entryToken: 'x'.repeat(1000000) },
  ])
    assert.throws(() => createInstalledWebSocketDrain(input));
  assert.equal(reads, 0);
});

test('invalid ports and wrong ordering cannot create a stop or completion capability', async () => {
  const probe = createInstalledWebSocketDrain(options());
  for (const port of [
    0,
    1,
    1023,
    65536,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    '3000',
    null,
    new Proxy({}, {}),
  ])
    await assert.rejects(probe.open(port));
  assert.throws(() => probe.beginStop());
  await assert.rejects(probe.verifyClosed());
  assert.equal(await probe.close(), true);
  assert.equal(probe.close(), probe.close());
  await assert.rejects(probe.open(3000));
  assert.throws(() =>
    probe.prepare({ path: '/v1/responses', authorization: 'Bearer ' + options().upstreamToken })
  );
});

test('malformed handshake authorities do not execute fields or become reusable after rejection', async () => {
  let reads = 0;
  for (const input of [
    null,
    {},
    Object.defineProperty({}, 'authorization', {
      enumerable: true,
      get() {
        reads++;
        throw Error('PRIVATE_SENTINEL');
      },
    }),
    new Proxy(
      {},
      {
        get() {
          reads++;
          throw Error('PRIVATE_SENTINEL');
        },
      }
    ),
    { path: '/v1/responses', authorization: 'wrong' },
  ]) {
    const probe = createInstalledWebSocketDrain(options());
    assert.throws(() => probe.prepare(input));
    assert.throws(() =>
      probe.prepare({ path: '/v1/responses', authorization: 'Bearer ' + options().upstreamToken })
    );
    assert.equal(await probe.close(), true);
  }
  assert.equal(reads, 0);
});
