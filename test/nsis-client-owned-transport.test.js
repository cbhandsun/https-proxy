'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const { digest } = require('../scripts/lib/nsis-encrypted-contract');
const {
  createInstalledClientSpawn,
  createInstalledCodexRestartSpawn,
  createInstalledClaudeRestartSpawn,
} = require('../scripts/lib/nsis-client-owned-transport');
const {
  validateOwnedSpec,
  loadOwnedSpec,
  runLauncher,
  hostRoot,
} = require('../scripts/lib/nsis-client-owned-launcher.cjs');
const failure = { message: 'nsis_client_owned_failed' };
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};

function fixture(t, fault) {
  const temp = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'owned-cli-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'hpm-installed-clients'),
    payload = path.join(root, 'payload'),
    caseRoot = path.join(root, 'cases', 'codex-default'),
    node = path.join(payload, 'runtime/node/node.exe'),
    binary = path.join(root, 'clients/codex.exe'),
    powershell = path.join(temp, 'pwsh.exe');
  for (const file of [
    node,
    binary,
    powershell,
    path.join(payload, 'runtime/native/hpm-context-recovery-key.exe'),
    path.join(payload, 'package-lock.json'),
    path.join(payload, 'lib/proxy/fixture.js'),
  ])
    write(file, 'inert synthetic file');
  const manifest = {
    schemaVersion: 2,
    nodeSha256: digest(node),
    contextRecoveryNativeSha256: digest(
      path.join(payload, 'runtime/native/hpm-context-recovery-key.exe')
    ),
    packageLockSha256: digest(path.join(payload, 'package-lock.json')),
    sourceSha256: { 'lib/proxy/fixture.js': digest(path.join(payload, 'lib/proxy/fixture.js')) },
  };
  write(path.join(payload, 'release-runtime-manifest.json'), JSON.stringify(manifest));
  const env = {};
  for (const name of [
    'HOME',
    'USERPROFILE',
    'CODEX_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
  ]) {
    env[name] = path.join(caseRoot, name.toLowerCase());
    fs.mkdirSync(env[name], { recursive: true });
  }
  env.HPM_NSIS_CLIENT_ENTRY = 'synthetic_' + 't'.repeat(32);
  const runtime = {
    platform: 'win32',
    execPath: node,
    execArgv: [],
    env: {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Windows',
      RUNNER_TEMP: temp,
    },
  };
  const options = {
    ownedRoot: root,
    caseRoot,
    client: 'codex',
    manifestSha256: digest(path.join(payload, 'release-runtime-manifest.json')),
    binarySha256: digest(binary),
    powershellExecutable: powershell,
  };
  const child = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
  let calls = 0,
    launch;
  child.stdin.once('finish', () => {
    if (fault === 'never-close') return;
    if (fault === 'binary-changed') fs.appendFileSync(binary, 'changed');
    if (fault === 'spec-changed')
      fs.appendFileSync(path.join(caseRoot, 'client-launch.json'), 'changed');
    queueMicrotask(() =>
      child.emit('close', fault === 'exit-failed' ? 1 : 0, fault === 'signal' ? 'SIGTERM' : null)
    );
  });
  const dependencies = {
    runtime,
    spawn(executable, args, input) {
      calls++;
      launch = { executable, args, input };
      if (fault === 'spawn-throw') throw new Error('PRIVATE executable error');
      return child;
    },
  };
  return {
    options,
    runtime,
    node,
    binary,
    caseRoot,
    child,
    dependencies,
    input: { args: ['app-server', '--listen', 'stdio://'], cwd: caseRoot, env },
    calls: () => calls,
    launch: () => launch,
  };
}

