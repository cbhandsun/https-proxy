const assert = require('assert');

const {
  attachClientDiagnostics,
  attachPreparedDiagnostics,
  updateClientDiagnostics,
} = require('../lib/proxy/handlers/client-diagnostics');

const prepared = {
  model: 'client-model',
  rewriteTo: 'target-model',
  profile: { id: 'profile-1', protocol: 'openai' },
};

{
  const res = {};
  const body = {
    __hpmDiagnostics: {
      contextBudget: { droppedCount: 1 },
      providerCache: { candidate: true },
    },
  };
  attachClientDiagnostics(res, prepared, 'target-model', '/responses', body, 'openai');
  assert.strictEqual(res.__diagnostics.hpmDiagnostics, body.__hpmDiagnostics);

  updateClientDiagnostics(res, { protocol: 'openai', route: 'stream-route' });
  assert.strictEqual(res.__diagnostics.route, 'stream-route');
  assert.strictEqual(res.__diagnostics.hpmDiagnostics, body.__hpmDiagnostics);
}

{
  const res = {};
  attachPreparedDiagnostics(
    res,
    {
      ...prepared,
      contextManagement: {
        provider: 'anthropic',
        applied: true,
        explicit: false,
        reason: 'native-compaction',
        privateContent: 'must not be copied',
      },
    },
    '/messages',
    {},
    {}
  );
  assert.deepStrictEqual(res.__diagnostics.hpmDiagnostics.providerContext, {
    provider: 'anthropic',
    applied: true,
    explicit: false,
    reason: 'native-compaction',
  });
  assert.equal(JSON.stringify(res.__diagnostics).includes('must not be copied'), false);
}

{
  const res = {};
  attachPreparedDiagnostics(
    res,
    prepared,
    '/responses',
    {},
    {
      missingReason: 'direct-responses-passthrough',
    }
  );
  assert.strictEqual(
    res.__diagnostics.contextDiagnosticsMissingReason,
    'direct-responses-passthrough'
  );
  assert.strictEqual(res.__diagnostics.target, 'target-model');
}

console.log('[client-diagnostics.test] ok');
