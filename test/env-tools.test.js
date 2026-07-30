const assert = require('assert');
const cp = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');
const { Readable } = require('stream');
const {
  createManagementCliEnvHandlers,
  buildToolCliArgs,
  buildCliLaunchCommand,
  buildCliLaunchSpec,
  normalizeCliModelOverride,
  normalizeCliTerminal,
  parseCliArgs,
  requireJsonObjectBody,
  resolveCliWorkDir,
} = require('../lib/proxy/handlers/management-cli-env');
const {
  ENV_CHECK_TOOLS,
  _test,
  getToolInstallCommand,
  getToolInstallProcessSpec,
  isVersionNewer,
  parseVersionText,
  startToolInstallJob,
  listInstallJobs,
} = require('../lib/proxy/env-tools');
const fs = require('fs');
const path = require('path');
const asyncChecks = [];

assert.strictEqual(parseVersionText('2.1.159 (Claude Code)'), '2.1.159');
assert.strictEqual(
  parseVersionText('OpenAI.Codex_26.602.4764.0_x64__2p2nqsd0c76g0'),
  '26.602.4764.0'
);
assert.strictEqual(parseVersionText('codex-cli 0.137.0-alpha.4'), '0.137.0-alpha.4');

assert.strictEqual(isVersionNewer('0.137.0-alpha.4', '0.137.0'), true);
assert.strictEqual(isVersionNewer('0.137.0', '0.137.0-alpha.4'), false);
assert.strictEqual(isVersionNewer('2.1.159', '2.1.167'), true);
assert.strictEqual(isVersionNewer('2.1.167', '2.1.159'), false);