test('owned transport pins packaged Node, binary, spec and fixed PS bridge, then awaits the tree acknowledgement once', async (t) => {
  const f = fixture(t),
    spawn = createInstalledClientSpawn(f.options, f.dependencies);
  const owned = await spawn(f.input);
  assert.equal(owned.child, f.child);
  const launch = f.launch();
  assert.equal(launch.executable, f.options.powershellExecutable);
  assert.ok(launch.args[4].endsWith('nsis-client-owned-process.ps1'));
  assert.equal(launch.input.shell, false);
  assert.equal(launch.input.cwd, f.caseRoot);
  assert.equal(launch.input.env.GITHUB_ACTIONS, 'true');
  assert.equal(Object.hasOwn(launch.input.env, 'HPM_NSIS_CLIENT_ENTRY'), false);
  const file = path.join(f.caseRoot, 'client-launch.json'),
    spec = JSON.parse(fs.readFileSync(file));
  assert.equal(spec.nodeSha256, digest(f.node));
  assert.equal(spec.binarySha256, digest(f.binary));
  assert.equal(loadOwnedSpec(file, digest(file), f.runtime).binary, f.binary);
  const first = owned.stop(),
    again = owned.stop();
  assert.equal(first, again);
  assert.deepEqual(await first, { terminal: true, treeStopped: true });
  await assert.rejects(spawn(f.input), failure);
  assert.equal(f.calls(), 1);
});

test('owned launcher consumes a single grant byte and never spawns on EOF or malformed grant', () => {
  for (const gate of [null, 0, 48, 50]) {
    let started = 0;
    assert.throws(
      () =>
        runLauncher(
          { argv: ['node', 'launcher', 'spec', 'sha'] },
          (_fd, bytes) => {
            if (gate === null) return 0;
            bytes[0] = gate;
            return 1;
          },
          () => {
            started++;
          }
        ),
      failure
    );
    assert.equal(started, 0);
  }
});

