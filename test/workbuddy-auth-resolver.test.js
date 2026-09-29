'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAuthResolver } = require('../lib/proxy/auth-resolver');

function makeResolver() {
  return createAuthResolver({
    loadConfig: () => ({ profiles: [] }),
    getProfiles: () => [],
    decryptKey: (value) => value,
    officialLoginProvider: () => 'workbuddy',
    inferOfficialProfileAuthMode: () => 'official-login',
    configuredAuthMode: () => '',
    isRedactedSecret: (value) => !value || value === 'PROXY_MANAGED',
    readGoogleOfficialCredentialFile: () => null,
    refreshGoogleAccessToken: async () => null,
    getFreshAntigravityOfficialAccessToken: async () => null,
    resolveGoogleOfficialLoginPrepared: (_prepared, _profile, _token, resolve) => resolve(null),
    shouldUseChatGPTBackendForOfficialLogin: () => false,
    TRAE_OFFICIAL_TARGET_URL: 'https://trae.example.test',
    readTraeStorageSummary: () => null,
    isGoogleOfficialLoginToken: () => false,
    PROFILES: [],
  });
}

function writeWorkBuddyAuth(localAppData, domain) {
  const authDir = path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(authDir, 'workbuddy-desktop.info'),
    JSON.stringify({
      auth: {
        accessToken: 'opaque-workbuddy-token-from-auth',
        refreshToken: 'refresh-token-must-not-leak',
        domain,
      },
      account: {
        uid: 'uid-from-auth',
        uin: 'uin-from-auth',
      },
    })
  );
}

function writeEncryptedWorkBuddyAuth(localAppData, domain) {
  const authDir = path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(authDir, 'workbuddy-desktop.info'),
    JSON.stringify({
      auth: {
        accessToken: { $wbEncrypted: 1, envelope: 'encrypted-access-token' },
        refreshToken: { $wbEncrypted: 1, envelope: 'encrypted-refresh-token' },
        domain,
      },
      account: {
        uid: 'uid-encrypted',
      },
    })
  );
}

async function main() {
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-workbuddy-auth-'));
  try {
    process.env.LOCALAPPDATA = tempRoot;
    writeWorkBuddyAuth(tempRoot, 'www.workbuddy.cn');

    const result = await makeResolver().resolveOfficialCredentials(
      {
        profile: {
          id: 'workbuddy-official',
          protocol: 'workbuddy',
          targetUrl: 'https://copilot.tencent.com/v2',
          apiKey: 'PROXY_MANAGED',
        },
      },
      {}
    );

    assert.strictEqual(result.authProvider, 'workbuddy');
    assert.strictEqual(result.authMode, 'official-login');
    assert.strictEqual(result.profile.targetUrl, 'https://www.workbuddy.cn/v2');
    assert.strictEqual(result.profile.apiKey, 'opaque-workbuddy-token-from-auth');
    assert.strictEqual(result.profile.uid, 'uid-from-auth');
    assert.ok(!JSON.stringify(result.profile).includes('refresh-token-must-not-leak'));

    const explicit = await makeResolver().resolveOfficialCredentials(
      {
        profile: {
          id: 'workbuddy-official',
          protocol: 'workbuddy',
          targetUrl: 'http://127.0.0.1:49305/v2',
          apiKey: 'PROXY_MANAGED',
        },
      },
      {}
    );
    assert.strictEqual(explicit.profile.targetUrl, 'http://127.0.0.1:49305/v2');

    writeEncryptedWorkBuddyAuth(tempRoot, 'www.workbuddy.cn');
    const encrypted = await makeResolver().resolveOfficialCredentials(
      {
        profile: {
          id: 'workbuddy-official',
          protocol: 'workbuddy',
          targetUrl: 'https://copilot.tencent.com/v2',
          apiKey: 'PROXY_MANAGED',
        },
      },
      {}
    );
    assert.strictEqual(encrypted.profile.targetUrl, 'https://www.workbuddy.cn/v2');
    assert.strictEqual(encrypted.profile.apiKey, null);
    assert.strictEqual(encrypted.workbuddyAuth.accessTokenEncrypted, true);
    assert.ok(!JSON.stringify(encrypted.profile).includes('encrypted-access-token'));

    fs.rmSync(tempRoot, { recursive: true, force: true });
    console.log('[workbuddy-auth-resolver.test] ok');
  } finally {
    if (previousLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = previousLocalAppData;
    }
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
