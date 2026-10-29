'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require('@modelcontextprotocol/sdk/client/stdio.js');
const { stagePackagedEvidenceGateway } = require('../lib/release/evidence-gateway');
const { readEvidenceGatewayArtifact } = require('../scripts/lib/evidence-gateway-artifact');
const {
  PACKAGED_GATEWAY_INPUTS,
  readPackagedEvidenceGateway,
} = require('../scripts/lib/evidence-gateway-release-artifact');
const root = path.resolve(__dirname, '..');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-gateway-release-'));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^hpm-gateway-release-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const write = (file, bytes) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  write('package.json', JSON.stringify({ private: true, version: '1.0.0', dependencies: {} }));
  write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
  for (const file of PACKAGED_GATEWAY_INPUTS.filter((file) => file.startsWith('lib/proxy/')))
    write(file, fs.readFileSync(path.join(root, file)));
  return { directory, write };
}

test('Tauri declared resources preserve a usable installed evidence gateway closure', (t) => {
  const { directory } = fixture(t);
  const artifact = stagePackagedEvidenceGateway(root, directory);
  const installed = path.join(directory, 'installed');
  fs.mkdirSync(installed);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const staging = path.join(root, 'dist/staging/runtime');
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    const relative = path.relative(staging, path.resolve(root, 'src-tauri', source));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep));
    assert.equal(path.isAbsolute(relative), false);
    const input = path.join(directory, relative);
    // This fixture contains the actual gateway artifact and its release inputs;
    // unrelated GUI/dependency resources are exercised by their own release gates.
    if (!fs.existsSync(input)) continue;
    const output = path.resolve(installed, destination);
    const outputRelative = path.relative(installed, output);
    assert.ok(
      outputRelative && outputRelative !== '..' && !outputRelative.startsWith('..' + path.sep)
    );
    assert.equal(path.isAbsolute(outputRelative), false);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.cpSync(input, output, { recursive: true, errorOnExist: true, force: false });
  }
  assert.equal(
    readPackagedEvidenceGateway(installed).manifest.bundleSha256,
    artifact.manifest.bundleSha256
  );
  fs.unlinkSync(path.join(installed, 'package-lock.json'));
  assert.throws(() => readPackagedEvidenceGateway(installed), {
    message: 'evidence_gateway_release_unavailable',
  });
});

