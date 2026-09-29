'use strict';

const assert = require('assert');

const {
  freshEnoughAuth,
  isWorkBuddyUnauthorizedResponse,
  refreshWorkBuddyOfficialAuth,
  sanitizedAuthState,
} = require('../lib/proxy/workbuddy-auth-refresh');

assert.deepStrictEqual(sanitizedAuthState(null), {
  found: false,
  hasAccessToken: false,
  tokenShapeOk: false,
  hasRefreshToken: false,
  expiresAt: null,
});

const beforeInvalid = {
  accessToken: 'opaque-workbuddy-token-old',
  refreshToken: 'refresh-secret',
  expiresAt: '2026-11-23T02:38:37.861Z',
  domain: 'www.workbuddy.cn',
};
const afterJwt = {
  accessToken: 'eyJ.new-token',
  refreshToken: 'refresh-secret',
  expiresAt: '2026-11-23T03:38:37.861Z',
  domain: 'www.workbuddy.cn',
};

assert.strictEqual(freshEnoughAuth(beforeInvalid, afterJwt), true);
assert.strictEqual(freshEnoughAuth(afterJwt, afterJwt), false);
assert.strictEqual(freshEnoughAuth(afterJwt, { ...afterJwt, accessToken: 'eyJ.other' }), true);
assert.strictEqual(
  freshEnoughAuth(beforeInvalid, { accessToken: 'opaque-workbuddy-token-new' }),
  true
);
assert.strictEqual(freshEnoughAuth(beforeInvalid, { accessToken: '' }), false);

const sanitized = sanitizedAuthState(beforeInvalid);
assert.deepStrictEqual(sanitized, {
  found: true,
  hasAccessToken: true,
  tokenShapeOk: true,
  tokenKind: 'opaque',
  accessTokenEncrypted: false,
  hasRefreshToken: true,
  refreshTokenEncrypted: false,
  expiresAt: '2026-11-23T02:38:37.861Z',
  domain: 'www.workbuddy.cn',
});
assert.ok(!JSON.stringify(sanitized).includes('opaque-workbuddy-token-old'));
assert.ok(!JSON.stringify(sanitized).includes('refresh-secret'));

assert.strictEqual(
  isWorkBuddyUnauthorizedResponse(
    401,
    '<html><head><title>401 Authorization Required</title></head></html>'
  ),
  true
);
assert.strictEqual(
  isWorkBuddyUnauthorizedResponse(
    401,
    JSON.stringify({ error: { type: 'authentication_error', message: 'token invalid' } })
  ),
  true
);
assert.strictEqual(isWorkBuddyUnauthorizedResponse(429, '{"error":{"message":"rate"}}'), false);
assert.strictEqual(isWorkBuddyUnauthorizedResponse(401, '{"error":{"message":"other"}}'), false);

async function main() {
  {
    const states = [afterJwt];
    const result = await refreshWorkBuddyOfficialAuth({
      beforeAuth: beforeInvalid,
      triggerRefresh: () => ({ status: 'started' }),
      readAuthInfo: () => states.shift() || afterJwt,
      timeoutMs: 100,
      intervalMs: 1,
    });
    assert.strictEqual(result.status, 'refreshed');
    assert.strictEqual(result.triggerStatus, 'started');
    assert.strictEqual(result.after.tokenShapeOk, true);
    assert.ok(!JSON.stringify(result).includes('eyJ.new-token'));
  }

  {
    const result = await refreshWorkBuddyOfficialAuth({
      beforeAuth: beforeInvalid,
      triggerRefresh: () => ({ status: 'missing_executable' }),
      readAuthInfo: () => beforeInvalid,
      timeoutMs: 5,
      intervalMs: 1,
    });
    assert.strictEqual(result.status, 'refresh_unavailable');
    assert.strictEqual(result.triggerStatus, 'missing_executable');
  }

  {
    const result = await refreshWorkBuddyOfficialAuth({
      beforeAuth: afterJwt,
      triggerRefresh: () => ({ status: 'started' }),
      readAuthInfo: () => afterJwt,
      timeoutMs: 5,
      intervalMs: 1,
    });
    assert.strictEqual(result.status, 'refresh_timeout');
  }

  console.log('[workbuddy-auth-refresh.test] ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
