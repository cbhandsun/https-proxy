'use strict';

const assert = require('assert');
const { createLazyHandlerGroup } = require('../lib/proxy/lazy-handler-group');

let createCount = 0;
const group = createLazyHandlerGroup(['first', 'second'], () => {
  createCount += 1;
  return {
    first: (value) => value + 1,
    second: async (value) => value + 2,
  };
});
assert.strictEqual(group.isInitialized(), false);
assert.strictEqual(createCount, 0);
assert.strictEqual(group.first(2), 3);
assert.strictEqual(group.isInitialized(), true);
assert.strictEqual(createCount, 1);

(async () => {
  assert.strictEqual(await group.second(2), 4);
  assert.strictEqual(createCount, 1);
  assert.throws(() => createLazyHandlerGroup([], () => ({})), /requires handler names/);
  assert.throws(() => createLazyHandlerGroup(['bad-name'], () => ({})), /Invalid/);
  assert.throws(() => createLazyHandlerGroup(['same', 'same'], () => ({})), /duplicate/);
  const invalid = createLazyHandlerGroup(['missing'], () => ({}));
  assert.throws(() => invalid.missing(), /missing function/);
  console.log('[lazy-handler-group.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
