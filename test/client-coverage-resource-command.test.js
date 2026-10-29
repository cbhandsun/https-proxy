'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  clientCoverageResourceArguments: argumentsFor,
} = require('../scripts/lib/client-coverage-resource-command');
const command = require('../package.json').scripts['test:client:coverage'];

test('resource probe retains the entire coverage command and changes only file concurrency', () => {
  const baseline = argumentsFor(command, 4);
  const serial = argumentsFor(command, 1);
  assert.deepEqual(
    serial.map((word) => (word === '--test-concurrency=1' ? '--test-concurrency=4' : word)),
    baseline
  );
  assert.equal(
    baseline.filter((word) => word.endsWith('.test.js')).length,
    serial.filter((word) => word.endsWith('.test.js')).length
  );
  assert.ok(baseline.includes('lib/proxy/context-recovery-*.js'));
  assert.ok(baseline.includes('--check-coverage'));
  assert.ok(baseline.includes('test/client-context-target.test.js'));
  const parallelCommand = command.replace('--test-concurrency=1', '--test-concurrency=4');
  assert.deepEqual(argumentsFor(parallelCommand, 1), serial);
  assert.deepEqual(argumentsFor(parallelCommand, 4), baseline);
});

test('resource probe refuses malformed script text and unsupported selections without coercion', () => {
  let touched = 0;
  const hostile = {
    toString() {
      touched++;
      throw Error('private');
    },
  };
  for (const input of [
    null,
    {},
    hostile,
    '',
    'x'.repeat(32769),
    command + '\n',
    command + ' && private',
    command.replace(' --test ', ' --test-only '),
    command.replace('--test-concurrency=1', '--test-concurrency=2'),
    command.replace('--test-concurrency=1', '--test-concurrency=4 --test-concurrency=1'),
    command.replace('c8 ', 'private '),
    command + ' "unterminated',
  ])
    assert.throws(() => argumentsFor(input, 1), /invalid_client_coverage_resource_probe/);
  for (const concurrency of [undefined, null, '1', 0, 2, 8, NaN, Infinity, hostile])
    assert.throws(
      () => argumentsFor(command, concurrency),
      /invalid_client_coverage_resource_probe/
    );
  assert.equal(touched, 0);
});

test('resource diagnostic refuses local execution before starting client or storage tests', () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../scripts/diagnose-client-coverage-resources.js'), '1'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' },
    }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'client_coverage_resource_probe_failed\n');
});
