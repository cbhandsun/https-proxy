'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertSyntheticProfileReadback: check,
} = require('../../scripts/context-hosted/n09-business/synthetic-profile-readback.js');
const profiles = () => [
  {
    id: 'n09-synthetic',
    name: 'N09 synthetic',
    protocol: 'openai',
    targetUrl: 'https://api.openai.com/v1',
    apiKey: '[redacted]',
    authMode: 'api-key',
  },
  {
    id: 'tianxi-official',
    name: 'Tianxi Official',
    protocol: 'tianxi',
    targetUrl: 'http://127.0.0.1:49305',
    apiKey: null,
    authMode: 'official-login',
  },
  {
    id: 'workbuddy-official',
    name: 'WorkBuddy Official',
    protocol: 'workbuddy',
    targetUrl: 'https://copilot.tencent.com/v2',
    apiKey: null,
    authMode: 'official-login',
  },
];
const rejected = (input) =>
  assert.throws(() => check(input), /^Error: n09_synthetic_profiles_invalid$/);

test('effective profile readback accepts exactly canonical defaults and a redacted synthetic profile in any order', () => {
  const input = profiles();
  const before = JSON.stringify(input);
  assert.equal(check(input), true);
  assert.equal(JSON.stringify(input), before);
  assert.equal(check(input.reverse()), true);
  assert.equal(
    check(input.map((value) => Object.freeze(Object.assign(Object.create(null), value)))),
    true
  );
});

test('profile readback rejects missing, duplicate, extra, sparse and oversized collections', () => {
  for (const input of [
    null,
    undefined,
    false,
    '',
    {},
    [],
    profiles().slice(0, 1),
    [...profiles(), profiles()[0]],
    [profiles()[0], profiles()[0], profiles()[2]],
    new Array(3),
    new Array(1000000),
  ])
    rejected(input);
  const input = profiles();
  input.extra = true;
  rejected(input);
  delete input.extra;
  input[Symbol('extra')] = true;
  rejected(input);
});

test('every profile field is pinned and credentialed defaults or unredacted synthetic secrets are rejected', () => {
  for (let index = 0; index < 3; index++) {
    for (const key of Object.keys(profiles()[index])) {
      for (const value of [undefined, null, '', 'PRIVATE_SENTINEL', 1, {}]) {
        const input = profiles();
        if (input[index][key] === value) continue;
        input[index][key] = value;
        rejected(input);
      }
      const missing = profiles();
      delete missing[index][key];
      rejected(missing);
    }
    const extra = profiles();
    extra[index].token = 'PRIVATE_SENTINEL';
    rejected(extra);
  }
});

test('profile validation never executes getters, proxy traps or inherited values and has a fixed failure', () => {
  let traps = 0;
  const trap = () => {
    traps++;
    throw new Error('PRIVATE_SENTINEL');
  };
  const proxy = new Proxy([], { get: trap, getPrototypeOf: trap, ownKeys: trap });
  rejected(proxy);
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  rejected(revoked.proxy);
  for (let index = 0; index < 3; index++) {
    const input = profiles();
    input[index] = new Proxy(input[index], { get: trap, getPrototypeOf: trap, ownKeys: trap });
    rejected(input);
    const getter = profiles();
    Object.defineProperty(getter[index], 'id', { get: trap });
    rejected(getter);
    const arrayGetter = profiles();
    Object.defineProperty(arrayGetter, String(index), { get: trap });
    rejected(arrayGetter);
    const inherited = profiles();
    inherited[index] = Object.create(inherited[index]);
    rejected(inherited);
  }
  assert.equal(traps, 0);
});
