'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildTianxiSuperModeOpenTabMessage,
  buildSetTokenHeader,
  getFreshQoderToken,
  hasFreshEncryptedQoderCache,
  injectTianxiServiceAccountToken,
  refreshTianxiQoderToken,
  sanitizeRefreshState,
  triggerTianxiSuperModeRefresh,
} = require('../lib/proxy/tianxi-token-refresh');

function fakeJwt(exp) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `sat-${encode({ alg: 'none' })}.${encode({ exp })}.signature`;
}

test('Tianxi token refresh detects only non-expired registry qoder tokens', () => {
  const freshToken = fakeJwt(300);
  assert.equal(
    getFreshQoderToken({
      credentials: { qoder_token: freshToken },
      credentialExpiry: { qoder_token: { expired: false } },
    }),
    freshToken
  );
  assert.equal(
    getFreshQoderToken({
      credentials: { qoder_token: fakeJwt(100) },
      credentialExpiry: { qoder_token: { expired: true } },
    }),
    ''
  );
  assert.equal(
    getFreshQoderToken({
      credentials: { qoder_token: '32 139 86 167 49 38 206 68 86' },
      credentialExpiry: { qoder_token: { expired: false } },
    }),
    ''
  );
  assert.equal(
    hasFreshEncryptedQoderCache({
      hasQoderToken: true,
      credentials: {},
      credentialExpiry: { qoder_token: { expired: false } },
    }),
    true
  );
});

test('Tianxi token refresh polls native refresh without exposing token in state', async () => {
  let reads = 0;
  const result = await refreshTianxiQoderToken(
    {
      userId: 'user',
      pollIntervalMs: 1,
      sleep: async () => {},
      readCache({ userId }) {
        assert.equal(userId, 'user');
        reads += 1;
        if (reads < 2) {
          return {
            credentials: { qoder_token: fakeJwt(100) },
            credentialExpiry: { qoder_token: { expired: true } },
          };
        }
        return {
          credentials: { qoder_token: fakeJwt(300) },
          credentialExpiry: { qoder_token: { expired: false } },
        };
      },
      async triggerNativeRefresh() {},
    },
    {}
  );

  assert.equal(result.status, 'refreshed');
  assert.equal(result.token, fakeJwt(300));
  assert.deepEqual(sanitizeRefreshState(result), {
    attempted: true,
    status: 'refreshed',
    source: 'native',
    injected: false,
    errorCode: '',
  });
});

test('Tianxi token refresh treats fresh encrypted registry qoder cache as usable', async () => {
  const result = await refreshTianxiQoderToken(
    {
      userId: 'user',
      readCache() {
        return {
          hasQoderToken: true,
          credentials: {},
          credentialExpiry: { qoder_token: { expired: false } },
        };
      },
      async triggerNativeRefresh() {
        throw new Error('should not refresh when encrypted cache is fresh');
      },
    },
    {}
  );

  assert.equal(result.status, 'fresh_encrypted_cache');
  assert.equal(result.token, undefined);
  assert.deepEqual(sanitizeRefreshState(result), {
    attempted: false,
    status: 'fresh_encrypted_cache',
    source: 'registry',
    injected: false,
    errorCode: '',
  });
});

test('Tianxi token refresh can force native refresh despite fresh encrypted cache', async () => {
  let reads = 0;
  let refreshed = false;
  const result = await refreshTianxiQoderToken(
    {
      userId: 'user',
      force: true,
      pollIntervalMs: 1,
      sleep: async () => {},
      readCache() {
        reads += 1;
        return {
          hasQoderToken: true,
          credentials: {},
          credentialExpiry: {
            qoder_token: { expiresAtMs: refreshed ? 300000 : 200000, expired: false },
          },
        };
      },
      async triggerNativeRefresh() {
        refreshed = true;
      },
    },
    {}
  );

  assert.equal(result.status, 'refreshed_encrypted_cache');
  assert.equal(result.source, 'native');
  assert.equal(result.attempted, true);
  assert.ok(reads >= 2);
});

test('Tianxi super mode UI refresh builds official OpenTab command safely', async () => {
  const message = JSON.parse(buildTianxiSuperModeOpenTabMessage({ source: 'Codex' }));
  assert.equal(message.type, 'OpenTab');
  assert.equal(message.source, 'Codex');
  assert.equal(message.data.id, 'XT_SuperMode');
  assert.deepEqual(JSON.parse(message.data.data), {
    handleType: 2,
    content: 'refresh super mode',
    source: 'Codex',
    tabRouter: 'AIConversationIndex',
  });

  let spawned;
  const result = await triggerTianxiSuperModeRefresh({
    forceWindows: true,
    exePath: 'C:\\Program Files\\Lenovo\\AIAgent\\XLSmartUI.exe',
    existsSync: () => true,
    spawn(file, args, options) {
      spawned = { file, args, options };
      return { pid: 1234, unref() {} };
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.status, 'started');
  assert.equal(spawned.file, 'C:\\Program Files\\Lenovo\\AIAgent\\XLSmartUI.exe');
  assert.equal(spawned.args[0], '--xlcommunicationdata');
  assert.equal(spawned.args[1], '--xlsource=Codex');
  assert.equal(spawned.args[2].startsWith('--xlmessage='), true);
  assert.equal(JSON.stringify(spawned).includes('sat-'), false);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.windowsHide, true);
});

test('Tianxi set_token injection sends control command but sanitizes failures', async () => {
  let sent;
  const ok = await injectTianxiServiceAccountToken(
    {
      async sendControlCommand(command) {
        sent = command;
        return [{ type: 'ack', name: 'set_token' }];
      },
    },
    'secret-token',
    {},
    {
      header: {
        app_id: 'app',
        credentials: { qoder_token: 'do-not-copy' },
        device_id: 'device',
        request_id: 'request',
        session_id: 'session',
        user_id: 'user',
      },
    }
  );
  assert.deepEqual(sent, {
    type: 'set_token',
    header: {
      app_id: 'app',
      device_id: 'device',
      request_id: 'request',
      session_id: 'session',
      user_id: 'user',
    },
    token: 'secret-token',
  });
  assert.equal(ok.injected, true);

  const failed = await injectTianxiServiceAccountToken(
    {
      async sendControlCommand() {
        throw new Error('secret-token');
      },
    },
    'secret-token'
  );
  assert.deepEqual(failed, {
    attempted: true,
    status: 'failed',
    source: 'tac-server',
    errorCode: 'tianxi_set_token_failed',
  });
});

test('Tianxi set_token header keeps only non-secret identity fields', () => {
  assert.deepEqual(
    buildSetTokenHeader({
      app_id: 'app',
      app_version: '1.0',
      credentials: { qoder_token: 'secret' },
      device_id: 'device',
      device_type: 'pc',
      extra: 'ignored',
      resource_id: 'resource',
      role: 'user',
      request_id: 'request',
      session_id: 'session',
      tab_id: 'tab',
      user_id: 'user',
    }),
    {
      app_id: 'app',
      app_version: '1.0',
      device_id: 'device',
      device_type: 'pc',
      resource_id: 'resource',
      role: 'user',
      request_id: 'request',
      session_id: 'session',
      tab_id: 'tab',
      user_id: 'user',
    }
  );
});
