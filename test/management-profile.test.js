const assert = require('assert');
const { Readable } = require('stream');

const {
  createManagementProfileHandlers,
  profileRequestBody,
} = require('../lib/proxy/handlers/management-profile');

function jsonReq(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
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

function invoke(handler, body) {
  return new Promise((resolve) => {
    const res = createRes();
    const originalEnd = res.end.bind(res);
    res.end = (payload) => {
      originalEnd(payload);
      resolve(res);
    };
    handler(jsonReq('/v1/local/test', body), res);
  });
}

(async () => {
  let makeRequestCalls = [];
  const profiles = [
    {
      id: 'trae-profile',
      protocol: 'trae',
      targetUrl: 'https://example.invalid/v1',
      apiKey: 'ignored',
      authMode: 'official-login',
    },
    {
      id: 'openai-profile',
      protocol: 'openai',
      targetUrl: 'https://api.openai.test/v1',
      apiKey: 'sk-test',
    },
    {
      id: 'trae-official',
      protocol: 'trae',
      targetUrl: 'https://coresg-normal.trae.ai',
      authMode: 'official-login',
    },
  ];

  const handlers = createManagementProfileHandlers({
    sendJson,
    makeRequest: async (url, options, body) => {
      makeRequestCalls.push({ url, options, body });
      if (url.includes('/health')) return { statusCode: 200, body: 'ok' };
      return {
        statusCode: 200,
        body: JSON.stringify({ data: [{ id: 'gpt-test' }] }),
      };
    },
    resolveOfficialCredentials: async ({ profile }) => ({
      profile,
      authMode: profile.authMode || 'api-key',
    }),
    resolveConfiguredProfile: (profile, profileId) => ({
      ...profiles.find((item) => item.id === profileId),
      ...profile,
    }),
    getProfilesSnapshot: () => profiles,
    queryTraeStateRows: async () => ({
      ok: true,
      rows: [{ model: 'trae-model', id: 'trae-model' }],
    }),
    traeOfficialModelSupport: (model) => ({
      known: model === 'trae-model' || model === 'trae/minimax-m3',
      supported: model === 'trae-model' || model === 'trae/minimax-m3',
      model: model === 'trae/minimax-m3' ? 'minimax-m3' : model,
    }),
    getTraeOfficialBridgeUrl: (pathname) => `http://127.0.0.1:17861${pathname}`,
  });

  assert.deepStrictEqual(profileRequestBody(null), {});
  assert.deepStrictEqual(profileRequestBody(['bad']), {});
  assert.deepStrictEqual(profileRequestBody({ protocol: 'openai' }), { protocol: 'openai' });

  const missing = await invoke(handlers.handleLocalProfileTestAuthRequest, {
    protocol: 'openai',
  });
  assert.strictEqual(missing.statusCode, 400);
  assert.match(JSON.parse(missing.body).error, /protocol and targetUrl are required/);

  const nullProfileBody = await invoke(handlers.handleLocalProfileTestAuthRequest, null);
  assert.strictEqual(nullProfileBody.statusCode, 400);
  assert.match(JSON.parse(nullProfileBody.body).error, /protocol and targetUrl are required/);

  const traeRoute = await invoke(handlers.handleLocalRouteTestRequest, {
    profileId: 'trae-profile',
    testModel: 'trae-model',
  });
  const traeBody = JSON.parse(traeRoute.body);
  assert.strictEqual(traeRoute.statusCode, 200);
  assert.strictEqual(traeBody.ok, true);
  assert.strictEqual(traeBody.source, 'trae-bridge');
  assert.strictEqual(makeRequestCalls[0].url, 'http://127.0.0.1:17861/health');

  makeRequestCalls = [];
  const traeOfficialRoute = await invoke(handlers.handleLocalRouteTestRequest, {
    profileId: 'trae-official',
    protocol: 'trae',
    targetUrl: 'https://coresg-normal.trae.ai',
    apiKey: '[redacted]',
    to: 'trae/minimax-m3',
  });
  const traeOfficialBody = JSON.parse(traeOfficialRoute.body);
  assert.strictEqual(traeOfficialRoute.statusCode, 200);
  assert.strictEqual(traeOfficialBody.ok, true);
  assert.strictEqual(traeOfficialBody.source, 'trae-bridge');
  assert.strictEqual(traeOfficialBody.model, 'minimax-m3');
  assert.strictEqual(makeRequestCalls.length, 1);
  assert.strictEqual(makeRequestCalls[0].url, 'http://127.0.0.1:17861/health');

  makeRequestCalls = [];
  const badTrae = await invoke(handlers.handleLocalRouteTestRequest, {
    profileId: 'trae-profile',
    testModel: 'missing-model',
  });
  const badTraeBody = JSON.parse(badTrae.body);
  assert.strictEqual(badTrae.statusCode, 200);
  assert.strictEqual(badTraeBody.ok, false);
  assert.strictEqual(badTraeBody.source, 'trae-state-cache');
  assert.strictEqual(makeRequestCalls.length, 0, 'unsupported Trae model must not probe bridge');

  const noProfile = await invoke(handlers.handleLocalRouteTestRequest, {
    profileId: 'missing-profile',
  });
  assert.strictEqual(noProfile.statusCode, 400);
  assert.match(JSON.parse(noProfile.body).error, /protocol and targetUrl are required/);

  const arrayRouteBody = await invoke(handlers.handleLocalRouteTestRequest, []);
  assert.strictEqual(arrayRouteBody.statusCode, 400);
  assert.match(JSON.parse(arrayRouteBody.body).error, /protocol and targetUrl are required/);

  console.log('[management-profile.test] ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
