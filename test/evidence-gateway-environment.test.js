'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseForwardEnvironmentKeys,
  selectEvidenceGatewayEnvironment,
} = require('../scripts/lib/evidence-gateway-environment');
const { parseEvidenceGatewayArguments } = require('../scripts/lib/evidence-gateway-runtime');

test('explicit owner environment names preserve exact synthetic values without copying unrelated variables', () => {
  const environment = {
    MCP_FIXTURE_KEY: 'synthetic-only-credential',
    MCP_FIXTURE_SETTINGS: '中文🙂\nline two',
    UNRELATED_PRIVATE_VALUE: 'must not copy',
  };
  assert.deepEqual(
    { ...selectEvidenceGatewayEnvironment(['MCP_FIXTURE_KEY'], environment) },
    {
      MCP_FIXTURE_KEY: 'synthetic-only-credential',
    }
  );
  assert.equal(
    selectEvidenceGatewayEnvironment(['mcp_fixture_settings'], environment).mcp_fixture_settings,
    environment.MCP_FIXTURE_SETTINGS
  );
  assert.deepEqual({ ...selectEvidenceGatewayEnvironment([], environment) }, {});
  assert.deepEqual(parseForwardEnvironmentKeys([]), []);
  const args = parseEvidenceGatewayArguments([
    '--forward-env',
    'MCP_FIXTURE_KEY',
    '--offload-bytes',
    '16384',
    '--forward-env',
    'MCP_FIXTURE_SETTINGS',
    '--',
    'node',
    'server.cjs',
  ]);
  assert.deepEqual(args.environmentKeys, ['MCP_FIXTURE_KEY', 'MCP_FIXTURE_SETTINGS']);
  assert.equal(args.options.offloadThresholdBytes, 16384);
});

test('environment selection rejects malformed names, duplicates, loader injection, missing and oversized values', () => {
  for (const names of [
    null,
    {},
    [''],
    ['x-y'],
    ['1KEY'],
    ['A'.repeat(65)],
    ['__proto__', '__PROTO__'],
    ['NODE_OPTIONS'],
    ['node_path'],
    ['LD_PRELOAD'],
    ['DYLD_INSERT_LIBRARIES'],
    ['PYTHONPATH'],
    ['BASH_ENV'],
    ['COMSPEC'],
    Array.from({ length: 33 }, (_, i) => 'KEY' + i),
  ])
    assert.throws(
      () => parseForwardEnvironmentKeys(names),
      (error) => error.message === 'invalid_gateway_environment'
    );
  for (const environment of [
    null,
    [],
    {},
    { KEY: '' },
    { KEY: 1 },
    { KEY: '\u0000' },
    { KEY: '\ud800' },
    { KEY: '() { injected; }' },
    { KEY: 'x'.repeat(16385) },
    { KEY: 'one', key: 'two' },
  ])
    assert.throws(
      () => selectEvidenceGatewayEnvironment(['KEY'], environment),
      /invalid_gateway_environment/
    );
  assert.throws(
    () =>
      selectEvidenceGatewayEnvironment(['A', 'B', 'C', 'D', 'E'], {
        A: 'x'.repeat(16384),
        B: 'x'.repeat(16384),
        C: 'x'.repeat(16384),
        D: 'x'.repeat(16384),
        E: 'x',
      }),
    /invalid_gateway_environment/
  );
  for (const args of [
    ['--forward-env', '--', 'node'],
    ['--forward-env', 'NODE_OPTIONS', '--', 'node'],
    ['--forward-env', 'KEY', '--forward-env', 'key', '--', 'node'],
    ['--unknown', 'KEY', '--', 'node'],
    ['--offload-bytes', '1024', '--offload-bytes', '2048', '--', 'node'],
  ])
    assert.throws(
      () => parseEvidenceGatewayArguments(args),
      /invalid_gateway_(?:configuration|environment)/
    );
});

test('environment accessors are not invoked, unrelated credentials are never inspected, and errors contain no values', () => {
  let invoked = 0;
  const environment = Object.defineProperty({ KEY: 'synthetic-not-real-secret' }, 'UNRELATED', {
    get() {
      invoked++;
      return 'never inspect';
    },
  });
  assert.equal(
    selectEvidenceGatewayEnvironment(['KEY'], environment).KEY,
    'synthetic-not-real-secret'
  );
  assert.equal(invoked, 0);
  const getter = Object.defineProperty({}, 'KEY', {
    get() {
      invoked++;
      return 'never inspect';
    },
  });
  assert.throws(
    () => selectEvidenceGatewayEnvironment(['KEY'], getter),
    /invalid_gateway_environment/
  );
  assert.equal(invoked, 0);
  const bad = { KEY: 'synthetic-sensitive-text\u0000' };
  assert.throws(
    () => selectEvidenceGatewayEnvironment(['KEY'], bad),
    (error) => !error.message.includes('synthetic-sensitive-text')
  );
});
