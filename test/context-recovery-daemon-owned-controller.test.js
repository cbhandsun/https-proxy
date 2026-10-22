'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { spawn } = require('node:child_process');
const { discoverTestFiles } = require('../lib/test-discovery');
const { readGate } = require('../scripts/lib/context-recovery-daemon-start-gate.cjs');
const { validateConfig } = require('../lib/proxy/validator');

test('synchronous gate accepts only byte one and EOF, never empty, malformed or extra input', () => {
  for (const text of ['', '0', '11', '1\n', '\u0000', 'PRIVATE_GATE_SENTINEL']) {
    const bytes = Buffer.from(text);
    let offset = 0;
    assert.throws(
      () =>
        readGate((fd, buffer, start, count) => {
          const size = Math.min(count, bytes.length - offset);
          bytes.copy(buffer, start, offset, offset + size);
          offset += size;
          return size;
        }),
      /^Error: daemon_start_gate_rejected$/
    );
  }
  let calls = 0;
  readGate((fd, buffer, start) => {
    calls++;
    if (calls === 1) {
      buffer[start] = 49;
      return 1;
    }
    return 0;
  });
  assert.equal(calls, 2);
  for (const count of [-1, 3, NaN, undefined]) assert.throws(() => readGate(() => count));
});

test('actual Node preload rejects before any main code on missing identity or a closed gate', () => {
  const preload = path.resolve('scripts/lib/context-recovery-daemon-start-gate.cjs');
  for (const input of ['', '1', '0', '11']) {
    const result = spawnSync(
      process.execPath,
      ['--require', preload, '-e', 'process.stdout.write("PRIVATE_MAIN_EXECUTED")'],
      { input, encoding: 'utf8', timeout: 5000, maxBuffer: 16384, env: {} }
    );
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /PRIVATE_MAIN_EXECUTED/);
    assert.match(result.stderr, /daemon_start_gate_rejected/);
    assert.equal(result.stderr.startsWith('HPM_GATE_ENTERED\nHPM_GATE_FAILED\n'), true);
    assert.doesNotMatch(result.stderr, /HPM_GATE_PASSED/);
  }
});

test('preload identity guard leaves main argv and module loader intact in an offline valid identity', () => {
  const file = path.resolve('scripts/lib/context-recovery-daemon-start-gate.cjs');
  const install = path.resolve('synthetic-owned/install');
  const caseRoot = path.resolve('synthetic-owned/case');
  let released = false,
    verified = false;
  const markers = [];
  const runtime = {
    platform: process.platform,
    execArgv: ['--require', file],
    argv: [process.execPath, path.join(install, 'openai-proxy.js')],
    execPath: process.execPath,
    cwd: () => install,
    env: {
      HPM_DAEMON_OWNED_INSTALL: install,
      HPM_DAEMON_OWNED_CASE_ROOT: caseRoot,
      HPM_DAEMON_OWNED_ROOT: path.dirname(install),
      HPM_DAEMON_OWNED_MANIFEST: 'a'.repeat(64),
      PROXY_CONFIG_DIR: path.join(caseRoot, 'config'),
      PROXY_RUNTIME_DIR: path.join(caseRoot, 'runtime'),
      MGMT_TOKEN: 'x'.repeat(32),
    },
  };
  const originalArgv = [...runtime.argv];
  const fakeModule = { parent: { id: 'internal/preload' }, exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Buffer,
    __filename: file,
    module: fakeModule,
    process: runtime,
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:fs')
        return {
          writeSync(fd, marker) {
            assert.equal(fd, 2);
            markers.push(marker);
          },
          readSync(fd, buffer, start) {
            if (released) return 0;
            released = true;
            buffer[start] = 49;
            return 1;
          },
          realpathSync: { native: (value) => value },
          readFileSync: () =>
            JSON.stringify({ sourceSha256: { 'openai-proxy.js': 'a'.repeat(64) } }),
        };
      assert.equal(name, './nsis-runtime-boundary-contract');
      return {
        parseRuntimeBoundaryArguments: () => ({ caseRoot }),
        verifyRuntimeBoundaryInstallation() {
          assert.fail('serial verifier must not be selected by the preload');
        },
        verifyRuntimeBoundaryInstallationParallel() {
          assert.equal(released, true);
          verified = true;
          return { install, node: process.execPath };
        },
      };
    },
  });
  assert.equal(verified, true);
  assert.deepEqual(markers, ['HPM_GATE_ENTERED\n', 'HPM_GATE_PASSED\n']);
  assert.deepEqual(runtime.argv, originalArgv);
  assert.deepEqual(Object.keys(fakeModule.exports).sort(), ['readGate', 'verifyGateIdentity']);
  for (const bad of [
    { ...runtime, execArgv: [] },
    { ...runtime, argv: [] },
    { ...runtime, env: { ...runtime.env, NODE_OPTIONS: '--inspect' } },
  ])
    assert.throws(() => fakeModule.exports.verifyGateIdentity(bad));
});