assert.strictEqual(_test.isSafeHttpsUrl('https://example.test/file.exe'), true);
assert.strictEqual(_test.isSafeHttpsUrl('http://example.test/file.exe'), false);
assert.strictEqual(_test.isSafeHttpsUrl('javascript:alert(1)'), false);
assert.strictEqual(_test.isSafeHttpsUrl('https://example.test/file.exe\nx'), false);
assert.deepStrictEqual(_test.buildCurlArgs('https://example.test/file.exe', 7890, ['-L', '-s']), [
  '-x',
  'socks5h://127.0.0.1:7890',
  '-L',
  '-s',
  'https://example.test/file.exe',
]);
const shellSpec = _test.buildShellCommandExecSpec('tool.cmd', ['--name', 'a&b', '100%']);
if (process.platform === 'win32') {
  assert.strictEqual(shellSpec.file, 'cmd.exe');
  assert.deepStrictEqual(shellSpec.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(shellSpec.args[3].includes('"tool.cmd" "--name" "a&b" "100%%"'));
} else {
  assert.strictEqual(shellSpec.file, 'tool.cmd');
  assert.deepStrictEqual(shellSpec.args, ['--name', 'a&b', '100%']);
}
const envToolsSource = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'proxy', 'env-tools.js'),
  'utf8'
);
assert.ok(!/cp\.exec\(/.test(envToolsSource), 'env-tools should not use cp.exec');
assert.throws(() => _test.buildCurlArgs('http://example.test/file.exe', null, []), /https/);
assert.throws(() => _test.buildCurlArgs('https://example.test/file.exe', 65536, []), /proxyPort/);
assert.throws(() => _test.buildCurlArgs('https://example.test/file.exe', 12.5, []), /proxyPort/);
assert.deepStrictEqual(
  _test.validateAntigravityManifest({
    url: 'https://storage.googleapis.com/antigravity-public/cli.exe',
    sha512: 'a'.repeat(128),
  }).sha512,
  'a'.repeat(128)
);
assert.throws(
  () => _test.validateAntigravityManifest({ url: 'https://example.test/cli.exe' }),
  /sha512/
);
assert.throws(
  () =>
    _test.validateAntigravityManifest({
      url: 'http://example.test/cli.exe',
      sha512: 'a'.repeat(128),
    }),
  /https/
);
assert.throws(() => requireJsonObjectBody(null), /JSON body must be an object/);
assert.throws(() => requireJsonObjectBody([]), /JSON body must be an object/);
assert.deepStrictEqual(requireJsonObjectBody({ ok: true }), { ok: true });
assert.deepStrictEqual(parseCliArgs('--model "gpt 5" --flag'), ['--model', 'gpt 5', '--flag']);
assert.throws(() => parseCliArgs('"unterminated'), /unterminated/);
assert.throws(() => parseCliArgs('ok\nbad'), /control characters/);
assert.strictEqual(normalizeCliModelOverride('default'), '');
assert.strictEqual(normalizeCliModelOverride(' Default '), '');
assert.strictEqual(normalizeCliModelOverride('codex/deepseek-v4-flash'), 'codex/deepseek-v4-flash');
assert.throws(() => normalizeCliModelOverride('bad\nmodel'), /control characters/);
assert.deepStrictEqual(
  buildToolCliArgs({
    toolId: 'claude-code',
    args: ['--dangerously-skip-permissions'],
    model: 'claude/sonnet',
  }),
  ['--dangerously-skip-permissions', '--model', 'claude/sonnet']
);
assert.deepStrictEqual(
  buildToolCliArgs({
    toolId: 'antigravity-cli',
    args: [],
    model: 'gemini-3.5-flash',
  }),
  ['--model', 'gemini-3.5-flash']
);
assert.deepStrictEqual(
  buildToolCliArgs({
    toolId: 'codex',
    args: ['--sandbox', 'workspace-write'],
    model: 'codex/deepseek-v4-flash',
  }),
  ['--sandbox', 'workspace-write', '--model', 'codex/deepseek-v4-flash']
);
assert.deepStrictEqual(
  buildToolCliArgs({
    toolId: 'codex',
    args: ['-m', 'manual-model'],
    model: 'ui-model',
  }),
  ['-m', 'manual-model']
);
assert.deepStrictEqual(
  buildToolCliArgs({
    toolId: 'codex',
    args: ['-c', 'model="manual-model"'],
    model: 'ui-model',
  }),
  ['-c', 'model="manual-model"']
);
assert.deepStrictEqual(
  buildToolCliArgs({
    toolId: 'claude-code',
    args: ['--model=manual-model'],
    model: 'ui-model',
  }),
  ['--model=manual-model']
);
assert.deepStrictEqual(
  buildToolCliArgs({
    toolId: 'opencode',
    args: [],
    model: 'ui-model',
  }),
  []
);
assert.deepStrictEqual(
  buildToolCliArgs({
    toolId: 'codex',
    args: [],
    model: 'default',
  }),
  []
);
assert.strictEqual(normalizeCliTerminal(''), 'cmd');
assert.strictEqual(normalizeCliTerminal('cmd'), 'cmd');
assert.strictEqual(normalizeCliTerminal('CommandPrompt'), 'cmd');
assert.strictEqual(normalizeCliTerminal('powershell'), 'PowerShell');
assert.strictEqual(normalizeCliTerminal('pwsh'), 'PowerShell 7');
assert.strictEqual(normalizeCliTerminal('PowerShell 7'), 'PowerShell 7');
assert.throws(() => normalizeCliTerminal('pwsh; calc'), /Unsupported terminal/);

const psLaunch = buildCliLaunchCommand({
  terminal: 'PowerShell',
  command: 'codex',
  args: ['--model', 'gpt 5', "user's", 'quote"arg'],
  workDir: 'E:\\DEV\\Work Space',
  model: 'gpt&5',
});
const encodedPsLaunch = psLaunch.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/);
assert.ok(encodedPsLaunch, 'PowerShell launch should use -EncodedCommand');
const decodedPsLaunch = Buffer.from(encodedPsLaunch[1], 'base64').toString('utf16le');
assert.ok(decodedPsLaunch.includes("'--model' 'gpt 5' 'user''s' 'quote\"arg'"));
assert.ok(!psLaunch.includes('gpt&5'));
assert.ok(!psLaunch.includes('quote"arg'));

