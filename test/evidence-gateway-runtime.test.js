'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  digest,
  regularArtifactFile,
  readEvidenceGatewayArtifact,
} = require('../scripts/lib/evidence-gateway-artifact');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { bindEvidenceGatewayShutdown } = require('../scripts/lib/evidence-gateway-shutdown');

function fakeHost() {
  const host = new EventEmitter();
  host.stdin = new EventEmitter();
  const messages = [];
  host.stderr = { write: (message) => messages.push(message) };
  return { host, messages };
}

function artifactFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-gateway-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, bytes) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  const inputs = [
    'package.json',
    'package-lock.json',
    'scripts/lib/evidence-gateway-runtime.js',
  ].map((file) => {
    write(file, '{}');
    return { file, sha256: digest('{}') };
  });
  const bundle = Buffer.from('module.exports = {};\n');
  const manifest = {
    schemaVersion: 1,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    bundleSha256: digest(bundle),
    inputs,
  };
  const relative = `runtime/evidence-gateway/gateway-${manifest.bundleSha256}.cjs`;
  write(relative, bundle);
  const publish = (value = manifest) =>
    write('runtime/evidence-gateway/manifest.json', JSON.stringify(value));
  publish();
  return { root, write, publish, manifest, relative };
}

test('gateway artifact validates source, lock, Node version and immutable bundle before selection', (t) => {
  const fixture = artifactFixture(t);
  const result = readEvidenceGatewayArtifact(fixture.root);
  assert.equal(result.file, path.join(fixture.root, fixture.relative));
  assert.deepEqual(JSON.parse(JSON.stringify(result.manifest)), fixture.manifest);
  assert.equal(Object.getPrototypeOf(result.manifest), null);
  result.manifest.inputs[0].sha256 = '0'.repeat(64);
  assert.equal(readEvidenceGatewayArtifact(fixture.root).manifest.inputs[0].sha256, digest('{}'));
  for (const file of fixture.manifest.inputs.map((row) => row.file)) {
    fixture.write(file, 'changed');
    assert.throws(() => readEvidenceGatewayArtifact(fixture.root), {
      message: 'evidence_gateway_artifact_unavailable',
    });
    fixture.write(file, '{}');
  }
  fixture.write(fixture.relative, 'corrupt');
  assert.throws(() => readEvidenceGatewayArtifact(fixture.root), {
    message: 'evidence_gateway_artifact_unavailable',
  });
  fixture.publish({ ...fixture.manifest, nodeMajor: fixture.manifest.nodeMajor + 1 });
  assert.throws(() => readEvidenceGatewayArtifact(fixture.root), {
    message: 'evidence_gateway_artifact_unavailable',
  });
});

test('prepared gateway bundle retains the runtime source map for child-process coverage attribution', () => {
  const root = path.resolve(__dirname, '..');
  const artifact = readEvidenceGatewayArtifact(root);
  const bytes = fs.readFileSync(artifact.file, 'utf8');
  const marker = '//# sourceMappingURL=data:application/json;charset=utf-8;base64,';
  const start = bytes.lastIndexOf(marker);
  assert.ok(start >= 0, 'published bundle must contain its inline source map');
  assert.equal(bytes.split('sourceMappingURL=').length - 1, 1, 'publish one source map');
  const map = JSON.parse(
    Buffer.from(bytes.slice(start + marker.length).trim(), 'base64').toString('utf8')
  );
  const source = path.join(root, 'scripts/lib/evidence-gateway-runtime.js');
  const index = map.sources.findIndex(
    (relative) => path.resolve(path.dirname(artifact.file), relative) === source
  );
  assert.ok(index >= 0, 'runtime source must map to the real source path');
  assert.equal(map.sourcesContent[index], fs.readFileSync(source, 'utf8'));
});

