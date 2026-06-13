const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const {
  createManagementLatencyHandlers,
  latencyRequestBody,
} = require('../lib/proxy/handlers/management-latency');

function jsonReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.url = '/v1/local/profile/latency';
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

function makeRequestWithProxy({ fail = false, calls }) {
  return (requestUrl, options, callback) => {
    calls.push({ requestUrl, options });
    const req = new EventEmitter();
    process.nextTick(() => {
      if (fail) {
        req.emit('error', new Error('network down'));
        return;
      }
      const res = Readable.from([]);
      res.statusCode = 200;
      callback(res);
    });
    return req;
  };
}

(async () => {
  assert.deepStrictEqual(latencyRequestBody(null), {});
  assert.deepStrictEqual(latencyRequestBody([]), {});
  assert.deepStrictEqual(latencyRequestBody({ protocol: 'openai' }), { protocol: 'openai' });

  let calls = [];
  const handlers = createManagementLatencyHandlers({
    sendJson,
    requestWithProxy: makeRequestWithProxy({ calls }),
    resolveConfiguredProfile: (profile) => ({
      ...profile,
      apiKey: 'sk-resolved',
    }),
    resolveOfficialCredentials: async ({ profile }) => ({ profile }),
  });

  const nullBody = await invoke(handlers.handleLocalLatencyRequest, null);
  assert.strictEqual(nullBody.statusCode, 400);
  assert.match(JSON.parse(nullBody.body).error, /targetUrl and protocol are required/);
  assert.strictEqual(calls.length, 0);

  const success = await invoke(handlers.handleLocalLatencyRequest, {
    id: 'main',
    protocol: 'openai',
    targetUrl: 'https://api.openai.test/v1',
  });
  assert.strictEqual(success.statusCode, 200);
  assert.strictEqual(JSON.parse(success.body).ok, true);
  assert.ok(typeof JSON.parse(success.body).latency === 'number');
  assert.strictEqual(calls[0].requestUrl, 'https://api.openai.test/v1/models?limit=1000');
  assert.strictEqual(calls[0].options.headers.authorization, 'Bearer sk-resolved');

  calls = [];
  const errorHandlers = createManagementLatencyHandlers({
    sendJson,
    requestWithProxy: makeRequestWithProxy({ calls, fail: true }),
    resolveConfiguredProfile: (profile) => profile,
    resolveOfficialCredentials: async ({ profile }) => ({ profile }),
  });
  const failed = await invoke(errorHandlers.handleLocalLatencyRequest, {
    protocol: 'gemini',
    targetUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'gemini-key',
  });
  assert.strictEqual(failed.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(failed.body), { ok: false, error: 'network down' });
  assert.strictEqual(calls[0].options.headers['x-goog-api-key'], 'gemini-key');

  console.log('[management-latency.test] ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
