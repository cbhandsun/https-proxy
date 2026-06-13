const SESSION_TOKEN_PATTERN = /^(?:Bearer\s+)?(hpm-session-\w+)/i;
const MANAGED_AUTH_VALUE = 'PROXY_MANAGED';

function resolveCliSession(headers, cliSessions, now = Date.now) {
  const source =
    headers['authorization'] ||
    headers['x-api-key'] ||
    headers['x-goog-api-key'] ||
    headers['api-key'];
  if (!source || !cliSessions || typeof cliSessions.get !== 'function') {
    return { sessionToken: '', cliSession: null };
  }

  const match = String(source).match(SESSION_TOKEN_PATTERN);
  if (!match) return { sessionToken: '', cliSession: null };

  const sessionToken = match[1];
  const cliSession = cliSessions.get(sessionToken) || null;
  if (!cliSession) return { sessionToken, cliSession: null };

  cliSession.lastUsedAt = now();
  cliSession.requestCount = (cliSession.requestCount || 0) + 1;
  return { sessionToken, cliSession };
}

function applyManagedAuthHeaders(headers) {
  if (headers['authorization']) headers['authorization'] = 'Bearer ' + MANAGED_AUTH_VALUE;
  if (headers['x-api-key']) headers['x-api-key'] = MANAGED_AUTH_VALUE;
  if (headers['x-goog-api-key']) headers['x-goog-api-key'] = MANAGED_AUTH_VALUE;
  if (headers['api-key']) headers['api-key'] = MANAGED_AUTH_VALUE;
}

function applyCliSessionModelOverride(initialPrepared, options) {
  const {
    cliSession,
    requestBuffer,
    requestEncoding,
    resolveRoute,
    modelRoutes,
    profiles,
    activeProfile,
  } = options || {};
  if (!cliSession || !cliSession.modelOverride) return initialPrepared;

  const targetModel = cliSession.modelOverride;
  const resolved = resolveRoute(targetModel, modelRoutes, profiles, activeProfile);

  initialPrepared.profile = resolved.profile;
  initialPrepared.route = resolved.route;
  initialPrepared.model = targetModel;
  initialPrepared.routed = true;
  initialPrepared.rewriteTo =
    resolved.route && resolved.route.to && resolved.route.to !== '*'
      ? resolved.route.to
      : targetModel;

  if (!requestEncoding && requestBuffer && requestBuffer.length > 0) {
    try {
      const parsed = JSON.parse(requestBuffer.toString('utf8'));
      if (parsed) {
        parsed.model = initialPrepared.rewriteTo;
        initialPrepared.buffer = Buffer.from(JSON.stringify(parsed));
      }
    } catch (e) {}
  }

  return initialPrepared;
}

module.exports = {
  MANAGED_AUTH_VALUE,
  resolveCliSession,
  applyManagedAuthHeaders,
  applyCliSessionModelOverride,
};
