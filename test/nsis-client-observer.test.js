'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const observer = require('../scripts/lib/nsis-client-observer.cjs');
const {
  verifyInstalledClientObserver,
} = require('../scripts/lib/context-recovery-daemon-start-gate.cjs');
const {
  installInstalledClientObserver,
} = require('../scripts/lib/nsis-client-observer-bootstrap.cjs');
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const failure = { message: 'installed_client_observer_rejected' };
function fixture(t, real = false) {
  const temp = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'observer-'));
  const root = path.join(temp, 'hpm-installed-clients'),
    install = path.join(root, 'payload'),
    caseRoot = path.join(root, 'cases/default');
  fs.mkdirSync(caseRoot, { recursive: true });
  fs.mkdirSync(install);
  const sessions = path.join(install, 'lib/proxy/context-recovery-sessions.js');
  if (real)
    fs.cpSync(path.resolve(__dirname, '../lib'), path.join(install, 'lib'), { recursive: true });
  else {
    fs.mkdirSync(path.dirname(sessions), { recursive: true });
    fs.writeFileSync(
      sessions,
      "module.exports={createContextRecoverySessions(...args){return {args,inspect(){return {roots:0,snapshots:0,enabled:false,closed:false}}}},restoreContextRecoverySessions(){throw new Error('sentinel')}};"
    );
  }
  const manifest = path.join(install, 'release-runtime-manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({ sourceSha256: { 'lib/proxy/context-recovery-sessions.js': digest(sessions) } })
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
    pid: 123,
    env: {
      RUNNER_TEMP: temp,
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Windows',
      HPM_INSTALLED_CLIENT_OBSERVER: '1',
      HPM_DAEMON_OWNED_CASE_ROOT: caseRoot,
      HPM_DAEMON_OWNED_INSTALL: install,
      HPM_DAEMON_OWNED_MANIFEST: input.manifestSha256,
      MGMT_TOKEN: input.token,
    },
  };
  t.after(() => {
    for (const file of Object.keys(require.cache))
      if (file.startsWith(install)) delete require.cache[file];
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { input, runtime, sessions, dir: path.join(caseRoot, 'installed-client-observer') };
}
test('observer prep binds pid manifest and complete fixed closure, disabled gate stays inert', (t) => {
  const f = fixture(t);
  assert.equal(verifyInstalledClientObserver({ env: {} }), null);
  assert.deepEqual(observer.prepareInstalledClientObserver(f.input, f.runtime), {
    prepared: true,
    pid: 123,
    manifestSha256: f.input.manifestSha256,
  });
  // Gate deliberately refuses warm observer modules. A fresh preload must verify before require.
  assert.throws(() => verifyInstalledClientObserver(f.runtime), {
    message: 'daemon_start_gate_rejected',
  });
  const cached = [];
  for (const name of ['nsis-client-observer.cjs', 'nsis-client-observer-bootstrap.cjs']) {
    const file = path.resolve(__dirname, '../scripts/lib', name);
    cached.push([file, require.cache[file]]);
    delete require.cache[file];
  }
  try {
    assert.deepEqual(verifyInstalledClientObserver(f.runtime), f.input);
  } finally {
    for (const [file, module] of cached) require.cache[file] = module;
  }
  const file = path.join(f.dir, 'plan.json'),
    plan = JSON.parse(fs.readFileSync(file));
  plan.payload.pid++;
  fs.writeFileSync(file, JSON.stringify(plan));
  assert.throws(() => verifyInstalledClientObserver(f.runtime), {
    message: 'daemon_start_gate_rejected',
  });
});
test('observer delegates factory identity and exceptions, reads only signed monotonic safe counts', async (t) => {
  const f = fixture(t);
  observer.prepareInstalledClientObserver(f.input, f.runtime);
  const installed = installInstalledClientObserver(f.input, f.runtime);
  t.after(() => installed.close());
  const sessions = require(f.sessions),
    value = sessions.createContextRecoverySessions('sentinel');
  assert.deepEqual(value.args, ['sentinel']);
  assert.throws(() => sessions.restoreContextRecoverySessions(), { message: 'sentinel' });
  const pending = observer.requestInstalledClientObservation(
    { ...f.input, sequence: 1 },
    f.runtime
  );
  installed.sample();
  const result = await pending;
  assert.equal(result.roots, 0);
  assert.equal(result.snapshots, 0);
  assert.equal(result.factoryCalls, 1);
  assert.equal(result.enabled, false);
  assert.equal(JSON.stringify(result).includes('sentinel'), false);
  const second = observer.requestInstalledClientObservation({ ...f.input, sequence: 2 }, f.runtime);
  installed.sample();
  assert.equal((await second).sequence, 2);
  await assert.rejects(
    observer.requestInstalledClientObservation({ ...f.input, sequence: 4 }, f.runtime),
    failure
  );
});
test('observer never qualifies cold factories, warm sessions, changed source, malformed request or foreign host', async (t) => {
  for (const fault of ['cold', 'warm', 'changed', 'request']) {
    const f = fixture(t);
    observer.prepareInstalledClientObserver(f.input, f.runtime);
    if (fault === 'warm') {
      require(f.sessions);
      assert.throws(() => installInstalledClientObserver(f.input, f.runtime), failure);
      continue;
    }
    if (fault === 'changed') {
      fs.appendFileSync(f.sessions, '\n');
      assert.throws(() => installInstalledClientObserver(f.input, f.runtime), failure);
      continue;
    }
    const installed = installInstalledClientObserver(f.input, f.runtime);
    t.after(() => installed.close());
    if (fault === 'request') {
      require(f.sessions).createContextRecoverySessions();
      fs.writeFileSync(path.join(f.dir, 'request.json'), 'PRIVATE');
    } else
      observer.write(
        path.join(f.dir, 'request.json'),
        observer.envelope(
          { version: 1, pid: 123, manifestSha256: f.input.manifestSha256, sequence: 1 },
          f.input.token,
          'request'
        )
      );
    assert.throws(() => installed.sample(), failure);
    assert.throws(() => installed.sample(), failure);
    assert.equal(fs.existsSync(path.join(f.dir, 'receipt.json')), false);
  }
  const f = fixture(t);
  assert.throws(
    () => observer.prepareInstalledClientObserver(f.input, { ...f.runtime, platform: 'darwin' }),
    failure
  );
  let calls = 0;
  const hostile = { ...f.input };
  Object.defineProperty(hostile, 'token', {
    enumerable: true,
    get() {
      calls++;
      return f.input.token;
    },
  });
  assert.throws(() => observer.prepareInstalledClientObserver(hostile, f.runtime), failure);
  assert.equal(calls, 0);
});
test('observer actual installed sessions default creation reports zero roots and snapshots', async (t) => {
  const f = fixture(t, true);
  observer.prepareInstalledClientObserver(f.input, f.runtime);
  const installed = installInstalledClientObserver(f.input, f.runtime);
  t.after(() => installed.close());
  const sessions = require(f.sessions).createContextRecoverySessions();
  const pending = observer.requestInstalledClientObservation(
    { ...f.input, sequence: 1 },
    f.runtime
  );
  installed.sample();
  const result = await pending;
  assert.equal(result.roots, 0);
  assert.equal(result.snapshots, 0);
  assert.equal(result.closed, false);
  sessions.close();
});
test('observer CLI refuses unsupported host without exposing stdin secrets', () => {
  if (process.platform === 'win32') return;
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../scripts/lib/nsis-client-observer.cjs'), 'prepare'],
    {
      input: JSON.stringify({ token: 'PRIVATE' }),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 8192,
    }
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'installed_client_observer_rejected\n');
});

