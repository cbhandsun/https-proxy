'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntimeConfigController } = require('../lib/proxy/runtime-config-controller');
const { createManagementHealthHandler } = require('../lib/proxy/handlers/management-health');
const { configureInstalledClient } = require('../scripts/lib/nsis-client-configuration');
const { diagnosticPolicy } = require('../scripts/lib/staged-client-diagnostic-policy');
function fixedListenerOwner(protocol) {
  const entries = Object.freeze([
    { protocol, host: '127.0.0.1', listenPort: 19001, basePath: '/v1', tls: false },
  ]);
  let config = { _revision: 'initial', profiles: [], localServer: { protocol }, appSettings: {} };
  let patch,
    health,
    elapsed = 0;
  const controller = createRuntimeConfigController({
    loadConfig: () => config,
    protocolOptions: {},
    defaultProtocolOptions: {},
    getProfiles: (c) => c.profiles,
    getActiveProfile: () => ({ id: 'synthetic' }),
    getLocalServer: (c) => c.localServer,
    getModelRoutes: () => [],
    getClaudeDesktopRoutes: () => [],
    createHttpsAgent: () => ({}),
    setHttpsAgent() {},
    setRuntimeState(value) {
      patch = value;
      config = value.config;
    },
    log: { info() {}, warn() {}, error() {} },
    debounceReload: () => ({ close() {} }),
    recoveryDiagnostics: { attachPlannerOptions() {} },
  });
  const healthHandler = createManagementHealthHandler({
    sendJson(_req, _status, value) {
      health = value;
    },
    appId: 'https-proxy-manager',
    packageVersion: 'synthetic',
    defaultPort: 19001,
    currentConfigSnapshot: () => config,
    currentEntryServersSnapshot: () => entries,
    recoveryDiagnostics: {
      inspect(c) {
        return {
          configValid: true,
          appliedEnabled: c.appSettings.contextRecoveryEnabled,
          storage: c.appSettings.contextRecoveryPersistenceEnabled ? 'persistent' : 'memory',
        };
      },
    },
  });
  const owner = {
    identity: { pid: process.pid, entryPort: 19001, managementPort: 19101 },
    isAlive: async () => true,
    async request({ method, route, body }) {
      if (method === 'POST') {
        controller.applyConfig({ ...body, _revision: 'applied' });
        return { status: 200, body: { ok: true, revision: 'applied' } };
      }
      if (route === '/v1/local/config') return { status: 200, body: config };
      healthHandler({}, {});
      return { status: 200, body: health };
    },
  };
  return {
    owner,
    controller,
    patch: () => patch,
    entries,
    clock: {
      now: () => elapsed,
      wait: async (ms) => {
        elapsed += ms;
      },
    },
    elapsed: () => elapsed,
  };
}
test('real hot configuration preserves the original listener protocol and cannot satisfy the unchanged Claude readiness gate', async () => {
  const options = {
    client: 'claude',
    mode: 'enhanced',
    entryToken: 'hpm-synthetic-' + 'a'.repeat(32),
    upstreamToken: 'hpm-upstream-' + 'b'.repeat(32),
  };
  const old = fixedListenerOwner('openai-responses');
  await assert.rejects(configureInstalledClient(old.owner, options, old.clock), {
    message: 'installed_client_configuration_failed',
  });
  assert.equal(old.elapsed(), 15000);
  assert.equal(old.patch().localServer.protocol, 'claude');
  assert.equal(Object.hasOwn(old.patch(), 'entryServers'), false);
  assert.equal(old.entries[0].protocol, 'openai-responses');
  old.controller.close();
  const correct = fixedListenerOwner('claude');
  assert.deepEqual(await configureInstalledClient(correct.owner, options, correct.clock), {
    protocol: 'claude',
  });
  assert.equal(correct.elapsed(), 0);
  correct.controller.close();
  const main = fs.readFileSync(path.resolve(__dirname, '../openai-proxy.js'), 'utf8');
  assert.match(main, /const ENTRY_SERVERS = getEntryServers\(CONFIG\)/);
  assert.match(main, /ENTRY_SERVERS: \(\) => ENTRY_SERVERS/);
});
test('Claude diagnostic must supply Claude initial protocols rather than relying on unsupported listener hot-switch', () => {
  assert.equal(diagnosticPolicy('claude').initialEntryProtocols?.[0], 'claude');
});

