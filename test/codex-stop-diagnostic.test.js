'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const { runCodexStopDiagnostic, businessHandler } = require('../scripts/lib/codex-stop-diagnostic');
const { parseDiagnosticReceipt } = require('../scripts/lib/codex-stop-diagnostic-contract');
const { createOwnedStopFailure } = require('../scripts/lib/nsis-client-owned-failure');
const {
  prepareDiagnosticStaging,
  verifyToolsLock,
} = require('../scripts/lib/codex-stop-diagnostic-staging');
function fixture(t, fault, client = 'codex') {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'codex-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownedRoot = path.join(root, 'hpm-installed-clients');
  fs.mkdirSync(ownedRoot);
  const args = [
    ownedRoot,
    path.join(ownedRoot, 'payload'),
    'a'.repeat(64),
    path.join(ownedRoot, 'n08-hosted-network'),
    ...['b', 'c', 'd', 'e'].map((x) => x.repeat(64)),
  ];
  const events = [],
    phases = [];
  const step = (name) => {
    events.push(name);
    if (fault === name) throw Error('PRIVATE_EXCEPTION');
  };
  const dependencies = {
    verify() {
      step('verify');
      return { node: 'fixed-node', powershellExecutable: 'fixed-pwsh' };
    },
    writer() {
      return (phase) => phases.push(phase);
    },
    address: () => '192.168.1.3',
    async listener() {
      step('listener');
      return {
        inspect: () => ({ negativePort: 14324 }),
        async close() {
          step('listener-close');
          return fault !== 'listener-false';
        },
      };
    },
    async probes() {
      step('probes');
      return Object.fromEntries(
        ['probesPassed', 'tlsVerified', 'nonLoopbackBlocked', 'listenerOwned'].map((key) => [
          key,
          fault !== 'proof',
        ])
      );
    },
    controller() {
      step('controller');
      return {
        close: async () => {
          step('channel-close');
          return true;
        },
      };
    },
    adapter() {
      step('adapter');
      return {
        async launch(input) {
          assert.equal(input.label, '00');
          step('launch');
          return {
            stop: async () => {
              step('owner-stop');
              return fault !== 'owner-false';
            },
          };
        },
        async close() {
          step('adapter-close');
          return fault !== 'adapter-false';
        },
      };
    },
    async runCase(input) {
      assert.equal(input.client, client);
      assert.equal(input.mode, 'enhanced');
      input.onPhase(client + '-enhanced-cli-compact-3');
      if (client === 'codex') input.onPhase('codex-enhanced-cli-restart-stop');
      step('case');
      if (fault === 'trusted-stop')
        throw createOwnedStopFailure('nsis_owned_stop_controller_natural_exit_timeout');
      if (fault === 'forged-stop')
        throw { code: 'nsis_owned_stop_controller_natural_exit_timeout' };
      input.active.current = null;
      await input.onReadyToStop();
      return {
        compactions: fault === 'compactions' ? 2 : 3,
        exactFinalAnswer: true,
        privateRead: true,
        publicGeneration: true,
        restartRetention: true,
      };
    },
  };
  return { args, dependencies, events, phases };
}
test('independent diagnostic executes one original enhanced case and grants no installation or provider qualification', async (t) => {
  const f = fixture(t);
  const report = await runCodexStopDiagnostic(f.args, f.dependencies);
  assert.equal(report.diagnosticPassed, true);
  assert.equal(report.installedQualified, false);
  assert.equal(report.realProvider, false);
  assert.equal(report.modelRequests, 0);
  assert.deepEqual(parseDiagnosticReceipt(JSON.stringify(report) + '\n'), report);
  assert.deepEqual(f.events, [
    'verify',
    'listener',
    'probes',
    'controller',
    'adapter',
    'launch',
    'case',
    'owner-stop',
    'adapter-close',
    'listener-close',
  ]);
});
test('independent diagnostic locks failures and closes all allocated capabilities without retries', async (t) => {
  for (const fault of [
    'verify',
    'listener',
    'probes',
    'proof',
    'controller',
    'adapter',
    'launch',
    'case',
    'compactions',
    'owner-stop',
    'owner-false',
    'adapter-close',
    'adapter-false',
    'listener-close',
    'listener-false',
  ]) {
    const f = fixture(t, fault);
    const report = await runCodexStopDiagnostic(f.args, f.dependencies);
    assert.equal(report.diagnosticPassed, false, fault);
    assert.equal(report.installedQualified, false);
    assert.equal(report.modelRequests, 0);
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
    assert.ok(f.events.filter((x) => x === 'case').length <= 1);
    if (f.events.includes('launch') && fault !== 'launch')
      assert.ok(f.events.includes('owner-stop'));
    if (f.events.includes('controller') && fault !== 'controller')
      assert.ok(f.events.includes(fault === 'adapter' ? 'channel-close' : 'adapter-close'));
    if (f.events.includes('listener') && fault !== 'listener')
      assert.ok(f.events.includes('listener-close'));
    assert.doesNotThrow(() => parseDiagnosticReceipt(JSON.stringify(report) + '\n'));
  }
});
test('only a privately attested stop cause refines the finite phase', async (t) => {
  for (const fault of ['trusted-stop', 'forged-stop']) {
    const f = fixture(t, fault);
    const r = await runCodexStopDiagnostic(f.args, f.dependencies);
    assert.equal(r.diagnosticPassed, false);
    assert.equal(
      r.failureCode,
      fault === 'trusted-stop' ? 'nsis_owned_stop_controller_natural_exit_timeout' : null
    );
    assert.equal(
      r.failedPhase,
      fault === 'trusted-stop'
        ? 'codex-enhanced-cli-restart-stop-controller-natural-exit-timeout'
        : 'codex-enhanced-cli-restart-stop'
    );
  }
});
test('standalone receipt refuses duplicate keys, qualification claims, raw phases and resource omissions', async (t) => {
  const f = fixture(t);
  const good = await runCodexStopDiagnostic(f.args, f.dependencies);
  for (const change of [
    { installedQualified: true },
    { realProvider: true },
    { modelRequests: 1 },
    { failedPhase: 'PRIVATE' },
    { failureCode: 'PRIVATE' },
    { ownedTreeEmpty: false },
    { schemaVersion: '1' },
    { extra: true },
    { diagnosticPassed: 'true' },
    { syntheticSocketsClosed: false },
  ]) {
    assert.throws(
      () => parseDiagnosticReceipt(JSON.stringify({ ...good, ...change }) + '\n'),
      /codex_stop_receipt_rejected/
    );
  }
  for (const text of [
    '',
    'x'.repeat(4097),
    JSON.stringify(good).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1') + '\n',
  ])
    assert.throws(() => parseDiagnosticReceipt(text), /codex_stop_receipt_rejected/);
});
test('diagnostic business transport preserves exact authentication, request bounds and synthetic bytes', async () => {
  for (const fault of [null, 'auth', 'path', 'utf8', 'oversize', 'key']) {
    let rejected = 0,
      calls = 0,
      destroyed = false,
      bytes;
    const active = {
      current: {
        client: 'codex',
        mode: 'enhanced',
        upstreamToken: 'token',
        upstream: {
          respond() {
            calls++;
            return {
              statusCode: 200,
              contentType: 'application/json; charset=utf-8',
              wire: Buffer.from('{"synthetic":true}'),
            };
          },
        },
      },
    };
    const business = businessHandler(active, () => rejected++);
    const event = {
      path: fault === 'path' ? '/unknown' : '/v1/responses',
      authorization: fault === 'auth' ? 'wrong' : 'Bearer token',
      apiKey: fault === 'key' ? 'unexpected' : undefined,
      bytes:
        fault === 'utf8'
          ? Buffer.from([255])
          : fault === 'oversize'
            ? Buffer.alloc(262145)
            : Buffer.from('{}'),
      response: {
        destroyed: false,
        writeHead() {},
        end(value) {
          bytes = value;
        },
        destroy() {
          destroyed = true;
        },
      },
    };
    await business.respond(event);
    assert.equal(business.pending(), 0);
    if (fault) {
      assert.equal(rejected, 1);
      assert.equal(destroyed, true);
      assert.equal(calls, 0);
    } else {
      assert.equal(rejected, 0);
      assert.equal(bytes.toString(), '{"synthetic":true}');
    }
  }
});
test('staging refuses non-hosted execution and altered client lock bytes without environment installation', () => {
  assert.throws(
    () => prepareDiagnosticStaging({ platform: 'darwin', env: {} }),
    /codex_stop_staging_failed/
  );
  assert.doesNotThrow(() => verifyToolsLock(path.resolve(__dirname, '../tools/nsis-clients')));
});