test('owned transport rejects bad identity, env, executable override and existing specs before starting PS', async (t) => {
  for (const mutate of [
    (f) => {
      f.input.executable = path.join(f.options.ownedRoot, 'clients/arbitrary.exe');
    },
    (f) => {
      f.input.cwd = path.dirname(f.caseRoot);
    },
    (f) => {
      f.input.env.OPENAI_API_KEY = 'PRIVATE';
    },
    (f) => {
      f.input.env.HOME = path.dirname(f.caseRoot);
    },
    (f) => {
      f.input.args = ['exec', 'unsafe'];
    },
    (f) => {
      f.input.stdio = ['pipe', 'inherit', 'pipe'];
    },
    (f) => {
      f.input.windowsHide = false;
    },
    (f) => {
      f.options.binarySha256 = '0'.repeat(64);
    },
    (f) => {
      f.options.manifestSha256 = '0'.repeat(64);
    },
    (f) => {
      write(path.join(f.caseRoot, 'client-launch.json'), 'existing sentinel');
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(createInstalledClientSpawn(f.options, f.dependencies)(f.input), failure);
    assert.equal(f.calls(), 0);
  }
});

test('owned stop rejects process errors and identity mutations without PID kill or an automatic restart', async (t) => {
  for (const fault of ['exit-failed', 'signal', 'binary-changed', 'spec-changed']) {
    const f = fixture(t, fault),
      owned = await createInstalledClientSpawn(f.options, f.dependencies)(f.input);
    await assert.rejects(owned.stop(), failure);
    assert.equal(f.calls(), 1);
  }
  const f = fixture(t, 'spawn-throw');
  await assert.rejects(createInstalledClientSpawn(f.options, f.dependencies)(f.input), failure);
  assert.equal(f.calls(), 1);
});

test('owned host and spec admission reject non-hosted, wrong root, hostile descriptors and unsafe node identity', async (t) => {
  const f = fixture(t),
    owned = await createInstalledClientSpawn(f.options, f.dependencies)(f.input);
  const file = path.join(f.caseRoot, 'client-launch.json'),
    spec = JSON.parse(fs.readFileSync(file));
  for (const runtime of [
    { ...f.runtime, platform: 'darwin' },
    { ...f.runtime, env: {} },
    { ...f.runtime, env: { ...f.runtime.env, RUNNER_ENVIRONMENT: 'self-hosted' } },
  ])
    assert.throws(() => hostRoot(f.options.ownedRoot, runtime), failure);
  for (const runtime of [
    { ...f.runtime, execPath: process.execPath },
    { ...f.runtime, execArgv: ['--require', 'unsafe'] },
    { ...f.runtime, env: { ...f.runtime.env, NODE_OPTIONS: 'PRIVATE' } },
  ])
    assert.throws(() => validateOwnedSpec(spec, runtime, true), failure);
  let access = 0;
  const malicious = { ...spec };
  Object.defineProperty(malicious, 'env', {
    enumerable: true,
    get() {
      access++;
      return spec.env;
    },
  });
  assert.throws(() => validateOwnedSpec(malicious, f.runtime), failure);
  assert.equal(access, 0);
  await owned.stop();
});

test('PowerShell bridge parses and preserves Assign-before-grant, EOF cleanup and no process-kill fallback', () => {
  const script = path.resolve(__dirname, '../scripts/lib/nsis-client-owned-process.ps1');
  const text = fs.readFileSync(script, 'utf8');
  assert.ok(text.indexOf('$job.Assign($process)') < text.indexOf('WriteByte(49)'));
  assert.match(text, /CopyToAsync/);
  assert.match(text, /StopAndWait\(5000\)/);
  assert.doesNotMatch(text, /\.Kill\(|Stop-Process|taskkill/i);
  const command =
    "$errors=$null; $tokens=$null; [void][Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts/lib/nsis-client-owned-process.ps1'),[ref]$tokens,[ref]$errors); if($errors.Count -ne 0){exit 1}";
  const result = spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000, maxBuffer: 4096 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('owned launcher grant precedes its fixed CLI spawn and preserves raw bidirectional bytes without stderr', async (t) => {
  const f = fixture(t),
    owned = await createInstalledClientSpawn(f.options, f.dependencies)(f.input);
  const file = path.join(f.caseRoot, 'client-launch.json');
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    output = [],
    received = [],
    order = [];
  stdout.on('data', (bytes) => output.push(bytes));
  const cli = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) cli[name] = new PassThrough();
  cli.stdin.on('data', (bytes) => received.push(bytes));
  const runtime = { ...f.runtime, argv: [f.node, 'launcher', file, digest(file)], stdin, stdout };
  runLauncher(
    runtime,
    (_fd, bytes, offset, length) => {
      assert.equal(length, 1);
      order.push('grant');
      bytes[offset] = 49;
      return 1;
    },
    (program, args, options) => {
      order.push('spawn');
      assert.equal(program, f.binary);
      assert.deepEqual(args, f.input.args);
      assert.equal(options.shell, false);
      return cli;
    }
  );
  assert.deepEqual(order, ['grant', 'spawn']);
  stdin.write(Buffer.from('request 中文🙂\n'));
  cli.stdout.write(Buffer.from('reply 中文🙂\n'));
  cli.stderr.write('PRIVATE ignored stderr');
  assert.equal(Buffer.concat(received).toString(), 'request 中文🙂\n');
  assert.equal(Buffer.concat(output).toString(), 'reply 中文🙂\n');
  fs.appendFileSync(f.binary, 'changed after spawn');
  cli.emit('close', 0);
  assert.equal(runtime.exitCode, 1);
  await assert.rejects(owned.stop(), failure);
});

test('owned stop times out at the unchanged 20-second bound and never fabricates terminal acknowledgement', async (t) => {
  const f = fixture(t, 'never-close'),
    owned = await createInstalledClientSpawn(f.options, f.dependencies)(f.input);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = owned.stop();
  const rejected = assert.rejects(stopped, failure);
  t.mock.timers.tick(20000);
  await rejected;
  assert.equal(f.calls(), 1);
});

test('PS rejects non-Windows or malformed launch spec using only the fixed safe error', () => {
  if (process.platform === 'win32') return; // This is an explicit platform-refusal negative control.
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.resolve(__dirname, '../scripts/lib/nsis-client-owned-process.ps1'),
      '-SpecFile',
      'PRIVATE_UNTRUSTED_PATH',
      '-SpecSha256',
      'PRIVATE_UNTRUSTED_HASH',
    ],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'HPM_OWNED_FAILURE=admission\nnsis_client_owned_failed\n');
});

test('PowerShell production pipe and exit helpers reject failed terminal states and bound each output stream', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.resolve(__dirname, 'fixtures/nsis-client-owned-pipes.ps1'),
      '-ScriptFile',
      path.resolve(__dirname, '../scripts/lib/nsis-client-owned-process.ps1'),
    ],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { checks: 14, nativeCalls: 0, networkCalls: 0 });
});

