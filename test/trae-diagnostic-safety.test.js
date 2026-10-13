'use strict';
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  safeTraeDiagnosticError,
  safeTraeStreamError,
  sanitizeTraeDiagnosticUrl,
  summarizeTraeBridgeHealth,
} = require('../lib/proxy/trae-error-contract');
const secret = 'SECRET-token-cookie-user-content';
const configured = `https://username:password@localhost:17861/private?token=${secret}#fragment`;
function safe(value) {
  const text = JSON.stringify(value);
  for (const token of [secret, 'username', 'password', '/private', 'fragment'])
    assert.ok(!text.includes(token), text);
}
for (const value of [
  null,
  undefined,
  secret,
  1,
  {},
  new Error(secret),
  { message: secret },
  {
    get message() {
      throw new Error(secret);
    },
  },
]) {
  safe(safeTraeDiagnosticError(value));
  safe(safeTraeDiagnosticError(value, 'input'));
  safe(safeTraeStreamError(value));
}
assert.equal(
  safeTraeDiagnosticError(new Error('Request body too large; max 1048576 bytes'), 'input'),
  'Request body too large'
);
assert.equal(
  safeTraeDiagnosticError(new Error(`Request body too large; max ${secret} bytes`), 'input'),
  'Invalid Trae diagnostic request'
);
assert.equal(
  safeTraeStreamError(new Error(`Now session is not waiting input ${secret}`)),
  'Trae bridge is busy'
);
assert.equal(
  safeTraeStreamError(new Error('busy'.repeat(1000) + secret)),
  'Trae bridge stream request failed'
);
assert.equal(sanitizeTraeDiagnosticUrl(configured), 'https://localhost:17861/health');
for (const value of [null, {}, [], 'file:///private', secret, 'x'.repeat(2049)])
  assert.equal(sanitizeTraeDiagnosticUrl(value), '');
assert.equal(sanitizeTraeDiagnosticUrl(configured, '/private'), '');
for (const body of [
  '',
  secret,
  'null',
  '[]',
  '{}',
  JSON.stringify({ ok: secret }),
  'x'.repeat(65537),
]) {
  const result = summarizeTraeBridgeHealth({ statusCode: 200, body }, configured);
  assert.equal(result.ok, false);
  safe(result);
}
const healthy = summarizeTraeBridgeHealth(
  {
    statusCode: 200,
    body: JSON.stringify({ ok: true, ts: 123, error: secret, raw: secret, bridgeUrl: configured }),
  },
  configured
);
assert.deepEqual(healthy, {
  ok: true,
  bridgeUrl: 'https://localhost:17861/health',
  statusCode: 200,
  ts: 123,
});
for (const statusCode of [null, -1, 199, 300, 503, 600, '200'])
  assert.equal(
    summarizeTraeBridgeHealth({ statusCode, body: '{"ok":true}' }, configured).ok,
    false
  );
assert.equal(
  summarizeTraeBridgeHealth({ statusCode: 200, body: '{"ok":false}' }, configured).ok,
  false
);

function invoke(handler, chunks, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Readable.from(chunks), extra);
    let status;
    const res = {
      writeHead(code) {
        status = code;
      },
      end(body) {
        resolve({ status, body: JSON.parse(body) });
      },
    };
    try {
      Promise.resolve(handler(req, res)).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}
async function main() {
  const official = require('../lib/proxy/trae-official');
  const debug = require('../lib/proxy/trae-debug-center');
  const originals = [];
  const throwSecret = () => {
    throw new Error(secret);
  };
  for (const [module, names] of [
    [official, ['readTraeStorageSummary']],
    [
      debug,
      [
        'collectLogEvents',
        'currentTraeDebugSettings',
        'getNativeDeepEvents',
        'nativeDebugStatus',
        'runNativeScan',
        'startNativeDeepProbe',
        'stopNativeDeepProbe',
        'updateTraeDebugSettings',
      ],
    ],
  ]) {
    for (const name of names) {
      originals.push([module, name, module[name]]);
      module[name] = throwSecret;
    }
  }
  const previousUrl = process.env.TRAE_BRIDGE_URL;
  process.env.TRAE_BRIDGE_URL = configured;
  try {
    delete require.cache[require.resolve('../lib/proxy/trae-status-handlers')];
    const { createTraeStatusHandlers } = require('../lib/proxy/trae-status-handlers');
    const handlers = createTraeStatusHandlers({
      makeRequest: async () => {
        throw new Error(secret);
      },
    });
    for (const name of [
      'handleLocalTraeStatusRequest',
      'handleLocalTraeBridgeStatusRequest',
      'handleLocalTraeDebugNativeStatusRequest',
      'handleLocalTraeDebugSettingsRequest',
      'handleLocalTraeDebugNativeScanRequest',
      'handleLocalTraeDebugNativeDeepStopRequest',
      'handleLocalTraeDebugEventsRequest',
      'handleLocalTraeDebugNativeDeepEventsRequest',
    ]) {
      const result = await invoke(handlers[name], [], { url: '/', headers: { host: 'localhost' } });
      safe(result);
      assert.ok(result.body.error);
    }
    for (const name of [
      'handleLocalTraeDebugSettingsSaveRequest',
      'handleLocalTraeDebugNativeDeepStartRequest',
      'handleLocalTraeDebugClaudeProcessSelfTestRequest',
    ]) {
      const result = await invoke(handlers[name], [Buffer.from(`{"${secret}`)]);
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'Invalid Trae diagnostic request');
      safe(result);
    }
    for (const name of [
      'handleLocalTraeDebugSettingsSaveRequest',
      'handleLocalTraeDebugNativeDeepStartRequest',
      'handleLocalTraeDebugClaudeProcessSelfTestRequest',
    ]) {
      safe(await invoke(handlers[name], [Buffer.from('{}')]));
    }
    const malformed = createTraeStatusHandlers({
      makeRequest: async () => ({ statusCode: 200, body: secret }),
    });
    const result = await invoke(malformed.handleLocalTraeBridgeStatusRequest, []);
    assert.equal(result.body.ok, false);
    safe(result);
    const { createManagementProfileHandlers } = require('../lib/proxy/handlers/management-profile');
    for (const makeRequest of [
      async () => {
        throw new Error(secret);
      },
      async () => ({ statusCode: 503, body: secret }),
    ]) {
      const profileHandlers = createManagementProfileHandlers({
        sendJson() {},
        makeRequest,
        resolveOfficialCredentials: async () => ({}),
        resolveConfiguredProfile: () => ({}),
        getProfilesSnapshot: () => [],
        getTraeOfficialBridgeUrl: () => configured,
      });
      const failure = await profileHandlers.testTraeOfficialUpstream();
      assert.equal(failure.ok, false);
      safe(failure);
    }
  } finally {
    for (const [module, name, value] of originals) module[name] = value;
    if (previousUrl === undefined) delete process.env.TRAE_BRIDGE_URL;
    else process.env.TRAE_BRIDGE_URL = previousUrl;
  }
}
main()
  .then(() => console.log('trae-diagnostic-safety.test.js passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
