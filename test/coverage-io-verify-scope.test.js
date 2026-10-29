'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { coverageIoVerifyScope } = require('../scripts/lib/coverage-io-verify-scope');

const source = (lifecycle = 'test:coverage') => ({
  HPM_COVERAGE_IO_VERIFY_PROXY_ONLY: '1',
  HPM_COVERAGE_IO_STAGE: 'proxy',
  npm_lifecycle_event: lifecycle,
});

test('verify capture scope selects only the original proxy command without changing later tests', () => {
  assert.equal(coverageIoVerifyScope({}), null);
  assert.equal(coverageIoVerifyScope({ HPM_COVERAGE_IO_STAGE: 'client' }), null);
  assert.equal(coverageIoVerifyScope(source()), 'proxy');
  assert.equal(coverageIoVerifyScope(source('test:client:coverage')), 'omit-client');
  assert.equal(coverageIoVerifyScope(Object.assign(Object.create(null), source())), 'proxy');
});

test('verify capture selection rejects unknown, empty, extreme and hostile controls without hooks', () => {
  const safe = { message: 'coverage_io_verify_scope_invalid' };
  for (const mode of ['', '0', 'true', true, 1, null, '1'.repeat(65536)])
    assert.throws(
      () => coverageIoVerifyScope({ ...source(), HPM_COVERAGE_IO_VERIFY_PROXY_ONLY: mode }),
      safe
    );
  for (const lifecycle of [
    '',
    'verify',
    'pretest:coverage',
    'test:unit',
    'TEST:COVERAGE',
    'test:coverage\n',
  ])
    assert.throws(() => coverageIoVerifyScope(source(lifecycle)), safe);
  const missingLifecycle = source();
  delete missingLifecycle.npm_lifecycle_event;
  assert.throws(() => coverageIoVerifyScope(missingLifecycle), safe);
  for (const stage of ['client', '', null, 'proxy\n'])
    assert.throws(() => coverageIoVerifyScope({ ...source(), HPM_COVERAGE_IO_STAGE: stage }), safe);
  let traps = 0;
  const hook = () => {
    traps++;
    throw Error('synthetic hook');
  };
  const proxy = new Proxy({}, { getPrototypeOf: hook, getOwnPropertyDescriptor: hook });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [null, undefined, [], true, Object.create({}), proxy, revoked.proxy])
    assert.throws(() => coverageIoVerifyScope(value), safe);
  for (const key of Object.keys(source())) {
    const getter = Object.defineProperty(source(), key, { enumerable: true, get: hook });
    assert.throws(() => coverageIoVerifyScope(getter), safe);
    const hidden = Object.defineProperty(source(), key, {
      enumerable: false,
      value: source()[key],
    });
    assert.throws(() => coverageIoVerifyScope(hidden), safe);
  }
  assert.equal(traps, 0);
});
