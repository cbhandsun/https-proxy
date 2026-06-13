const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. 创建一个 Mock 下游服务器 (Upstream)
let receivedHeaders = {};
const mockUpstream = http.createServer((req, res) => {
  receivedHeaders = req.headers;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

let upstreamPort = 0;
mockUpstream.listen(0, '127.0.0.1', () => {
  upstreamPort = mockUpstream.address().port;
  runTests();
});

// 2. 准备测试配置文件
const configPath = path.join(__dirname, 'proxy.config.json');
function setupTestConfig(profile) {
  const config = {
    activeProfile: profile.id,
    entryServers: [
      {
        basePath: '/v1',
        enabled: true,
        host: '127.0.0.1',
        listenPort: 4443,
        name: 'Test Claude Entry',
        protocol: 'claude',
        tls: false,
      },
      {
        basePath: '/v1',
        enabled: true,
        host: '127.0.0.1',
        listenPort: 4445,
        name: 'Test OpenAI Entry',
        protocol: 'openai-chat',
        tls: false,
      },
    ],
    localServer: {
      basePath: '/v1',
      host: '127.0.0.1',
      listenPort: 4443,
      protocol: 'claude',
    },
    profiles: [profile],
    modelRoutes: [],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function readManagementToken() {
  const candidates = [
    path.join(__dirname, '.mgmt-token-4543'),
    path.join(__dirname, '.mgmt-token'),
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendClaudeMessageRequest() {
  return new Promise((resolve, reject) => {
    receivedHeaders = {};
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 4443,
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
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    req.end();
  });
}

async function waitForForwardedApiKey(expectedKey, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastHeaders = {};
  while (Date.now() < deadline) {
    lastHeaders = await sendClaudeMessageRequest();
    if (lastHeaders['x-api-key'] === expectedKey) return lastHeaders;
    await delay(intervalMs);
  }
  assert.strictEqual(lastHeaders['x-api-key'], expectedKey);
  return lastHeaders;
}

function cleanUp() {
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
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
      clientPort: 4445,
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
      clientPort: 4445,
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
      clientPort: 4445,
      clientPath: '/v1/chat/completions',
      clientBody: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
      expectedHeadersCheck: (headers) => {
        // 验证客户端传入的密钥已被彻底擦除，而不能传给上游
        assert.notStrictEqual(headers['authorization'], 'Bearer client-google-token');
        assert.notStrictEqual(headers['x-goog-api-key'], 'client-google-key');
      },
      message: 'Google Official Privilege Profile ignores and strips client credentials',
    });

    // 测试新特性 1: 配置文件动态热加载 (Hot-Reload)
    await runHotReloadTest();

    // 测试新特性 2: 延迟测速本地 API
    await runLatencyApiTest();

    // 测试新特性 3: 提示词同步本地 API
    await runPromptsSyncApiTest();

    console.log('\nAll integration tests passed successfully!');
  } catch (err) {
    console.error('\nTest failed:', err);
    process.exitCode = 1;
  } finally {
    cleanUp();
  }
}

function runSingleTest({
  profile,
  clientHeaders,
  expectedHeadersCheck,
  message,
  clientPort = 4443,
  clientPath = '/v1/messages',
  clientBody,
}) {
  return new Promise((resolve, reject) => {
    receivedHeaders = {};
    setupTestConfig(profile);

    // 启动代理子进程，通过环境变量加载测试配置
    const proxyProc = spawn('node', [path.join(__dirname, '../openai-proxy.js')], {
      env: {
        ...process.env,
        PROXY_DATA_DIR: __dirname,
      },
    });

    let isStarted = false;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      stopProxyProcess(proxyProc, () => (err ? reject(err) : resolve()));
    };
    const timeoutTimer = setTimeout(() => {
      if (!isStarted) {
        finish(new Error('Timeout waiting for proxy to start (10s)'));
      }
    }, 10000);

    const startClient = () => {
      isStarted = true;
      clearTimeout(timeoutTimer);

      // 发送 HTTP 请求给代理服务器
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: clientPort,
          path: clientPath,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...clientHeaders,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              expectedHeadersCheck(receivedHeaders);
              console.log(`  [PASS] ${message}`);
              finish();
            } catch (err) {
              finish(err);
            }
          });
        }
      );

      req.on('error', (err) => {
        finish(err);
      });

      const bodyData = clientBody || {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hi' }],
      };
      req.write(JSON.stringify(bodyData));
      req.end();
    };

    proxyProc.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[PROXY OUT] ${output.trim()}`);
      if (output.includes('Mgmt:') && !isStarted) {
        startClient();
      }
    });

    proxyProc.stderr.on('data', (data) => {
      console.error(`[PROXY ERR] ${data.toString().trim()}`);
    });
  });
}

function runHotReloadTest() {
  return new Promise((resolve, reject) => {
    receivedHeaders = {};
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

    setupTestConfig(profile1);

    // 启动代理
    const proxyProc = spawn('node', [path.join(__dirname, '../openai-proxy.js')], {
      env: {
        ...process.env,
        PROXY_DATA_DIR: __dirname,
      },
    });

    let isStarted = false;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      stopProxyProcess(proxyProc, () => (err ? reject(err) : resolve()));
    };
    const timeoutTimer = setTimeout(() => {
      finish(new Error('Hot reload test timeout (10s)'));
    }, 10000);

    proxyProc.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Mgmt:') && !isStarted) {
        isStarted = true;

        // 1. 发送第一次请求，此时应该使用 key-1
        const req1 = http.request(
          {
            hostname: '127.0.0.1',
            port: 4443,
            path: '/v1/messages',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (res1) => {
            res1.resume();
            try {
              assert.strictEqual(receivedHeaders['x-api-key'], 'key-1');

              // 2. 动态改写配置文件，切换为 profile2
              setupTestConfig(profile2);

              waitForForwardedApiKey('key-2')
                .then(() => {
                  console.log('  [PASS] Configuration hot-reload test');
                  finish();
                })
                .catch(finish);
            } catch (err) {
              finish(err);
            }
          }
        );
        req1.write(
          JSON.stringify({
            model: 'claude-3-5-sonnet-latest',
            messages: [{ role: 'user', content: 'hi' }],
          })
        );
        req1.end();
      }
    });
  });
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
      env: {
        ...process.env,
        PROXY_DATA_DIR: __dirname,
      },
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
            port: 4443,
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
      env: {
        ...process.env,
        PROXY_DATA_DIR: __dirname,
      },
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
            port: 4443,
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
                    port: 4443,
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