test('launcher rejects CLI nonzero, signal, stream errors and excessive discarded stderr', async (t) => {
  for (const fault of ['nonzero', 'signal', 'stderr-limit', 'stream-error']) {
    const f = fixture(t),
      owned = await createInstalledClientSpawn(f.options, f.dependencies)(f.input);
    const file = path.join(f.caseRoot, 'client-launch.json');
    const runtime = {
      ...f.runtime,
      argv: [f.node, 'launcher', file, digest(file)],
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    };
    const cli = new EventEmitter();
    for (const name of ['stdin', 'stdout', 'stderr']) cli[name] = new PassThrough();
    runLauncher(
      runtime,
      (_fd, bytes) => {
        bytes[0] = 49;
        return 1;
      },
      () => cli
    );
    if (fault === 'nonzero') cli.emit('close', 1, null);
    if (fault === 'signal') cli.emit('close', null, 'SIGTERM');
    if (fault === 'stream-error') cli.stdout.emit('error', new Error('PRIVATE'));
    if (fault === 'stderr-limit') {
      cli.stderr.write(Buffer.alloc(262144));
      assert.equal(runtime.exitCode, undefined);
      cli.stderr.write(Buffer.alloc(1));
    }
    assert.equal(runtime.exitCode, 1);
    await owned.stop();
  }
});

test('locked Windows Codex binary larger than the generic digest cap reaches owned launch', async (t) => {
  const f = fixture(t);
  const size = 326875440;
  fs.truncateSync(f.binary, size);
  const { createHash } = require('node:crypto');
  const hash = createHash('sha256');
  const fd = fs.openSync(f.binary, 'r');
  try {
    const block = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, block, 0, block.length, null)))
      hash.update(block.subarray(0, count));
  } finally {
    fs.closeSync(fd);
  }
  f.options.binarySha256 = hash.digest('hex');
  assert.throws(() => digest(f.binary));
  const start = createInstalledClientSpawn(f.options, f.dependencies);
  const owned = await start(f.input);
  assert.equal(f.calls(), 1);
  assert.deepEqual(await owned.stop(), { terminal: true, treeStopped: true });
});

function restartFixture(t, { hold = false, failed = false } = {}) {
  const f = fixture(t),
    children = [],
    launches = [];
  const releases = [];
  f.dependencies.spawn = (executable, args, input) => {
    const child = new EventEmitter();
    for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
    child.stdin.once('finish', () => {
      const release = () => child.emit('close', failed ? 1 : 0, null);
      if (hold) releases.push(release);
      else queueMicrotask(release);
    });
    children.push(child);
    launches.push({ executable, args, input });
    return child;
  };
  return { ...f, children, launches, releases };
}

test('explicit Codex restart grant allows exactly two independently owned processes with the same immutable spec', async (t) => {
  const f = restartFixture(t),
    launch = createInstalledCodexRestartSpawn(f.options, f.dependencies);
  const first = await launch(f.input);
  const file = path.join(f.caseRoot, 'client-launch.json'),
    before = fs.readFileSync(file);
  assert.deepEqual(await first.stop(), { terminal: true, treeStopped: true });
  const second = await launch(f.input);
  assert.notEqual(first.child, second.child);
  assert.deepEqual(f.launches[1], f.launches[0]);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(await second.stop(), { terminal: true, treeStopped: true });
  await assert.rejects(launch(f.input), failure);
  assert.equal(f.children.length, 2);
});

test('restart grant permanently rejects admission before the first owned tree is confirmed terminal', async (t) => {
  for (const pendingStop of [false, true]) {
    const f = restartFixture(t, { hold: true }),
      launch = createInstalledCodexRestartSpawn(f.options, f.dependencies);
    const first = await launch(f.input);
    const pending = pendingStop ? first.stop() : undefined;
    await assert.rejects(launch(f.input), failure);
    const stopping = pending ?? first.stop();
    await new Promise(setImmediate);
    assert.equal(f.releases.length, 1);
    f.releases[0]();
    assert.deepEqual(await stopping, { terminal: true, treeStopped: true });
    await assert.rejects(launch(f.input), failure);
    assert.equal(f.children.length, 1);
  }
});

