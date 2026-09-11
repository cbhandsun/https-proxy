const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-management-ingress-'));
process.env.PROXY_CONFIG_DIR = tmpDir;
process.env.PROXY_RUNTIME_DIR = tmpDir;

const {
  createManagementDiagnosticsHandlers,
} = require('../lib/proxy/handlers/management-diagnostics');

function requestWithJson(value) {
  const request = new EventEmitter();
  request.url = '/v1/local/diagnostics/ingress-probe';
  request.headers = { host: 'localhost' };
  request.start = () => {
    const body = Buffer.from(JSON.stringify(value));
    request.emit('data', body);
    request.emit('end');
  };
  return request;
}

function invoke(handler, value) {
  return new Promise((resolve) => {
    const request = requestWithJson(value);
    const response = {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body) {
        this.body = body == null ? '' : String(body);
        resolve(this);
      },
    };
    handler(request, response);
    queueMicrotask(request.start);
  });
}

(async () => {
  const calls = [];
  const handlers = createManagementDiagnosticsHandlers({
    sendJson(response, statusCode, data) {
      response.writeHead(statusCode, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    },
    currentConfigSnapshot() {
      return {
        diagnostics: {
          externalIngressUrl: 'https://configured.example.test/v1',
          externalIngressTimeoutMs: 6400,
        },
      };
    },
    async probeExternalIngress(url, options) {
      calls.push({ url, timeoutMs: options.timeoutMs });
      return {
        ok: true,
        proxyReached: true,
        classification: 'proxy_reached',
        message: 'reached',
      };
    },
  });

  const explicit = await invoke(handlers.handleLocalIngressProbeRequest, {
    url: 'https://public.example.test/v1',
    timeoutMs: 7000,
  });
  assert.equal(explicit.statusCode, 200);
  assert.equal(JSON.parse(explicit.body).classification, 'proxy_reached');
  assert.deepEqual(calls[0], {
    url: 'https://public.example.test/v1',
    timeoutMs: 7000,
  });

  const configured = await invoke(handlers.handleLocalIngressProbeRequest, {});
  assert.equal(configured.statusCode, 200);
  assert.deepEqual(calls[1], {
    url: 'https://configured.example.test/v1',
    timeoutMs: 6400,
  });

  const diagnosticsResponse = {
    statusCode: 0,
    body: '',
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(body) {
      this.body = String(body || '');
    },
  };
  handlers.handleLocalDiagnosticsGetRequest(
    { url: '/v1/local/diagnostics', headers: { host: 'localhost' } },
    diagnosticsResponse
  );
  const diagnostics = JSON.parse(diagnosticsResponse.body);
  assert.equal(diagnostics.status.externalIngress.classification, 'proxy_reached');
  assert.equal(diagnostics.status.config.externalIngressTimeoutMs, 6400);

  const invalid = await invoke(handlers.handleLocalIngressProbeRequest, []);
  assert.equal(invalid.statusCode, 400);
  assert.match(JSON.parse(invalid.body).error, /must be an object/);

  const rejectingHandlers = createManagementDiagnosticsHandlers({
    sendJson(response, statusCode, data) {
      response.writeHead(statusCode, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    },
    async probeExternalIngress() {
      throw new Error('External ingress URL must use HTTPS');
    },
  });
  const rejected = await invoke(rejectingHandlers.handleLocalIngressProbeRequest, {
    url: 'http://private.example.test/v1',
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(JSON.parse(rejected.body).classification, 'invalid_target');

  console.log('[management-ingress-probe.test] ok');
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
