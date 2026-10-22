function buildOutgoingHeaders(baseHeaders, options) {
  const {
    requestProtocol,
    protocolVersion,
    authMode,
    authProvider,
    uid,
    profile,
    apiKey,
    routed,
    bodyBuffer,
    bodyChanged,
  } = options || {};
  const headers = { ...(baseHeaders || {}) };

  if (requestProtocol === 'claude' && protocolVersion) {
    headers['anthropic-version'] = String(protocolVersion);
  }

  const managesAuth = Boolean(apiKey) || authMode === 'official-login';
  if (managesAuth) {
    delete headers['authorization'];
    delete headers['api-key'];
    delete headers['x-api-key'];
    delete headers['x-goog-api-key'];
    if (apiKey) {
      if (requestProtocol === 'claude') {
        headers['x-api-key'] = apiKey;
      } else if (requestProtocol === 'gemini') {
        if (String(apiKey).startsWith('ya29.')) {
          headers['authorization'] = 'Bearer ' + apiKey;
        } else {
          headers['x-goog-api-key'] = apiKey;
        }
      } else {
        headers['authorization'] = 'Bearer ' + apiKey;
        headers['api-key'] = apiKey;
      }
    }
  }

  if (
    authProvider === 'workbuddy' ||
    requestProtocol === 'workbuddy' ||
    (profile && profile.protocol === 'workbuddy')
  ) {
    const effectiveUid = uid || (profile && profile.uid);
    const { buildWorkBuddyDesktopHeaders } = require('./workbuddy-official');
    const desktopHeaders = buildWorkBuddyDesktopHeaders({ uid: effectiveUid });
    for (const [k, v] of Object.entries(desktopHeaders)) {
      if (!headers[k]) {
        headers[k] = v;
      }
    }
  }

  if ((routed || bodyChanged) && bodyBuffer) {
    headers['content-length'] = Buffer.byteLength(bodyBuffer);
    if (bodyChanged) {
      delete headers['content-encoding'];
    }
  }

  const rewriteTo = options && options.rewriteTo;
  if (rewriteTo && rewriteTo !== '-' && rewriteTo !== '*') {
    if (headers['x-codex-routing-hint']) {
      headers['x-codex-routing-hint'] = headers['x-codex-routing-hint'].replace(
        /(model=)[^\s;,]+/i,
        `$1${rewriteTo}`
      );
    }
    if (headers['x-codex-turn-metadata']) {
      try {
        const meta = JSON.parse(headers['x-codex-turn-metadata']);
        if (meta && typeof meta === 'object') {
          meta.model = rewriteTo;
          headers['x-codex-turn-metadata'] = JSON.stringify(meta);
        }
      } catch (_) {}
    }
  }

  return headers;
}

module.exports = {
  buildOutgoingHeaders,
};
