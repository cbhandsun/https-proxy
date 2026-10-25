'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const {
  installCoverageIoCapture,
  parseSummary,
  readCoverageIoReceipt,
} = require('../scripts/lib/coverage-io-capture');
const summary = () => ({
  schemaVersion: 1,
  scope: 'synthetic_sqlite_etw_flush_pairs',
  events: 3,
  pairedFlushes: 1,
  database: { count: 1, maxMs: 20, over100Ms: 0, over1000Ms: 0 },
  journal: { count: 0, maxMs: 0, over100Ms: 0, over1000Ms: 0 },
  collisions: 0,
  unmatchedEnds: 0,
  failedFlushes: 0,
  unfinishedFlushes: 0,
  traceCompletenessVerified: false,
  fiveSecondQualified: false,
  realModelRequests: 0,
});
const failure = { message: 'coverage_io_capture_failed' };
function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-coverage-capture-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = {
    HPM_COVERAGE_IO: 'a'.repeat(40),
    HPM_COVERAGE_IO_STAGE: 'proxy',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_ACTIONS: 'true',
    CI: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows',
    RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'cbhandsun/https-proxy',
    GITHUB_WORKFLOW_REF:
      'cbhandsun/https-proxy/.github/workflows/windows-persistent-io-coverage.yml@refs/heads/acceptance/context-recovery/fixture',
    GITHUB_WORKSPACE: path.resolve(__dirname, '..'),
    RUNNER_TEMP: root,
    TOKEN: 'PRIVATE',
    API_KEY: 'PRIVATE',
    NODE_OPTIONS: 'PRIVATE',
  };
  const hooks = {},
    timeouts = {},
    reports = [],
    commands = [],
    killed = [];
  const host = {
    before(fn, options) {
      hooks.before = fn;
      timeouts.before = options.timeout;
    },
    after(fn, options) {
      hooks.after = fn;
      timeouts.after = options.timeout;
    },
  };
  function start(mode = 'success') {
    return (program, args, options) => {
      assert.equal(program, 'pwsh');
      assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File']);
      assert.equal(options.shell, false);
      for (const key of ['TOKEN', 'API_KEY', 'NODE_OPTIONS'])
        assert.equal(Object.hasOwn(options.env, key), false);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        killed.push(signal);
        child.emit('close', null, signal);
        return true;
      };
      child.stdin = new Writable({
        write(chunk, _encoding, done) {
          const command = chunk.toString();
          commands.push(command);
          done();
          if (command === 'abort\n') {
            queueMicrotask(() => child.emit('close', 1, null));
            return;
          }
          assert.equal(command, 'finish\n');
          if (mode === 'stop-timeout') return;
          queueMicrotask(() => {
            let text = 'HPM_PERSISTENT_IO=' + JSON.stringify(summary()) + '\n';
            if (mode === 'private-output') text = 'PRIVATE_MODEL_REPLY\n';
            if (mode === 'duplicate-summary') text += text;
            if (mode !== 'missing-summary') child.stdout.write(text);
            child.stderr.write(
              mode === 'extra-stderr'
                ? 'persistent_io_trace_bytes=1024\n\n'
                : mode === 'private-error'
                  ? 'PRIVATE_ERROR\n'
                  : mode === 'stderr-overflow'
                    ? 'x'.repeat(16385)
                    : mode === 'size-overflow'
                      ? 'persistent_io_trace_bytes=999999999\n'
                      : 'persistent_io_trace_bytes=1024\n'
            );
            if (mode === 'stdin-error') child.stdin.emit('error', new Error('PRIVATE'));
            child.emit('close', mode === 'nonzero' ? 1 : 0, mode === 'signal' ? 'SIGTERM' : null);
          });
        },
      });
      queueMicrotask(() => {
        if (mode === 'ready-timeout') return;
        if (mode === 'spawn-error') {
          child.emit('error', new Error('PRIVATE'));
          return;
        }
        child.stdout.write('HPM_PERSISTENT_IO_CAPTURE_READY\r\n');
        if (mode === 'duplicate-ready') child.stdout.write('HPM_PERSISTENT_IO_CAPTURE_READY\n');
        if (mode === 'stdout-overflow') child.stdout.write('x'.repeat(16385));
        if (mode === 'premature-summary')
          child.stdout.write('HPM_PERSISTENT_IO=' + JSON.stringify(summary()) + '\n');
      });
      return child;
    };
  }
  return {
    root,
    environment,
    hooks,
    timeouts,
    reports,
    commands,
    killed,
    host,
    start,
    install(mode, extra = {}) {
      return installCoverageIoCapture(host, {
        environment,
        platform: 'win32',
        start: start(mode),
        report: (value) => reports.push(value),
        ...extra,
      });
    },
  };
}

