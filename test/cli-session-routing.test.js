const assert = require('assert');
const {
  resolveCliSession,
  applyManagedAuthHeaders,
  applyCliSessionModelOverride,
} = require('../lib/proxy/cli-session-routing');

function testResolveCliSessionFromBearerToken() {
  const session = { requestCount: 2, lastUsedAt: 1 };
  const sessions = new Map([['hpm-session-abc123', session]]);

  const resolved = resolveCliSession(
    { authorization: 'Bearer hpm-session-abc123' },
    sessions,
    () => 12345
  );

  assert.strictEqual(resolved.sessionToken, 'hpm-session-abc123');
  assert.strictEqual(resolved.cliSession, session);
  assert.strictEqual(session.lastUsedAt, 12345);
  assert.strictEqual(session.requestCount, 3);
}

function testResolveCliSessionFromApiKeyHeader() {
  const session = {};
  const sessions = new Map([['hpm-session-deadbeef', session]]);

  const resolved = resolveCliSession({ 'x-api-key': 'hpm-session-deadbeef' }, sessions, () => 10);

  assert.strictEqual(resolved.sessionToken, 'hpm-session-deadbeef');
  assert.strictEqual(resolved.cliSession, session);
  assert.strictEqual(session.requestCount, 1);
}

function testResolveCliSessionMissingSessionDoesNotMutate() {
  const resolved = resolveCliSession(
    { authorization: 'Bearer hpm-session-missing' },
    new Map(),
    () => 99
  );

  assert.strictEqual(resolved.sessionToken, 'hpm-session-missing');
  assert.strictEqual(resolved.cliSession, null);
}

function testApplyManagedAuthHeadersOnlyRewritesPresentHeaders() {
  const headers = {
    authorization: 'Bearer hpm-session-abc',
    'x-api-key': 'hpm-session-abc',
    other: 'kept',
  };

  applyManagedAuthHeaders(headers);

  assert.strictEqual(headers.authorization, 'Bearer PROXY_MANAGED');
  assert.strictEqual(headers['x-api-key'], 'PROXY_MANAGED');
  assert.strictEqual(headers['x-goog-api-key'], undefined);
  assert.strictEqual(headers.other, 'kept');
}

function createPrepared() {
  return {
    profile: { id: 'old-profile' },
    route: null,
    model: 'old-model',
    rewriteTo: 'old-model',
    buffer: Buffer.from(JSON.stringify({ model: 'old-model', messages: [{ content: 'hi' }] })),
  };
}

function testApplyCliSessionModelOverrideUpdatesRouteAndJsonBody() {
  const prepared = createPrepared();
  const route = { from: '*', to: 'provider-model' };
  const profile = { id: 'target-profile' };

  applyCliSessionModelOverride(prepared, {
    cliSession: { modelOverride: 'ui-model' },
    requestBuffer: prepared.buffer,
    requestEncoding: '',
    resolveRoute(model, routes, profiles, activeProfile) {
      assert.strictEqual(model, 'ui-model');
      assert.deepStrictEqual(routes, ['route']);
      assert.deepStrictEqual(profiles, ['profile']);
      assert.strictEqual(activeProfile, 'active');
      return { route, profile };
    },
    modelRoutes: ['route'],
    profiles: ['profile'],
    activeProfile: 'active',
  });

  assert.strictEqual(prepared.profile, profile);
  assert.strictEqual(prepared.route, route);
  assert.strictEqual(prepared.model, 'ui-model');
  assert.strictEqual(prepared.routed, true);
  assert.strictEqual(prepared.rewriteTo, 'provider-model');
  assert.strictEqual(JSON.parse(prepared.buffer.toString('utf8')).model, 'provider-model');
}

function testApplyCliSessionModelOverrideKeepsBodyForEncodedRequests() {
  const prepared = createPrepared();
  const originalBuffer = prepared.buffer;

  applyCliSessionModelOverride(prepared, {
    cliSession: { modelOverride: 'ui-model' },
    requestBuffer: originalBuffer,
    requestEncoding: 'gzip',
    resolveRoute() {
      return { route: { to: '*' }, profile: { id: 'target-profile' } };
    },
  });

  assert.strictEqual(prepared.rewriteTo, 'ui-model');
  assert.strictEqual(prepared.buffer, originalBuffer);
}

function testApplyCliSessionModelOverrideIgnoresInvalidJsonBody() {
  const prepared = {
    profile: {},
    route: null,
    buffer: Buffer.from('{'),
  };
  const originalBuffer = prepared.buffer;

  applyCliSessionModelOverride(prepared, {
    cliSession: { modelOverride: 'ui-model' },
    requestBuffer: originalBuffer,
    requestEncoding: '',
    resolveRoute() {
      return { route: { to: 'provider-model' }, profile: { id: 'target-profile' } };
    },
  });

  assert.strictEqual(prepared.rewriteTo, 'provider-model');
  assert.strictEqual(prepared.buffer, originalBuffer);
}

function testApplyCliSessionModelOverrideNoSessionIsNoop() {
  const prepared = createPrepared();
  const originalBuffer = prepared.buffer;

  const result = applyCliSessionModelOverride(prepared, {
    cliSession: null,
    requestBuffer: originalBuffer,
    resolveRoute() {
      throw new Error('should not resolve route');
    },
  });

  assert.strictEqual(result, prepared);
  assert.strictEqual(prepared.buffer, originalBuffer);
  assert.strictEqual(prepared.model, 'old-model');
}

testResolveCliSessionFromBearerToken();
testResolveCliSessionFromApiKeyHeader();
testResolveCliSessionMissingSessionDoesNotMutate();
testApplyManagedAuthHeadersOnlyRewritesPresentHeaders();
testApplyCliSessionModelOverrideUpdatesRouteAndJsonBody();
testApplyCliSessionModelOverrideKeepsBodyForEncodedRequests();
testApplyCliSessionModelOverrideIgnoresInvalidJsonBody();
testApplyCliSessionModelOverrideNoSessionIsNoop();

console.log('cli-session-routing tests passed');