test('observer rejects unsafe paths, hardlinked mailbox, empty malformed signatures, and poisoned numeric counts', async (t) => {
  const f = fixture(t);
  for (const change of [
    { caseRoot: f.input.install },
    { caseRoot: f.input.caseRoot + '/../default' },
    { manifestSha256: '' },
    { pid: 0 },
    { token: '' },
    { install: f.input.install + '/../payload' },
  ])
    assert.throws(
      () => observer.prepareInstalledClientObserver({ ...f.input, ...change }, f.runtime),
      failure
    );
  let touched = false;
  assert.throws(
    () =>
      observer.prepareInstalledClientObserver(
        {
          ...f.input,
          manifestSha256: {
            toString() {
              touched = true;
              return f.input.manifestSha256;
            },
          },
        },
        f.runtime
      ),
    failure
  );
  assert.equal(touched, false);
  observer.prepareInstalledClientObserver(f.input, f.runtime);
  const plan = path.join(f.dir, 'plan.json');
  fs.linkSync(plan, path.join(f.dir, 'duplicate'));
  assert.throws(() => observer.read(plan), failure);
  fs.unlinkSync(path.join(f.dir, 'duplicate'));
  for (const value of [
    {},
    { payload: {}, signature: '' },
    { payload: {}, signature: '0'.repeat(64) },
  ])
    assert.throws(() => observer.authenticate(value, f.input.token, 'request'), failure);
  const installed = installInstalledClientObserver(f.input, f.runtime);
  t.after(() => installed.close());
  const session = require(f.sessions).createContextRecoverySessions();
  session.inspect = () => ({ roots: -1, snapshots: 0, enabled: false, closed: false });
  observer.write(
    path.join(f.dir, 'request.json'),
    observer.envelope(
      { version: 1, pid: 123, manifestSha256: f.input.manifestSha256, sequence: 1 },
      f.input.token,
      'request'
    )
  );
  assert.throws(() => installed.sample(), failure);
});

