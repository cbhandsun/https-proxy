'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AbortController } = globalThis;
const {
  createTacServerTransport,
  decodeLogdatBuffer,
  discoverTianxiTacServerWsUrls,
  ensureTianxiTacServer,
  extractHeaderFromSendMessageLine,
  extractLatestAgentCoreHeader,
  getJwtExpiryMs,
  inspectTianxiCredentialExpiry,
  isPlaintextServiceAccountToken,
  parseEpochMs,
  readTianxiRegistryCredentialCache,
  readTianxiRegistryCredentialCacheWithFallback,
} = require('../lib/proxy/tianxi-agentcore-local');

function fakeJwt(exp) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `sat-${encode({ alg: 'none' })}.${encode({ exp })}.signature`;
}

test('Tianxi AgentCore log helpers decode logdat and extract safe header fields', () => {
  const text =
    '2026 SENDMESSAGE:' +
    JSON.stringify({
      header: {
        app_id: 'app',
        app_version: '1.0',
        credentials: { type: 'official-login' },
        device_id: 'device',
        device_type: 'pc',
        request_id: 'request',
        session_id: 'session',
        tab_id: 'tab',
        user_id: 'user',
      },
      data: { text: 'SECRET prompt' },
    });
  const encoded = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    Buffer.from(text, 'utf8').map((byte) => byte ^ 0xff),
  ]);
  assert.ok(decodeLogdatBuffer(encoded).includes('SENDMESSAGE'));
  const header = extractHeaderFromSendMessageLine(text);
  assert.equal(header.user_id, 'user');
  assert.equal(header.device_id, 'device');
  assert.equal(header.app_id, 'app');
  assert.equal(header.request_id, undefined);
  assert.equal(JSON.stringify(header).includes('SECRET'), false);
  assert.deepEqual(extractLatestAgentCoreHeader(text).credentials, { type: 'official-login' });
});

test('Tianxi tac-server transport sends a frame and resolves terminal frames', async () => {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      setImmediate(() => this.listeners.open?.({}));
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send(value) {
      this.sent = value;
      this.listeners.message?.({
        data: JSON.stringify({ type: 'task_output', data: { content: 'ok' } }),
      });
      this.listeners.message?.({
        data: JSON.stringify({ type: 'task_status', data: { status: 'COMPLETED' } }),
      });
    }
    close() {
      this.closed = true;
    }
  }
  const transport = createTacServerTransport({
    WebSocketImpl: FakeWebSocket,
    url: 'ws://unit',
    autoStart: false,
  });
  const streamed = [];
  const frames = await transport.sendQuery(
    { type: 'query', data: { text: 'hello' } },
    { onFrame: (frame) => streamed.push(frame.type) }
  );
  assert.equal(frames[0].data.content, 'ok');
  assert.equal(frames[1].data.status, 'COMPLETED');
  assert.deepEqual(streamed, ['task_output', 'task_status']);
});

test('Tianxi tac-server transport resolves terminal frames wrapped in notify envelopes', async () => {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      setImmediate(() => this.listeners.open?.({}));
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send() {
      this.listeners.message?.({
        data: JSON.stringify({
          type: 'notify',
          data: { type: 'task_output', data: { content: 'wrapped-ok' } },
        }),
      });
      this.listeners.message?.({
        data: JSON.stringify({
          type: 'notify',
          data: { type: 'task_status', data: { status: 'COMPLETED' } },
        }),
      });
    }
    close() {
      this.closed = true;
    }
  }
  const transport = createTacServerTransport({
    WebSocketImpl: FakeWebSocket,
    url: 'ws://unit',
    autoStart: false,
  });
  const frames = await transport.sendQuery(
    { type: 'query', data: { text: 'hello' } },
    { idleTimeoutMs: 10 }
  );
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, 'notify');
  assert.equal(frames[1].data.type, 'task_status');
});

