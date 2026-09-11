'use strict';

// Explicit live verification, never run by CI. Requires an existing official AGY login.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { AbortSignal, AbortController } = globalThis;
const { createAgyRuntime, prepareWorkspace } = require('../lib/proxy/agy-runtime');
const { parseChatRequest } = require('../lib/proxy/agy-chat-request');
const { createAgyBridgeServer } = require('../lib/proxy/agy-bridge-server');
const { ensurePrivateDirectorySync } = require('../lib/proxy/secure-files');
const { findAvailablePorts } = require('../test/helpers/test-ports');
const { createIsolatedTestEnv } = require('../lib/test-runtime');

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('close', resolve);
    child.kill();
  });
}

function cleanVerificationRoot(root) {
  const resolved = path.resolve(root);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith('hpm-agy-verify-')
  ) {
    throw new Error('unsafe_cleanup_path');
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
}

async function verifyLifecycle(report) {
  for (const kind of ['timeout', 'cancel']) {
    let workspaceRoot;
    const runtime = createAgyRuntime({
      executable: path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
      timeoutMs: kind === 'timeout' ? 250 : 10000,
      prepare() {
        const workspace = prepareWorkspace();
        workspaceRoot = workspace.root;
        return workspace;
      },
    });
    const controller = new AbortController();
    const pending = runtime.generate(
      parseChatRequest({
        model: 'agy/gemini-3.7-flash-high',
        messages: [{ role: 'user', content: 'Reply OK without tools.' }],
      }),
      { signal: controller.signal }
    );
    const timer = kind === 'cancel' ? setTimeout(() => controller.abort(), 250) : null;
    const expected = kind === 'timeout' ? 'agy_timeout' : 'agy_canceled';
    try {
      await assert.rejects(pending, (error) => error.code === expected);
      assert.ok(
        workspaceRoot && !fs.existsSync(workspaceRoot),
        'private workspace must be removed'
      );
      const record = { name: `real-cli-${kind}`, ok: true, code: expected, workspaceRemoved: true };
      report.push(record);
      process.stdout.write(JSON.stringify(record) + '\n');
    } finally {
      clearTimeout(timer);
    }
  }
}

