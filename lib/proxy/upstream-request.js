function buildOutgoingHeaders(baseHeaders, options) {
  const { requestProtocol, protocolVersion, authMode, apiKey, routed, bodyBuffer } = options || {};
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

  if (routed && bodyBuffer) {
    headers['content-length'] = Buffer.byteLength(bodyBuffer);
  }

  return headers;
}

module.exports = {
  buildOutgoingHeaders,
};