test('gateway artifact rejects malformed, missing, oversized and unsafe manifests with a fixed error', (t) => {
  const fixture = artifactFixture(t);
  const { manifest } = fixture;
  const invalid = [
    null,
    [],
    '',
    1,
    {},
    { ...manifest, extra: true },
    { ...manifest, schemaVersion: 2 },
    { ...manifest, bundleSha256: '../private' },
    { ...manifest, inputs: [] },
    { ...manifest, inputs: Array(513).fill(manifest.inputs[0]) },
    { ...manifest, inputs: [manifest.inputs[0], manifest.inputs[0], manifest.inputs[2]] },
    { ...manifest, inputs: [...manifest.inputs, { file: '../private.js', sha256: digest('') }] },
    {
      ...manifest,
      inputs: [...manifest.inputs, { file: 'scripts/../private.js', sha256: digest('') }],
    },
    { ...manifest, inputs: [...manifest.inputs, { file: 'lib//private.js', sha256: digest('') }] },
    { ...manifest, inputs: [...manifest.inputs, { file: 'lib/private.js', sha256: 'invalid' }] },
    { ...manifest, inputs: [...manifest.inputs, null] },
    { ...manifest, inputs: [...manifest.inputs, { ...manifest.inputs[0], extra: true }] },
    {
      ...manifest,
      inputs: manifest.inputs
        .filter((row) => row.file !== 'package-lock.json')
        .concat({ file: 'lib/other.js', sha256: digest('') }),
    },
  ];
  for (const value of invalid) {
    fixture.publish(value);
    assert.throws(() => readEvidenceGatewayArtifact(fixture.root), {
      message: 'evidence_gateway_artifact_unavailable',
    });
  }
  for (const bytes of [
    '',
    '{',
    'x'.repeat(256 * 1024 + 1),
    '{"__proto__":{"private":"synthetic"}}',
  ]) {
    fixture.write('runtime/evidence-gateway/manifest.json', bytes);
    assert.throws(() => readEvidenceGatewayArtifact(fixture.root), {
      message: 'evidence_gateway_artifact_unavailable',
    });
  }
  fixture.publish();
  fs.unlinkSync(path.join(fixture.root, fixture.relative));
  assert.throws(() => readEvidenceGatewayArtifact(fixture.root), {
    message: 'evidence_gateway_artifact_unavailable',
  });
  assert.throws(() => readEvidenceGatewayArtifact('relative'), {
    message: 'evidence_gateway_artifact_unavailable',
  });
});

test('artifact reads reject path escapes, directories, size overflows and symlinked ancestors', (t) => {
  const fixture = artifactFixture(t);
  for (const relative of [
    '',
    '/package.json',
    '../package.json',
    './package.json',
    'lib/../../package.json',
    'lib\\private.js',
    'package.json\0',
  ]) {
    assert.throws(() => regularArtifactFile(fixture.root, relative, 1024));
  }
  assert.throws(() => regularArtifactFile(fixture.root, 'scripts', 1024));
  assert.throws(() => regularArtifactFile(fixture.root, 'package.json', 1));
  for (const maximum of [undefined, null, 0, -1, Infinity, 8 * 1024 * 1024 + 1])
    assert.throws(() => regularArtifactFile(fixture.root, 'package.json', maximum));
  const target = path.join(fixture.root, 'linked-target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'file.js'), 'synthetic');
  fs.symlinkSync(
    target,
    path.join(fixture.root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  assert.throws(() => regularArtifactFile(fixture.root, 'linked/file.js', 1024));
});

test(
  'source runtime API discovers tools, executes once and owns downstream cleanup',
  { timeout: 15000 },
  async (t) => {
    const client = new Client({ name: 'source-runtime-api-fixture', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(__dirname, 'fixtures/evidence-gateway-runtime-entry.cjs'),
        '--',
        process.execPath,
        path.join(__dirname, 'fixtures/evidence-gateway-source-mcp.cjs'),
      ],
      env: process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {},
      stderr: 'pipe',
    });
    transport.stderr.on('data', () => {});
    const sourceProcess = { pid: null };
    t.after(async () => {
      await client.close();
      if (sourceProcess.pid) {
        try {
          process.kill(sourceProcess.pid);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 4);
    const response = await client.callTool({ name: 'fresh_source' });
    const result = JSON.parse(response.content[0].text);
    const sourcePid = result.pid;
    sourceProcess.pid = sourcePid;
    assert.equal(result.calls, 1);
    assert.ok(Number.isSafeInteger(sourcePid));
    const child = transport._process;
    assert.ok(child?.stdin);
    const closed = new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal }))
    );
    let timer;
    child.stdin.end();
    const outcome = await Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 3000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.deepEqual(outcome, { code: 0, signal: null });
    assert.throws(() => process.kill(sourcePid, 0), { code: 'ESRCH' });
  }
);

test('source runtime API startup failure closes transport and exposes a fixed error', () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'fixtures/evidence-gateway-runtime-entry.cjs'),
      '--',
      path.join(__dirname, 'fixtures/does-not-exist-evidence-gateway.exe'),
    ],
    {
      env: {
        ...getDefaultEnvironment(),
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      },
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 15000,
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'evidence_gateway_start_failed\n');
});

