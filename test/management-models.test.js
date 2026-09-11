const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const {
  createManagementModelsHandlers,
  modelEntryName,
  modelListErrorMessage,
  modelsRequestBody,
  normalizeModelNames,
  parseModelListResponse,
  redactModelListRequestUrl,
} = require('../lib/proxy/handlers/management-models');

function jsonReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.url = '/v1/local/models';
  req.headers = { host: 'localhost' };
  return req;
}

function createRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body == null ? '' : String(body);
      this.writableEnded = true;
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

function makeRequestWithProxy({ statusCode = 200, responseBody = '{}' } = {}) {
  return (requestUrl, options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const res = Readable.from([Buffer.from(responseBody, 'utf8')]);
      res.statusCode = statusCode;
      callback(res);
    };
    req.destroy = (err) => {
      req.emit('error', err);
    };
    return req;
  };
}

(async () => {
  assert.deepStrictEqual(
    parseModelListResponse(JSON.stringify({ models: ['models/gemini-2.5', { id: 'custom' }] })),
    ['gemini-2.5', 'custom']
  );
  assert.deepStrictEqual(
    parseModelListResponse(JSON.stringify({ data: [{ id: 'gpt-a' }, 'gpt-b'] })),
    ['gpt-a', 'gpt-b']
  );
  assert.deepStrictEqual(parseModelListResponse(JSON.stringify({ models: { a: {}, b: {} } })), [
    'a',
    'b',
  ]);
  assert.strictEqual(modelEntryName(null), '');
  assert.strictEqual(modelEntryName({ id: 123 }), '123');
  assert.strictEqual(modelEntryName({ slug: 'slug-a' }), 'slug-a');
  assert.deepStrictEqual(
    normalizeModelNames([null, { id: 123 }, {}, 'models/gemini-test'], {
      stripGeminiPrefix: true,
    }),
    ['123', '{}', 'gemini-test']
  );
  assert.deepStrictEqual(
    parseModelListResponse(JSON.stringify({ data: [null, { id: 123 }, { name: 'named' }] })),
    ['123', 'named']
  );
  assert.strictEqual(
    redactModelListRequestUrl('https://x.test/v1beta/models?key=secret&alt=json'),
    'https://x.test/v1beta/models?key=[redacted]&alt=json'
  );
  assert.strictEqual(
    modelListErrorMessage(401, JSON.stringify({ error: { message: 'bad key' } })),
    'bad key'
  );
  assert.match(modelListErrorMessage(502, 'not json'), /HTTP 502: not json/);
  assert.deepStrictEqual(modelsRequestBody(null), {});
  assert.deepStrictEqual(modelsRequestBody([]), {});
  assert.deepStrictEqual(modelsRequestBody({ protocol: 'openai' }), { protocol: 'openai' });

  const baseDeps = {
    sendJson,
    resolveOfficialCredentials: async ({ profile }) => ({
      profile,
      authMode: profile.authMode || 'api-key',
      authProvider: profile.authProvider || '',
    }),
    resolveConfiguredProfile: (profile) => profile,
  };

  const upstreamHandlers = createManagementModelsHandlers({
    ...baseDeps,
    requestWithProxy: makeRequestWithProxy({
      responseBody: JSON.stringify({ data: [{ id: 'gpt-test' }] }),
    }),
  });
  const upstream = await invoke(upstreamHandlers.handleLocalModelsListRequest, {
    protocol: 'openai',
    targetUrl: 'https://api.openai.test/v1',
    apiKey: 'sk-test',
  });
  assert.strictEqual(upstream.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(upstream.body), {
    ok: true,
    models: ['gpt-test'],
    authMode: 'api-key',
    source: 'upstream-api',
  });

  let invalidBodyRequestCount = 0;
  const invalidBodyHandlers = createManagementModelsHandlers({
    ...baseDeps,
    requestWithProxy: () => {
      invalidBodyRequestCount += 1;
      throw new Error('must not request upstream for invalid body');
    },
  });
  const nullBody = await invoke(invalidBodyHandlers.handleLocalModelsListRequest, null);
  assert.strictEqual(nullBody.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(nullBody.body), {
    ok: false,
    error: 'targetUrl and protocol are required',
  });
  const arrayBody = await invoke(invalidBodyHandlers.handleLocalModelsListRequest, []);
  assert.strictEqual(arrayBody.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(arrayBody.body), {
    ok: false,
    error: 'targetUrl and protocol are required',
  });
  assert.strictEqual(invalidBodyRequestCount, 0);

  let googleDiscoveryArgs = null;
  const googleHandlers = createManagementModelsHandlers({
    ...baseDeps,
    requestWithProxy: makeRequestWithProxy(),
    resolveOfficialCredentials: async ({ profile }) => ({
      profile: { ...profile, apiKey: 'ya29.token' },
      authMode: 'official-login',
      authProvider: 'google',
      googleOfficialProjectId: 'project-1',
    }),
    fetchGoogleOfficialAvailableModels: async (...args) => {
      googleDiscoveryArgs = args;
      return {
        ok: true,
        models: ['gemini-3.7-flash-tiered'],
        source: 'code-assist-fetchAvailableModels',
      };
    },
  });
  const google = await invoke(googleHandlers.handleLocalModelsListRequest, {
    protocol: 'gemini',
    targetUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'ignored-client-key',
  });
  assert.deepStrictEqual(googleDiscoveryArgs, ['ya29.token', 'project-1']);
  assert.deepStrictEqual(JSON.parse(google.body), {
    ok: true,
    models: ['gemini-3.7-flash-tiered'],
    source: 'code-assist-fetchAvailableModels',
  });

  const googleFallbackHandlers = createManagementModelsHandlers({
    ...baseDeps,
    requestWithProxy: makeRequestWithProxy(),
    resolveOfficialCredentials: async ({ profile }) => ({
      profile: { ...profile, apiKey: 'ya29.token' },
      authMode: 'official-login',
      authProvider: 'google',
      googleOfficialProjectId: 'project-1',
    }),
    fetchGoogleOfficialAvailableModels: async () => ({ ok: false, error: 'quota unavailable' }),
  });
  const googleFallback = await invoke(googleFallbackHandlers.handleLocalModelsListRequest, {
    protocol: 'gemini',
    targetUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'ya29.token',
  });
  const googleFallbackBody = JSON.parse(googleFallback.body);
  assert.strictEqual(googleFallback.statusCode, 200);
  assert.strictEqual(googleFallbackBody.ok, true);
  assert.strictEqual(googleFallbackBody.warning, 'quota unavailable');
  assert.strictEqual(googleFallbackBody.source, 'official-model-config-fallback');

  const upstreamErrorHandlers = createManagementModelsHandlers({
    ...baseDeps,
    requestWithProxy: makeRequestWithProxy({
      statusCode: 403,
      responseBody: JSON.stringify({ error: { message: 'forbidden' } }),
    }),
  });
  const upstreamError = await invoke(upstreamErrorHandlers.handleLocalModelsListRequest, {
    protocol: 'gemini',
    targetUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'secret-key',
  });
  const upstreamErrorBody = JSON.parse(upstreamError.body);
  assert.strictEqual(upstreamError.statusCode, 200);
  assert.strictEqual(upstreamErrorBody.ok, false);
  assert.strictEqual(upstreamErrorBody.error, 'forbidden');
  assert.ok(!upstreamErrorBody.requestUrl.includes('secret-key'));

  console.log('[management-models.test] ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