test('Claude startup transform accepts one exact original statement and rejects missing, repeated or caller-selected variants', () => {
  const {
    transformClaudeDiagnosticStartup,
  } = require('../scripts/lib/claude-context-diagnostic-controller');
  const original =
    "$config = New-HpmDaemonOwnedConfig $ports -EntryProtocol $(if ($Request.case -cin @('10','11')) { 'claude' } else { 'openai-responses' })";
  const source = 'fixed-prefix\n' + original + '\nfixed-suffix';
  assert.equal(
    transformClaudeDiagnosticStartup(source),
    "fixed-prefix\n$config = New-HpmDaemonOwnedConfig $ports -EntryProtocol 'claude'\nfixed-suffix"
  );
  for (const value of [
    '',
    null,
    {},
    source + '\n' + original,
    source.replace('10', '00'),
    'x'.repeat(262145),
  ])
    assert.throws(() => transformClaudeDiagnosticStartup(value), {
      message: 'claude_diagnostic_controller_failed',
    });
  assert.deepEqual(diagnosticPolicy('codex').initialEntryProtocols, [
    'openai-responses',
    'openai-responses',
    'claude',
    'claude',
  ]);
  assert.deepEqual(diagnosticPolicy('claude').initialEntryProtocols, [
    'claude',
    'claude',
    'claude',
    'claude',
  ]);
});
test('actual Claude diagnostic controller generation changes only its copied initial protocol and rebinds exact source pins', (t) => {
  const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
  const { digest } = require('../scripts/lib/nsis-encrypted-contract');
  const { buildInstalledClientController } = require('../scripts/lib/nsis-client-controller');
  const {
    buildClaudeDiagnosticController,
    transformClaudeDiagnosticStartup,
  } = require('../scripts/lib/claude-context-diagnostic-controller');
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'claude-initial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownedRoot = path.join(root, 'hpm-installed-clients');
  fs.mkdirSync(path.join(ownedRoot, 'n08-hosted-network'), { recursive: true });
  const ca = path.join(ownedRoot, 'n08-hosted-network/ca.pem');
  fs.writeFileSync(ca, 'synthetic CA identity');
  const candidate = path.resolve(__dirname, '..');
  const source = path.join(candidate, 'scripts/lib/context-recovery-daemon-owned-controller.psm1');
  const sourceBefore = digest(source);
  const options = { candidate, ownedRoot, caSha256: digest(ca) };
  const original = buildInstalledClientController(options);
  const moduleName = 'context-recovery-daemon-owned-controller.psm1';
  const originalModule = fs.readFileSync(path.join(original.outputRoot, moduleName), 'utf8');
  const entryName = 'context-recovery-daemon-owned-controller.ps1';
  const originalEntry = fs.readFileSync(path.join(original.outputRoot, entryName));
  fs.rmSync(original.outputRoot, { recursive: true });
  const built = buildClaudeDiagnosticController(options);
  const modified = fs.readFileSync(path.join(built.outputRoot, moduleName), 'utf8');
  assert.equal(modified, transformClaudeDiagnosticStartup(originalModule));
  assert.deepEqual(fs.readFileSync(path.join(built.outputRoot, entryName)), originalEntry);
  assert.equal(digest(source), sourceBefore);
  for (const [name, sha] of Object.entries(built.copyPins))
    assert.equal(digest(path.join(built.outputRoot, name)), sha);
  const assign = modified.indexOf('$owner.job.Assign($process)');
  const grant = modified.indexOf("$process.StandardInput.Write('1')");
  assert.ok(assign >= 0 && grant > assign);
  assert.ok(modified.includes("@('00', '01', '10', '11')"));
});

test('Claude generated-controller admission rejects growth during its bounded fd read and closes that descriptor', (t) => {
  const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
  const { digest } = require('../scripts/lib/nsis-encrypted-contract');
  const {
    buildClaudeDiagnosticController,
  } = require('../scripts/lib/claude-context-diagnostic-controller');
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'claude-copy-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownedRoot = path.join(root, 'hpm-installed-clients');
  const networkRoot = path.join(ownedRoot, 'n08-hosted-network');
  fs.mkdirSync(networkRoot, { recursive: true });
  const ca = path.join(networkRoot, 'ca.pem');
  fs.writeFileSync(ca, 'synthetic CA');
  const target = path.join(
    ownedRoot,
    'n08-hosted-controller/context-recovery-daemon-owned-controller.psm1'
  );
  const open = fs.openSync,
    read = fs.readSync;
  let admittedFd,
    changed = false;
  t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
    const fd = open(file, flags, ...rest);
    if (file === target && (flags & fs.constants.O_RDWR) === fs.constants.O_RDWR) admittedFd = fd;
    return fd;
  });
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    if (fd === admittedFd && !changed) {
      changed = true;
      fs.appendFileSync(target, 'unexpected growth');
    }
    return read(fd, ...args);
  });
  assert.throws(
    () =>
      buildClaudeDiagnosticController({
        candidate: path.resolve(__dirname, '..'),
        ownedRoot,
        caSha256: digest(ca),
      }),
    { message: 'claude_diagnostic_controller_failed' }
  );
  assert.equal(changed, true);
  assert.throws(() => fs.fstatSync(admittedFd), { code: 'EBADF' });
});
