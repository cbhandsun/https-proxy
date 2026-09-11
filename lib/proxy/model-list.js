const { isGoogleOfficialLoginToken } = require('./google-official');

function getModelsUrl(targetUrl, protocol) {
  const base = new URL(targetUrl);
  const pathname = base.pathname.replace(/\/$/, '');

  if (base.hostname === 'chatgpt.com' && pathname.includes('/backend-api')) {
    return new URL('/backend-api/models', base.origin).toString();
  }

  if (protocol === 'gemini') {
    return new URL('/v1beta/models?pageSize=1000', base.origin).toString();
  }

  if (
    protocol === 'claude' &&
    base.hostname === 'api.deepseek.com' &&
    (pathname === '/anthropic' || pathname.startsWith('/anthropic/'))
  ) {
    return new URL('/models?limit=1000', base.origin).toString();
  }

  const hasV1 = pathname.endsWith('/v1') || pathname.includes('/v1/');
  const suffix = hasV1 ? '/models?limit=1000' : '/v1/models?limit=1000';
  return new URL(pathname + suffix, base.origin).toString();
}

function buildModelListRequest(targetUrl, protocol, apiKey) {
  let requestUrl = getModelsUrl(targetUrl, protocol);
  const headers = {
    accept: 'application/json',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  if (apiKey) {
    if (protocol === 'claude') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (protocol === 'gemini') {
      if (isGoogleOfficialLoginToken(apiKey)) {
        headers['authorization'] = 'Bearer ' + apiKey;
      } else {
        const urlObj = new URL(requestUrl);
        urlObj.searchParams.set('key', apiKey);
        requestUrl = urlObj.toString();
      }
    } else {
      headers['authorization'] = 'Bearer ' + apiKey;
    }
  }

  return {
    requestUrl,
    method: 'GET',
    headers,
  };
}

module.exports = {
  getModelsUrl,
  buildModelListRequest,
};