test('staged identity binds every real source byte, packaged Node and default native worker before execution', (t) => {
  const { verifyDiagnosticRuntime } = require('../scripts/lib/codex-stop-diagnostic-staging');
  const { digest } = require('../scripts/lib/nsis-encrypted-contract');
  const root = fs.mkdtempSync(
    path.join(resolvePhysicalTestTempDirectory(), 'codex-stop-identity-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate'),
    staging = path.join(root, 'staging');
  for (const directory of [candidate, staging]) fs.mkdirSync(directory);
  const write = (dir, name, text) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const source = write(candidate, 'lib/proxy/fixture.js', 'fixed synthetic source');
  write(staging, 'lib/proxy/fixture.js', 'fixed synthetic source');
  const node = write(staging, 'runtime/node/node.exe', 'synthetic Node identity');
  const native = write(
    staging,
    'runtime/native/hpm-context-recovery-key.exe',
    'synthetic default worker identity'
  );
  const lock = write(staging, 'package-lock.json', 'fixed locked dependency identity');
  const manifest = {
    schemaVersion: 2,
    nodeSha256: digest(node),
    contextRecoveryNativeSha256: digest(native),
    packageLockSha256: digest(lock),
    sourceSha256: { 'lib/proxy/fixture.js': digest(source) },
  };
  const manifestFile = write(staging, 'release-runtime-manifest.json', JSON.stringify(manifest));
  const normal = verifyDiagnosticRuntime(candidate, staging);
  assert.equal(normal.manifestSha256, digest(manifestFile));
  assert.equal(normal.nodeSha256, digest(node));
  assert.equal(normal.nativeSha256, digest(native));
  for (const file of [source, node, native, lock, path.join(staging, 'lib/proxy/fixture.js')]) {
    const before = fs.readFileSync(file);
    fs.appendFileSync(file, 'changed');
    assert.throws(() => verifyDiagnosticRuntime(candidate, staging));
    fs.writeFileSync(file, before);
  }
});

test('independent Claude case uses the same owned lifecycle with no preceding Codex protocol', async (t) => {
  const { runClaudeContextDiagnostic } = require('../scripts/lib/claude-context-diagnostic');
  const {
    parseClaudeDiagnosticReceipt,
  } = require('../scripts/lib/claude-context-diagnostic-contract');
  for (const fault of [
    undefined,
    'case',
    'owner-false',
    'adapter-false',
    'listener-false',
    'compactions',
  ]) {
    const f = fixture(t, fault, 'claude');
    const report = await runClaudeContextDiagnostic(f.args, f.dependencies);
    assert.equal(report.diagnosticPassed, fault === undefined);
    assert.equal(report.scope, 'staged_claude_enhanced_protocol_diagnostic');
    assert.equal(report.failureCode, null);
    assert.equal(report.installedQualified, false);
    assert.equal(report.realProvider, false);
    assert.equal(report.modelRequests, 0);
    assert.doesNotThrow(() => parseClaudeDiagnosticReceipt(JSON.stringify(report) + '\n'));
    assert.equal(f.events.filter((event) => event === 'case').length, 1);
    assert.ok(f.events.includes('owner-stop'));
    assert.ok(f.events.includes('adapter-close'));
  }
});
