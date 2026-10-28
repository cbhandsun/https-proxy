'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requiredCoverageIoWindows } = require('../scripts/lib/coverage-io-windows');

test('coverage windows keep the legacy proxy and serial client profiles and explicitly select one native proxy window', () => {
  const legacy = requiredCoverageIoWindows({ HPM_COVERAGE_IO_STAGE: 'proxy' });
  assert.deepEqual(legacy, ['client-context-target']);
  assert.equal(Object.isFrozen(legacy), true);
  assert.deepEqual(requiredCoverageIoWindows({ HPM_COVERAGE_IO_STAGE: 'client' }), [
    'client-context-target',
    'publication-graceful-http',
  ]);
  assert.deepEqual(
    requiredCoverageIoWindows({
      HPM_COVERAGE_IO_STAGE: 'proxy',
      HPM_COVERAGE_IO_PROXY_WINDOW: 'native-publication-interruption',
    }),
    ['native-publication-interruption']
  );
  assert.deepEqual(
    requiredCoverageIoWindows({
      HPM_COVERAGE_IO_STAGE: 'proxy',
      HPM_COVERAGE_IO_PROXY_WINDOW: 'publication-graceful-http',
    }),
    ['publication-graceful-http']
  );
  assert.deepEqual(
    requiredCoverageIoWindows({
      HPM_COVERAGE_IO_STAGE: 'proxy',
      HPM_COVERAGE_IO_PROXY_WINDOW: 'publication-interruption',
    }),
    ['publication-interruption']
  );
});

test('coverage window selection refuses empty, foreign, inherited, extreme and hostile inputs without hooks', () => {
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw Error('PRIVATE');
  };
  const hostile = { toString: trap, [Symbol.toPrimitive]: trap };
  const base = { HPM_COVERAGE_IO_STAGE: 'proxy' };
  for (const input of [
    null,
    [],
    {},
    '',
    new Proxy(base, { getOwnPropertyDescriptor: trap }),
    Object.create(base),
    ...[null, '', 'PRIVATE', 'x'.repeat(4096), hostile].map((value) => ({
      HPM_COVERAGE_IO_STAGE: value,
    })),
    ...[null, '', 'PRIVATE', '../native', 'x'.repeat(4096), hostile].map((value) => ({
      ...base,
      HPM_COVERAGE_IO_PROXY_WINDOW: value,
    })),
    {
      HPM_COVERAGE_IO_STAGE: 'client',
      HPM_COVERAGE_IO_PROXY_WINDOW: 'native-publication-interruption',
    },
    {
      HPM_COVERAGE_IO_STAGE: 'client',
      HPM_COVERAGE_IO_PROXY_WINDOW: 'publication-graceful-http',
    },
    { HPM_COVERAGE_IO_STAGE: 'client', HPM_COVERAGE_IO_PROXY_WINDOW: 'publication-interruption' },
    Object.defineProperty({ ...base }, 'HPM_COVERAGE_IO_PROXY_WINDOW', {
      enumerable: true,
      get: trap,
    }),
    Object.defineProperty({}, 'HPM_COVERAGE_IO_STAGE', { enumerable: true, get: trap }),
  ])
    assert.throws(() => requiredCoverageIoWindows(input), /coverage_io_window_invalid/);
  assert.equal(hooks, 0);
});
