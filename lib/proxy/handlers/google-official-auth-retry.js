'use strict';
const { googleRuntimeErrorSummary } = require('../google-runtime-errors');

function shouldRetryGoogleOfficialAuthFailure({
  prepared,
  apiKey,
  useCodeAssist,
  proxyRes,
  refreshAntigravityOfficialAccessToken,
}) {
  if (!useCodeAssist || typeof refreshAntigravityOfficialAccessToken !== 'function') {
    return false;
  }
  if (!prepared || prepared.authProvider !== 'google' || prepared.authMode !== 'official-login') {
    return false;
  }
  if (typeof apiKey !== 'string' || !apiKey.startsWith('ya29.')) return false;
  const statusCode = Number(proxyRes && proxyRes.statusCode);
  return statusCode === 401 || statusCode === 403;
}

function createGoogleOfficialAuthRetry({
  logProxyEvent = () => {},
  refreshAntigravityOfficialAccessToken,
} = {}) {
  async function refreshRejectedToken(apiKey, routeType) {
    return refreshAntigravityOfficialAccessToken({
      reason: 'upstream_auth_failure',
      routeType,
      rejectedToken: apiKey,
    });
  }

  return function retryGoogleOfficialAuthOnce({
    clientReq,
    clientRes,
    prepared,
    apiKey,
    useCodeAssist,
    proxyRes,
    routeType,
    upstreamPath,
    startTime,
    sendJsonError,
    logRequestEnd,
    target,
    handler,
  }) {
    if (
      !shouldRetryGoogleOfficialAuthFailure({
        prepared,
        apiKey,
        useCodeAssist,
        proxyRes,
        refreshAntigravityOfficialAccessToken,
      })
    ) {
      return false;
    }
    if (clientReq.__googleOfficialAuthRetryAttempted) return false;
    clientReq.__googleOfficialAuthRetryAttempted = true;
    const statusCode = Number(proxyRes && proxyRes.statusCode) || 0;
    const eventBase = {
      method: clientReq.method,
      path: clientReq.url,
      statusCode,
      routeType,
      profileId: prepared.profile && prepared.profile.id,
    };
    logProxyEvent('google_official_auth_retry', {
      ...eventBase,
      action: 'refresh_antigravity_token',
    });
    Promise.resolve(refreshRejectedToken(apiKey, routeType))
      .then((newToken) => {
        if (!newToken || newToken === apiKey) {
          logProxyEvent('google_official_auth_retry', {
            ...eventBase,
            action: 'no_new_token',
          });
          sendUnavailable({
            clientReq,
            clientRes,
            upstreamPath,
            startTime,
            sendJsonError,
            logRequestEnd,
            statusCode,
            routeType,
          });
          return;
        }
        handler(clientReq, clientRes, prepared, target, newToken, upstreamPath, startTime);
      })
      .catch((error) => {
        const diagnostic = googleRuntimeErrorSummary(error);
        logProxyEvent('google_official_auth_retry', {
          ...eventBase,
          action: 'refresh_failed',
          ...diagnostic,
        });
        sendUnavailable({
          clientReq,
          clientRes,
          upstreamPath,
          startTime,
          sendJsonError,
          logRequestEnd,
          statusCode,
          routeType,
          ...diagnostic,
        });
      });
    return true;
  };
}

function sendUnavailable({
  clientReq,
  clientRes,
  upstreamPath,
  startTime,
  sendJsonError,
  logRequestEnd,
  statusCode,
  routeType,
  errorType = 'ANTIGRAVITY_TOKEN_REFRESH_FAILED',
  stage = 'credential_refresh',
}) {
  sendJsonError(clientRes, 503, {
    error: {
      type: 'google_official_auth_unavailable',
      code: 'ANTIGRAVITY_TOKEN_REFRESH_FAILED',
      message: 'Antigravity login could not provide a fresh Google access token.',
    },
  });
  logRequestEnd(clientReq.method, upstreamPath, startTime, 503, {
    type: 'google_official_auth_unavailable',
    code: 'ANTIGRAVITY_TOKEN_REFRESH_FAILED',
    upstreamStatusCode: statusCode,
    routeType,
    errorType,
    stage,
  });
}

module.exports = {
  createGoogleOfficialAuthRetry,
  sendUnavailable,
  shouldRetryGoogleOfficialAuthFailure,
};
