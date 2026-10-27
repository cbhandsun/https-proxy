'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCapacityFailureObserver,
} = require('../scripts/lib/context-recovery-capacity-failure-observer');
const { capacityFailureReceipt } = require('../scripts/lib/context-recovery-capacity-failure');
const primary = {
  operation: 'reply',
  stage: 'reply',
  commandIndex: Number.MAX_SAFE_INTEGER,
  scheduledMs: 86400000,
};

test('observer accepts absence, sends only the first frozen branded token and preserves boundary values', () => {
  const absent = createCapacityFailureObserver();
  absent.notify(primary);
  assert.equal(absent.failed(), false);
  const seen = [];
  const observer = createCapacityFailureObserver((token) => {
    seen.push(token);
  });
  observer.notify(primary);
  observer.notify({ ...primary, commandIndex: 2 });
  assert.equal(seen.length, 1);
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.deepEqual(Reflect.ownKeys(seen[0]), []);
  assert.deepEqual({ ...capacityFailureReceipt(seen[0]).primary }, primary);
  assert.equal(observer.failed(), false);
});

test('invalid callback capabilities reject without invoking proxy traps', () => {
  let touched = 0;
  const proxy = new Proxy(() => {}, {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  for (const value of [
    null,
    false,
    0,
    '',
    {},
    [],
    proxy,
    async () => {},
    function* () {},
    async function* () {},
  ]) {
    assert.throws(() => createCapacityFailureObserver(value), {
      message: 'persistent_capacity_execution_failed',
    });
  }
  assert.equal(touched, 0);
});

test('throwing, asynchronous and nonempty callback returns latch failure without executing thenable getters', async () => {
  let touched = 0;
  const thenable = Object.defineProperty({}, 'then', {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  for (const callback of [
    () => {
      throw Error('PRIVATE');
    },
    () => null,
    () => false,
    () => thenable,
    () => Promise.reject(Error('PRIVATE')),
    () => Promise.resolve(),
  ]) {
    const observer = createCapacityFailureObserver(callback);
    observer.notify(primary);
    assert.equal(observer.failed(), true);
    observer.notify(primary);
    assert.equal(observer.failed(), true);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(touched, 0);
});