test('lightweight: failed parallel verification prevents main entry without serial fallback', () => {
  const file = path.resolve('scripts/lib/context-recovery-daemon-start-gate.cjs');
  const markers = [];
  const runtime = {
    env: {},
    execArgv: ['--require', file],
    argv: [process.execPath, path.resolve('synthetic-main.js')],
    mainReached: false,
  };
  let released = false;
  let parallelCalls = 0;
  assert.throws(
    () =>
      vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nprocess.mainReached = true;', {
        Buffer,
        __filename: file,
        module: { parent: { id: 'internal/preload' }, exports: {} },
        process: runtime,
        require(name) {
          if (name === 'node:path') return path;
          if (name === 'node:fs')
            return {
              writeSync: (fd, marker) => markers.push(marker),
              readSync(fd, buffer, start) {
                if (released) return 0;
                released = true;
                buffer[start] = 49;
                return 1;
              },
            };
          assert.equal(name, './nsis-runtime-boundary-contract');
          return {
            parseRuntimeBoundaryArguments: () => ({}),
            verifyRuntimeBoundaryInstallation: () => assert.fail('no serial fallback'),
            verifyRuntimeBoundaryInstallationParallel() {
              parallelCalls++;
              assert.equal(released, true);
              throw Error('PRIVATE_VERIFIER_FAILURE');
            },
          };
        },
      }),
    /^Error: daemon_start_gate_rejected$/
  );
  assert.equal(parallelCalls, 1);
  assert.equal(runtime.mainReached, false);
  assert.deepEqual(markers, ['HPM_GATE_ENTERED\n', 'HPM_GATE_FAILED\n']);
});

test('PowerShell controller parses bounded frames and enforces four synthetic cases and Job stop ACK', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      'test/fixtures/daemon-owned-controller-mocks.ps1',
      '-NodeExecutable',
      process.execPath,
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 16384 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /protocolRejects=\d+; syntheticCases=4; daemonExecutions=0; networkRequests=0/
  );
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/);
});

test('real Windows child pipe blocks readGate until delayed byte one and EOF without EAGAIN', async () => {
  const gate = path.resolve('scripts/lib/context-recovery-daemon-start-gate.cjs');
  const code = `const fs=require('node:fs');const {readGate}=require(${JSON.stringify(gate)});process.stdout.write('entered\\n');try{readGate((...a)=>{try{return fs.readSync(...a)}catch(e){process.stdout.write(e.code==='EAGAIN'?'read_eagain\\n':'read_other_failed\\n');throw e}});process.stdout.write('passed\\n')}catch{process.stdout.write('failed\\n');process.exitCode=1}`;
  const child = spawn(process.execPath, ['-e', code], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  });
  let output = '',
    stderrBytes = 0,
    released = false,
    pipeErrors = 0;
  child.stdout.on('data', (bytes) => {
    output += bytes.toString('utf8');
    if (output === 'entered\n')
      setTimeout(() => {
        released = true;
        child.stdin.end('1');
      }, 100);
  });
  child.stderr.on('data', (bytes) => {
    stderrBytes += bytes.length;
  });
  child.stdin.on('error', () => {
    pipeErrors++;
  });
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exit, signal) => resolve({ exit, signal }));
  });
  assert.equal(released, true);
  assert.deepEqual(result, { exit: 0, signal: null });
  assert.equal(output, 'entered\npassed\n');
  assert.equal(stderrBytes, 0);
  assert.equal(pipeErrors, 0);
});

