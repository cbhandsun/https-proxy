'use strict';

const DEFAULT_SECONDARY_REFRESH_DELAY_MS = 1200;
const MAX_SECONDARY_REFRESH_DELAY_MS = 5000;

function boundedSecondaryRefreshDelayMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SECONDARY_REFRESH_DELAY_MS;
  return Math.min(MAX_SECONDARY_REFRESH_DELAY_MS, Math.max(0, Math.trunc(parsed)));
}

function delay(ms, setTimeoutFn) {
  const waitMs = boundedSecondaryRefreshDelayMs(ms);
  if (waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeoutFn(resolve, waitMs));
}

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
  secondaryRefreshDelayMs = DEFAULT_SECONDARY_REFRESH_DELAY_MS,
  setTimeoutFn = setTimeout,
} = {}) {
  async function refreshWithCredentialManagerFallback(eventBase, apiKey, routeType) {
    const newToken = await refreshAntigravityOfficialAccessToken({
      reason: 'upstream_auth_failure',
      routeType,
    });
    if (newToken && newToken !== apiKey) return newToken;
    logProxyEvent('google_official_auth_retry', {
      ...eventBase,
      action: 'delayed_credential_manager_refresh',
    });
    await delay(secondaryRefreshDelayMs, setTimeoutFn);
    return refreshAntigravityOfficialAccessToken({
      reason: 'upstream_auth_failure_secondary',
      routeType,
      preferCredentialManager: true,
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
    Promise.resolve(refreshWithCredentialManagerFallback(eventBase, apiKey, routeType))
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
        logProxyEvent('google_official_auth_retry', {
          ...eventBase,
          action: 'refresh_failed',
          errorType: error && (error.code || error.name) ? error.code || error.name : 'error',
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
          errorType: error && (error.code || error.name) ? error.code || error.name : 'error',
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
  });
}

module.exports = {
  DEFAULT_SECONDARY_REFRESH_DELAY_MS,
  MAX_SECONDARY_REFRESH_DELAY_MS,
  boundedSecondaryRefreshDelayMs,
  createGoogleOfficialAuthRetry,
  sendUnavailable,
  shouldRetryGoogleOfficialAuthFailure,
};
