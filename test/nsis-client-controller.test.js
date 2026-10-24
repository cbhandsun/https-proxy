'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { digest } = require('../scripts/lib/nsis-encrypted-contract');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const {
  buildInstalledClientController,
  createInstalledControllerSpawn,
  transformInstalledController,
} = require('../scripts/lib/nsis-client-controller');
const failure = { message: 'installed_client_controller_failed' };
const candidate = path.resolve(__dirname, '..');
const originalFile = path.join(
  candidate,
  'scripts/lib/context-recovery-daemon-owned-controller.psm1'
);
function fixture(t) {
  const temp = fs.mkdtempSync(
    path.join(resolvePhysicalTestTempDirectory(), 'installed-controller-')
  );
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const ownedRoot = path.join(temp, 'hpm-installed-clients');
  fs.mkdirSync(path.join(ownedRoot, 'n08-hosted-network'), { recursive: true });
  const ca = path.join(ownedRoot, 'n08-hosted-network/ca.pem');
  fs.writeFileSync(ca, 'synthetic certificate bytes');
  const before = fs.readFileSync(originalFile);
  const controller = buildInstalledClientController({ candidate, ownedRoot, caSha256: digest(ca) });
  assert.deepEqual(fs.readFileSync(originalFile), before);
  return { temp, ownedRoot, controller };
}
function hosted(t, f) {
  const values = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: f.temp,
  };
  const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(old))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key];
  const powershellExecutable = path.join(f.temp, 'pwsh.exe');
  const options = {
    candidate,
    ownedRoot: f.ownedRoot,
    manifestSha256: 'a'.repeat(64),
    powershellExecutable,
    controller: f.controller,
  };
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    path.join(candidate, 'scripts/lib/context-recovery-daemon-owned-controller.ps1'),
    '-OwnedRoot',
    f.ownedRoot,
    '-InstallDirectory',
    path.join(f.ownedRoot, 'payload'),
    '-ManifestSha256',
    'a'.repeat(64),
  ];
  const raw = { env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] };
  return { options, args, raw, powershellExecutable };
}
test('installed controller transforms current original source exactly once, retains CA identity and original gate/deadlines', (t) => {
  const f = fixture(t),
    file = path.join(f.controller.outputRoot, 'context-recovery-daemon-owned-controller.psm1'),
    source = fs.readFileSync(file, 'utf8');
  assert.match(source, /Join-Path \(Join-Path \$OwnedRoot 'cases'\)/);
  assert.match(source, /NODE_EXTRA_CA_CERTS/);
  assert.match(source, /HPM_INSTALLED_CLIENT_OBSERVER/);
  assert.ok(
    source.indexOf('$owner.job.Assign($process)') <
      source.indexOf('nsis-client-observer-prepare.ps1')
  );
  assert.ok(
    source.indexOf('-Token $Request.token -Job $owner.job') <
      source.indexOf("$process.StandardInput.Write('1')")
  );
  const original = fs.readFileSync(originalFile, 'utf8');
  for (const expression of [
    /StopAndWait\([^)]*\)/g,
    /ElapsedMilliseconds[^\r\n]*/g,
    /ReadAsync\([^\r\n]*/g,
  ])
    assert.deepEqual(source.match(expression), original.match(expression));
  for (const [name, pin] of Object.entries(f.controller.copyPins))
    assert.equal(digest(path.join(f.controller.outputRoot, name)), pin);
  assert.equal(Object.isFrozen(f.controller.copyPins), true);
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile($env:HPM_TEST_CONTROLLER,[ref]$tokens,[ref]$errors);if($errors.Count){exit 1}',
    ],
    {
      env: { ...process.env, HPM_TEST_CONTROLLER: file },
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4096,
    }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
test('installed transform refuses missing, duplicate, already-transformed anchors and malformed paths or pins', () => {
  const source = fs.readFileSync(originalFile, 'utf8'),
    options = {
      prepareFile: path.join(candidate, "work's/prep.ps1"),
      prepareSha256: 'a'.repeat(64),
      temporary: path.join(candidate, "temp's"),
    };
  const valid = transformInstalledController(source, options);
  assert.ok(valid.includes(options.prepareFile.replaceAll("'", "''")));
  assert.ok(valid.includes(options.temporary.replaceAll("'", "''")));
  for (const input of [
    '',
    null,
    source + source,
    valid,
    source.replace("$process.StandardInput.Write('1')", 'changed'),
  ])
    assert.throws(() => transformInstalledController(input, options), failure);
  for (const change of [
    { prepareSha256: '' },
    { prepareSha256: 'A'.repeat(64) },
    { prepareFile: 'relative' },
    { temporary: 'relative' },
    { prepareFile: '/PRIVATE\nscript' },
  ])
    assert.throws(() => transformInstalledController(source, { ...options, ...change }), failure);
});
test('installed spawn allows only original exact invocation and repins copied controller before one owned launch', (t) => {
  const f = fixture(t),
    h = hosted(t, f),
    calls = [];
  const sentinel = { owned: true };
  const start = createInstalledControllerSpawn(h.options, (...args) => {
    calls.push(args);
    return sentinel;
  });
  assert.equal(start(h.powershellExecutable, h.args, h.raw), sentinel);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][1][4],
    path.join(f.controller.outputRoot, 'context-recovery-daemon-owned-controller.ps1')
  );
  assert.deepEqual(calls[0][2].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].env.RUNNER_TEMP, f.temp);
  assert.throws(() => start(h.powershellExecutable, h.args, h.raw), failure);
});
test('installed spawn rejects wrong executable, args, host, env, stream settings and copy drift before launch', (t) => {
  const f = fixture(t),
    h = hosted(t, f);
  let calls = 0;
  const attempt = (exe, args, raw) =>
    createInstalledControllerSpawn(h.options, () => {
      calls++;
    })(exe, args, raw);
  for (const [exe, args, raw] of [
    [h.powershellExecutable + 'other', h.args, h.raw],
    [h.powershellExecutable, [...h.args, 'extra'], h.raw],
    [h.powershellExecutable, h.args, { ...h.raw, shell: true }],
    [h.powershellExecutable, h.args, { ...h.raw, stdio: ['inherit', 'pipe', 'pipe'] }],
    [h.powershellExecutable, h.args, { ...h.raw, env: { ...h.raw.env, NODE_OPTIONS: 'PRIVATE' } }],
  ])
    assert.throws(() => attempt(exe, args, raw), failure);
  process.env.RUNNER_ENVIRONMENT = 'self-hosted';
  assert.throws(() => attempt(h.powershellExecutable, h.args, h.raw), failure);
  process.env.RUNNER_ENVIRONMENT = 'github-hosted';
  fs.appendFileSync(
    path.join(f.controller.outputRoot, 'context-recovery-daemon-owned-controller.ps1'),
    'changed'
  );
  assert.throws(() => attempt(h.powershellExecutable, h.args, h.raw), failure);
  assert.equal(calls, 0);
});
test('installed spawn rejects copied-script symlink and hardlink substitutions even with matching bytes', (t) => {
  const f = fixture(t),
    h = hosted(t, f),
    file = path.join(f.controller.outputRoot, 'context-recovery-daemon-owned-controller.ps1'),
    copy = path.join(f.temp, 'same.ps1');
  fs.copyFileSync(file, copy);
  fs.unlinkSync(file);
  fs.symlinkSync(copy, file);
  let calls = 0;
  const attempt = () =>
    createInstalledControllerSpawn(h.options, () => {
      calls++;
    })(h.powershellExecutable, h.args, h.raw);
  assert.throws(attempt, failure);
  fs.unlinkSync(file);
  fs.linkSync(copy, file);
  assert.throws(attempt, failure);
  assert.equal(calls, 0);
});
test('installed spawn rejects nested environment accessors and proxies without executing them', (t) => {
  const f = fixture(t),
    h = hosted(t, f);
  let accesses = 0,
    calls = 0;
  const env = { ...h.raw.env };
  Object.defineProperty(env, 'NODE_OPTIONS', {
    enumerable: true,
    get() {
      accesses++;
      return 'PRIVATE';
    },
  });
  const proxy = new Proxy(h.raw.env, {
    ownKeys() {
      accesses++;
      return Reflect.ownKeys(h.raw.env);
    },
  });
  for (const input of [env, proxy])
    assert.throws(
      () =>
        createInstalledControllerSpawn(h.options, () => {
          calls++;
        })(h.powershellExecutable, h.args, { ...h.raw, env: input }),
      failure
    );
  assert.equal(accesses, 0);
  assert.equal(calls, 0);
});

