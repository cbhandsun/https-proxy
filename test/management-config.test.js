const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
  createManagementConfigHandlers,
  configRevisionFromText,
  redactConfigSecrets,
  requireConfigObjectBody,
} = require('../lib/proxy/handlers/management-config');

function jsonReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.url = '/v1/local/config';
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

function invoke(handler, body) {
  return new Promise((resolve) => {
    const res = createRes();
    const originalEnd = res.end.bind(res);
    res.end = (payload) => {
      originalEnd(payload);
      resolve(res);
    };
    handler(jsonReq(body), res);
  });
}

function baseConfig(overrides = {}) {
  return {
    activeProfile: 'main',
    profiles: [
      {
        id: 'main',
        protocol: 'openai',
        targetUrl: 'https://api.openai.test/v1',
        apiKey: 'hpm-enc:old-main',
      },
      {
        id: 'backup',
        protocol: 'gemini',
        targetUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'hpm-enc:old-backup',
      },
    ],
    localServer: {
      listenPort: 3443,
      basePath: '/v1',
    },
    entryServers: [],
    mcpHub: {
      servers: [],
      routing: [],
    },
    ...overrides,
  };
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-management-config-'));
  const configFile = path.join(tmpDir, 'config.json');
  let reloads = 0;
  let loadedConfig = baseConfig();
  const loadConfigFn = () => loadedConfig;

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      ...baseConfig(),
      claudeDesktop: {
        token: 'old-token',
        directApiKey: 'old-direct-key',
      },
      entryAuth: {
        enabled: true,
        keys: [{ id: 'team-a', name: 'Team A', key: 'old-entry-key', enabled: true }],
      },
    })
  );

  const handlers = createManagementConfigHandlers({
    sendJson,
    reloadProxyConfig: () => {
      reloads += 1;
    },
    configFile,
    loadConfigFn,
    encryptConfigForStorage: (config) => config,
  });

  assert.deepStrictEqual(requireConfigObjectBody({ ok: true }), {
    ok: true,
    body: { ok: true },
  });
  assert.deepStrictEqual(requireConfigObjectBody(null), {
    ok: false,
    error: 'JSON body must be an object',
  });
  assert.deepStrictEqual(requireConfigObjectBody([]), {
    ok: false,
    error: 'JSON body must be an object',
  });
  assert.match(configRevisionFromText('config'), /^[a-f0-9]{64}$/);
  assert.notStrictEqual(configRevisionFromText('config'), configRevisionFromText('Config'));
  assert.deepStrictEqual(redactConfigSecrets({ apiKey: 'sk', nested: { accessToken: 'tok' } }), {
    apiKey: '[redacted]',
    nested: { accessToken: '[redacted]' },
  });
  assert.deepStrictEqual(
    redactConfigSecrets({
      profiles: [{ apiKey: 'sk-secret', nested: { authorization: 'Bearer token' } }],
      claudeDesktop: { token: 'hpm-token', directApiKey: '' },
      entryAuth: { keys: [{ id: 'team-a', key: 'entry-secret' }] },
      safe: 'visible',
    }),
    {
      profiles: [{ apiKey: '[redacted]', nested: { authorization: '[redacted]' } }],
      claudeDesktop: { token: '[redacted]', directApiKey: '' },
      entryAuth: { keys: [{ id: 'team-a', key: '[redacted]' }] },
      safe: 'visible',
    }
  );

  loadedConfig = {
    ...baseConfig(),
    entryAuth: {
      enabled: true,
      keys: [{ id: 'team-a', name: 'Team A', key: 'old-entry-key', enabled: true }],
    },
  };
  const revealRes = await invoke(handlers.handleLocalEntryAuthKeyRevealRequest, {
    keyId: 'team-a',
  });
  assert.strictEqual(revealRes.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(revealRes.body), {
    ok: true,
    keyId: 'team-a',
    key: 'old-entry-key',
  });
  const missingRevealRes = await invoke(handlers.handleLocalEntryAuthKeyRevealRequest, {
    keyId: 'missing',
  });
  assert.strictEqual(missingRevealRes.statusCode, 404);

  const nullSave = await invoke(handlers.handleLocalSaveConfigRequest, null);
  assert.strictEqual(nullSave.statusCode, 400);
  assert.match(JSON.parse(nullSave.body).error, /JSON body must be an object/);

  const saveConfig = baseConfig({
    profiles: [
      {
        id: 'main',
        protocol: 'openai',
        targetUrl: 'https://api.openai.test/v1',
        apiKey: '[redacted]',
      },
    ],
    claudeDesktop: {
      token: '[redacted]',
      directApiKey: '***',
    },
    entryAuth: {
      enabled: true,
      keys: [{ id: 'team-a', name: 'Team A', key: '[redacted]', enabled: true }],
    },
  });
  const saveRes = await invoke(handlers.handleLocalSaveConfigRequest, saveConfig);
  assert.strictEqual(saveRes.statusCode, 200);
  assert.strictEqual(JSON.parse(saveRes.body).ok, true);
  assert.match(JSON.parse(saveRes.body).revision, /^[a-f0-9]{64}$/);
  assert.strictEqual(reloads, 1);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.strictEqual(saved.profiles[0].apiKey, 'hpm-enc:old-main');
  assert.strictEqual(saved.claudeDesktop.token, 'old-token');
  assert.strictEqual(saved.claudeDesktop.directApiKey, 'old-direct-key');
  assert.strictEqual(saved.entryAuth.keys[0].key, 'old-entry-key');

  const arraySetActive = await invoke(handlers.handleLocalSetActiveRequest, []);
  assert.strictEqual(arraySetActive.statusCode, 400);
  assert.match(JSON.parse(arraySetActive.body).error, /JSON body must be an object/);

  fs.writeFileSync(configFile, JSON.stringify(baseConfig()));
  const setActive = await invoke(handlers.handleLocalSetActiveRequest, { profileId: 'backup' });
  assert.strictEqual(setActive.statusCode, 200);
  assert.strictEqual(JSON.parse(setActive.body).ok, true);
  assert.strictEqual(JSON.parse(setActive.body).activeProfile, 'backup');
  assert.match(JSON.parse(setActive.body).revision, /^[a-f0-9]{64}$/);
  assert.strictEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).activeProfile, 'backup');
  assert.strictEqual(reloads, 2);

  const missing = await invoke(handlers.handleLocalSetActiveRequest, { profileId: 'missing' });
  assert.strictEqual(missing.statusCode, 404);
  assert.match(JSON.parse(missing.body).error, /Profile not found: missing/);

  const getConfigRes = await invoke(handlers.handleLocalGetConfigRequest, {});
  assert.strictEqual(getConfigRes.statusCode, 200);
  const fetchedConfig = JSON.parse(getConfigRes.body);
  assert.match(fetchedConfig._revision, /^[a-f0-9]{64}$/);
  fs.writeFileSync(configFile, JSON.stringify(baseConfig({ activeProfile: 'backup' })), 'utf8');
  const conflictingSave = await invoke(handlers.handleLocalSaveConfigRequest, {
    ...baseConfig(),
    _revision: fetchedConfig._revision,
  });
  assert.strictEqual(conflictingSave.statusCode, 409);
  assert.match(JSON.parse(conflictingSave.body).error, /changed since it was loaded/);
  assert.strictEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).activeProfile, 'backup');

  const operationOrder = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const firstMutation = handlers.enqueueConfigMutation(async () => {
    operationOrder.push('first-start');
    await firstGate;
    operationOrder.push('first-end');
  });
  const secondMutation = handlers.enqueueConfigMutation(async () => {
    operationOrder.push('second');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(operationOrder, ['first-start']);
  releaseFirst();
  await Promise.all([firstMutation, secondMutation]);
  assert.deepStrictEqual(operationOrder, ['first-start', 'first-end', 'second']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('[management-config.test] ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
