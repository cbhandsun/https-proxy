'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createOwnedPublicationAck,
} = require('../../scripts/context-hosted/n09-business/publication-ack-owner');
const resource = (overrides = {}) => ({
  arm: async () => ({}),
  waitHeld: async () => ({}),
  release() {},
  waitReleased: async () => ({}),
  close() {},
  ...overrides,
});
const safe = { message: 'n09_lifecycle_client_failed' };

test('owned ACK capabilities reject executable data and asynchronous ownership validation', () => {
  let touched = 0;
  const accessor = resource();
  Object.defineProperty(accessor, 'arm', {
    enumerable: true,
    get() {
      touched++;
      throw Error('private-content');
    },
  });
  for (const value of [
    null,
    {},
    accessor,
    new Proxy(resource(), {
      ownKeys() {
        touched++;
      },
    }),
    resource({ release: async () => {} }),
    resource({ close: async () => {} }),
  ])
    assert.throws(() => createOwnedPublicationAck(value, () => {}), safe);
  for (const validate of [
    null,
    async () => {},
    function* () {},
    new Proxy(() => {}, {
      apply() {
        touched++;
      },
    }),
  ])
    assert.throws(() => createOwnedPublicationAck(resource(), validate), safe);
  assert.equal(touched, 0);
});

test('unknown thenables and failing validation cannot release or return an ACK capability result', async () => {
  let touched = 0;
  const thenable = {
    then() {
      touched++;
    },
  };
  const client = createOwnedPublicationAck(resource({ arm: () => thenable }), () => {});
  await assert.rejects(client.arm({}), safe);
  assert.throws(() => client.release(), safe);
  client.close();
  const invalidOwner = createOwnedPublicationAck(
    resource({
      release() {
        touched++;
      },
    }),
    () => thenable
  );
  assert.throws(() => invalidOwner.release(), safe);
  invalidOwner.close();
  assert.equal(touched, 0);
});

test('failed synchronous release and close expose only fixed errors and remain sticky', async () => {
  let releases = 0,
    closes = 0;
  const client = createOwnedPublicationAck(
    resource({
      release() {
        releases++;
        throw Error('private-content');
      },
      close() {
        closes++;
        throw Error('private-content');
      },
    }),
    () => {}
  );
  assert.throws(() => client.release(), safe);
  assert.throws(() => client.release(), safe);
  await assert.rejects(client.waitReleased(), safe);
  assert.throws(() => client.close(), safe);
  assert.throws(() => client.close(), safe);
  assert.equal(releases, 1);
  assert.equal(closes, 1);
});

test('cancellation capability is complete and owned; partial or async command extensions are rejected', async () => {
  const resource = {
    arm: async () => ({}),
    waitHeld: async () => ({}),
    release() {},
    waitReleased: async () => ({}),
    close() {},
    armCancellation: async () => ({ armed: true }),
    waitTriggerHeld: async () => ({ held: true }),
    releaseTrigger() {},
  };
  const {
    publicationAckCapability,
  } = require('../../scripts/context-hosted/n09-business/publication-ack-capability');
  assert.equal(publicationAckCapability(resource).cancellation, true);
  const client = createOwnedPublicationAck(resource, () => {});
  assert.deepEqual(await client.armCancellation({}), { armed: true });
  assert.deepEqual(await client.waitTriggerHeld(), { held: true });
  assert.equal(client.releaseTrigger(), undefined);
  client.close();
  const { waitTriggerHeld: omitted, ...partial } = resource;
  assert.ok(omitted);
  assert.throws(() => createOwnedPublicationAck(partial, () => {}), safe);
  assert.throws(
    () => createOwnedPublicationAck({ ...resource, releaseTrigger: async () => {} }, () => {}),
    safe
  );
});