const cmdLaunch = buildCliLaunchCommand({
  terminal: 'cmd',
  command: 'codex',
  args: ['--model', 'gpt 5', '100%'],
  workDir: 'E:\\DEV\\Work Space',
  model: 'gpt|5',
});
assert.ok(cmdLaunch.includes('""--model"" ""gpt 5""'));
assert.ok(cmdLaunch.includes('100%%%%'));
assert.ok(!cmdLaunch.includes('gpt|5'));

const cmdLaunchSpec = buildCliLaunchSpec({
  terminal: 'cmd',
  command: 'codex',
  args: ['--model', 'gpt 5', '100%', 'safe&arg'],
  workDir: 'E:\\DEV\\Work Space',
  model: 'gpt|5',
});
assert.strictEqual(cmdLaunchSpec.file, 'cmd.exe');
assert.deepStrictEqual(cmdLaunchSpec.args.slice(0, 7), [
  '/d',
  '/s',
  '/c',
  'start',
  'Claude Code (gpt 5)',
  'cmd.exe',
  '/k',
]);
assert.ok(cmdLaunchSpec.args[7].includes('"safe&arg"'));
assert.ok(cmdLaunchSpec.args[7].includes('"100%%"'));
assert.ok(!cmdLaunchSpec.args.slice(0, 7).join(' ').includes('gpt|5'));

const psLaunchSpec = buildCliLaunchSpec({
  terminal: 'PowerShell',
  command: 'codex',
  args: ['--model', 'gpt 5', "user's", 'quote"arg'],
  workDir: 'E:\\DEV\\Work Space',
  model: 'gpt&5',
});
assert.strictEqual(psLaunchSpec.file, 'powershell.exe');
assert.deepStrictEqual(psLaunchSpec.args.slice(0, 4), [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
]);
const outerPsLaunch = Buffer.from(psLaunchSpec.args[4], 'base64').toString('utf16le');
assert.ok(outerPsLaunch.includes('Start-Process'));
const innerEncodedPsLaunch = outerPsLaunch.match(/'([A-Za-z0-9+/=]{20,})'/);
assert.ok(innerEncodedPsLaunch, 'PowerShell launch spec should carry encoded inner command');
const innerPsLaunch = Buffer.from(innerEncodedPsLaunch[1], 'base64').toString('utf16le');
assert.ok(innerPsLaunch.includes("'--model' 'gpt 5' 'user''s' 'quote\"arg'"));
assert.ok(!outerPsLaunch.includes('quote"arg'));
assert.ok(!psLaunchSpec.args.join(' ').includes('gpt&5'));

const pwshLaunch = buildCliLaunchCommand({
  terminal: 'PowerShell 7',
  command: 'codex',
  args: ['--model', 'gpt 5'],
  workDir: 'E:\\DEV\\Work Space',
  model: 'gpt-5',
});
assert.ok(pwshLaunch.startsWith('start pwsh '));

const pwshLaunchSpec = buildCliLaunchSpec({
  terminal: 'pwsh',
  command: 'codex',
  args: ['--model', 'gpt 5'],
  workDir: 'E:\\DEV\\Work Space',
  model: 'gpt-5',
});
assert.strictEqual(pwshLaunchSpec.file, 'powershell.exe');
const outerPwshLaunch = Buffer.from(pwshLaunchSpec.args[4], 'base64').toString('utf16le');
assert.ok(outerPwshLaunch.includes("'pwsh.exe'"));
assert.ok(!outerPwshLaunch.includes("'powershell.exe'"));