test('controller uses a fixed actual main invocation and gate assignment before release', () => {
  const source = fs.readFileSync(
    'scripts/lib/context-recovery-daemon-owned-controller.psm1',
    'utf8'
  );
  assert.match(
    source,
    /\$owner\.job\.Assign\(\$process\)[\s\S]*\$process\.StandardInput\.Write\('1'\)/
  );
  assert.match(source, /@\('--require',[\s\S]*'openai-proxy\.js'\)/);
  assert.doesNotMatch(source, /taskkill|\.Kill\(|Get-Process|Write-Host|Write-Output|ReadLine\(/i);
  const files = discoverTestFiles(path.resolve(__dirname, '..'));
  assert.ok(files.includes('test/context-recovery-daemon-owned-controller.test.js'));
  assert.ok(files.includes('test/context-recovery-daemon-owned-adapter.test.js'));
});

test('controller-generated config passes real validation and loadConfig for four settings cases without upstream I/O', (t) => {
  const generated = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      'test/fixtures/daemon-owned-controller-mocks.ps1',
      '-ConfigOnly',
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 16384 }
  );
  assert.ifError(generated.error);
  assert.equal(generated.status, 0);
  const config = JSON.parse(generated.stdout);
  assert.equal(validateConfig(config).valid, true);
  assert.equal(config.activeProfile, 'hpm-owned-local');
  assert.deepEqual(
    config.profiles.map((profile) => ({
      id: profile.id,
      targetUrl: profile.targetUrl,
      apiKey: profile.apiKey,
    })),
    [{ id: 'hpm-owned-local', targetUrl: 'http://127.0.0.1:1/v1', apiKey: '' }]
  );
  assert.equal(config.appSettings.contextRecoveryEnabled, false);
  assert.equal(config.appSettings.contextRecoveryPersistenceEnabled, false);
  assert.equal(config.appSettings.conversationAuditEnabled, false);
  assert.equal(config.appSettings.conversationAuditCaptureContent, false);
  assert.equal(config.appSettings.upstreamWarmupEnabled, false);
  assert.equal(config.appSettings.antigravityCredentialWatchdogEnabled, false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-owned-config-load-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directories = Object.fromEntries(
    ['config', 'runtime', 'home', 'appdata', 'localappdata', 'tmp'].map((name) => {
      const directory = path.join(root, name);
      fs.mkdirSync(directory);
      return [name, directory];
    })
  );
  fs.writeFileSync(path.join(directories.config, 'proxy.config.json'), JSON.stringify(config));
  const loader = path.resolve('lib/proxy/config.js');
  const warmupModule = path.resolve('lib/proxy/upstream-warmup.js');
  const validationModule = path.resolve('lib/proxy/validator.js');
  const code = `
    const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),http=require('node:http'),https=require('node:https');
    let networkAttempts=0; const deny=()=>{networkAttempts++;throw Error('network_forbidden')};
    net.Socket.prototype.connect=deny;http.request=deny;https.request=deny;globalThis.fetch=deny;
    const {loadConfig}=require(${JSON.stringify(loader)}),{validateConfig}=require(${JSON.stringify(validationModule)}),{createUpstreamWarmup}=require(${JSON.stringify(warmupModule)});
    const file=path.join(process.env.PROXY_CONFIG_DIR,'proxy.config.json');
    const original=JSON.parse(fs.readFileSync(file,'utf8'));let cases=0,missingActiveRejected=false;
    try {
      fs.writeFileSync(file,JSON.stringify({...original,profiles:[],activeProfile:''}));
      try {loadConfig({throwOnError:true,logWarnings:false})}catch(error){missingActiveRejected=error instanceof Error && error.message.includes('Missing activeProfile')}
      for(const label of ['00','01','10','11']){
        const raw=JSON.parse(JSON.stringify(original));raw.appSettings.contextRecoveryEnabled=label[0]==='1';raw.appSettings.contextRecoveryPersistenceEnabled=label[1]==='1';
        fs.writeFileSync(file,JSON.stringify(raw));
        const loaded=loadConfig({throwOnError:true,logWarnings:false});
        if(!validateConfig(loaded).valid||loaded.activeProfile!=='hpm-owned-local'||loaded.appSettings.contextRecoveryEnabled!==raw.appSettings.contextRecoveryEnabled||loaded.appSettings.contextRecoveryPersistenceEnabled!==raw.appSettings.contextRecoveryPersistenceEnabled)throw Error('loaded_config_rejected');
        const warmup=createUpstreamWarmup({getRuntimeState:()=>({CONFIG:loaded,PROFILES:loaded.profiles}),decryptKey:()=>'',getModelsUrl:deny,parseTargetUrl:deny,http,https});
        warmup.refresh();if(warmup.runOnce()!==0)throw Error('warmup_active');warmup.stop();cases++;
      }
      process.stdout.write(JSON.stringify({cases,missingActiveRejected,networkAttempts}));
    } catch {process.stdout.write('config_load_probe_failed');process.exitCode=1}
  `;
  const result = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 16384,
    env: {
      ...process.env,
      PROXY_CONFIG_DIR: directories.config,
      PROXY_RUNTIME_DIR: directories.runtime,
      PROXY_DATA_DIR: '',
      HOME: directories.home,
      USERPROFILE: directories.home,
      APPDATA: directories.appdata,
      LOCALAPPDATA: directories.localappdata,
      TEMP: directories.tmp,
      TMP: directories.tmp,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    cases: 4,
    missingActiveRejected: true,
    networkAttempts: 0,
  });
});
