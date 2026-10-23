'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  managementFailurePhase,
} = require('../../scripts/context-hosted/shared/management-failure-phase.js');

test('management failure classifier emits fixed codes without reading supplied error content', () => {
  assert.equal(managementFailurePhase({ code: 'HPM_DAEMON_HTTP_DEADLINE' }), 185);
  let traps = 0;
  const getter = {
    get code() {
      traps++;
      throw new Error('PRIVATE');
    },
  };
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error('PRIVATE');
      },
    }
  );
  for (const value of [
    null,
    undefined,
    0,
    '',
    'HPM_DAEMON_HTTP_DEADLINE',
    [],
    {},
    { code: 'PRIVATE' },
    Object.create({ code: 'HPM_DAEMON_HTTP_DEADLINE' }),
    getter,
    proxy,
  ]) {
    assert.equal(managementFailurePhase(value), 186);
  }
  assert.equal(traps, 0);
});