const managementSource = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'proxy', 'handlers', 'management.js'),
  'utf8'
);
assert.ok(
  !/cp\.exec\(/.test(managementSource),
  'management handlers should not launch CLI via cp.exec'
);
assert.throws(
  () =>
    buildCliLaunchCommand({
      terminal: 'bash',
      command: 'codex',
      args: [],
      workDir: process.cwd(),
      model: 'gpt-5',
    }),
  /Unsupported terminal/
);

const tempCliWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-cli-workdir-'));
const tempCliWorkFile = path.join(tempCliWorkDir, 'not-a-dir.txt');
fs.writeFileSync(tempCliWorkFile, 'x');
try {
  assert.strictEqual(resolveCliWorkDir(tempCliWorkDir), path.resolve(tempCliWorkDir));
  assert.throws(() => resolveCliWorkDir(path.join(tempCliWorkDir, 'missing')), /does not exist/);
  assert.throws(() => resolveCliWorkDir(tempCliWorkFile), /not a directory/);
} finally {
  fs.rmSync(tempCliWorkDir, { recursive: true, force: true });
}

function jsonReqForManagement(body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from([Buffer.from(payload, 'utf8')]);
  req.url = '/v1/local/test';
  req.headers = { host: 'localhost' };
  return req;
}

function createManagementRes(resolve) {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body == null ? '' : String(body);
      resolve(this);
    },
  };
}

function invokeManagementHandler(handler, body) {
  return new Promise((resolve) => {
    handler(jsonReqForManagement(body), createManagementRes(resolve));
  });
}

function sendManagementJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function assertManagementBodyObjectRequired(handler, body) {
  const res = await invokeManagementHandler(handler, body);
  assert.strictEqual(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /JSON body must be an object/);
}

const pendingManagementChecks = [];
{
  const handlers = createManagementCliEnvHandlers({
    sendJson: sendManagementJson,
    cliSessions: new Map([['session-1', { toolId: 'codex', createdAt: 1 }]]),
    getEntryServersSnapshot: () => [],
    getLocalServerSnapshot: () => ({ tls: true }),
    defaultPort: 3443,
  });
  pendingManagementChecks.push(
    assertManagementBodyObjectRequired(handlers.handleLocalEnvUpgradeRequest, null),
    assertManagementBodyObjectRequired(handlers.handleLocalCliLaunchRequest, []),
    assertManagementBodyObjectRequired(handlers.handleLocalCliSessionDeleteRequest, 'bad')
  );
}

function readFakeResponse(chunks, maxBytes) {
  const res = new EventEmitter();
  res.destroyed = false;
  res.destroy = () => {
    res.destroyed = true;
  };
  let reqDestroyed = false;
  const req = {
    destroy() {
      reqDestroyed = true;
    },
  };
  let result = null;
  _test.readResponseTextBounded(
    res,
    req,
    (err, text) => {
      result = { err, text, resDestroyed: res.destroyed, reqDestroyed };
    },
    maxBytes
  );
  for (const chunk of chunks) res.emit('data', Buffer.from(chunk));
  res.emit('end');
  return result;
}

const ok = readFakeResponse(['{"version":"1.', '2.3"}'], 1024);
assert.ifError(ok.err);
assert.strictEqual(ok.text, '{"version":"1.2.3"}');
assert.strictEqual(ok.resDestroyed, false);
assert.strictEqual(ok.reqDestroyed, false);

const tooLarge = readFakeResponse(['12345', '67890'], 8);
assert.match(tooLarge.err.message, /Response body too large/);
assert.strictEqual(tooLarge.text, '');
assert.strictEqual(tooLarge.resDestroyed, true);
assert.strictEqual(tooLarge.reqDestroyed, true);

const toolsById = new Map(ENV_CHECK_TOOLS.map((tool) => [tool.id, tool]));
const codexSpec = getToolInstallProcessSpec(toolsById.get('codex'));
assert.strictEqual(codexSpec.file, 'powershell.exe');
assert.ok(codexSpec.args.includes('-NonInteractive'));
assert.match(codexSpec.displayCommand, /CODEX_NON_INTERACTIVE='1'/);
assert.match(codexSpec.displayCommand, /irm https:\/\/chatgpt\.com\/codex\/install\.ps1 \| iex/);