test('restart grant refuses altered arguments, homes, tokens, spec bytes and installation identity before spawning', async (t) => {
  for (const change of ['args', 'home', 'token', 'spec', 'same-size-spec', 'binary', 'manifest']) {
    const f = restartFixture(t),
      launch = createInstalledCodexRestartSpawn(f.options, f.dependencies);
    const first = await launch(f.input);
    await first.stop();
    const next = globalThis.structuredClone(f.input);
    if (change === 'args') next.args.push('-c', 'model="other"');
    if (change === 'home') next.env.HOME = next.env.APPDATA;
    if (change === 'token') next.env.HPM_NSIS_CLIENT_ENTRY = 'other_' + 't'.repeat(32);
    if (change === 'spec') fs.appendFileSync(path.join(f.caseRoot, 'client-launch.json'), '\n');
    if (change === 'same-size-spec') {
      const file = path.join(f.caseRoot, 'client-launch.json'),
        bytes = fs.readFileSync(file);
      bytes[0] ^= 1;
      fs.writeFileSync(file, bytes);
    }
    if (change === 'binary') fs.appendFileSync(f.binary, 'changed');
    if (change === 'manifest')
      fs.appendFileSync(
        path.join(f.options.ownedRoot, 'payload/release-runtime-manifest.json'),
        'changed'
      );
    await assert.rejects(launch(next), failure);
    await assert.rejects(launch(f.input), failure);
    assert.equal(f.children.length, 1);
  }
});

test('restart grant rejects a failed first exit and does not retry or admit another client', async (t) => {
  const f = restartFixture(t, { failed: true }),
    launch = createInstalledCodexRestartSpawn(f.options, f.dependencies);
  const first = await launch(f.input);
  await assert.rejects(first.stop(), failure);
  await assert.rejects(launch(f.input), failure);
  assert.equal(f.children.length, 1);
  const g = restartFixture(t);
  assert.throws(
    () => createInstalledCodexRestartSpawn({ ...g.options, client: 'claude' }, g.dependencies),
    failure
  );
  assert.equal(fs.existsSync(path.join(g.caseRoot, 'client-launch.json')), false);
});

test('restart launch retains the original 64KiB spec bound and refuses oversized grants before writing or spawning', async (t) => {
  const f = restartFixture(t);
  for (const name of ['SystemRoot', 'WINDIR', 'PATH']) {
    f.runtime.env[name] = 'a'.repeat(16384);
    f.input.env[name] = f.runtime.env[name];
  }
  f.input.args.push('-c', 'x=' + 'a'.repeat(16300));
  const launch = createInstalledCodexRestartSpawn(f.options, f.dependencies);
  await assert.rejects(launch(f.input), failure);
  assert.equal(f.children.length, 0);
  assert.equal(fs.existsSync(path.join(f.caseRoot, 'client-launch.json')), false);
});

function claudeRestartFixture(t, fault) {
  const f = restartFixture(t, fault);
  const binary = path.join(f.options.ownedRoot, 'clients/claude.exe');
  write(binary, 'inert synthetic Claude');
  f.options.client = 'claude';
  f.options.binarySha256 = digest(binary);
  const env = f.input.env;
  delete env.CODEX_HOME;
  delete env.HPM_NSIS_CLIENT_ENTRY;
  env.CLAUDE_CONFIG_DIR = path.join(f.caseRoot, 'claude-config');
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  Object.assign(env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:41234',
    ANTHROPIC_AUTH_TOKEN: 'hpm-synthetic-' + 'a'.repeat(32),
    ANTHROPIC_MODEL: 'synthetic-claude',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  });
  f.input.args = ['--bare', '-p', '--model', 'synthetic-claude'];
  return { ...f, binary };
}
const claudeSession = '12345678-1234-4234-9234-123456789abc';

