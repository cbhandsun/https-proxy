'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { discoverTestFiles } = require('../lib/test-discovery');
const {
  parseInstalledHttpArguments,
  verifyInstalledHttpIdentity,
  installedHttpReceipt,
  runInstalledDaemonHttp,
} = require('../scripts/lib/nsis-installed-daemon-http');

const sha = 'a'.repeat(64);
const root = path.resolve(os.tmpdir(), 'hpm-installed-http-unit');
const args = [
  root,
  path.join(root, 'install'),
  path.join(root, 'case'),
  sha,
  path.join(root, 'pwsh.exe'),
];
function report() {
  return {
    schemaVersion: 1,
    scope: 'daemon-management-http-settings',
    mode: 'execute',
    requiresReviewedOwnedAdapter: true,
    modelRequests: 0,
    retentionQualified: false,
    clientQualified: false,
    gracefulDrainQualified: false,
    passed: true,
    cases: ['00', '01', '10', '11'].map((label) => ({
      label,
      configSaved: true,
      applicationObserved: true,
      storageVerified: true,
      ownedStopAcknowledged: true,
      cleanupSemantics: 'forced_cleanup',
      passed: true,
      failure: null,
    })),
  };
}
function fixture(change = {}) {
  const events = [];
  const channel = {
    close: async () => {
      events.push('channel-close');
      return true;
    },
  };
  const adapter = {
    close: async () => {
      events.push('adapter-close');
      await channel.close();
      return true;
    },
  };
  return {
    events,
    dependencies: {
      verify: () => {
        events.push('verify');
        return true;
      },
      start: (options) => {
        events.push('start');
        assert.deepEqual(Object.keys(options).sort(), [
          'install',
          'manifestSha256',
          'ownedRoot',
          'powershellExecutable',
        ]);
        return channel;
      },
      adapter: () => {
        events.push('adapter');
        return adapter;
      },
      matrix: async (owner, options) => {
        events.push('matrix');
        assert.equal(owner, adapter);
        assert.deepEqual(options, { mode: 'execute' });
        return report();
      },
      ...change,
    },
  };
}

test('installed HTTP fixed driver closes its controller before returning a bounded receipt', async () => {
  const f = fixture();
  const receipt = await runInstalledDaemonHttp(args, f.dependencies);
  assert.deepEqual(f.events, [
    'verify',
    'start',
    'adapter',
    'matrix',
    'adapter-close',
    'channel-close',
  ]);
  assert.equal(receipt.controllerClosed, true);
  assert.equal(receipt.scope, 'installed_daemon_management_http');
  assert.deepEqual(
    receipt.combinations.map((c) => c.combination),
    ['00', '01', '10', '11']
  );
  assert.equal(receipt.restartRetention, false);
  assert.equal(receipt.modelRequests, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 4096);
});

test('installed HTTP arguments reject empty, extra, traversal, overlaps and executable overrides without launch', async () => {
  let getterCalls = 0;
  const accessor = [...args];
  Object.defineProperty(accessor, '0', {
    get() {
      getterCalls++;
      throw Error('PRIVATE_UNTRUSTED_CONTENT');
    },
    enumerable: true,
  });
  const invalid = [
    [],
    args.slice(0, 4),
    [...args, '--execute'],
    ['relative', ...args.slice(1)],
    [root, args[1], args[1], sha, args[4]],
    [root, args[1], path.join(args[1], 'nested'), sha, args[4]],
    [root, args[1], path.dirname(root), sha, args[4]],
    [root, args[1], args[2], 'A'.repeat(64), args[4]],
    [root, args[1], args[2], sha, path.join(root, 'cmd.exe')],
    [root, args[1], args[2], sha, 'x'.repeat(5000)],
    [root, args[1] + path.sep + '..' + path.sep + 'other', args[2], sha, args[4]],
    accessor,
    new Proxy(args, {
      get() {
        throw Error('PRIVATE_UNTRUSTED_CONTENT');
      },
    }),
  ];
  for (const input of invalid) {
    const f = fixture();
    await assert.rejects(
      runInstalledDaemonHttp(input, f.dependencies),
      /^Error: installed_daemon_http_failed$/
    );
    assert.deepEqual(f.events, []);
  }
  assert.equal(getterCalls, 0);
  assert.equal(parseInstalledHttpArguments(args).manifestSha256, sha);
});

