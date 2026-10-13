'use strict';
const connectionCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);

function describeTraeBridgeFailure(error, configuredUrl, { stream = false } = {}) {
  const source = error && typeof error === 'object' ? error : {};
  const unavailable =
    connectionCodes.has(source.code) ||
    (typeof source.message === 'string' &&
      source.message.length <= 2048 &&
      /timeout|connect ECONNREFUSED/i.test(source.message));
  const statusCode = unavailable
    ? 503
    : Number.isInteger(source.statusCode) && source.statusCode >= 400 && source.statusCode <= 599
      ? source.statusCode
      : 502;
  const bridgeUrl = sanitizeTraeBridgeUrl(configuredUrl, { stream });
  return {
    statusCode,
    type: unavailable ? 'service_unavailable' : 'api_error',
    message: unavailable
      ? 'Trae bridge extension is not reachable. Install/reload https-proxy-manager-trae-bridge in Trae, then retry.'
      : stream
        ? 'Trae bridge stream request failed'
        : 'Trae bridge request failed',
    bridgeUrl,
  };
}
function sanitizeTraeBridgeUrl(configuredUrl, { stream = false } = {}) {
  let bridgeUrl = '';
  if (typeof configuredUrl === 'string' && configuredUrl.length <= 2048) {
    try {
      const url = new URL(configuredUrl);
      if (['http:', 'https:'].includes(url.protocol))
        bridgeUrl = url.origin + (stream ? '/v1/chat/stream' : '/v1/chat');
    } catch {
      bridgeUrl = '';
    }
  }
  return bridgeUrl;
}
function safeTraeDiagnosticError(error, operation = 'request') {
  if (operation === 'input') {
    let message;
    try {
      message = error && typeof error === 'object' ? error.message : undefined;
    } catch {
      message = undefined;
    }
    return typeof message === 'string' && /^Request body too large; max \d+ bytes$/.test(message)
      ? 'Request body too large'
      : 'Invalid Trae diagnostic request';
  }
  const messages = {
    request: 'Trae diagnostic request failed',
    bridge: 'Trae bridge diagnostic request failed',
    command: 'Trae diagnostic command failed',
    scan: 'Trae native scan failed',
    probe: 'Trae native probe failed',
    storage: 'Trae storage could not be read',
    product: 'Trae product information could not be read',
    sqlite: 'Trae SQLite module is unavailable',
  };
  return Object.hasOwn(messages, operation) ? messages[operation] : messages.request;
}
function safeTraeStreamError(error) {
  let message;
  try {
    message = error && typeof error === 'object' ? error.message : error;
  } catch {
    message = undefined;
  }
  return typeof message === 'string' &&
    message.length <= 2048 &&
    /not waiting input|busy|running/i.test(message)
    ? 'Trae bridge is busy'
    : 'Trae bridge stream request failed';
}
function sanitizeTraeDiagnosticUrl(configuredUrl, pathname = '/health') {
  const paths = new Set([
    '/health',
    '/debug/raw-stream',
    '/v1/messages',
    '/claude-desktop/v1/messages',
  ]);
  if (typeof configuredUrl !== 'string' || configuredUrl.length > 2048 || !paths.has(pathname))
    return '';
  try {
    const url = new URL(configuredUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin + pathname : '';
  } catch {
    return '';
  }
}
function summarizeTraeBridgeHealth(response, configuredUrl) {
  const bridgeUrl = sanitizeTraeDiagnosticUrl(configuredUrl);
  const statusCode =
    Number.isInteger(response?.statusCode) &&
    response.statusCode >= 100 &&
    response.statusCode <= 599
      ? response.statusCode
      : null;
  let payload;
  try {
    if (typeof response?.body !== 'string' || Buffer.byteLength(response.body) > 65536)
      throw new TypeError();
    payload = JSON.parse(response.body);
  } catch {
    return { ok: false, bridgeUrl, statusCode, error: 'Invalid Trae bridge health response' };
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof payload.ok !== 'boolean'
  )
    return { ok: false, bridgeUrl, statusCode, error: 'Invalid Trae bridge health response' };
  return {
    ok: statusCode >= 200 && statusCode < 300 && payload.ok,
    bridgeUrl,
    statusCode,
    ...(Number.isSafeInteger(payload.ts) && payload.ts >= 0 ? { ts: payload.ts } : {}),
  };
}
module.exports = {
  describeTraeBridgeFailure,
  sanitizeTraeBridgeUrl,
  safeTraeDiagnosticError,
  safeTraeStreamError,
  sanitizeTraeDiagnosticUrl,
  summarizeTraeBridgeHealth,
};