test('Claude resume receives a second immutable grant chained to the first and preserving every other launch fact', async (t) => {
  const f = claudeRestartFixture(t),
    launch = createInstalledClaudeRestartSpawn(f.options, f.dependencies);
  const first = await launch(f.input);
  const firstFile = path.join(f.caseRoot, 'client-launch.json'),
    before = fs.readFileSync(firstFile);
  await first.stop();
  const second = await launch({ ...f.input, args: [...f.input.args, '--resume', claudeSession] });
  assert.notEqual(first.child, second.child);
  const file = path.join(f.caseRoot, 'client-resume.json'),
    spec = JSON.parse(fs.readFileSync(file));
  assert.equal(spec.schemaVersion, 2);
  assert.equal(spec.predecessorSha256, digest(firstFile));
  assert.deepEqual(fs.readFileSync(firstFile), before);
  assert.equal(loadOwnedSpec(file, digest(file), f.runtime).binary, f.binary);
  assert.deepEqual(await second.stop(), { terminal: true, treeStopped: true });
  await assert.rejects(launch(f.input), failure);
  assert.equal(f.children.length, 2);
});

test('Claude second grant refuses arbitrary resume selectors, extra flags and changed credentials before spawn', async (t) => {
  for (const change of [
    'missing',
    'name',
    'path',
    'empty',
    'long',
    'duplicate',
    'fork',
    'model',
    'token',
    'home',
    'first-grant',
    'existing-resume',
  ]) {
    const f = claudeRestartFixture(t),
      launch = createInstalledClaudeRestartSpawn(f.options, f.dependencies);
    const first = await launch(f.input);
    await first.stop();
    const next = globalThis.structuredClone(f.input);
    next.args.push('--resume', claudeSession);
    if (change === 'missing') next.args = f.input.args;
    if (change === 'name') next.args[next.args.length - 1] = 'daily-session';
    if (change === 'path') next.args[next.args.length - 1] = '/private/transcript.jsonl';
    if (change === 'empty') next.args[next.args.length - 1] = '';
    if (change === 'long') next.args[next.args.length - 1] = 'a'.repeat(16384);
    if (change === 'duplicate') next.args.push('--resume', claudeSession);
    if (change === 'fork') next.args.splice(1, 0, '--fork-session');
    if (change === 'model') next.args[3] = 'other';
    if (change === 'token') next.env.ANTHROPIC_AUTH_TOKEN = 'hpm-synthetic-' + 'b'.repeat(32);
    if (change === 'home') next.env.HOME = next.env.APPDATA;
    if (change === 'first-grant')
      fs.appendFileSync(path.join(f.caseRoot, 'client-launch.json'), 'changed');
    if (change === 'existing-resume')
      fs.writeFileSync(path.join(f.caseRoot, 'client-resume.json'), 'PRIVATE');
    await assert.rejects(launch(next), failure);
    assert.equal(f.children.length, 1);
  }
});

test('Claude first grant forbids an inherited or non-persistent session and premature restart', async (t) => {
  for (const flag of [
    '--resume',
    '--resume=' + claudeSession,
    '--continue',
    '-c',
    '-r',
    '--session-id',
    '--fork-session',
    '--no-session-persistence',
  ]) {
    const f = claudeRestartFixture(t),
      launch = createInstalledClaudeRestartSpawn(f.options, f.dependencies);
    await assert.rejects(launch({ ...f.input, args: [...f.input.args, flag] }), failure);
    assert.equal(f.children.length, 0);
  }
  const f = claudeRestartFixture(t),
    launch = createInstalledClaudeRestartSpawn(f.options, f.dependencies);
  const first = await launch(f.input);
  await assert.rejects(
    launch({ ...f.input, args: [...f.input.args, '--resume', claudeSession] }),
    failure
  );
  await first.stop();
  await assert.rejects(launch(f.input), failure);
  assert.equal(f.children.length, 1);
});

