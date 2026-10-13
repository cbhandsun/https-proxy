'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { bindEvidenceGatewayShutdown } = require('../scripts/lib/evidence-gateway-shutdown');

function fakeHost() {
  const host = new EventEmitter();
  const messages = [];
  host.stderr = { write: (message) => messages.push(message) };
  return { host, messages };
}

test('composition root can be imported without loading the MCP SDK', () => {
  const entry = path.resolve(__dirname, '../scripts/start-evidence-mcp-gateway.js');
  const code = [
    "const Module = require('node:module');",
    'const original = Module._load;',
    'Module._load = function (name, ...args) {',
    "  if (name.startsWith('@modelcontextprotocol/sdk/')) throw new Error('SDK loaded before validation');",
    '  return original.call(this, name, ...args);',
    '};',
    `require(${JSON.stringify(entry)});`,
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', code], {
    env: getDefaultEnvironment(),
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, 'importing the composition root must not load the MCP SDK');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('invalid owner configuration fails before SDK imports and never echoes input', () => {
  const entry = path.resolve(__dirname, '../scripts/start-evidence-mcp-gateway.js');
  for (const args of [
    [],
    ['--synthetic-private-flag', 'synthetic-private-value'],
    ['--offload-bytes', 'NaN', '--', process.execPath],
    ['--forward-env', 'NODE_OPTIONS', '--', process.execPath],
  ]) {
    const code = [
      "const Module = require('node:module');",
      'const original = Module._load;',
      'Module._load = function (name, ...args) {',
      "  if (name.startsWith('@modelcontextprotocol/sdk/')) {",
      "    process.stdout.write('unexpected_sdk_import\\n');",
      "    throw new Error('synthetic-private-sdk-error');",
      '  }',
      '  return original.call(this, name, ...args);',
      '};',
      `process.argv = ${JSON.stringify([process.execPath, entry, ...args])};`,
      'Module.runMain();',
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', code], {
      env: getDefaultEnvironment(),
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '', 'invalid configuration must never load the MCP SDK');
    assert.equal(result.stderr, 'evidence_gateway_start_failed\n');
  }
});

test('signal shutdown is idempotent, awaits closure and removes both listeners', async () => {
  const { host, messages } = fakeHost();
  let calls = 0;
  let finish;
  const binding = bindEvidenceGatewayShutdown(
    {
      close() {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    host
  );
  assert.equal(host.listenerCount('SIGINT'), 1);
  host.emit('SIGINT');
  host.emit('SIGTERM');
  const completion = binding.stop();
  assert.equal(binding.stop(), completion);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(host.listenerCount('SIGINT'), 0);
  assert.equal(host.listenerCount('SIGTERM'), 0);
  finish();
  await completion;
  assert.deepEqual(messages, []);
  assert.equal(host.exitCode, undefined);
});

test('shutdown failures remain fixed and cannot expose exception content', async () => {
  const { host, messages } = fakeHost();
  const binding = bindEvidenceGatewayShutdown(
    {
      close() {
        throw new Error('synthetic-private-exception');
      },
    },
    host
  );
  host.emit('SIGTERM');
  await binding.stop();
  assert.deepEqual(messages, ['evidence_gateway_close_failed\n']);
  assert.equal(host.exitCode, 1);
  assert.equal(host.listenerCount('SIGTERM'), 0);
  const other = bindEvidenceGatewayShutdown(
    {
      close() {
        assert.fail('disposed listener executed');
      },
    },
    host
  );
  other.dispose();
  host.emit('SIGINT');
  assert.equal(host.listenerCount('SIGINT'), 0);
});

test(
  'actual CLI startup failures exit nonzero, close their launch transport and emit only a fixed error',
  { timeout: 15000 },
  async (t) => {
    const entry = path.resolve(__dirname, '../scripts/start-evidence-mcp-gateway.js');
    for (const args of [
      ['--', path.resolve(__dirname, 'fixtures/does-not-exist-evidence-gateway.exe')],
      ['--forward-env', 'NODE_OPTIONS', '--', process.execPath],
    ]) {
      const child = spawn(process.execPath, [entry, ...args], {
        env: {
          ...getDefaultEnvironment(),
          ...(process.env.NODE_V8_COVERAGE
            ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }
            : {}),
        },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      });
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, 1);
      assert.equal(stdout, '');
      assert.equal(stderr, 'evidence_gateway_start_failed\n');
    }
  }
);