const openCodeSpec = getToolInstallProcessSpec(toolsById.get('opencode'));
if (process.platform === 'win32') {
  assert.strictEqual(openCodeSpec.file, 'cmd.exe');
  assert.deepStrictEqual(openCodeSpec.args.slice(0, 5), ['/d', '/s', '/c', 'npm.cmd', 'install']);
} else {
  assert.strictEqual(openCodeSpec.file, 'npm');
}
assert.match(getToolInstallCommand(toolsById.get('claude-code')), /^irm https:\/\/claude\.ai/);
assert.match(
  getToolInstallCommand(toolsById.get('antigravity-cli')),
  /^irm https:\/\/antigravity\.google/
);
assert.match(
  getToolInstallCommand(toolsById.get('openclaw')),
  /\(\(irm https:\/\/openclaw\.ai\/install\.ps1\)\)\) -NoOnboard$/
);
assert.match(getToolInstallCommand(toolsById.get('hermes')), /-SkipSetup$/);

const windowsCandidateDirs = _test.getWindowsCommandCandidateDirs(
  toolsById.get('codex'),
  'C:\\Users\\tester',
  'C:\\Users\\tester\\AppData\\Local',
  'C:\\Users\\tester\\AppData\\Roaming',
  'codex'
);
assert.ok(
  windowsCandidateDirs.includes(
    path.join('C:\\Users\\tester\\AppData\\Local', 'Programs', 'OpenAI', 'Codex', 'bin')
  )
);
const hermesCandidateDirs = _test.getWindowsCommandCandidateDirs(
  toolsById.get('hermes'),
  'C:\\Users\\tester',
  'C:\\Users\\tester\\AppData\\Local',
  'C:\\Users\\tester\\AppData\\Roaming',
  'hermes'
);
assert.ok(
  hermesCandidateDirs.includes(path.join('C:\\Users\\tester\\AppData\\Local', 'hermes', 'bin'))
);

assert.strictEqual(_test.parseInstallJobTimeoutMs('not-a-number'), 15 * 60 * 1000);
assert.strictEqual(_test.parseInstallJobTimeoutMs('1'), 30 * 1000);
assert.strictEqual(_test.parseInstallJobTimeoutMs(String(2 * 60 * 60 * 1000)), 60 * 60 * 1000);
assert.strictEqual(
  _test.evaluateInstallVerificationStatus({
    current: '1.0.13',
    latest: '1.0.13',
    hasUpdate: false,
  }).ok,
  true
);
assert.match(
  _test.evaluateInstallVerificationStatus({
    current: '1.0.8',
    latest: '1.0.13',
    hasUpdate: true,
  }).error,
  /当前版本仍为 1\.0\.8，最新版本为 1\.0\.13/
);
assert.match(
  _test.evaluateInstallVerificationStatus({ latest: '1.0.13' }).error,
  /未检测到本地版本/
);

{
  const originalSpawn = cp.spawn;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalTimeoutEnv = process.env.PROXY_ENV_INSTALL_TIMEOUT_MS;
  let timeoutCallback = null;
  let timeoutDelay = 0;
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.pid = 43210;
  fakeChild.killed = false;
  fakeChild.kill = () => {
    fakeChild.killed = true;
    return true;
  };
  try {
    process.env.PROXY_ENV_INSTALL_TIMEOUT_MS = '30000';
    cp.spawn = () => fakeChild;
    global.setTimeout = (callback, delay) => {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return { unref() {} };
    };
    global.clearTimeout = () => {};

    const job = startToolInstallJob(ENV_CHECK_TOOLS.find((tool) => tool.id === 'codex'));
    assert.strictEqual(job.status, 'running');
    assert.strictEqual(job.timeoutMs, 30000);
    assert.strictEqual(timeoutDelay, 30000);
    assert.strictEqual(typeof timeoutCallback, 'function');

    timeoutCallback();
    assert.strictEqual(fakeChild.killed, true);
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.ok, false);
    assert.match(job.error, /超时/);
    assert.strictEqual(job.lastLine, '安装/升级超时');

    fakeChild.emit('close', 0);
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.ok, false);
    assert.match(listInstallJobs([job.jobId])[0].outputTail, /已尝试终止/);
  } finally {
    cp.spawn = originalSpawn;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    if (originalTimeoutEnv == null) delete process.env.PROXY_ENV_INSTALL_TIMEOUT_MS;
    else process.env.PROXY_ENV_INSTALL_TIMEOUT_MS = originalTimeoutEnv;
  }
}

