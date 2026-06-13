const assert = require('assert');
const { Readable } = require('stream');

const {
  createManagementClaudeDesktopHandlers,
  decorateClaudeDesktopStatus,
  expectedClaudeDesktopBaseUrl,
} = require('../lib/proxy/handlers/management-claude-desktop');

function emptyReq(url) {
  const req = Readable.from([]);
  req.url = url;
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

function invoke(handler, url) {
  const res = createRes();
  handler(emptyReq(url), res);
  return res;
}

(() => {
  const config = {
    claudeDesktop: {
      mode: 'proxy',
      token: 'hpm-enc:desktop-token',
    },
  };

  assert.strictEqual(
    expectedClaudeDesktopBaseUrl(
      { claudeDesktop: { mode: 'direct', directBaseUrl: 'https://direct.test' } },
      { baseUrl: () => 'https://proxy.test', proxyPrefix: '/api' }
    ),
    'https://direct.test'
  );

  const decorated = decorateClaudeDesktopStatus(
    {
      actualBaseUrl: 'https://proxy.test/api',
      configPath: 'settings.json',
      configured: true,
    },
    config,
    {
      baseUrl: () => 'https://proxy.test',
      proxyPrefix: '/api',
      gatewayConfig: () => ({ isLocalProxy: true, token: 'desktop-token' }),
      clientEvidence: () => ({ app: 'claude-desktop' }),
      decrypt: (value) => (value === 'hpm-enc:desktop-token' ? 'desktop-token' : value),
    }
  );
  assert.strictEqual(decorated.expectedBaseUrl, 'https://proxy.test/api');
  assert.strictEqual(decorated.matchesExpected, true);
  assert.strictEqual(decorated.tokenMatchesExpected, true);
  assert.deepStrictEqual(decorated.clientEvidence, { app: 'claude-desktop' });

  const calls = [];
  const handlers = createManagementClaudeDesktopHandlers({
    sendJson,
    currentConfigSnapshot: () => config,
    configFile: 'config.test.json',
    decrypt: (value) => (value === 'hpm-enc:desktop-token' ? 'desktop-token' : value),
    encryptConfigForStorage: (value) => ({ encrypted: value }),
    getStatus: () => ({
      actualBaseUrl: 'https://proxy.test/api',
      configPath: 'settings.json',
      configured: true,
    }),
    applyConfig: (nextConfig, configFile, decrypt, encryptConfigForStorage) => {
      calls.push({
        type: 'apply',
        nextConfig,
        configFile,
        decrypted: decrypt(nextConfig.claudeDesktop.token),
        encrypted: encryptConfigForStorage({ ok: true }),
      });
      return { applied: true };
    },
    restoreConfig: (nextConfig, configFile, encryptConfigForStorage) => {
      calls.push({
        type: 'restore',
        nextConfig,
        configFile,
        encrypted: encryptConfigForStorage({ ok: true }),
      });
    },
    baseUrl: () => 'https://proxy.test',
    proxyPrefix: '/api',
    gatewayConfig: () => ({ isLocalProxy: true, token: 'desktop-token' }),
    clientEvidence: () => ({ app: 'claude-desktop' }),
  });

  const status = invoke(
    handlers.handleLocalClaudeDesktopStatusRequest,
    '/v1/local/claude-desktop/status'
  );
  assert.strictEqual(status.statusCode, 200);
  assert.strictEqual(JSON.parse(status.body).tokenMatchesExpected, true);

  const apply = invoke(
    handlers.handleLocalClaudeDesktopApplyRequest,
    '/v1/local/claude-desktop/apply'
  );
  assert.strictEqual(apply.statusCode, 200);
  assert.strictEqual(JSON.parse(apply.body).applied, true);
  assert.strictEqual(calls[0].type, 'apply');
  assert.strictEqual(calls[0].configFile, 'config.test.json');
  assert.strictEqual(calls[0].decrypted, 'desktop-token');
  assert.deepStrictEqual(calls[0].encrypted, { encrypted: { ok: true } });

  const restore = invoke(
    handlers.handleLocalClaudeDesktopRestoreRequest,
    '/v1/local/claude-desktop/restore'
  );
  assert.strictEqual(restore.statusCode, 200);
  assert.strictEqual(JSON.parse(restore.body).ok, true);
  assert.strictEqual(calls[1].type, 'restore');
  assert.strictEqual(calls[1].configFile, 'config.test.json');

  console.log('[management-claude-desktop.test] ok');
})();