test('packaged gateway binds pruned release inputs and refuses workspace manifest substitution', (t) => {
  const { directory, write } = fixture(t);
  const artifact = stagePackagedEvidenceGateway(root, directory);
  assert.equal(
    artifact.manifest.bundleSha256,
    readEvidenceGatewayArtifact(root).manifest.bundleSha256
  );
  assert.equal(fs.existsSync(path.join(directory, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(directory, 'lib/client')), false);
  assert.equal(
    fs.existsSync(path.join(directory, 'scripts/lib/evidence-gateway-runtime.js')),
    false
  );
  assert.deepEqual(
    Array.from(artifact.manifest.files, (row) => row.file),
    PACKAGED_GATEWAY_INPUTS
  );
  assert.throws(() => readEvidenceGatewayArtifact(directory), {
    message: 'evidence_gateway_artifact_unavailable',
  });
  const valid = fs.readFileSync(
    path.join(directory, 'runtime/evidence-gateway/release-manifest.json')
  );
  write(
    'runtime/evidence-gateway/release-manifest.json',
    JSON.stringify(readEvidenceGatewayArtifact(root).manifest)
  );
  assert.throws(() => readPackagedEvidenceGateway(directory), {
    message: 'evidence_gateway_release_unavailable',
  });
  write('runtime/evidence-gateway/release-manifest.json', valid);
  assert.equal(readPackagedEvidenceGateway(directory).file, artifact.file);
  assert.throws(() => stagePackagedEvidenceGateway(root, directory), {
    message: 'evidence_gateway_release_stage_failed',
  });
});

test('release selection rejects changed launchers, lock, bundle, malformed and oversized manifests', (t) => {
  const { directory, write } = fixture(t);
  const artifact = stagePackagedEvidenceGateway(root, directory);
  for (const { file } of artifact.manifest.files) {
    const original = fs.readFileSync(path.join(directory, file));
    write(file, 'changed');
    assert.throws(() => readPackagedEvidenceGateway(directory), {
      message: 'evidence_gateway_release_unavailable',
    });
    write(file, original);
  }
  const bundle = fs.readFileSync(artifact.file);
  fs.writeFileSync(artifact.file, 'changed');
  assert.throws(() => readPackagedEvidenceGateway(directory), {
    message: 'evidence_gateway_release_unavailable',
  });
  fs.writeFileSync(artifact.file, bundle);
  const manifest = JSON.parse(JSON.stringify(artifact.manifest));
  const invalid = [
    null,
    [],
    {},
    { ...manifest, extra: 1 },
    { ...manifest, schemaVersion: 2 },
    { ...manifest, nodeMajor: manifest.nodeMajor + 1 },
    { ...manifest, bundleSha256: '../escape' },
    { ...manifest, files: [] },
    { ...manifest, files: manifest.files.slice().reverse() },
    { ...manifest, files: [...manifest.files, { file: '../escape', sha256: '0'.repeat(64) }] },
  ];
  for (const value of invalid) {
    write('runtime/evidence-gateway/release-manifest.json', JSON.stringify(value));
    assert.throws(() => readPackagedEvidenceGateway(directory), {
      message: 'evidence_gateway_release_unavailable',
    });
  }
  for (const value of ['', '{', 'x'.repeat(32769), '{"__proto__":{"private":"synthetic"}}']) {
    write('runtime/evidence-gateway/release-manifest.json', value);
    assert.throws(() => readPackagedEvidenceGateway(directory), {
      message: 'evidence_gateway_release_unavailable',
    });
  }
});

test('release staging rejects invalid roots and output junctions without touching their targets', (t) => {
  const { directory } = fixture(t);
  for (const source of ['', null, 'relative', directory])
    assert.throws(() => stagePackagedEvidenceGateway(source, directory), {
      message: 'evidence_gateway_release_stage_failed',
    });
  for (const destination of [undefined, null, 'relative', directory + '\0'])
    assert.throws(() => stagePackagedEvidenceGateway(root, destination), {
      message: 'evidence_gateway_release_stage_failed',
    });
  assert.throws(() => stagePackagedEvidenceGateway(root, root), {
    message: 'evidence_gateway_release_stage_failed',
  });
  const target = path.join(directory, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'sentinel'), 'unchanged');
  fs.symlinkSync(
    target,
    path.join(directory, 'scripts'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  assert.throws(() => stagePackagedEvidenceGateway(root, directory), {
    message: 'evidence_gateway_release_stage_failed',
  });
  assert.equal(fs.readFileSync(path.join(target, 'sentinel'), 'utf8'), 'unchanged');
  assert.deepEqual(fs.readdirSync(target), ['sentinel']);
  assert.equal(
    fs.existsSync(path.join(directory, 'runtime/evidence-gateway/release-manifest.json')),
    false
  );
});

test(
  'standalone release uses only packaged files and builtins, reads exactly and exits on EOF',
  { timeout: 15000 },
  async (t) => {
    const { directory, write } = fixture(t);
    stagePackagedEvidenceGateway(root, directory);
    write(
      'downstream.cjs',
      fs.readFileSync(path.join(__dirname, 'fixtures/evidence-gateway-standalone-source.cjs'))
    );
    // A module-load guard makes accidental access to the repository or to npm
    // dependencies fail even if this machine happens to have them installed.
    write(
      'guard.cjs',
      "const Module=require('node:module'),path=require('node:path');const load=Module._load;const base=__dirname+path.sep;Module._load=function(name,...args){if(!Module.isBuiltin(name)){const resolved=Module._resolveFilename(name,args[0]);if(!resolved.startsWith(base))throw new Error('fixture_external_module');}return load.call(this,name,...args);};"
    );
    const client = new Client({ name: 'standalone-release-fixture', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      cwd: os.tmpdir(),
      args: [
        '--require',
        path.join(directory, 'guard.cjs'),
        path.join(directory, 'scripts/start-packaged-evidence-mcp-gateway.js'),
        '--offload-bytes',
        '1024',
        '--',
        process.execPath,
        path.join(directory, 'downstream.cjs'),
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
    const reference = JSON.parse((await client.callTool({ name: 'fresh_source' })).content[0].text);
    assert.equal(reference.kind, 'retained_tool_result_reference');
    const page = JSON.parse(
      (
        await client.callTool({
          name: 'hpm_read_retained_evidence',
          arguments: { sourceId: reference.source.sourceId, digest: reference.source.digest },
        })
      ).content[0].text
    );
    const source = JSON.parse(JSON.parse(page.page.text).content[0].text);
    assert.equal(source.calls, 1);
    assert.equal(source.text, '独立原文🙂'.repeat(400));
    sourceProcess.pid = source.pid;
    assert.ok(Number.isSafeInteger(source.pid));
    const child = transport._process;
    const closed = new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal }))
    );
    child.stdin.end();
    let timer;
    const outcome = await Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 3000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.deepEqual(outcome, { code: 0, signal: null });
    assert.throws(() => process.kill(source.pid, 0), { code: 'ESRCH' });
  }
);

test('packaged CLI rejects invalid arguments and damaged artifacts with fixed output', (t) => {
  const { directory, write } = fixture(t);
  stagePackagedEvidenceGateway(root, directory);
  write('runtime/evidence-gateway/release-manifest.json', 'corrupt-synthetic-private-value');
  for (const args of [
    ['--synthetic-private-value'],
    ['--', process.execPath, 'synthetic-private-value'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(directory, 'scripts/start-packaged-evidence-mcp-gateway.js'), ...args],
      {
        cwd: os.tmpdir(),
        env: getDefaultEnvironment(),
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 15000,
      }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'evidence_gateway_start_failed\n');
  }
});