test('capture is absent by default and refuses foreign/nonhosted/invalid authority before starting a process', (t) => {
  const f = fixture(t);
  let started = 0;
  const start = () => {
    started++;
    throw new Error('unexpected');
  };
  assert.equal(installCoverageIoCapture(f.host, { environment: {}, start }), false);
  assert.deepEqual(f.hooks, {});
  for (const change of [
    { CI: 'false' },
    { GITHUB_ACTIONS: 'false' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { RUNNER_OS: 'Linux' },
    { RUNNER_ARCH: 'ARM64' },
    { GITHUB_REPOSITORY: 'other/repo' },
    { GITHUB_WORKFLOW_REF: 'other' },
    { HPM_COVERAGE_IO: '' },
    { HPM_COVERAGE_IO: 'b'.repeat(40) },
    { GITHUB_SHA: 'x' },
    { GITHUB_SHA: 'a'.repeat(40) + '\n', HPM_COVERAGE_IO: 'a'.repeat(40) + '\n' },
    { HPM_COVERAGE_IO_STAGE: 'other' },
  ]) {
    assert.throws(
      () =>
        installCoverageIoCapture(f.host, {
          environment: { ...f.environment, ...change },
          platform: 'win32',
          start,
        }),
      failure
    );
  }
  assert.throws(
    () =>
      installCoverageIoCapture(f.host, { environment: f.environment, platform: 'darwin', start }),
    failure
  );
  let touched = 0;
  const env = Object.defineProperty({}, 'HPM_COVERAGE_IO', {
    get() {
      touched++;
      return 'a'.repeat(40);
    },
  });
  assert.throws(() => installCoverageIoCapture(f.host, { environment: env, start }), failure);
  assert.throws(
    () =>
      installCoverageIoCapture(f.host, {
        environment: new Proxy(
          {},
          {
            get() {
              touched++;
            },
          }
        ),
        start,
      }),
    failure
  );
  assert.equal(touched, 0);
  assert.equal(started, 0);
});

test('only a finished owned capture with clean exit can write the source-bound observation receipt', async (t) => {
  const f = fixture(t);
  assert.equal(f.install('success'), true);
  await f.hooks.before();
  assert.equal(f.reports.length, 0);
  await f.hooks.after();
  assert.deepEqual(f.commands, ['finish\n']);
  assert.deepEqual(f.killed, []);
  assert.equal(f.reports.length, 1);
  assert.deepEqual(readCoverageIoReceipt(f.environment), f.reports[0]);
  assert.equal(f.reports[0].cleanupVerified, true);
  assert.equal(f.reports[0].summary.fiveSecondQualified, false);
  assert.doesNotMatch(JSON.stringify(f.reports), /PRIVATE|checkpoint|Temp|0x/);
  assert.equal(f.timeouts.before, 65000);
  assert.equal(f.timeouts.after, 305000);
  assert.throws(
    () => f.install('success'),
    failure,
    'a prior receipt cannot qualify another capture'
  );
});

for (const mode of [
  'private-output',
  'duplicate-summary',
  'missing-summary',
  'private-error',
  'extra-stderr',
  'stderr-overflow',
  'size-overflow',
  'stdin-error',
  'nonzero',
  'signal',
]) {
  test('failed capture cannot produce a receipt or leak output: ' + mode, async (t) => {
    const f = fixture(t);
    f.install(mode);
    await f.hooks.before();
    await assert.rejects(f.hooks.after(), failure);
    assert.equal(f.reports.length, 0);
    assert.throws(() => readCoverageIoReceipt(f.environment));
  });
}
for (const mode of ['duplicate-ready', 'stdout-overflow', 'premature-summary', 'spawn-error']) {
  test(
    'capture startup refuses protocol failure and requests owned cleanup: ' + mode,
    async (t) => {
      const f = fixture(t);
      f.install(mode);
      await assert.rejects(f.hooks.before(), failure);
      assert.ok(f.commands.includes('abort\n'));
      assert.equal(f.reports.length, 0);
    }
  );
}

test('startup and stopping deadlines fail without extending recording or reporting confirmed cleanup', async (t) => {
  const f = fixture(t);
  f.install('ready-timeout', {
    wait: (promise, ms) =>
      ms === 30000 && !f.commands.length
        ? Promise.race([promise, Promise.reject(new Error('deadline'))])
        : promise,
  });
  await assert.rejects(f.hooks.before(), failure);
  assert.deepEqual(f.commands, ['abort\n']);
  const second = fixture(t);
  second.install('stop-timeout', {
    wait: (promise, ms) =>
      ms === 300000 ? Promise.race([promise, Promise.reject(new Error('deadline'))]) : promise,
  });
  await second.hooks.before();
  await assert.rejects(second.hooks.after(), failure);
  assert.deepEqual(second.killed, ['SIGKILL']);
  assert.equal(second.reports.length, 0);
});

test('summary admits only bounded positive observations, with no qualification or arbitrary fields', () => {
  assert.deepEqual(parseSummary(JSON.stringify(summary())), summary());
  for (const mutate of [
    (v) => {
      v.fiveSecondQualified = true;
    },
    (v) => {
      v.traceCompletenessVerified = true;
    },
    (v) => {
      v.realModelRequests = 1;
    },
    (v) => {
      v.collisions = 1;
    },
    (v) => {
      v.pairedFlushes = 0;
    },
    (v) => {
      v.events = 100001;
    },
    (v) => {
      v.journal.count = 2;
    },
    (v) => {
      v.database.maxMs = -1;
    },
    (v) => {
      v.database.over100Ms = 2;
    },
    (v) => {
      v.private = 'PRIVATE';
    },
  ]) {
    const value = summary();
    mutate(value);
    assert.throws(() => parseSummary(JSON.stringify(value)));
  }
  for (const text of [
    '',
    'PRIVATE',
    JSON.stringify(summary()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    'x'.repeat(16385),
  ])
    assert.throws(() => parseSummary(text));
  let touched = 0;
  assert.throws(() =>
    parseSummary({
      toString() {
        touched++;
        return '{}';
      },
    })
  );
  assert.equal(touched, 0);
});

test('the PowerShell capture entry refuses this nonhosted environment before trace access', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.resolve(__dirname, '../scripts/capture-persistent-io.ps1'),
    ],
    { encoding: 'utf8', timeout: 5000, env: { ...process.env, GITHUB_ACTIONS: 'false' } }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'persistent_io_diagnostic_failed:phase=host');
});

