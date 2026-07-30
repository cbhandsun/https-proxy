'use strict';

function createManagedWebSearchFallbackPrepared(chatBody, parsed, prepared) {
  if (
    !Array.isArray(chatBody?.__managedWebSearchFallback) ||
    chatBody.__managedWebSearchFallback.length !== 1 ||
    parsed?.__disableManagedWebSearchPromotion === true
  ) {
    return null;
  }
  return {
    ...prepared,
    buffer: Buffer.from(
      JSON.stringify({
        ...parsed,
        tools: chatBody.__managedWebSearchFallback,
        __disableManagedWebSearchPromotion: true,
      })
    ),
  };
}

function isManagedWebSearchFallbackStatus(statusCode) {
  const status = Number(statusCode);
  return (
    Number.isInteger(status) &&
    (status === 400 ||
      status === 404 ||
      status === 409 ||
      status === 422 ||
      status === 429 ||
      status >= 500)
  );
}

function scheduleManagedWebSearchFallback({ proxyRes, fallbackPrepared, clientRes, retry } = {}) {
  if (
    !fallbackPrepared ||
    !proxyRes ||
    !isManagedWebSearchFallbackStatus(proxyRes.statusCode) ||
    typeof retry !== 'function'
  ) {
    return false;
  }
  proxyRes.resume();
  proxyRes.once('end', () => {
    if (clientRes?.headersSent || clientRes?.destroyed) return;
    retry(fallbackPrepared);
  });
  return true;
}

function createManagedWebSearchFallbackContext(
  chatBody,
  parsed,
  prepared,
  retryHandler,
  handlerArguments
) {
  const fallbackPrepared = createManagedWebSearchFallbackPrepared(chatBody, parsed, prepared);
  if (!fallbackPrepared || typeof retryHandler !== 'function') return null;
  const retryArguments = Array.from(handlerArguments || []);
  retryArguments[2] = fallbackPrepared;
  return {
    fallbackPrepared,
    retry() {
      retryHandler(...retryArguments);
    },
  };
}

function retryManagedWebSearch(proxyRes, context, clientRes) {
  return scheduleManagedWebSearchFallback({
    proxyRes,
    fallbackPrepared: context?.fallbackPrepared,
    clientRes,
    retry: context?.retry,
  });
}

function createGeminiRequestHeaders(apiKey, contentLength, userAgent = '') {
  const headers = { 'content-type': 'application/json', 'content-length': contentLength };
  if (userAgent) headers['user-agent'] = userAgent;
  if (apiKey) {
    if (String(apiKey).startsWith('ya29.')) headers.authorization = `Bearer ${apiKey}`;
    else headers['x-goog-api-key'] = apiKey;
  }
  return headers;
}

module.exports = {
  createGeminiRequestHeaders,
  context: createManagedWebSearchFallbackContext,
  createManagedWebSearchFallbackPrepared,
  isManagedWebSearchFallbackStatus,
  headers: createGeminiRequestHeaders,
  retry: retryManagedWebSearch,
  scheduleManagedWebSearchFallback,
};
