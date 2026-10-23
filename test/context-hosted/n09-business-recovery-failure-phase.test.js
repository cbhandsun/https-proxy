'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recoveryFailurePhase,
} = require('../../scripts/context-hosted/n09-business/recovery-failure-phase');
const names = [
  'httpPreparationFailed',
  'httpRunFailed',
  'httpEncodingFailed',
  'httpPrepareFailed',
  'httpSendingFailed',
  'httpPublishingFailed',
  'httpFinishFailed',
];
const fixture = (counters) => ({
  status: 200,
  body: { contextRecovery: { counters: { responses: counters } } },
});
const zero = () => Object.fromEntries(names.map((name) => [name, 0]));
test('only one validated failure class leaves the local health projection', () => {
  for (const [index, name] of names.entries()) {
    assert.equal(recoveryFailurePhase(fixture({ ...zero(), [name]: 1 })), 217 + index);
    assert.equal(
      recoveryFailurePhase(fixture({ ...zero(), [name]: Number.MAX_SAFE_INTEGER })),
      217 + index
    );
  }
  for (const value of [
    null,
    undefined,
    {},
    [],
    fixture({}),
    fixture(zero()),
    fixture({ ...zero(), httpRunFailed: 1, httpEncodingFailed: 1 }),
  ])
    assert.equal(recoveryFailurePhase(value), 224);
  for (const value of [-1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1, '1', null, {}])
    assert.equal(recoveryFailurePhase(fixture({ ...zero(), httpRunFailed: value })), 224);
  assert.equal(recoveryFailurePhase({ ...fixture(zero()), status: 503 }), 224);
});
test('projection rejects getters and proxies without invoking them or disclosing content', () => {
  let touched = 0;
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        touched++;
        throw Error('PRIVATE');
      },
    }
  );
  const getter = {
    get httpRunFailed() {
      touched++;
      throw Error('PRIVATE');
    },
  };
  for (const value of [
    hostile,
    fixture(hostile),
    fixture(getter),
    {
      status: 200,
      get body() {
        touched++;
        throw Error('PRIVATE');
      },
    },
  ])
    assert.equal(recoveryFailurePhase(value), 224);
  assert.equal(touched, 0);
});
