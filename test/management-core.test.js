const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
  createManagementCoreHandlers,
  readRawConfigSnapshot,
} = require('../lib/proxy/handlers/management-core');

function emptyReq(method = 'GET') {
  const req = Readable.from([]);
  req.method = method;
  req.headers = { host: 'localhost' };
  return req;
}

function createRes() {
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
    },
  };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

(async () => {
  const previousMgmtPort = process.env.MGMT_PORT;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-management-core-'));
  const configFile = path.join(tmpDir, 'missing-config.json');
  const writes = [];
  let reloads = 0;

  try {
    process.env.MGMT_PORT = '999999';

    const currentConfig = {
      localServer: { managementPort: 'also-invalid' },
      promptPresets: [{ id: 'default', content: 'hello' }],
    };
    const handlers = createManagementCoreHandlers({
      sendJson,
      metricsInstance: { render: () => 'hpm_requests_total 1\n' },
      appId: 'test-app',
      packageVersion: '1.2.3',
      defaultPort: 4443,
      currentConfigSnapshot: () => currentConfig,
      currentEntryServersSnapshot: () => [
        { protocol: 'claude', host: '127.0.0.1', listenPort: 4443, basePath: '/v1' },
      ],
      writeConfigFileAtomically: (nextConfig) => writes.push(nextConfig),
      reloadProxyConfig: () => {
        reloads += 1;
      },
      configFile,
      usageSummary: async () => ({ totalRequests: 3 }),
    });

    const healthRes = createRes();
    handlers.handleLocalHealthRequest(emptyReq(), healthRes);
    const health = JSON.parse(healthRes.body);
    assert.strictEqual(healthRes.statusCode, 200);
    assert.ok(path.isAbsolute(health.runtime.configDir));
    assert.ok(path.isAbsolute(health.runtime.runtimeDir));
    assert.ok(health.runtime.entrypoint);
    assert.strictEqual(typeof health.runtime.cwd, 'string');
    assert.strictEqual(health.ports.management, 4543);
    assert.deepStrictEqual(health.ports.entries[0], {
      protocol: 'claude',
      host: '127.0.0.1',
      listenPort: 4443,
      basePath: '/v1',
      tls: true,
    });

    const metricsRes = createRes();
    handlers.handleLocalMetricsRequest(emptyReq(), metricsRes);
    assert.strictEqual(metricsRes.statusCode, 200);
    assert.strictEqual(metricsRes.body, 'hpm_requests_total 1\n');

    const badMetrics = createManagementCoreHandlers({
      sendJson,
      metricsInstance: {
        render: () => {
          throw new Error('metrics broke');
        },
      },
      appId: 'test-app',
      packageVersion: '1.2.3',
      defaultPort: 4443,
      currentConfigSnapshot: () => currentConfig,
      currentEntryServersSnapshot: () => [],
      writeConfigFileAtomically: (nextConfig) => writes.push(nextConfig),
      reloadProxyConfig: () => {
        reloads += 1;
      },
      configFile,
    });
    const badMetricsRes = createRes();
    badMetrics.handleLocalMetricsRequest(emptyReq(), badMetricsRes);
    assert.strictEqual(badMetricsRes.statusCode, 500);
    assert.strictEqual(JSON.parse(badMetricsRes.body).error, 'metrics broke');

    const usageRes = createRes();
    await handlers.handleLocalUsageSummaryRequest(emptyReq(), usageRes);
    assert.strictEqual(usageRes.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(usageRes.body).summary, { totalRequests: 3 });
    assert.deepStrictEqual(
      readRawConfigSnapshot(configFile, () => currentConfig),
      currentConfig
    );
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(reloads, 0);
    console.log('[management-core.test] ok');
  } finally {
    if (previousMgmtPort == null) {
      delete process.env.MGMT_PORT;
    } else {
      process.env.MGMT_PORT = previousMgmtPort;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
