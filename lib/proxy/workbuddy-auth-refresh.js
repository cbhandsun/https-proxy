'use strict';

const {
  isWorkBuddyOfficialLoginToken,
  isUsableWorkBuddyAccessToken,
  readWorkBuddyAuthInfo,
  triggerWorkBuddyOfficialRefresh,
} = require('./workbuddy-official');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_INTERVAL_MS = 750;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenValue(authInfo) {
  return authInfo && typeof authInfo.accessToken === 'string' ? authInfo.accessToken : '';
}

function sanitizedAuthState(authInfo) {
  if (!authInfo) {
    return {
      found: false,
      hasAccessToken: false,
      tokenShapeOk: false,
      hasRefreshToken: false,
      expiresAt: null,
    };
  }
  return {
    found: true,
    hasAccessToken: Boolean(authInfo.accessToken),
    tokenShapeOk: isUsableWorkBuddyAccessToken(authInfo.accessToken),
    tokenKind: authInfo.accessToken
      ? isWorkBuddyOfficialLoginToken(authInfo.accessToken)
        ? 'jwt'
        : 'opaque'
      : null,
    accessTokenEncrypted: authInfo.accessTokenEncrypted === true,
    hasRefreshToken: Boolean(authInfo.refreshToken),
    refreshTokenEncrypted: authInfo.refreshTokenEncrypted === true,
    expiresAt: authInfo.expiresAt || null,
    domain: authInfo.domain || '',
  };
}

function freshEnoughAuth(beforeAuth, candidateAuth) {
  const candidateToken = tokenValue(candidateAuth);
  if (!candidateToken || !isUsableWorkBuddyAccessToken(candidateToken)) return false;
  const beforeToken = tokenValue(beforeAuth);
  if (!beforeToken) return true;
  return candidateToken !== beforeToken;
}

async function refreshWorkBuddyOfficialAuth(options = {}) {
  const readAuthInfo = options.readAuthInfo || readWorkBuddyAuthInfo;
  const triggerRefresh = options.triggerRefresh || triggerWorkBuddyOfficialRefresh;
  const timeoutMs = Math.max(0, Math.trunc(Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
  const intervalMs = Math.max(50, Math.trunc(Number(options.intervalMs ?? DEFAULT_INTERVAL_MS)));
  const beforeAuth = options.beforeAuth === undefined ? readAuthInfo() : options.beforeAuth || null;

  const trigger = triggerRefresh();
  if (!trigger || (trigger.status !== 'started' && trigger.status !== 'already_running')) {
    return {
      status: 'refresh_unavailable',
      triggerStatus: trigger && trigger.status ? trigger.status : 'unknown',
      before: sanitizedAuthState(beforeAuth),
      after: sanitizedAuthState(readAuthInfo()),
    };
  }

  const deadline = Date.now() + timeoutMs;
  let afterAuth = readAuthInfo();
  if (freshEnoughAuth(beforeAuth, afterAuth)) {
    return {
      status: 'refreshed',
      triggerStatus: trigger.status,
      before: sanitizedAuthState(beforeAuth),
      after: sanitizedAuthState(afterAuth),
    };
  }

  while (Date.now() < deadline) {
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    afterAuth = readAuthInfo();
    if (freshEnoughAuth(beforeAuth, afterAuth)) {
      return {
        status: 'refreshed',
        triggerStatus: trigger.status,
        before: sanitizedAuthState(beforeAuth),
        after: sanitizedAuthState(afterAuth),
      };
    }
  }

  return {
    status: 'refresh_timeout',
    triggerStatus: trigger.status,
    before: sanitizedAuthState(beforeAuth),
    after: sanitizedAuthState(afterAuth),
  };
}

function isWorkBuddyUnauthorizedResponse(statusCode, responseBody) {
  if (Number(statusCode) !== 401) return false;
  const text = typeof responseBody === 'string' ? responseBody : '';
  if (!text) return true;
  try {
    const parsed = JSON.parse(text);
    const err = parsed && typeof parsed === 'object' ? parsed.error || parsed : null;
    const message = err && typeof err.message === 'string' ? err.message : '';
    const type = err && typeof err.type === 'string' ? err.type : '';
    return (
      /authorization required|unauthorized|invalid.*token|token.*invalid/i.test(message) ||
      /auth/i.test(type)
    );
  } catch (_err) {
    return /authorization required|unauthorized|<html/i.test(text);
  }
}

module.exports = {
  freshEnoughAuth,
  isWorkBuddyUnauthorizedResponse,
  refreshWorkBuddyOfficialAuth,
  sanitizedAuthState,
};