test('gateway build CLI rejects unknown arguments before building and never echoes them', () => {
  for (const args of [['--synthetic-private-value'], ['--', 'synthetic-private-value']]) {
    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../scripts/prepare-evidence-gateway.js'), ...args],
      {
        env: getDefaultEnvironment(),
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 15000,
      }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'evidence_gateway_build_failed\n');
  }
});

test(
  'actual initialized gateway exits on host EOF and reaps its downstream',
  { timeout: 15000 },
  async (t) => {
    const started = performance.now();
    const phases = [];
    const phase = (name) =>
      phases.push({ phase: name, elapsedMs: Math.round(performance.now() - started) });
    t.after(() => t.diagnostic(JSON.stringify({ gatewayEof: phases })));
    phase('host_started');
    const client = new Client({ name: 'eof-fixture', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve(__dirname, '../scripts/start-evidence-mcp-gateway.js'),
        '--',
        process.execPath,
        path.resolve(__dirname, 'fixtures/evidence-gateway-source-mcp.cjs'),
      ],
      env: process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {},
      stderr: 'pipe',
    });
    transport.stderr.on('data', () => {});
    const sourceProcess = { pid: null };
    t.after(async () => {
      await client.close();
      if (sourceProcess.pid) {
        try {
          process.kill(sourceProcess.pid);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    });
    phase('connect_started');
    await client.connect(transport);
    phase('connected');
    assert.equal((await client.listTools()).tools.length, 4);
    phase('catalog_received');
    const result = await client.callTool({ name: 'fresh_source' });
    phase('tool_received');
    const sourcePid = JSON.parse(result.content[0].text).pid;
    assert.ok(Number.isSafeInteger(sourcePid));
    sourceProcess.pid = sourcePid;
    // Test-only access to the pinned SDK child: client.close() would force-kill
    // after two seconds and conceal a gateway that never handles stdin EOF.
    const child = transport._process;
    assert.ok(child?.stdin);
    const closed = new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal }))
    );
    child.stdin.end();
    phase('eof_sent');
    let timer;
    const outcome = await Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 3000);
      }),
    ]).finally(() => clearTimeout(timer));
    phase('exit_observed');
    assert.deepEqual(
      outcome,
      { code: 0, signal: null },
      'gateway must exit without host force-kill'
    );
    assert.throws(() => process.kill(sourcePid, 0), { code: 'ESRCH' });
  }
);

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

test('input EOF, close and already-ended input share signal shutdown and dispose listeners', async () => {
  for (const event of ['end', 'close', 'readableEnded', 'destroyed']) {
    const { host, messages } = fakeHost();
    if (event === 'readableEnded' || event === 'destroyed') host.stdin[event] = true;
    let calls = 0;
    const binding = bindEvidenceGatewayShutdown({ close: async () => calls++ }, host);
    host.stdin.emit(event);
    host.emit('SIGTERM');
    await binding.stop();
    assert.equal(calls, 1);
    assert.equal(host.stdin.listenerCount('end'), 0);
    assert.equal(host.stdin.listenerCount('close'), 0);
    assert.equal(host.listenerCount('SIGINT'), 0);
    assert.equal(host.listenerCount('SIGTERM'), 0);
    assert.deepEqual(messages, []);
  }
  const { host } = fakeHost();
  const binding = bindEvidenceGatewayShutdown({ close: () => assert.fail('disposed input') }, host);
  binding.dispose();
  host.stdin.emit('end');
  host.stdin.emit('close');
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
