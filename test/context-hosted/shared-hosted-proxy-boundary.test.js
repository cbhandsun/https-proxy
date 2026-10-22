'use strict';

// Pure validation only. No filesystem fixtures, processes, sockets or hosted setup.
const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotOwnData, exact } = require('../../scripts/context-hosted/shared/boundary.js');
const { composeHostedN08 } = require('../../scripts/context-hosted/n08/observed-composition.js');
const { createOwnedN08Adapter } = require('../../scripts/context-hosted/shared/owned-adapter.js');
const { createHostedListener } = require('../../scripts/context-hosted/shared/hosted-listener.js');

function trappedProxy(target) {
  let count = 0;
  const privateError = Object.create(null);
  Object.defineProperty(privateError, 'message', {
    get() {
      count++;
      throw new Error('PRIVATE_MESSAGE');
    },
  });
  const handler = Object.fromEntries(
    ['get', 'getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'apply'].map((name) => [
      name,
      () => {
        count++;
        throw privateError;
      },
    ])
  );
  return { value: new Proxy(target, handler), count: () => count };
}

test('plain own-data snapshot preserves data and rejects accessors without execution', () => {
  const original = Object.assign(Object.create(null), { first: 'pinned', second: 2 });
  const copied = snapshotOwnData(original);
  assert.equal(Object.getPrototypeOf(copied), null);
  assert.deepEqual({ ...copied }, { first: 'pinned', second: 2 });
  original.first = 'changed';
  assert.equal(copied.first, 'pinned');
  for (const name of ['loadedPins', 'onBusinessRequest', 'createSession']) {
    let calls = 0;
    const input = {};
    Object.defineProperty(input, name, {
      enumerable: true,
      get() {
        calls++;
        throw new Error('PRIVATE_GETTER');
      },
    });
    assert.throws(() => snapshotOwnData(input), /^Error: n08_boundary_rejected$/);
    assert.equal(calls, 0);
  }
});

for (const kind of ['record', 'record-field', 'function-field']) {
  test('snapshot and exact reject ' + kind + ' Proxy before every trap', () => {
    const proxy = trappedProxy(kind === 'function-field' ? () => true : { key: 'value' });
    const input = kind === 'record' ? proxy.value : { capability: proxy.value };
    assert.throws(() => snapshotOwnData(input), /^Error: n08_boundary_rejected$/);
    assert.throws(() => exact(input, ['capability']), /^Error: n08_boundary_rejected$/);
    assert.equal(proxy.count(), 0);
  });
}

test('exact schema still rejects missing, extra, symbol and non-enumerable fields', () => {
  for (const input of [
    {},
    { key: 1, extra: 2 },
    { [Symbol('key')]: 1 },
    Object.defineProperty({}, 'key', { value: 1 }),
  ]) {
    assert.throws(() => exact(input, ['key']), /^Error: n08_boundary_rejected$/);
  }
  assert.equal(exact({ key: 1 }, ['key']).key, 1);
});

function compositionInput(loadedPins) {
  return {
    candidate: 'unused',
    ownedRoot: 'unused',
    manifestSha256: 'a'.repeat(64),
    powershellExecutable: 'unused',
    sourcePins: {},
    controllerPins: {},
    loadedPins,
    networkRoot: 'unused',
    caSha256: 'b'.repeat(64),
    leafSha256: 'c'.repeat(64),
    negativeAddress: '10.0.0.1',
    scenario: {},
  };
}

test('hosted composition rejects loadedPins Proxy before Object.keys or filesystem work', async () => {
  const pins = trappedProxy({});
  await assert.rejects(
    composeHostedN08(compositionInput(pins.value)),
    /^Error: n08_boundary_rejected$/
  );
  assert.equal(pins.count(), 0);
});

test('owned adapter rejects Proxy createSession without invocation or network proof use', () => {
  const createSession = trappedProxy(() => true);
  assert.throws(
    () =>
      createOwnedN08Adapter({
        manifestSha256: 'a'.repeat(64),
        createSession: createSession.value,
        scenario: {},
        networkProof: {},
      }),
    /^Error: n08_boundary_rejected$/
  );
  assert.equal(createSession.count(), 0);
});

test('listener refuses Proxy business handler before platform, key or network access', async () => {
  const handler = trappedProxy(() => true);
  await assert.rejects(
    createHostedListener({
      networkRoot: 'unused',
      ownedNode: 'unused',
      negativeAddress: '10.0.0.1',
      onBusinessRequest: handler.value,
    }),
    /^Error: n08_boundary_rejected$/
  );
  assert.equal(handler.count(), 0);
});

test('scenario function Proxy is rejected by exact capability snapshot without invocation', () => {
  const capability = trappedProxy(() => true);
  assert.throws(
    () => exact({ beginRecovery: capability.value }, ['beginRecovery']),
    /^Error: n08_boundary_rejected$/
  );
  assert.equal(capability.count(), 0);
});