test('installed controller build rejects empty identity and repeated output creation without overwriting copies', (t) => {
  const f = fixture(t);
  const file = path.join(f.controller.outputRoot, 'context-recovery-daemon-owned-controller.psm1'),
    before = fs.readFileSync(file);
  for (const caSha256 of ['', '0'.repeat(64)])
    assert.throws(
      () => buildInstalledClientController({ candidate, ownedRoot: f.ownedRoot, caSha256 }),
      failure
    );
  assert.throws(
    () =>
      buildInstalledClientController({
        candidate,
        ownedRoot: f.ownedRoot,
        caSha256: digest(path.join(f.ownedRoot, 'n08-hosted-network/ca.pem')),
      }),
    failure
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

test('installed spawn malformed raw data and spawn failures expose fixed errors and never retry a consumed capability', (t) => {
  const f = fixture(t),
    h = hosted(t, f);
  let getters = 0,
    calls = 0;
  const hostile = { ...h.raw };
  Object.defineProperty(hostile, 'env', {
    enumerable: true,
    get() {
      getters++;
      return h.raw.env;
    },
  });
  for (const raw of [null, {}, [], hostile])
    assert.throws(
      () =>
        createInstalledControllerSpawn(h.options, () => {
          calls++;
        })(h.powershellExecutable, h.args, raw),
      failure
    );
  assert.equal(getters, 0);
  assert.equal(calls, 0);
  const start = createInstalledControllerSpawn(h.options, () => {
    calls++;
    throw new Error('PRIVATE unsafe path');
  });
  assert.throws(() => start(h.powershellExecutable, h.args, h.raw), failure);
  assert.throws(() => start(h.powershellExecutable, h.args, h.raw), failure);
  assert.equal(calls, 1);
});

test('installed observer composition accepts the actual release generator formatted manifest bytes', async (t) => {
  const f = fixture(t),
    install = path.join(f.ownedRoot, 'payload'),
    caseRoot = path.join(f.ownedRoot, 'cases/observer');
  fs.mkdirSync(caseRoot, { recursive: true });
  fs.mkdirSync(install);
  fs.cpSync(path.join(candidate, 'lib'), path.join(install, 'lib'), { recursive: true });
  const sessionsFile = path.join(install, 'lib/proxy/context-recovery-sessions.js');
  const manifest = path.join(install, 'release-runtime-manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      { sourceSha256: { 'lib/proxy/context-recovery-sessions.js': digest(sessionsFile) } },
      null,
      2
    ) + '\n'
  );
  const input = {
    caseRoot,
    install,
    token: 's'.repeat(32),
    pid: 123,
    manifestSha256: digest(manifest),
  };
  const runtime = {
    platform: 'win32',
    env: {
      RUNNER_TEMP: f.temp,
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Windows',
    },
  };
  const helper = require('../scripts/lib/nsis-client-observer.cjs');
  helper.prepareInstalledClientObserver(input, runtime);
  const observer =
    require('../scripts/lib/nsis-client-observer-bootstrap.cjs').installInstalledClientObserver(
      input,
      runtime
    );
  t.after(() => {
    observer.close();
    for (const file of Object.keys(require.cache))
      if (file.startsWith(install)) delete require.cache[file];
  });
  const sessions = require(sessionsFile).createContextRecoverySessions();
  const pending = helper.requestInstalledClientObservation({ ...input, sequence: 1 }, runtime);
  observer.sample();
  const result = await pending;
  assert.equal(result.roots, 0);
  assert.equal(result.snapshots, 0);
  assert.equal(result.factoryCalls, 1);
  sessions.close();
});
