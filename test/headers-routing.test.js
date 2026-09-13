const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { createTestStateDatabase, encodeTestOAuthState } = require('./helpers/antigravity-state');

const testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'https-proxy-headers-routing-'));
const testAppDataDir = path.join(testHomeDir, 'AppData', 'Roaming');
const testConfigDir = path.join(testHomeDir, 'config');
const testRuntimeDir = path.join(testHomeDir, 'runtime');

fs.mkdirSync(testConfigDir, { recursive: true });
fs.mkdirSync(testRuntimeDir, { recursive: true });
fs.mkdirSync(path.join(testHomeDir, '.codex'), { recursive: true });
fs.writeFileSync(
  path.join(testHomeDir, '.codex', 'auth.json'),
  JSON.stringify({ tokens: { access_token: 'eyJ.test-openai-oauth-token' } })
);
fs.mkdirSync(path.join(testHomeDir, '.gemini'), { recursive: true });
fs.writeFileSync(
  path.join(testHomeDir, '.gemini', 'oauth_creds.json'),
  JSON.stringify({ access_token: 'ya29.test-google-oauth-token' })
);
const testIdeState = createTestStateDatabase(
  path.join(testAppDataDir, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
  encodeTestOAuthState('ya29.test-ide-oauth-token')
);

function createProxyEnv() {
  return {
    ...createIsolatedTestEnv(process.env, testHomeDir),
    APPDATA: testAppDataDir,
    CODE_ASSIST_ENDPOINT: `http://127.0.0.1:${upstreamPort}`,
    GOOGLE_CLOUD_PROJECT: 'test-project',
    HOME: testHomeDir,
    HPM_DISABLE_WINDOWS_CREDENTIAL_MANAGER: '1',
    LOCALAPPDATA: path.join(testHomeDir, 'AppData', 'Local'),
    USERPROFILE: testHomeDir,
    MGMT_PORT: String(managementPort),
  };
}

// 1. 创建一个 Mock 下游服务器 (Upstream)
let receivedHeaders = {};
const mockUpstream = http.createServer((req, res) => {
  receivedHeaders = req.headers;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

let upstreamPort = 0;
let claudeEntryPort = 0;
let openAiEntryPort = 0;
let managementPort = 0;
const PROXY_START_TIMEOUT_MS = 30000;
const HOT_RELOAD_TIMEOUT_MS = 20000;

mockUpstream.listen(0, '127.0.0.1', async () => {
  upstreamPort = mockUpstream.address().port;
  try {
    [claudeEntryPort, openAiEntryPort, managementPort] = await findAvailablePorts(3);
    await runTests();
  } catch (error) {
    console.error('\nTest failed:', error);
    process.exitCode = 1;
    cleanUp();
  }
});

// 2. 准备测试配置文件
const configPath = path.join(testConfigDir, 'proxy.config.json');
function setupTestConfig(profile) {
  const config = {
    activeProfile: profile.id,
    entryServers: [
      {
        basePath: '/v1',
        enabled: true,
        host: '127.0.0.1',
        listenPort: claudeEntryPort,
        name: 'Test Claude Entry',
        protocol: 'claude',
        tls: false,
      },
      {
        basePath: '/v1',
        enabled: true,
        host: '127.0.0.1',
        listenPort: openAiEntryPort,
        name: 'Test OpenAI Entry',
        protocol: 'openai-chat',
        tls: false,
      },
    ],
    localServer: {
      basePath: '/v1',
      host: '127.0.0.1',
      listenPort: claudeEntryPort,
      managementPort,
      protocol: 'claude',
    },
    profiles: [profile],
    modelRoutes: [],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function readManagementToken() {
  const candidates = [
    path.join(testRuntimeDir, `.mgmt-token-${managementPort}`),
    path.join(testRuntimeDir, '.mgmt-token'),
  ];
  for (const file of candidates) {
    try {
      const token = fs.readFileSync(file, 'utf8').trim();
      if (token) return token;
    } catch (err) {}
  }
  return '';
}

function stopProxyProcess(proxyProc, done) {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done();
  };
  const timer = setTimeout(finish, 1500);
  if (typeof timer.unref === 'function') timer.unref();
  if (!proxyProc || proxyProc.exitCode != null || proxyProc.signalCode != null) {
    finish();
    return;
  }
  proxyProc.once('exit', finish);
  proxyProc.once('close', finish);
  if (!proxyProc.killed) {
    proxyProc.kill();
  }
}

let sharedProxyProc = null;
let sharedProfileId = '';

function stopSharedProxy() {
  const proxyProc = sharedProxyProc;
  sharedProxyProc = null;
  sharedProfileId = '';
  if (!proxyProc) return Promise.resolve();
  return new Promise((resolve) => stopProxyProcess(proxyProc, resolve));
}

async function useSharedProxy(profile) {
  if (sharedProxyProc) {
    if (sharedProfileId !== profile.id) {
      setupTestConfig(profile);
      sharedProfileId = profile.id;
    }
    return;
  }

  setupTestConfig(profile);
  sharedProfileId = profile.id;
  const proxyProc = spawn('node', [path.join(__dirname, '../openai-proxy.js')], {
    env: createProxyEnv(),
  });
  sharedProxyProc = proxyProc;

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`Timeout waiting for shared proxy readiness (${PROXY_START_TIMEOUT_MS}ms)`));
    }, PROXY_START_TIMEOUT_MS);

    proxyProc.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[PROXY OUT] ${output.trim()}`);
      if (output.includes('Mgmt:')) finish();
    });
    proxyProc.stderr.on('data', (data) => {
      console.error(`[PROXY ERR] ${data.toString().trim()}`);
    });
    proxyProc.once('error', finish);
    proxyProc.once('exit', (code, signal) => {
      finish(new Error(`Shared proxy exited (code=${code}, signal=${signal || 'none'})`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendClaudeMessageRequest() {
  return new Promise((resolve, reject) => {
    receivedHeaders = {};
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: claudeEntryPort,
        path: '/v1/messages',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ...receivedHeaders }));
      }
    );
    req.on('error', reject);
    req.write(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    req.end();
  });
}

async function waitForForwardedApiKey(expectedKey, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastHeaders = {};
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastHeaders = await sendClaudeMessageRequest();
      if (lastHeaders['x-api-key'] === expectedKey) return lastHeaders;
    } catch (err) {
      lastError = err;
    }
    await delay(intervalMs);
  }
  if (Object.keys(lastHeaders).length === 0 && lastError) throw lastError;
  assert.strictEqual(lastHeaders['x-api-key'], expectedKey);
  return lastHeaders;
}

function cleanUp() {
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  fs.rmSync(testHomeDir, { recursive: true, force: true });
  mockUpstream.close();
}

async function runTests() {
  console.log('Starting integration tests for headers routing...');

  try {
    // 测试用例 1: Claude 官方 Profile (不提供 apiKey，透传 OAuth/原有密钥)
    await runSingleTest({
      profile: {
        id: 'claude-official',
        name: 'Claude Official',
        protocol: 'claude',
        targetUrl: `http://127.0.0.1:${upstreamPort}`,
      },
      clientHeaders: {
        authorization: 'Bearer client-oauth-token',
        'x-api-key': 'client-api-key',
        'anthropic-version': '2023-06-01',
      },
      expectedHeadersCheck: (headers) => {
        assert.strictEqual(headers['authorization'], 'Bearer client-oauth-token');
        assert.strictEqual(headers['x-api-key'], 'client-api-key');
        assert.strictEqual(headers['anthropic-version'], '2023-06-01');
      },
      message: 'Claude Official Profile (Empty API Key) preserves client credentials',
    });

    // 测试用例 2: Claude 官方 Profile 带 apiKey
    await runSingleTest({
      profile: {
        id: 'claude-official-with-key',
        name: 'Claude Official with key',
        protocol: 'claude',
        targetUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'sk-ant-test-auth-key',
      },
      clientHeaders: {
        authorization: 'Bearer client-oauth-token',
        'x-api-key': 'client-api-key',
        'anthropic-version': '2023-06-01',
      },
      expectedHeadersCheck: (headers) => {
        assert.strictEqual(headers['x-api-key'], 'sk-ant-test-auth-key');
        assert.strictEqual(headers['authorization'], undefined);
        assert.strictEqual(headers['api-key'], undefined);
      },
      message: 'Claude Profile overrides with x-api-key for Anthropic protocol',
    });

    // 测试用例 3: Google Official Profile 带 apiKey
    await runSingleTest({
      profile: {
        id: 'google-test-profile',
        name: 'Google Test Profile',
        protocol: 'gemini',
        targetUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'google-api-test-key',
      },
      clientHeaders: {
        authorization: 'Bearer some-auth',
      },
      expectedHeadersCheck: (headers) => {
        assert.strictEqual(headers['x-goog-api-key'], 'google-api-test-key');
        assert.strictEqual(headers['authorization'], undefined);
      },
      message: 'Google Profile overrides with x-goog-api-key for Gemini protocol',
    });

    // 测试用例 4: OpenAI Profile 带 apiKey
    await runSingleTest({
      profile: {
        id: 'openai-profile',
        name: 'OpenAI Profile',
        protocol: 'openai',
        targetUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'openai-api-test-key',
      },
      clientHeaders: {
        'x-api-key': 'some-x-key',
      },
      expectedHeadersCheck: (headers) => {
        assert.strictEqual(headers['authorization'], 'Bearer openai-api-test-key');
        assert.strictEqual(headers['x-api-key'], undefined);
      },
      message: 'OpenAI Profile overrides with authorization Bearer for OpenAI protocol',
    });

    // 测试用例 5: OpenAI 官方 Profile (不提供 apiKey，透传客户端原有密钥)
    await runSingleTest({
      profile: {
        id: 'openai-test-profile',
        name: 'OpenAI Test Profile',
        protocol: 'openai',
        targetUrl: `http://127.0.0.1:${upstreamPort}`,
      },
      clientHeaders: {
        authorization: 'Bearer client-openai-oauth-token',
        'api-key': 'client-api-key',
      },
      clientPort: openAiEntryPort,
      clientPath: '/v1/chat/completions',
      clientBody: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
      expectedHeadersCheck: (headers) => {
        assert.strictEqual(headers['authorization'], 'Bearer client-openai-oauth-token');
        assert.strictEqual(headers['api-key'], 'client-api-key');
      },
      message: 'OpenAI Official Profile (Empty API Key) preserves client credentials',
    });

    // 测试用例 6: OpenAI 官方特权 Profile 强制忽略并擦除客户端传入的 API Key
    await runSingleTest({
      profile: {
        id: 'openai-official',
        name: 'OpenAI Official',
        protocol: 'openai',
        targetUrl: `http://127.0.0.1:${upstreamPort}`,
      },
      clientHeaders: {
        authorization: 'Bearer client-openai-oauth-token',
        'api-key': 'client-api-key',
      },
      clientPort: openAiEntryPort,
      clientPath: '/v1/chat/completions',
      clientBody: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
      expectedHeadersCheck: (headers) => {
        // 验证客户端传入的密钥已被彻底擦除，而不能传给上游
        assert.notStrictEqual(headers['authorization'], 'Bearer client-openai-oauth-token');
        assert.notStrictEqual(headers['api-key'], 'client-api-key');
      },
      message: 'OpenAI Official Privilege Profile ignores and strips client credentials',
    });

    // 测试用例 7: Google 官方特权 Profile 强制忽略并擦除客户端传入的 API Key
    await runSingleTest({
      profile: {
        id: 'google-official',
        name: 'Google Official',
        protocol: 'gemini',
        targetUrl: `http://127.0.0.1:${upstreamPort}`,
      },
      clientHeaders: {
        authorization: 'Bearer client-google-token',
        'x-goog-api-key': 'client-google-key',
      },
      clientPort: openAiEntryPort,
      clientPath: '/v1/chat/completions',
      clientBody: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
      expectedHeadersCheck: (headers) => {
        // 验证客户端传入的密钥已被彻底擦除，而不能传给上游
        assert.notStrictEqual(headers['authorization'], 'Bearer client-google-token');
        assert.strictEqual(headers['authorization'], 'Bearer ya29.test-ide-oauth-token');
        assert.notStrictEqual(headers['x-goog-api-key'], 'client-google-key');
      },
      message: 'Google Official Privilege Profile ignores and strips client credentials',
    });

    // Missing IDE login must fail locally, even when Gemini CLI login exists.
    fs.unlinkSync(testIdeState);
    receivedHeaders = {};
    const missingLogin = await fetch(`http://127.0.0.1:${openAiEntryPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
      signal: globalThis.AbortSignal.timeout(10000),
    });
    assert.equal(missingLogin.status, 503);
    assert.equal((await missingLogin.json()).error.code, 'ANTIGRAVITY_CREDENTIALS_MISSING');
    assert.deepStrictEqual(receivedHeaders, {}, 'credential failure must not reach upstream');

    // 测试新特性 1: 配置文件动态热加载 (Hot-Reload)
    await runHotReloadTest();
    await stopSharedProxy();

    // 测试新特性 2: 延迟测速本地 API
    await runLatencyApiTest();

    // 测试新特性 3: 提示词同步本地 API
    await runPromptsSyncApiTest();

    console.log('\nAll integration tests passed successfully!');
  } catch (err) {
    console.error('\nTest failed:', err);
    process.exitCode = 1;
  } finally {
    await stopSharedProxy();
    cleanUp();
  }
}

function sendRoutedRequest({ clientHeaders, clientPort, clientPath, clientBody }) {
  return new Promise((resolve, reject) => {
    receivedHeaders = {};
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: clientPort,
        path: clientPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...clientHeaders },
      },
      (res) => {
        res.resume();
        res.on('error', reject);
        res.on('end', () => resolve({ ...receivedHeaders }));
      }
    );
    req.on('error', reject);
    req.end(
      JSON.stringify(
        clientBody || {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }],
        }
      )
    );
  });
}

async function runSingleTest({
  profile,
  clientHeaders,
  expectedHeadersCheck,
  message,
  clientPort = claudeEntryPort,
  clientPath = '/v1/messages',
  clientBody,
}) {
  await useSharedProxy(profile);
  const deadline = Date.now() + HOT_RELOAD_TIMEOUT_MS;
  let lastError;
  do {
    try {
      const headers = await sendRoutedRequest({
        clientHeaders,
        clientPort,
        clientPath,
        clientBody,
      });
      expectedHeadersCheck(headers);
      console.log(`  [PASS] ${message}`);
      return;
    } catch (err) {
      lastError = err;
      await delay(100);
    }
  } while (Date.now() < deadline);
  throw lastError || new Error(`Timed out waiting for routed profile ${profile.id}`);
}

async function runHotReloadTest() {
  const profile1 = {
    id: 'claude-official-1',
    name: 'Claude Official 1',
    protocol: 'claude',
    targetUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: 'key-1',
  };
  const profile2 = {
    id: 'claude-official-2',
    name: 'Claude Official 2',
    protocol: 'claude',
    targetUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: 'key-2',
  };

  await useSharedProxy(profile1);
  await waitForForwardedApiKey('key-1');
  setupTestConfig(profile2);
  sharedProfileId = profile2.id;
  await waitForForwardedApiKey('key-2');
  console.log('  [PASS] Configuration hot-reload test');
}

function runLatencyApiTest() {
  return new Promise((resolve, reject) => {
    setupTestConfig({
      id: 'dummy',
      name: 'Dummy',
      protocol: 'claude',
      targetUrl: `http://127.0.0.1:${upstreamPort}`,
    });

    const proxyProc = spawn('node', [path.join(__dirname, '../openai-proxy.js')], {
      env: createProxyEnv(),
    });

    let isStarted = false;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      stopProxyProcess(proxyProc, () => (err ? reject(err) : resolve()));
    };
    proxyProc.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Mgmt:') && !isStarted) {
        isStarted = true;
        const managementToken = readManagementToken();

        // 请求本地测速 API
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: claudeEntryPort,
            path: '/v1/local/profile/latency',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-mgmt-token': managementToken },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
              try {
                const result = JSON.parse(body);
                assert.strictEqual(result.ok, true);
                assert.ok(typeof result.latency === 'number');
                console.log('  [PASS] Profile latency speed test API');
                finish();
              } catch (err) {
                finish(err);
              }
            });
          }
        );

        req.on('error', finish);

        req.write(
          JSON.stringify({
            protocol: 'claude',
            targetUrl: `http://127.0.0.1:${upstreamPort}`,
            apiKey: 'test-api-key',
          })
        );
        req.end();
      }
    });
  });
}