test('Tianxi tac-server transport closes its socket when cancelled', async () => {
  let socket;
  class FakeWebSocket {
    constructor() {
      socket = this;
      this.listeners = {};
      setImmediate(() => this.listeners.open?.({}));
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send() {}
    close() {
      this.closed = true;
    }
  }
  const transport = createTacServerTransport({
    WebSocketImpl: FakeWebSocket,
    url: 'ws://unit',
    autoStart: false,
  });
  const controller = new AbortController();
  const pending = transport.sendQuery({ type: 'query' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /tianxi_tac_server_aborted/);
  assert.equal(socket.closed, true);
});

test('Tianxi tac-server query rejects partial frames after content idle', async () => {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      setImmediate(() => this.listeners.open?.({}));
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send() {
      this.listeners.message?.({
        data: JSON.stringify({ type: 'task_output', data: { content: 'partial-ok' } }),
      });
    }
    close() {
      this.closed = true;
    }
  }
  const transport = createTacServerTransport({
    WebSocketImpl: FakeWebSocket,
    url: 'ws://unit',
    autoStart: false,
  });
  await assert.rejects(
    transport.sendQuery({ type: 'query', data: { text: 'hello' } }, { idleTimeoutMs: 10 }),
    /tianxi_tac_server_idle_timeout/
  );
  const partialFrames = await transport.sendQuery(
    { type: 'query', data: { text: 'hello' } },
    { allowPartialOnIdle: true, idleTimeoutMs: 10 }
  );
  assert.equal(partialFrames[0].data.content, 'partial-ok');
  const controlFrames = await transport.sendControlCommand(
    { type: 'control' },
    { idleTimeoutMs: 10 }
  );
  assert.equal(controlFrames[0].data.content, 'partial-ok');
});

test('Tianxi tac-server query rejects a socket close before terminal status', async () => {
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      setImmediate(() => this.listeners.open?.({}));
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send() {
      this.listeners.message?.({
        data: JSON.stringify({ type: 'task_status', data: { status: 'WORKING' } }),
      });
      this.listeners.close?.({});
    }
    close() {}
  }
  const transport = createTacServerTransport({
    WebSocketImpl: FakeWebSocket,
    url: 'ws://unit',
    autoStart: false,
  });
  await assert.rejects(transport.sendQuery({ type: 'query' }), /tianxi_tac_server_incomplete/);
});

test('Tianxi tac-server transport prefers discovered active tac-server port', async () => {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      FakeWebSocket.urls.push(url);
      this.listeners = {};
      setImmediate(() => this.listeners.open?.({}));
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send() {
      this.listeners.message?.({
        data: JSON.stringify({ type: 'task_status', data: { status: 'COMPLETED' } }),
      });
    }
    close() {}
  }
  FakeWebSocket.urls = [];
  const ensured = [];
  const transport = createTacServerTransport({
    WebSocketImpl: FakeWebSocket,
    url: 'ws://127.0.0.1:63982/ws/connect',
    discoverWsUrls: () => ['ws://127.0.0.1:63269/ws/connect'],
    ensureServer: (options) => ensured.push(options.url),
  });
  await transport.sendQuery({ type: 'query' });
  assert.deepEqual(FakeWebSocket.urls, ['ws://127.0.0.1:63269/ws/connect']);
  assert.deepEqual(ensured, ['ws://127.0.0.1:63269/ws/connect']);
});

test('Tianxi tac-server discovery maps listening tac-server ports to websocket urls', () => {
  const urls = discoverTianxiTacServerWsUrls({
    forceWindows: true,
    execFileSync(command) {
      if (command === 'tasklist') return '';
      if (command === 'powershell.exe') return '20776\r\n';
      if (command === 'netstat') {
        return [
          '  TCP    0.0.0.0:63269          0.0.0.0:0              LISTENING       20776',
          '  TCP    0.0.0.0:63982          0.0.0.0:0              LISTENING       20776',
          '  TCP    0.0.0.0:63269          0.0.0.0:0              LISTENING       20776',
          '  TCP    0.0.0.0:5000           0.0.0.0:0              LISTENING       12345',
        ].join('\r\n');
      }
      return '';
    },
  });
  assert.deepEqual(urls, ['ws://127.0.0.1:63269/ws/connect', 'ws://127.0.0.1:63982/ws/connect']);
});

test('Tianxi tac-server discovery prefers filtered tasklist before PowerShell fallback', () => {
  const commands = [];
  const urls = discoverTianxiTacServerWsUrls({
    forceWindows: true,
    execFileSync(command) {
      commands.push(command);
      if (command === 'tasklist') return '"tac-server.exe","20776","Console","1","37,180 K"\r\n';
      if (command === 'powershell.exe') throw new Error('unexpected powershell fallback');
      if (command === 'netstat') {
        return [
          '  TCP    0.0.0.0:63269          0.0.0.0:0              LISTENING       20776',
          '  TCP    127.0.0.1:62422        127.0.0.1:63269        ESTABLISHED     5464',
        ].join('\r\n');
      }
      return '';
    },
  });
  assert.deepEqual(urls, ['ws://127.0.0.1:63269/ws/connect']);
  assert.deepEqual(commands, ['tasklist', 'netstat']);
});