test('observer capacity failure stays passive for production factory return values', (t) => {
  const f = fixture(t);
  observer.prepareInstalledClientObserver(f.input, f.runtime);
  const installed = installInstalledClientObserver(f.input, f.runtime);
  t.after(() => installed.close());
  const sessions = require(f.sessions);
  for (let count = 0; count < 17; count++)
    assert.deepEqual(sessions.createContextRecoverySessions(count).args, [count]);
  assert.throws(() => installed.sample(), failure);
});

test('observer prepare PowerShell parses, bounds pipes, shares controller Job and keeps token off external argv', () => {
  const file = path.resolve(__dirname, '../scripts/lib/nsis-client-observer-prepare.ps1');
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(
    source.indexOf('$Job.Assign($child)') <
      source.indexOf('$child.StandardInput.BaseStream.WriteAsync($bytes,0,$bytes.Length)')
  );
  assert.doesNotMatch(source, /ReadToEnd|\.Kill\(|Stop-Process|ArgumentList.Add\(\$Token/);
  assert.match(source, /\[int\]\$Maximum = 5000/);
  assert.match(source, /\$Pipe.Count -gt 8192/);
  const command =
    "$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts/lib/nsis-client-observer-prepare.ps1'),[ref]$tokens,[ref]$errors);if($errors.Count){exit 1}";
  const result = spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000, maxBuffer: 4096 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('hosted source closure accepts only the fixed observer installed sessions import', (t) => {
  const { collectClosure } = require('../scripts/context-hosted/build-plan');
  const bootstrap = path.resolve(__dirname, '../scripts/lib/nsis-client-observer-bootstrap.cjs');
  const pins = collectClosure([bootstrap], []);
  assert.deepEqual(
    Object.keys(pins).sort(),
    [bootstrap, path.resolve(__dirname, '../scripts/lib/nsis-client-observer.cjs')].sort()
  );
  const f = fixture(t),
    copy = path.join(f.input.caseRoot, 'nsis-client-observer-bootstrap.cjs');
  fs.writeFileSync(
    copy,
    "require(path.join(value.install, 'lib/proxy/context-recovery-sessions.js'));"
  );
  assert.throws(() => collectClosure([copy], []), { message: 'context_hosted_plan_rejected' });
  fs.writeFileSync(copy, "require(path.join(value.install, 'lib/proxy/other.js'));");
  assert.throws(() => collectClosure([copy], []), { message: 'context_hosted_plan_rejected' });
});

test('prepare production helpers accept fragmented success and require bounded EOF, exit zero and one total deadline', () => {
  const command =
    String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts/lib/nsis-client-observer-prepare.ps1'),[ref]$tokens,[ref]$errors)
foreach($fn in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) { if($fn.Name -cin @('New-ObserverPreparationPipe','Update-ObserverPreparationPipe','Wait-ObserverPreparation')) {Invoke-Expression $fn.Extent.Text} }
$checks=0
foreach($size in @(1,2,3,16,1024)) {
 $stdout=[IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes("observer_prepared` +
    '`n' +
    String.raw`"))
 $pipes=@((New-ObserverPreparationPipe $stdout $size),(New-ObserverPreparationPipe ([IO.MemoryStream]::new()) 1))
 $input=[IO.MemoryStream]::new()
 $child=@{StandardInput=$input;HasExited=$true;ExitCode=0}
 Wait-ObserverPreparation $child $pipes ([Threading.Tasks.Task]::CompletedTask) ([Diagnostics.Stopwatch]::StartNew())
 if($input.CanWrite) {throw 'input_not_closed'}
 $checks++
}
foreach($fault in @('stdout-limit','stderr-limit','no-eof','nonzero','stderr','wrong','stdin-pending','stdin-fault','read-fault')) {
 $outText=if($fault -eq 'wrong'){'wrong'}else{"observer_prepared` +
    '`n' +
    String.raw`"}
 $outBytes=if($fault -eq 'stdout-limit'){[byte[]]::new(8193)}else{[Text.Encoding]::UTF8.GetBytes($outText)}
 $errBytes=[byte[]]::new(0)
 if($fault -eq 'stderr-limit'){$errBytes=[byte[]]::new(8193)}elseif($fault -eq 'stderr'){$errBytes=[byte[]]@(1)}
 $pipes=@((New-ObserverPreparationPipe ([IO.MemoryStream]::new($outBytes))),(New-ObserverPreparationPipe ([IO.MemoryStream]::new($errBytes))))
 $write=[Threading.Tasks.Task]::CompletedTask
 if($fault -eq 'no-eof'){$pipes[0].Task=([Threading.Tasks.TaskCompletionSource[int]]::new()).Task}
 if($fault -eq 'stdin-pending'){$write=([Threading.Tasks.TaskCompletionSource[int]]::new()).Task}
 if($fault -eq 'stdin-fault'){$write=[Threading.Tasks.Task]::FromException([IO.IOException]::new('PRIVATE'))}
 if($fault -eq 'read-fault'){$pipes[0].Task=[Threading.Tasks.Task]::FromException[int]([IO.IOException]::new('PRIVATE'))}
 $child=@{StandardInput=[IO.MemoryStream]::new();HasExited=$true;ExitCode=$(if($fault -eq 'nonzero'){1}else{0})}
 $rejected=$false
 try{Wait-ObserverPreparation $child $pipes $write ([Diagnostics.Stopwatch]::StartNew()) 50}catch{$rejected=$true}
 if(-not $rejected){throw 'fault_accepted'}
 $checks++
}
[Console]::Out.Write($checks)
`;
  const result = spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000, maxBuffer: 4096 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '14');
});

test('pinned release manifest accepts pretty bytes but rejects UTF8 corruption, oversize, hash drift and malformed JSON', (t) => {
  const f = fixture(t),
    file = path.join(f.input.install, 'release-runtime-manifest.json');
  const value = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  const config = { ...f.input, manifestSha256: digest(file) };
  assert.deepEqual(observer.readInstalledManifest(config), value);
  assert.throws(() => observer.read(file), failure); // Mailbox canonical policy remains strict.
  assert.throws(() => observer.readInstalledManifest(f.input), failure);
  for (const bytes of [Buffer.from([0xff]), Buffer.from('not JSON'), Buffer.alloc(2097153, 32)]) {
    fs.writeFileSync(file, bytes);
    assert.throws(
      () => observer.readInstalledManifest({ ...config, manifestSha256: digest(file) }),
      failure
    );
  }
});
