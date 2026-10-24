'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { waitForProxyFixtureReady } = require('./helpers/proxy-fixture-ready');
const { parseStopIdentity } = require('../lib/proxy/proxy-stop-control');
const { AbortSignal } = globalThis;

test(
  'actual source HTTP stop retains management authentication, rejects stale targets and exits after drain',
  { timeout: 30000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-authenticated-stop-'));
    const env = createIsolatedTestEnv(process.env, directory);
    const [entryPort, managementPort] = await findAvailablePorts(2);
    fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
    const token = 'synthetic-stop-management-token';
    const entry = {
      protocol: 'openai-chat',
      host: '127.0.0.1',
      listenPort: entryPort,
      basePath: '/v1',
      tls: false,
    };
    fs.writeFileSync(
      path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
      JSON.stringify({
        activeProfile: 'synthetic',
        localServer: { ...entry, managementPort },
        entryServers: [entry],
        profiles: [
          {
            id: 'synthetic',
            name: 'synthetic',
            protocol: 'openai',
            targetUrl: 'http://127.0.0.1:9/v1',
            apiKey: '',
          },
        ],
        modelRoutes: [],
        appSettings: { contextRecoveryEnabled: false, contextRecoveryPersistenceEnabled: false },
      })
    );
    const child = spawn(process.execPath, [path.resolve('openai-proxy.js')], {
      cwd: path.resolve('.'),
      env: {
        ...env,
        MGMT_PORT: String(managementPort),
        MGMT_TOKEN: token,
        PROXY_DISABLE_CONVERSATION_AUDIT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    child.stderr.resume();
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await waitForProxyFixtureReady(child);
    child.stdout.resume();
    const base = `http://127.0.0.1:${managementPort}`;
    const getHealth = async () => {
      const response = await fetch(base + '/v1/local/health', {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const health = await getHealth();
    const identity = parseStopIdentity(health.shutdown);
    assert.ok(identity);
    assert.equal(identity.pid, child.pid);
    const post = async (body, headers = {}, port = managementPort) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/local/runtime/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer();
      return response.status;
    };
    for (const headers of [{}, { 'x-mgmt-token': 'wrong' }, { Authorization: `Bearer ${token}` }])
      assert.equal(await post(identity, headers), 401);
    assert.equal(
      await post(identity, { 'x-mgmt-token': token, Origin: 'https://untrusted.invalid' }),
      403
    );
    assert.notEqual(await post(identity, { 'x-mgmt-token': token }, entryPort), 202);
    assert.equal(
      await post({ ...identity, instanceId: '0'.repeat(32) }, { 'x-mgmt-token': token }),
      409
    );
    assert.equal(await post({ ...identity, pid: child.pid + 1 }, { 'x-mgmt-token': token }), 409);
    for (const invalid of ['', 'null', '{}', '[]', '{', ' '.repeat(129)])
      assert.equal(await post(invalid, { 'x-mgmt-token': token }), 400);
    assert.equal((await getHealth()).shutdown.instanceId, identity.instanceId);
    const response = await fetch(base + '/v1/local/runtime/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mgmt-token': token },
      body: JSON.stringify(identity),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true, ...identity });
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('owned source drain deadline')), 4000);
      timer.unref();
    });
    assert.deepEqual(await Promise.race([exited, timeout]), [0, null]);
    assert.equal(fs.existsSync(path.join(env.PROXY_RUNTIME_DIR, '.proxy.pid')), false);
  }
);