async function verify() {
  if (!process.argv.includes('--live'))
    throw new Error('Use --live to authorize real model requests');
  const report = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-agy-verify-'));
  ensurePrivateDirectorySync(root);
  const token = randomBytes(32).toString('hex');
  const entryToken = randomBytes(32).toString('hex');
  const bridge = createAgyBridgeServer({
    token,
    runtime: createAgyRuntime({
      executable: path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
    }),
  });
  let child;
  try {
    await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
    const bridgePort = bridge.server.address().port;
    const [entryPort, managementPort] = await findAvailablePorts(2);
    const env = createIsolatedTestEnv(process.env, root);
    Object.assign(env, {
      MGMT_PORT: String(managementPort),
      PROXY_DISABLE_CONVERSATION_AUDIT: '1',
      PROXY_DISABLE_FILE_LOG: '1',
      HPM_NATIVE_DPAPI_HELPER: path.join(
        process.env.LOCALAPPDATA,
        'HTTPS Proxy Manager',
        'https-proxy-manager.exe'
      ),
    });
    delete env.PORT;
    const entry = {
      host: '127.0.0.1',
      listenPort: entryPort,
      basePath: '/v1',
      protocol: 'openai-chat',
      tls: false,
    };
    fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
      JSON.stringify({
        activeProfile: 'agy-cli',
        localServer: entry,
        entryServers: [entry],
        profiles: [
          {
            id: 'agy-cli',
            name: 'Official AGY CLI bridge',
            protocol: 'openai',
            authMode: 'api-key',
            targetUrl: `http://127.0.0.1:${bridgePort}/v1`,
            apiKey: token,
          },
        ],
        modelRoutes: [
          {
            from: 'agy/gemini-3.7-flash-high',
            to: 'agy/gemini-3.7-flash-high',
            profileId: 'agy-cli',
          },
        ],
        entryAuth: {
          enabled: true,
          keys: [{ id: 'verify', key: entryToken, enabled: true, allowedProfileIds: ['agy-cli'] }],
        },
        appSettings: {
          conversationAuditEnabled: false,
          conversationAuditCaptureContent: false,
          upstreamWarmupEnabled: false,
        },
        diagnostics: { enabled: false },
      }),
      { mode: 0o600 }
    );
    child = spawn(process.execPath, [path.resolve(__dirname, '..', 'openai-proxy.js')], {
      cwd: path.resolve(__dirname, '..'),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('isolated_proxy_start_timeout')), 60000);
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('isolated_proxy_start_failed'));
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('isolated_proxy_exited'));
      });
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('Mgmt:')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const url = `http://127.0.0.1:${entryPort}/v1/chat/completions`;
    const headers = { authorization: `Bearer ${entryToken}`, 'content-type': 'application/json' };
    const cases = [
      {
        name: 'single-turn',
        messages: [{ role: 'user', content: 'Reply exactly HPM_SINGLE_OK. Do not use tools.' }],
        expected: 'HPM_SINGLE_OK',
      },
      {
        name: 'history',
        messages: [
          { role: 'user', content: 'Remember this code: HPM_MEMORY_7249' },
          { role: 'assistant', content: 'I will remember it.' },
          { role: 'user', content: 'Repeat only the code from earlier. Do not use tools.' },
        ],
        expected: 'HPM_MEMORY_7249',
      },
      {
        name: 'stream',
        stream: true,
        messages: [{ role: 'user', content: 'Reply exactly HPM_STREAM_OK. Do not use tools.' }],
        expected: 'HPM_STREAM_OK',
      },
    ];
    for (const item of cases) {
      const started = Date.now();
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'agy/gemini-3.7-flash-high',
          messages: item.messages,
          stream: !!item.stream,
        }),
        signal: AbortSignal.timeout(75000),
      });
      const raw = await response.text();
      let text;
      if (item.stream) {
        assert.ok(raw.includes('data: [DONE]'), 'SSE must terminate');
        const events = raw
          .split('\n')
          .filter((line) => line.startsWith('data: {'))
          .map((line) => JSON.parse(line.slice(6)));
        assert.ok(
          events.every((event) => !event.error),
          'SSE must not contain errors'
        );
        text = events.map((event) => event.choices?.[0]?.delta?.content || '').join('');
      } else text = JSON.parse(raw).choices?.[0]?.message?.content || '';
      const ok = response.status === 200 && text.trim() === item.expected;
      const record = {
        name: item.name,
        ok,
        status: response.status,
        elapsedMs: Date.now() - started,
      };
      report.push(record);
      process.stdout.write(JSON.stringify(record) + '\n');
      assert.ok(ok, `${item.name} failed; response content intentionally withheld`);
    }
    const rejected = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'agy/gemini-3.7-flash-high',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    });
    assert.equal(rejected.status, 400);
    report.push({ name: 'unsupported-tools-rejected', ok: true, status: rejected.status });
    await verifyLifecycle(report);
    const destination = path.resolve(__dirname, '..', '.hpm-runtime', 'agy-validation.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(
      destination,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          chain: 'HTTP -> isolated HTTPS Proxy -> AGY bridge -> official agy -> Google',
          report,
        },
        null,
        2
      ) + '\n'
    );
    process.stdout.write(JSON.stringify({ ok: true, report: destination }) + '\n');
  } finally {
    await stop(child);
    await bridge.close();
    cleanVerificationRoot(root);
  }
}

verify().catch((error) => {
  const reason = /^isolated_proxy_[a-z_]+$/.test(error.message)
    ? error.message
    : error.code || 'verification_failed';
  process.stderr.write(
    `AGY live verification failed: ${reason}; ${error.cause?.code || error.name}\n`
  );
  process.exitCode = 1;
});
