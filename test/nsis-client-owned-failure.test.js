'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OWNED_STOP_CODES,
  OWNED_STOP_PHASES,
  createOwnedStopFailure,
  ownedStopFailure,
  carryOwnedStopFailure,
} = require('../scripts/lib/nsis-client-owned-failure');

test('owned stop diagnostics transfer only module-attested finite failures', () => {
  assert.equal(Object.isFrozen(OWNED_STOP_CODES), true);
  assert.equal(Object.isFrozen(OWNED_STOP_PHASES), true);
  assert.equal(new Set(OWNED_STOP_CODES).size, 21);
  for (const code of OWNED_STOP_CODES) {
    const failure = createOwnedStopFailure(code);
    assert.equal(failure.message, 'nsis_client_owned_failed');
    assert.equal(failure.code, code);
    assert.equal(ownedStopFailure(failure), code);
    const wrapper = carryOwnedStopFailure(new Error('generic failure'), failure);
    assert.equal(ownedStopFailure(wrapper), code);
    assert.equal(Object.hasOwn(wrapper, 'code'), false);
    assert.equal(ownedStopFailure({ ...failure }), null);
    assert.equal(ownedStopFailure(Object.assign(new Error('forged'), { code })), null);
  }
  const first = createOwnedStopFailure(OWNED_STOP_CODES[0]);
  carryOwnedStopFailure(first, createOwnedStopFailure(OWNED_STOP_CODES[1]));
  assert.equal(ownedStopFailure(first), OWNED_STOP_CODES[0]);
  first.code = 'PRIVATE forged field';
  assert.equal(ownedStopFailure(first), OWNED_STOP_CODES[0]);
});

test('owned stop diagnostics reject unknown values and never evaluate exception hooks', () => {
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error('PRIVATE');
      },
      ownKeys() {
        traps++;
        throw Error('PRIVATE');
      },
      getPrototypeOf() {
        traps++;
        throw Error('PRIVATE');
      },
    }
  );
  const getter = Object.defineProperty({}, 'code', {
    get() {
      traps++;
      throw Error('PRIVATE');
    },
  });
  for (const value of [undefined, null, '', false, 0, [], {}, getter, hostile]) {
    assert.equal(ownedStopFailure(value), null);
    const wrapper = new Error('generic');
    assert.equal(carryOwnedStopFailure(wrapper, value), wrapper);
    assert.equal(ownedStopFailure(wrapper), null);
    assert.throws(() => createOwnedStopFailure(value));
  }
  for (const value of [
    'PRIVATE',
    'nsis_owned_stop_controller_unsafe',
    'nsis_owned_stop_timeout\nPRIVATE',
    'x'.repeat(65536),
  ])
    assert.throws(() => createOwnedStopFailure(value));
  assert.throws(() => carryOwnedStopFailure(hostile, createOwnedStopFailure(OWNED_STOP_CODES[0])));
  assert.equal(traps, 0);
});
