const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
  createManagementCredentialsHandlers,
  credentialTypeFromRequest,
  hasFreshAccessToken,
} = require('../lib/proxy/handlers/management-credentials');

function emptyReq(url) {
  const req = Readable.from([]);
  req.url = url;
  req.headers = { host: 'localhost' };
  return req;
}

function createRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body == null ? '' : String(body);
    },
  };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function invoke(handler, url) {
  return new Promise((resolve) => {
    const res = createRes();
    const originalEnd = res.end.bind(res);
    res.end = (payload) => {
      originalEnd(payload);
      resolve(res);
    };
    handler(emptyReq(url), res);
  });
}

(async () => {
  assert.strictEqual(
    credentialTypeFromRequest(emptyReq('/v1/local/auth/cli-credentials?type= Google ')),
    'google'
  );
  assert.strictEqual(
    hasFreshAccessToken({ access_token: 'ya29.fresh', expiry_date: 1000000 }, 1),
    true
  );
  assert.strictEqual(
    hasFreshAccessToken({ access_token: 'ya29.expiring', expiry_date: 1000 }, 800),
    false
  );
  assert.strictEqual(hasFreshAccessToken({ access_token: '', expiry_date: 1000 }, 1), false);

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-credentials-home-'));
  try {
    fs.mkdirSync(path.join(tmpHome, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.gemini', 'oauth_creds.json'),
      JSON.stringify({
        access_token: 'google-access',
        expiry_date: 123,
        refresh_token: 'google-refresh',
      })
    );
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'codex-access',
          refresh_token: 'codex-refresh',
        },
      })
    );

    let refreshCalls = 0;
    const handlers = createManagementCredentialsHandlers({
      sendJson,
      protectToken: (token) => `protected:${token}`,
      homeDir: () => tmpHome,
      readAntigravityState: () => ({
        content: {
          access_token: 'agy-access',
          refresh_token: 'agy-refresh',
          expiry_date: 456,
        },
        source: 'antigravity-state',
      }),
      refreshGoogleToken: async (credsPath, content) => {
        refreshCalls += 1;
        assert.strictEqual(credsPath, null);
        assert.strictEqual(content.refresh_token, 'agy-refresh');
        return 'agy-refreshed';
      },
    });

    const google = await invoke(
      handlers.handleLocalCliCredentialsRequest,
      '/v1/local/auth/cli-credentials?type=google'
    );
    assert.strictEqual(google.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(google.body), {
      ok: true,
      protectedToken: 'protected:google-access',
      expiry: 123,
      hasRefreshToken: true,
    });

    const codex = await invoke(
      handlers.handleLocalCliCredentialsRequest,
      '/v1/local/auth/cli-credentials?type=openai'
    );
    assert.strictEqual(codex.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(codex.body), {
      ok: true,
      protectedToken: 'protected:codex-access',
      hasRefreshToken: true,
    });

    const agy = await invoke(
      handlers.handleLocalCliCredentialsRequest,
      '/v1/local/auth/cli-credentials?type=agy'
    );
    assert.strictEqual(agy.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(agy.body), {
      ok: true,
      protectedToken: 'protected:agy-refreshed',
      expiry: 456,
      hasRefreshToken: true,
      source: 'antigravity-state',
    });
    assert.strictEqual(refreshCalls, 1);

    const fallbackHandlers = createManagementCredentialsHandlers({
      sendJson,
      protectToken: (token) => `protected:${token}`,
      homeDir: () => tmpHome,
      readAntigravityState: () => ({
        content: {
          access_token: 'agy-stale',
          refresh_token: 'agy-refresh',
        },
        source: 'antigravity-state',
      }),
      refreshGoogleToken: async () => {
        throw new Error('refresh failed');
      },
    });
    const fallback = await invoke(
      fallbackHandlers.handleLocalCliCredentialsRequest,
      '/v1/local/auth/cli-credentials?type=antigravity'
    );
    assert.strictEqual(fallback.statusCode, 200);
    assert.strictEqual(JSON.parse(fallback.body).protectedToken, 'protected:agy-stale');

    let freshRefreshCalls = 0;
    const freshHandlers = createManagementCredentialsHandlers({
      sendJson,
      protectToken: (token) => `protected:${token}`,
      homeDir: () => tmpHome,
      readAntigravityState: () => ({
        content: {
          access_token: 'agy-fresh',
          refresh_token: 'agy-refresh',
          expiry_date: Date.now() + 3600 * 1000,
        },
        source: 'antigravity-credential-manager',
      }),
      refreshGoogleToken: async () => {
        freshRefreshCalls += 1;
        throw new Error('should not refresh');
      },
    });
    const fresh = await invoke(
      freshHandlers.handleLocalCliCredentialsRequest,
      '/v1/local/auth/cli-credentials?type=agy'
    );
    assert.strictEqual(fresh.statusCode, 200);
    assert.strictEqual(JSON.parse(fresh.body).protectedToken, 'protected:agy-fresh');
    assert.strictEqual(freshRefreshCalls, 0);

    const missing = await invoke(
      handlers.handleLocalCliCredentialsRequest,
      '/v1/local/auth/cli-credentials?type=missing'
    );
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(JSON.parse(missing.body).ok, false);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  console.log('[management-credentials.test] ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