function runPromptsSyncApiTest() {
  return new Promise((resolve, reject) => {
    setupTestConfig({
      id: 'dummy',
      name: 'Dummy',
      protocol: 'claude',
      targetUrl: `http://127.0.0.1:${upstreamPort}`,
    });

    const proxyProc = spawn('node', [path.join(__dirname, '../openai-proxy.js')], {
      env: createProxyEnv(),
    });

    let isStarted = false;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      stopProxyProcess(proxyProc, () => (err ? reject(err) : resolve()));
    };
    proxyProc.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Mgmt:') && !isStarted) {
        isStarted = true;
        const managementToken = readManagementToken();

        // 1. 请求本地同步 API 测试 claude
        const reqClaude = http.request(
          {
            hostname: '127.0.0.1',
            port: claudeEntryPort,
            path: '/v1/local/prompts/sync',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-mgmt-token': managementToken },
          },
          (resClaude) => {
            let bodyClaude = '';
            resClaude.on('data', (chunk) => (bodyClaude += chunk));
            resClaude.on('end', () => {
              try {
                const resultClaude = JSON.parse(bodyClaude);
                assert.strictEqual(resultClaude.ok, true);
                assert.ok(resultClaude.path.includes('CLAUDE.md'));
                assert.strictEqual(
                  fs.readFileSync(resultClaude.path, 'utf8'),
                  'test-claude-prompt'
                );
                fs.unlinkSync(resultClaude.path);

                // 2. 接着请求本地同步 API 测试 antigravity
                const reqAnti = http.request(
                  {
                    hostname: '127.0.0.1',
                    port: claudeEntryPort,
                    path: '/v1/local/prompts/sync',
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-mgmt-token': managementToken,
                    },
                  },
                  (resAnti) => {
                    let bodyAnti = '';
                    resAnti.on('data', (chunk) => (bodyAnti += chunk));
                    resAnti.on('end', () => {
                      try {
                        const resultAnti = JSON.parse(bodyAnti);
                        assert.strictEqual(resultAnti.ok, true);
                        assert.ok(resultAnti.path.includes('CLAUDE.md'));
                        assert.ok(resultAnti.path.includes('.antigravity'));
                        assert.strictEqual(
                          fs.readFileSync(resultAnti.path, 'utf8'),
                          'test-antigravity-prompt'
                        );
                        fs.unlinkSync(resultAnti.path);

                        console.log('  [PASS] Prompts Markdown sync API (Claude & Antigravity)');
                        finish();
                      } catch (err) {
                        finish(err);
                      }
                    });
                  }
                );

                reqAnti.on('error', finish);

                reqAnti.write(
                  JSON.stringify({
                    type: 'antigravity',
                    content: 'test-antigravity-prompt',
                  })
                );
                reqAnti.end();
              } catch (err) {
                finish(err);
              }
            });
          }
        );

        reqClaude.on('error', finish);

        reqClaude.write(
          JSON.stringify({
            type: 'claude',
            content: 'test-claude-prompt',
          })
        );
        reqClaude.end();
      }
    });
  });
}