asyncChecks.push(
  (async () => {
    let verificationChecks = 0;
    let cacheClears = 0;
    const retryDelays = [];
    const retryVerification = await _test.verifyInstalledToolAfterInstall(
      toolsById.get('claude-code'),
      {
        attempts: 3,
        clearCaches: () => {
          cacheClears++;
        },
        refreshLatest: async () => ({}),
        checkEnvironment: async () => {
          verificationChecks++;
          return {
            tools: [
              verificationChecks === 1
                ? { id: 'claude-code', current: null, latest: '2.1.220' }
                : {
                    id: 'claude-code',
                    current: '2.1.220',
                    latest: '2.1.220',
                    hasUpdate: false,
                  },
            ],
          };
        },
        wait: async (delay) => {
          retryDelays.push(delay);
        },
      }
    );
    assert.strictEqual(retryVerification.ok, true);
    assert.strictEqual(verificationChecks, 2);
    assert.strictEqual(cacheClears, 2);
    assert.deepStrictEqual(retryDelays, [1000]);

    const originalSpawn = cp.spawn;
    const fakeChild = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.pid = 54321;
    try {
      cp.spawn = () => fakeChild;
      const job = startToolInstallJob(
        ENV_CHECK_TOOLS.find((tool) => tool.id === 'antigravity-cli'),
        {
          verifyInstalledTool: async () =>
            _test.evaluateInstallVerificationStatus({
              current: '1.0.8',
              latest: '1.0.13',
              hasUpdate: true,
            }),
        }
      );
      fakeChild.emit('close', 0);
      assert.strictEqual(job.status, 'verifying');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.strictEqual(job.status, 'failed');
      assert.strictEqual(job.ok, false);
      assert.match(job.error, /当前版本仍为 1\.0\.8，最新版本为 1\.0\.13/);
      assert.match(listInstallJobs([job.jobId])[0].lastLine, /版本复检失败/);
    } finally {
      cp.spawn = originalSpawn;
    }

    const queuedChildren = [];
    try {
      cp.spawn = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 60000 + queuedChildren.length;
        child.kill = () => true;
        queuedChildren.push(child);
        return child;
      };
      const verifyOk = async () => ({ ok: true, lastLine: '安装/升级完成，当前版本 1.0.0' });
      const firstJob = startToolInstallJob(toolsById.get('opencode'), {
        verifyInstalledTool: verifyOk,
      });
      const secondJob = startToolInstallJob(toolsById.get('openclaw'), {
        verifyInstalledTool: verifyOk,
      });
      assert.strictEqual(firstJob.status, 'running');
      assert.strictEqual(secondJob.status, 'queued');
      assert.strictEqual(queuedChildren.length, 1);

      queuedChildren[0].emit('close', 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.strictEqual(firstJob.status, 'succeeded');
      assert.strictEqual(secondJob.status, 'running');
      assert.strictEqual(queuedChildren.length, 2);

      queuedChildren[1].emit('close', 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.strictEqual(secondJob.status, 'succeeded');
    } finally {
      cp.spawn = originalSpawn;
    }
  })()
);

Promise.all(pendingManagementChecks)
  .then(() => Promise.all(asyncChecks))
  .then(() => {
    console.log('[env-tools.test] ok');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
