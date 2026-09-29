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

test('Tianxi forced refresh rejects an unchanged encrypted registry cache', async () => {
  const result = await refreshTianxiQoderToken(
    {
      userId: 'user',
      force: true,
      attempts: 1,
      readCache: () => ({
        hasQoderToken: true,
        credentials: {},
        credentialExpiry: { qoder_token: { expiresAtMs: 300000, expired: false } },
      }),
      async triggerNativeRefresh() {},
    },
    { now: () => 150000 }
  );
  assert.equal(result.status, 'refresh_no_fresh_token');
});

test('Tianxi refresh waits for AgentCore when registry holds only encrypted bytes', async () => {
  const result = await refreshTianxiQoderToken(
    {
      userId: 'user',
      attempts: 1,
      readCache: () => ({
        hasQoderToken: true,
        credentials: {},
        credentialExpiry: { qoder_token: { expiresAtMs: 300000, expired: false } },
      }),
      readHeader: () => ({
        user_id: 'user',
        credentials: { qoder_token: fakeJwt(100) },
      }),
      async triggerNativeRefresh() {},
    },
    { now: () => 150000 }
  );
  assert.equal(result.status, 'refresh_no_fresh_token');
});

test('Tianxi token refresh accepts a new same-user AgentCore token when registry stays stale', async () => {
  let refreshed = false;
  const stale = {
    hasQoderToken: true,
    credentialExpiry: { qoder_token: { expired: true } },
  };
  const freshToken = fakeJwt(300);
  const result = await refreshTianxiQoderToken(
    {
      userId: 'user',
      readCache: () => stale,
      readHeader: () => ({
        user_id: 'user',
        credentials: { qoder_token: fakeJwt(refreshed ? 300 : 100) },
      }),
      async triggerNativeRefresh() {
        refreshed = true;
      },
    },
    { now: () => 150000 }
  );
  assert.equal(result.status, 'refreshed_agentcore');
  assert.equal(result.source, 'agentcore');
  assert.equal(result.token, freshToken);
  assert.equal(result.header.user_id, 'user');
  assert.equal(result.cache, stale);
  assert.ok(!JSON.stringify(sanitizeRefreshState(result)).includes(freshToken));
});

test('Tianxi token refresh ignores another user and unchanged forced AgentCore token', async () => {
  const freshToken = fakeJwt(300);
  for (const [userId, token] of [
    ['another-user', freshToken],
    ['user', freshToken],
  ]) {
    const result = await refreshTianxiQoderToken(
      {
        userId: 'user',
        force: true,
        previousToken: freshToken,
        attempts: 1,
        readCache: () => ({ credentialExpiry: { qoder_token: { expired: true } } }),
        readHeader: () => ({ user_id: userId, credentials: { qoder_token: token } }),
        async triggerNativeRefresh() {},
      },
      { now: () => 150000 }
    );
    assert.equal(result.status, 'refresh_no_fresh_token');
    assert.equal(result.token, undefined);
  }
});

test('Tianxi super mode UI refresh builds official OpenTab command safely', async () => {
  const message = JSON.parse(buildTianxiSuperModeOpenTabMessage({ source: 'Codex' }));
  assert.equal(message.type, 'OpenTab');
  assert.equal(message.source, 'Codex');
  assert.equal(message.data.id, 'XT_SuperMode');
  assert.deepEqual(JSON.parse(message.data.data), {
    handleType: 2,
    content: '只回答OK',
    source: 'Codex',
    tabRouter: 'AIConversationIndex',
  });

  const spacedMessage = buildTianxiSuperModeOpenTabMessage({
    source: 'Codex',
    content: 'short warmup',
  });
  assert.equal(/\s/.test(spacedMessage), false);
  assert.equal(JSON.parse(JSON.parse(spacedMessage).data.data).content, 'short warmup');

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
  assert.equal(spawned.options.windowsVerbatimArguments, true);
});

test('Tianxi native refresh coalesces concurrent warmups and sanitizes CLI source', async () => {
  let starts = 0;
  let nowMs = 1000;
  const options = {
    forceWindows: true,
    exePath: 'C:\\Program Files\\Lenovo\\AIAgent\\XLSmartUI.exe',
    existsSync: () => true,
    source: 'bad source"',
    userId: 'coalesce-test-user',
    now: () => nowMs,
    spawn(_file, args) {
      starts += 1;
      const message = JSON.parse(args[2].slice('--xlmessage='.length));
      assert.equal(message.source, 'Codex');
      return { pid: starts, unref() {} };
    },
  };
  assert.equal((await triggerTianxiSuperModeRefresh(options)).status, 'started');
  assert.equal((await triggerTianxiSuperModeRefresh(options)).status, 'already_started');
  assert.equal(starts, 1);
  nowMs += 20001;
  assert.equal((await triggerTianxiSuperModeRefresh(options)).status, 'started');
  assert.equal(starts, 2);
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