test('installed HTTP identity verifies all manifest bytes, fixed node, paths and injected runtime flags', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-http-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const install = path.join(directory, 'install');
  const caseRoot = path.join(directory, 'case');
  fs.mkdirSync(caseRoot);
  const entries = {
    'openai-proxy.js': 'synthetic-main',
    'package-lock.json': 'synthetic-lock',
    'runtime/node/node.exe': 'synthetic-node',
    'runtime/native/hpm-context-recovery-key.exe': 'synthetic-helper',
  };
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  for (const [file, text] of Object.entries(entries)) {
    const full = path.join(install, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  const manifest = {
    schemaVersion: 2,
    sourceSha256: { 'openai-proxy.js': digest(entries['openai-proxy.js']) },
    nodeSha256: digest(entries['runtime/node/node.exe']),
    contextRecoveryNativeSha256: digest(entries['runtime/native/hpm-context-recovery-key.exe']),
    packageLockSha256: digest(entries['package-lock.json']),
  };
  const json = JSON.stringify(manifest);
  fs.writeFileSync(path.join(install, 'release-runtime-manifest.json'), json);
  fs.writeFileSync(path.join(directory, 'pwsh.exe'), 'synthetic-pwsh');
  const request = parseInstalledHttpArguments([
    directory,
    install,
    caseRoot,
    digest(json),
    path.join(directory, 'pwsh.exe'),
  ]);
  const runtime = {
    platform: 'win32',
    execArgv: [],
    env: {},
    execPath: path.join(install, 'runtime/node/node.exe'),
    cwd: () => install,
  };
  assert.equal(verifyInstalledHttpIdentity(request, runtime), true);
  for (const changed of [
    { platform: 'linux' },
    { execArgv: ['--require', 'unsafe'] },
    { env: { NODE_OPTIONS: 'unsafe' } },
    { env: { Node_V8_Coverage: 'unsafe' } },
    { env: { node_path: 'unsafe' } },
    { execPath: process.execPath },
    { cwd: () => directory },
  ])
    assert.throws(
      () => verifyInstalledHttpIdentity(request, { ...runtime, ...changed }),
      /^Error: installed_daemon_http_failed$/
    );
  fs.writeFileSync(path.join(install, 'openai-proxy.js'), 'tampered');
  assert.throws(
    () => verifyInstalledHttpIdentity(request, runtime),
    /^Error: installed_daemon_http_failed$/
  );
});

test('matrix errors and adapter construction failures always close; failed close never grants success', async () => {
  for (const change of [
    {
      matrix: async () => {
        throw Error('PRIVATE_UNTRUSTED_CONTENT');
      },
    },
    { matrix: async () => ({ ...report(), passed: false }) },
    {
      adapter: () => {
        throw Error('PRIVATE_UNTRUSTED_CONTENT');
      },
    },
    { adapter: () => ({ close: async () => false }), matrix: async () => report() },
    {
      adapter: () => ({
        close: async () => {
          throw Error('PRIVATE_UNTRUSTED_CONTENT');
        },
      }),
      matrix: async () => report(),
    },
  ]) {
    const f = fixture(change);
    await assert.rejects(
      runInstalledDaemonHttp(args, f.dependencies),
      /^Error: installed_daemon_http_failed$/
    );
    if (!change.adapter) assert.ok(f.events.includes('channel-close'));
    if (change.adapter) assert.ok(f.events.includes('start'));
  }
  const f = fixture({ verify: () => false });
  await assert.rejects(
    runInstalledDaemonHttp(args, f.dependencies),
    /^Error: installed_daemon_http_failed$/
  );
  assert.deepEqual(f.events, []);
});

test('receipt projection rejects incomplete, additional, private and executable fields', () => {
  const invalid = [
    null,
    [],
    {},
    { ...report(), cases: [] },
    { ...report(), cases: report().cases.reverse() },
    { ...report(), modelRequests: 1 },
    { ...report(), private: 'PRIVATE_UNTRUSTED_CONTENT' },
    { ...report(), retentionQualified: true },
  ];
  for (const field of [
    'configSaved',
    'applicationObserved',
    'storageVerified',
    'ownedStopAcknowledged',
    'passed',
    'cleanupSemantics',
    'failure',
  ]) {
    const value = report();
    value.cases[3][field] = 'PRIVATE_UNTRUSTED_CONTENT';
    invalid.push(value);
  }
  const executable = report();
  Object.defineProperty(executable, 'passed', {
    get() {
      throw Error('PRIVATE_UNTRUSTED_CONTENT');
    },
    enumerable: true,
  });
  invalid.push(executable);
  for (const value of invalid)
    assert.throws(() => installedHttpReceipt(value, sha), /^Error: installed_daemon_http_failed$/);
});

test('hosted PowerShell receipt and composition regressions run in unified discovery with zero live execution', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      'test/fixtures/nsis-installed-daemon-http-mocks.ps1',
    ],
    { encoding: 'utf8', timeout: 45000, maxBuffer: 16384 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /installedHttpRefusals=\d+; installerExecutions=0; daemonExecutions=0; modelRequests=0/
  );
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_UNTRUSTED_CONTENT/);
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/nsis-installed-daemon-http.test.js'
    )
  );
});