test('Claude resume cannot replace its predecessor or conceal a nested chain or malformed grant', async (t) => {
  const f = claudeRestartFixture(t),
    launch = createInstalledClaudeRestartSpawn(f.options, f.dependencies);
  const first = await launch(f.input);
  await first.stop();
  const second = await launch({ ...f.input, args: [...f.input.args, '--resume', claudeSession] });
  const file = path.join(f.caseRoot, 'client-resume.json'),
    original = fs.readFileSync(file),
    spec = JSON.parse(original);
  for (const change of [
    (x) => {
      x.predecessorSha256 = 'f'.repeat(64);
    },
    (x) => {
      x.client = 'codex';
    },
    (x) => {
      x.extra = true;
    },
    (x) => {
      x.args[x.args.length - 1] = 'daily';
    },
  ]) {
    const changed = globalThis.structuredClone(spec);
    change(changed);
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => loadOwnedSpec(file, digest(file), f.runtime), failure);
  }
  fs.writeFileSync(file, original);
  const firstFile = path.join(f.caseRoot, 'client-launch.json');
  const prior = fs.readFileSync(firstFile);
  fs.writeFileSync(firstFile, original);
  const nested = { ...spec, predecessorSha256: digest(firstFile) };
  fs.writeFileSync(file, JSON.stringify(nested));
  assert.throws(() => loadOwnedSpec(file, digest(file), f.runtime), failure);
  fs.writeFileSync(firstFile, prior);
  fs.writeFileSync(file, original);
  await second.stop();
});

test('owned launch reader bounds raw bytes and rejects ambiguous UTF-8, JSON and linked grants', async (t) => {
  const f = fixture(t),
    owned = await createInstalledClientSpawn(f.options, f.dependencies)(f.input);
  const file = path.join(f.caseRoot, 'client-launch.json'),
    original = fs.readFileSync(file),
    expected = digest(file);
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(65537, 65),
    Buffer.from([255]),
    Buffer.concat([Buffer.from([239, 187, 191]), original]),
    Buffer.from('null'),
    Buffer.from(
      original.toString().replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1')
    ),
    Buffer.concat([original, Buffer.from(' ')]),
  ]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => loadOwnedSpec(file, digest(file), f.runtime), failure);
  }
  fs.writeFileSync(file, original);
  const alias = path.join(f.caseRoot, 'linked-grant');
  fs.linkSync(file, alias);
  assert.throws(() => loadOwnedSpec(file, expected, f.runtime), failure);
  fs.unlinkSync(alias);
  await owned.stop();
});

test('owned grant reader rejects growth and replacement during its bounded fd read', async (t) => {
  for (const mode of ['grow', 'replace']) {
    const f = fixture(t),
      owned = await createInstalledClientSpawn(f.options, f.dependencies)(f.input);
    const file = path.join(f.caseRoot, 'client-launch.json'),
      original = fs.readFileSync(file),
      expected = digest(file);
    const read = fs.readSync;
    let touched = false;
    const mock = t.mock.method(fs, 'readSync', function (...args) {
      if (!touched) {
        touched = true;
        if (mode === 'grow') fs.appendFileSync(file, 'changed');
        else {
          fs.renameSync(file, file + '.old');
          fs.writeFileSync(file, original);
        }
      }
      return Reflect.apply(read, this, args);
    });
    try {
      assert.throws(() => loadOwnedSpec(file, expected, f.runtime), failure);
      assert.equal(touched, true);
    } finally {
      mock.mock.restore();
      fs.writeFileSync(file, original);
    }
    await owned.stop();
  }
});

test('owned stop classifies only its fixed rejection boundary and permanently denies restart', async (t) => {
  for (const [fault, code] of [
    ['exit-failed', 'nsis_owned_stop_controller_exit'],
    ['signal', 'nsis_owned_stop_controller_signal'],
    ['spec-changed', 'nsis_owned_stop_spec'],
    ['binary-changed', 'nsis_owned_stop_identity'],
    ['stream', 'nsis_owned_stop_stream'],
    ['spec-missing', 'nsis_owned_stop_spec'],
  ]) {
    const f = fixture(t, fault),
      spawn = createInstalledCodexRestartSpawn(f.options, f.dependencies);
    const owned = await spawn(f.input);
    if (fault === 'stream')
      f.child.stdout.emit(
        'error',
        Object.assign(new Error('PRIVATE raw error'), { code: 'nsis_owned_stop_controller_eof' })
      );
    if (fault === 'spec-missing') fs.unlinkSync(path.join(f.caseRoot, 'client-launch.json'));
    const stopped = owned.stop();
    assert.equal(owned.stop(), stopped);
    await assert.rejects(stopped, { message: 'nsis_client_owned_failed', code });
    await assert.rejects(owned.stop(), { message: 'nsis_client_owned_failed', code });
    await assert.rejects(spawn(f.input), failure);
    assert.equal(f.calls(), 1);
  }
});

