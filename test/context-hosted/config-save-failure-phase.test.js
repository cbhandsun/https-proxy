'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  configSaveFailurePhase,
} = require('../../scripts/context-hosted/shared/config-save-failure-phase.js');

test('rejected config saves reveal only fixed validator, crypto or unknown categories', () => {
  for (const [error, phase] of [
    ['Invalid configuration: PRIVATE_SENTINEL', 196],
    ['secret_encryption_failed', 197],
    ['secret_decryption_failed', 198],
    ['secret_encryption_failed PRIVATE_SENTINEL', 199],
    ['PRIVATE_SENTINEL', 199],
    ['', 199],
  ])
    assert.equal(configSaveFailurePhase({ error }), phase);
});

test('config rejection classification rejects empty, extreme and executable boundaries without traps', () => {
  let traps = 0;
  const accessor = Object.defineProperty({}, 'error', {
    get() {
      traps++;
      throw new Error('PRIVATE_SENTINEL');
    },
  });
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error('PRIVATE_SENTINEL');
      },
      get() {
        traps++;
        throw new Error('PRIVATE_SENTINEL');
      },
    }
  );
  for (const body of [
    undefined,
    null,
    [],
    'PRIVATE_SENTINEL',
    {},
    { error: null },
    { error: {} },
    { error: 'x'.repeat(16385) },
    Object.create({ error: 'secret_encryption_failed' }),
    accessor,
    proxy,
  ])
    assert.equal(configSaveFailurePhase(body), 200);
  assert.equal(configSaveFailurePhase({ error: 'x'.repeat(16384) }), 199);
  assert.equal(traps, 0);
});
