'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recoveryFailurePhase,
  recoveryAdmissionFailurePhase,
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
test('missing-read classification uses only validated aggregate admission counters', () => {
  const counters = { ...zero(), bound: 4, bindingUnavailable: 0, completed: 1 };
  assert.equal(recoveryAdmissionFailurePhase(fixture(counters)), 202);
  assert.equal(recoveryAdmissionFailurePhase(fixture({ ...counters, bound: 3 })), 210);
  assert.equal(recoveryAdmissionFailurePhase(fixture({ ...counters, bindingUnavailable: 1 })), 200);
  assert.equal(
    recoveryAdmissionFailurePhase(fixture({ ...counters, bound: Number.MAX_SAFE_INTEGER })),
    202
  );
  for (const key of ['bound', 'bindingUnavailable', 'completed']) {
    for (const invalid of [
      undefined,
      null,
      -1,
      1.5,
      Infinity,
      NaN,
      '4',
      {},
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.equal(recoveryAdmissionFailurePhase(fixture({ ...counters, [key]: invalid })), 224);
    }
  }
  for (const value of [
    null,
    {},
    [],
    fixture({}),
    fixture({ ...counters, completed: 0 }),
    fixture({ ...counters, httpRunFailed: 1, httpFinishFailed: 1 }),
    { ...fixture(counters), status: 503 },
  ]) {
    assert.equal(recoveryAdmissionFailurePhase(value), 224);
  }
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
    ...counters,
    get bound() {
      touched++;
      throw Error('PRIVATE');
    },
  };
  for (const value of [hostile, fixture(hostile), fixture(getter)]) {
    assert.equal(recoveryAdmissionFailurePhase(value), 224);
  }
  assert.equal(touched, 0);
});
test('missing READ preserves a unique HTTP publication failure before admission fallback', () => {
  for (const [index, name] of names.entries()) {
    for (const completed of [0, 1]) {
      assert.equal(
        recoveryAdmissionFailurePhase(
          fixture({ ...zero(), bound: 3, bindingUnavailable: 1, completed, [name]: 1 })
        ),
        217 + index
      );
    }
  }
});
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