test('owned stop timeout keeps the original 20-second limit and its fixed failure code', async (t) => {
  const f = fixture(t, 'never-close'),
    spawn = createInstalledCodexRestartSpawn(f.options, f.dependencies);
  const owned = await spawn(f.input);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = owned.stop();
  const rejected = assert.rejects(stopped, {
    message: 'nsis_client_owned_failed',
    code: 'nsis_owned_stop_timeout',
  });
  let settled = false;
  void stopped.catch(() => {
    settled = true;
  });
  t.mock.timers.tick(19999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(owned.stop(), stopped);
  await assert.rejects(spawn(f.input), failure);
  assert.equal(f.calls(), 1);
});

test('owned stop consumes only bounded closed controller failure markers without exposing stderr', async (t) => {
  const phases = [
    'admission',
    'launch',
    'forward',
    'eof',
    'natural_exit',
    'natural_exit_timeout',
    'natural_exit_code',
    'job_cleanup',
    'process_cleanup',
    'drain',
    'final_identity',
  ];
  for (const phase of phases) {
    const f = fixture(t, 'exit-failed'),
      owned = await createInstalledClientSpawn(f.options, f.dependencies)(f.input);
    f.child.stderr.write('PRIVATE arbitrary stderr\nHPM_OWNED_FAIL');
    f.child.stderr.write('URE=' + phase + '\r\n');
    await assert.rejects(owned.stop(), (error) => {
      assert.equal(error.message, 'nsis_client_owned_failed');
      assert.equal(error.code, 'nsis_owned_stop_controller_' + phase);
      assert.equal(JSON.stringify(error).includes('PRIVATE'), false);
      return true;
    });
  }
  for (const stderr of [
    'HPM_OWNED_FAILURE=unknown\n',
    'HPM_OWNED_FAILURE=launch\nHPM_OWNED_FAILURE=drain\n',
    'HPM_OWNED_FAILURE=launch\nHPM_OWNED_FAILURE=launch\n',
    'HPM_OWNED_FAILURE=launch',
  ]) {
    const f = fixture(t, 'exit-failed'),
      owned = await createInstalledClientSpawn(f.options, f.dependencies)(f.input);
    f.child.stderr.write(stderr);
    await assert.rejects(owned.stop(), {
      message: 'nsis_client_owned_failed',
      code: 'nsis_owned_stop_diagnostic_invalid',
    });
  }
  const recovered = fixture(t, 'exit-failed');
  const recoveredOwned = await createInstalledClientSpawn(
    recovered.options,
    recovered.dependencies
  )(recovered.input);
  recovered.child.stderr.write('HPM_OWNED_FAILURE=' + 'x'.repeat(1024 * 1024) + '\n');
  recovered.child.stderr.write('HPM_OWNED_FAILURE=eof\n');
  await assert.rejects(recoveredOwned.stop(), {
    message: 'nsis_client_owned_failed',
    code: 'nsis_owned_stop_controller_eof',
  });
  const marked = fixture(t),
    rejected = await createInstalledClientSpawn(marked.options, marked.dependencies)(marked.input);
  marked.child.stderr.write('HPM_OWNED_FAILURE=drain\n');
  await assert.rejects(rejected.stop(), {
    message: 'nsis_client_owned_failed',
    code: 'nsis_owned_stop_controller_drain',
  });
  for (const stderr of [
    '',
    'PRIVATE ignored\n',
    'x'.repeat(1024 * 1024) + '\n',
    'noise HPM_OWNED_FAILURE=launch\n',
  ]) {
    const f = fixture(t),
      owned = await createInstalledClientSpawn(f.options, f.dependencies)(f.input);
    f.child.stderr.write(stderr);
    assert.deepEqual(await owned.stop(), { terminal: true, treeStopped: true });
  }
});
