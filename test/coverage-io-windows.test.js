'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('extra full-suite coverage records the Core request file that failed its five-second gate', () => {
  const workflow = fs
    .readFileSync(
      path.resolve(__dirname, '../.github/workflows/windows-persistent-io-coverage.yml'),
      'utf8'
    )
    .replaceAll('\r\n', '\n');
  const block = workflow.slice(
    workflow.indexOf('      - name: Execute complete original coverage commands')
  );
  const run = block.match(/ {8}run: \|\n((?: {10}[^\n]*\n)+)/);
  assert.ok(run, 'the original complete coverage command must still execute');
  const selector = run[1].match(/\$env:HPM_COVERAGE_IO_PROXY_WINDOW = '([a-z-]+)'/);
  const environment = { HPM_COVERAGE_IO_STAGE: 'proxy' };
  if (selector) environment.HPM_COVERAGE_IO_PROXY_WINDOW = selector[1];
  assert.deepEqual(requiredCoverageIoWindows(environment), ['client-context-target']);
  assert.equal(
    /^\s*Remove-Item Env:\\HPM_COVERAGE_IO_PROXY_WINDOW/m.test(run[1]),
    false,
    'an unset default selector must not fail before serial client coverage'
  );
  const commands = run[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:npm run |node scripts\/check-coverage-io-receipt\.cjs$)/.test(line));
  assert.deepEqual(commands, [
    'npm run test:coverage',
    'node scripts/check-coverage-io-receipt.cjs',
    'npm run test:client:coverage',
    'node scripts/check-coverage-io-receipt.cjs',
    'npm run test:frontend:coverage',
  ]);
});