test('PowerShell control consumes only the bounded finish line and EOF without executing input', () => {
  const { spawnSync } = require('node:child_process');
  const modulePath = path
    .resolve(__dirname, '../scripts/lib/persistent-io-recording.psm1')
    .replaceAll("'", "''");
  const code = `
    $ErrorActionPreference='Stop'
    $module=Import-Module '${modulePath}' -PassThru -Force
    & $module {
      Read-HpmCoverageIoCommand -Reader ([IO.StringReader]::new("finish\u0060n"))
      foreach($text in @('', 'finish', "abort\u0060n", "finish\u0060r\u0060n", "finish\u0060nextra", "finish\u0060n\u0060n", ('x'*9+"\u0060n"), "完成\u0060n")) {
        $refused=$false
        try { Read-HpmCoverageIoCommand -Reader ([IO.StringReader]::new($text)) }
        catch { if($_.Exception.Message -cne 'persistent_io_capture_command_refused'){throw 'unsafe_capture_control_error'};$refused=$true }
        if(-not $refused){throw 'invalid_capture_control_accepted'}
      }
      $reader=[IO.StringReader]::new('');$reader.Dispose()
      $refused=$false;try {Read-HpmCoverageIoCommand -Reader $reader}catch{if($_.Exception.Message -cne 'persistent_io_capture_command_refused'){throw 'unsafe_reader_error'};$refused=$true}
      if(-not $refused){throw 'failed_reader_accepted'}
    }
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('source/stage receipt rejects wrong identity, duplicate JSON, unconfirmed cleanup and file boundaries', async (t) => {
  const f = fixture(t);
  f.install('success');
  await f.hooks.before();
  await f.hooks.after();
  const file = path.join(f.root, 'hpm-coverage-io-' + f.environment.GITHUB_SHA + '-proxy.json');
  const original = fs.readFileSync(file, 'utf8');
  for (const mutate of [
    (v) => {
      v.sourceSha = 'b'.repeat(40);
    },
    (v) => {
      v.coverageStage = 'client';
    },
    (v) => {
      v.cleanupVerified = false;
    },
    (v) => {
      v.summary.fiveSecondQualified = true;
    },
    (v) => {
      v.extra = 'PRIVATE';
    },
  ]) {
    const value = JSON.parse(original);
    mutate(value);
    fs.writeFileSync(file, JSON.stringify(value) + '\n');
    assert.throws(() => readCoverageIoReceipt(f.environment));
  }
  for (const text of [
    '',
    original.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    'x'.repeat(16385),
  ]) {
    fs.writeFileSync(file, text);
    assert.throws(() => readCoverageIoReceipt(f.environment));
  }
  fs.writeFileSync(file, original);
  const client = path.join(f.root, 'hpm-coverage-io-' + f.environment.GITHUB_SHA + '-client.json');
  fs.copyFileSync(file, client);
  assert.throws(() => readCoverageIoReceipt({ ...f.environment, HPM_COVERAGE_IO_STAGE: 'client' }));
  fs.rmSync(client);
  fs.linkSync(file, path.join(f.root, 'linked.json'));
  assert.throws(() => readCoverageIoReceipt(f.environment));
});

test('the original second coverage command gets a distinct source-bound observation', async (t) => {
  const f = fixture(t);
  f.environment.HPM_COVERAGE_IO_STAGE = 'client';
  f.install('success');
  await f.hooks.before();
  await f.hooks.after();
  assert.equal(readCoverageIoReceipt(f.environment).coverageStage, 'client');
});

test('real PowerShell private stdin/EOF handshake completes before the receipt is admitted', async (t) => {
  const { spawn } = require('node:child_process');
  const f = fixture(t);
  const modulePath = path
    .resolve(__dirname, '../scripts/lib/persistent-io-recording.psm1')
    .replaceAll("'", "''");
  for (const key of ['SystemRoot', 'WINDIR']) {
    if (typeof process.env[key] === 'string') f.environment[key] = process.env[key];
  }
  const file = path.join(f.root, 'synthetic-control.ps1');
  fs.writeFileSync(
    file,
    `$ErrorActionPreference='Stop'
$module=Import-Module '${modulePath}' -PassThru -Force
[Console]::Out.WriteLine('HPM_PERSISTENT_IO_CAPTURE_READY')
& $module { Read-HpmCoverageIoCommand }
[Console]::Error.WriteLine('persistent_io_trace_bytes=1024')
[Console]::Out.WriteLine('HPM_PERSISTENT_IO=${JSON.stringify(summary())}')
`
  );
  f.install('success', {
    start: (program, args, options) =>
      spawn(program, [...args.slice(0, 4), file], {
        ...options,
        env: { ...options.env, PATH: process.env.PATH },
      }),
  });
  await f.hooks.before();
  await f.hooks.after();
  assert.equal(readCoverageIoReceipt(f.environment).summary.pairedFlushes, 1);
  assert.equal(f.reports[0].summary.fiveSecondQualified, false);
});

test('actual coverage workflow stops after each failed original stage or receipt and never masks its exit', () => {
  const { spawnSync } = require('node:child_process');
  const workflow = fs
    .readFileSync(
      path.resolve(__dirname, '../.github/workflows/windows-persistent-io-coverage.yml'),
      'utf8'
    )
    .replaceAll('\r\n', '\n');
  const block = workflow.slice(
    workflow.indexOf('      - name: Execute complete original coverage commands')
  );
  const matched = block.match(/ {8}run: \|\n((?: {10}[^\n]*\n)+)/);
  assert.ok(matched);
  const body = matched[1].replace(/^ {10}/gm, '');
  const all = [
    'npm run test:coverage',
    'receipt proxy',
    'npm run test:client:coverage',
    'receipt client',
    'npm run test:frontend:coverage',
  ];
  for (const [mode, count] of [
    ['success', 5],
    ['npm-test:coverage', 2],
    ['receipt-proxy', 2],
    ['npm-test:client:coverage', 4],
    ['receipt-client', 4],
    ['npm-test:frontend:coverage', 5],
  ]) {
    const code = `
      $mode='${mode}'
      $calls=[Collections.Generic.List[string]]::new()
      function npm {
        param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Parts)
        [void]$calls.Add('npm '+($Parts -join ' '))
        $global:LASTEXITCODE=if($mode -ceq ('npm-'+$Parts[1])){1}else{0}
      }
      function node {
        param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Parts)
        if($Parts.Count -ne 1 -or $Parts[0] -cne 'scripts/check-coverage-io-receipt.cjs'){throw 'unexpected_receipt_command'}
        [void]$calls.Add('receipt '+$env:HPM_COVERAGE_IO_STAGE)
        $global:LASTEXITCODE=if($mode -ceq ('receipt-'+$env:HPM_COVERAGE_IO_STAGE)){1}else{0}
      }
      $failed=$false
      try { ${body} } catch { $failed=$true }
      [ordered]@{calls=@($calls);failed=$failed}|ConvertTo-Json -Compress
    `;
    const result = spawnSync(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      calls: all.slice(0, count),
      failed: mode !== 'success',
    });
    if (mode === 'npm-test:coverage')
      assert.equal(result.stderr.trim(), 'coverage_original_stage_failed:stage=proxy');
    else if (mode === 'npm-test:client:coverage')
      assert.equal(result.stderr.trim(), 'coverage_original_stage_failed:stage=client');
    else assert.equal(result.stderr, '');
  }
});

test('receipt publication refuses a replaced owned parent directory', async (t) => {
  const f = fixture(t);
  f.install('success');
  await f.hooks.before();
  const moved = f.root + '-owned-original';
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.renameSync(f.root, moved);
  fs.mkdirSync(f.root);
  await assert.rejects(f.hooks.after(), failure);
  assert.equal(f.reports.length, 0);
  assert.deepEqual(fs.readdirSync(f.root), []);
});
