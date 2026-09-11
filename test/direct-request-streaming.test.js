const assert = require('assert');
const { isDirectStreamingEligible } = require('../lib/proxy/direct-request-streaming');

const eligible = {
  appSettings: { streamDirectRequestBodies: true },
  auditEnabled: false,
  cliSession: null,
  contentLength: { present: true, exceeds: false },
  entryAuth: { enabled: true, profileAllowed: true },
  entryPath: 'chat',
  modelRoutes: [],
  profile: { protocol: 'openai', targetUrl: 'https://api.example.test/v1' },
  requestEncoding: '',
};
assert.strictEqual(isDirectStreamingEligible(eligible), true);
assert.strictEqual(isDirectStreamingEligible({ ...eligible, auditEnabled: true }), false);
assert.strictEqual(isDirectStreamingEligible({ ...eligible, modelRoutes: [{}] }), false);
assert.strictEqual(
  isDirectStreamingEligible({
    ...eligible,
    profile: { protocol: 'openai', targetUrl: 'https://api.example.test/backend-api/codex' },
  }),
  false
);
assert.strictEqual(isDirectStreamingEligible({ ...eligible, entryPath: 'responses' }), false);

console.log('[direct-request-streaming.test] ok');