test('Tianxi tac-server ensure starts qoder daemon when port is not listening', () => {
  let spawned;
  const result = ensureTianxiTacServer({
    forceWindows: true,
    url: 'ws://127.0.0.1:63982/ws/connect',
    exePath: 'C:\\Program Files\\Lenovo\\AIAgent\\Modules\\AgentServer\\tac-server.exe',
    existsSync: () => true,
    isListening: () => false,
    waitMs: 1,
    spawn(file, args, options) {
      spawned = { file, args, options };
      return { pid: 1234, unref() {} };
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.status, 'started');
  assert.equal(result.port, 63982);
  assert.equal(spawned.args.includes('-backend'), true);
  assert.equal(spawned.args.includes('qoder'), true);
  assert.equal(spawned.args.includes('-port'), true);
  assert.equal(spawned.args.includes('63982'), true);
  assert.equal(spawned.options.windowsHide, true);
});

test('Tianxi credential expiry helper decodes qoder and user token expirations safely', () => {
  const qoderToken = fakeJwt(100);
  const userToken = fakeJwt(300);
  assert.equal(getJwtExpiryMs(qoderToken), 100000);

  const summary = inspectTianxiCredentialExpiry(
    {
      qoder_token: qoderToken,
      tx_token: userToken,
    },
    { nowMs: 150000, skewMs: 0 }
  );
  assert.equal(summary.qoder_token.expired, true);
  assert.equal(summary.tx_token.expired, false);
  assert.equal(JSON.stringify(summary).includes(qoderToken), false);
});

test('Tianxi registry credential cache reads only token presence and expiry metadata', () => {
  const qoderToken = fakeJwt(300);
  const cache = readTianxiRegistryCredentialCache({
    userId: 'user-1',
    forceWindows: true,
    now: () => 150000,
    registryValues: {
      'HKCU:\\Software\\Lenovo\\AIAgent\\user-1': {
        qoder_vpc_token: qoderToken,
        qoder_vpc_expires_after: '300',
        token4_0: 'opaque-login-token',
        expires4_0after: '100',
      },
    },
  });
  assert.equal(parseEpochMs('300'), 300000);
  assert.equal(cache.available, true);
  assert.equal(cache.keyScope, 'account');
  assert.equal(cache.hasQoderToken, true);
  assert.equal(cache.hasLoginToken, true);
  assert.equal(cache.credentials.qoder_token, qoderToken);
  assert.equal(cache.credentialExpiry.qoder_token.expired, false);
  assert.equal(cache.credentialExpiry.tianxi_login_token.expired, true);
  assert.equal(JSON.stringify(cache).includes('opaque-login-token'), false);
});

test('Tianxi registry credential cache falls back to root login metadata when account cache is empty', () => {
  const cache = readTianxiRegistryCredentialCacheWithFallback({
    userId: 'user-1',
    forceWindows: true,
    now: () => 150000,
    registryValues: {
      'HKCU:\\Software\\Lenovo\\AIAgent': {
        token4_0: 'opaque-root-login-token',
        expires4_0after: '300',
      },
    },
  });
  assert.equal(cache.available, true);
  assert.equal(cache.keyScope, 'root-fallback');
  assert.equal(cache.hasLoginToken, true);
  assert.equal(cache.credentialExpiry.tianxi_login_token.expired, false);
  assert.equal(JSON.stringify(cache).includes('opaque-root-login-token'), false);
});

test('Tianxi registry credential cache does not expose encrypted qoder token bytes as credentials', () => {
  const cache = readTianxiRegistryCredentialCache({
    userId: 'user-1',
    forceWindows: true,
    now: () => 150000,
    registryValues: {
      'HKCU:\\Software\\Lenovo\\AIAgent\\user-1': {
        qoder_vpc_token: '32 139 86 167 49 38 206 68 86 136 129 17',
        qoder_vpc_expires_after: '300',
      },
    },
  });
  assert.equal(cache.hasQoderToken, true);
  assert.equal(cache.credentials.qoder_token, undefined);
  assert.equal(cache.credentialExpiry.qoder_token.expired, false);
  assert.equal(isPlaintextServiceAccountToken('32 139 86 167 49 38 206 68 86'), false);
  assert.equal(isPlaintextServiceAccountToken(fakeJwt(300)), true);
});
