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
    discoverWsUrls: () => [],
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
    discoverWsUrls: () => [],
  });
  const frames = await transport.sendQuery(
    { type: 'query', data: { text: 'hello' } },
    { idleTimeoutMs: 10 }
  );
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, 'notify');
  assert.equal(frames[1].data.type, 'task_status');
});

test('Tianxi query ACK acknowledges acceptance, not completion; control ACK still completes', async () => {
  let closedOnAck;
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      setImmediate(() => this.listeners.open?.({}));
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send(value) {
      const command = JSON.parse(value);
      this.listeners.message({ data: JSON.stringify({ type: 'ack', name: command.type }) });
      closedOnAck = this.closed === true;
      setImmediate(() => {
        if (this.closed) return;
        this.listeners.message({
          data: JSON.stringify({ type: 'task_status', data: { status: 'COMPLETED' } }),
        });
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
    discoverWsUrls: () => [],
  });
  const frames = await transport.sendQuery({ type: 'query' }, { idleTimeoutMs: 100 });
  assert.equal(closedOnAck, false);
  assert.equal(frames.at(-1).data.status, 'COMPLETED');
  const controlFrames = await transport.sendControlCommand({ type: 'control' });
  assert.equal(closedOnAck, true);
  assert.equal(controlFrames.length, 1);
});

test('Native query silence emits waiting notices but preserves terminal, abort and close boundaries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const outcome of ['complete', 'abort', 'close', 'observer_error']) {
    let socket;
    let ready;
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    class FakeWebSocket {
      constructor() {
        socket = this;
        this.listeners = {};
        setImmediate(() => this.listeners.open?.({}));
      }
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      }
      send() {
        this.emit({ type: 'task_status', data: { status: 'WORKING' } });
        ready();
      }
      emit(frame) {
        this.listeners.message({ data: JSON.stringify(frame) });
      }
      close() {
        this.closed = true;
      }
    }
    const transport = createTacServerTransport({
      WebSocketImpl: FakeWebSocket,
      url: 'ws://unit',
      autoStart: false,
      discoverWsUrls: () => [],
    });
    const controller = new AbortController();
    const notices = [];
    let activityCount = 0;
    let settled = false;
    const pending = transport.sendQuery(
      { type: 'query' },
      {
        signal: controller.signal,
        onActivity() {
          activityCount += 1;
        },
        idleTimeoutMs: 10,
        waitForTerminalOnIdle: true,
        onFrame(frame) {
          if (frame.type !== 'task_output') return;
          notices.push(frame);
          if (outcome === 'observer_error') throw new Error('observer_failed');
        },
      }
    );
    const observed = pending.then(
      (frames) => {
        settled = true;
        return { frames };
      },
      (error) => {
        settled = true;
        return { error };
      }
    );
    await started;
    t.mock.timers.tick(10);
    await Promise.resolve();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].data.content_type, 'summary');
    assert.equal(activityCount, 0);
    if (outcome !== 'observer_error') {
      assert.equal(settled, false);
      assert.notEqual(socket.closed, true);
      t.mock.timers.tick(10);
      assert.equal(notices.length, 2);
    }
    if (outcome === 'complete') socket.emit({ type: 'task_status', data: { status: 'COMPLETED' } });
    if (outcome === 'abort') controller.abort();
    if (outcome === 'close') socket.listeners.close();
    const result = await observed;
    if (outcome === 'complete') assert.equal(result.frames.at(-1).data.status, 'COMPLETED');
    else
      assert.match(
        result.error.message,
        /tianxi_tac_server_aborted|tianxi_tac_server_incomplete|observer_failed/
      );
    assert.equal(socket.closed, true);
    const count = notices.length;
    t.mock.timers.tick(100);
    assert.equal(notices.length, count);
  }
});

test('Native message activity excludes invalid/status frames and stops after settlement', async () => {
  let socket;
  class FakeWebSocket {
    constructor() {
      socket = this;
      this.listeners = {};
      setImmediate(() => this.listeners.open());
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send() {
      for (const data of ['invalid', 'null', '[]', '1', '"text"']) {
        this.listeners.message({ data });
      }
      for (const type of [
        'ack',
        'task_status',
        'act_exec',
        'act_resp',
        'risk_exec',
        'task_output',
      ]) {
        this.emit({ type, data: { status: 'WORKING', content: 'unit' } });
      }
      this.emit({ type: 'notify', data: { type: 'task_output', data: { content: 'unit' } } });
      this.emit({ type: 'task_status', data: { status: 'COMPLETED' } });
      this.emit({ type: 'task_output', data: { content: 'late' } });
    }
    emit(frame) {
      this.listeners.message({ data: JSON.stringify(frame) });
    }
    close() {
      this.closed = true;
    }
  }
  const transport = createTacServerTransport({
    WebSocketImpl: FakeWebSocket,
    autoStart: false,
    discoverWsUrls: () => [],
  });
  let activityCount = 0;
  const observed = [];
  const frames = await transport.sendQuery(
    { type: 'query' },
    {
      onActivity() {
        activityCount += 1;
      },
      onFrame(frame) {
        observed.push(frame);
      },
    }
  );
  assert.equal(activityCount, 5);
  assert.equal(frames.length, 8);
  assert.deepEqual(observed, frames);
  assert.equal(socket.closed, true);
});

test('Native message observer failures reject and clean up without processing late frames', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const callback of ['onFrame', 'onActivity']) {
    let socket;
    class FakeWebSocket {
      constructor() {
        socket = this;
        this.listeners = {};
        setImmediate(() => this.listeners.open());
      }
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      }
      send() {
        this.listeners.message({
          data: JSON.stringify({ type: 'task_status', data: { status: 'WORKING' } }),
        });
        this.listeners.message({
          data: JSON.stringify({ type: 'task_output', data: { content: 'unit' } }),
        });
        this.listeners.message({
          data: JSON.stringify({ type: 'task_output', data: { content: 'late' } }),
        });
      }
      close() {
        this.closed = true;
      }
    }
    let calls = 0;
    const transport = createTacServerTransport({
      WebSocketImpl: FakeWebSocket,
      autoStart: false,
      discoverWsUrls: () => [],
    });
    await assert.rejects(
      transport.sendQuery(
        { type: 'query' },
        {
          idleTimeoutMs: 10,
          waitForTerminalOnIdle: true,
          [callback](frame) {
            if (callback === 'onFrame' && frame.type !== 'task_output') return;
            calls += 1;
            throw new Error('observer_failed');
          },
        }
      ),
      /observer_failed/
    );
    assert.equal(socket.closed, true);
    t.mock.timers.tick(100);
    assert.equal(calls, 1);
  }
});

test('Native idle timers reject unsafe types and overflow without premature completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const idleTimeoutMs of [true, [], {}, '', 'invalid', 0, -1, 1.5, 2147483648, '2147483648']) {
    let socket;
    let ready;
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    class FakeWebSocket {
      constructor() {
        socket = this;
        this.listeners = {};
        setImmediate(() => this.listeners.open());
      }
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      }
      send() {
        this.listeners.message({
          data: JSON.stringify({ type: 'task_status', data: { status: 'WORKING' } }),
        });
        ready();
      }
      close() {
        this.closed = true;
      }
    }
    const transport = createTacServerTransport({
      WebSocketImpl: FakeWebSocket,
      autoStart: false,
      discoverWsUrls: () => [],
    });
    const pending = transport.sendQuery({ type: 'query' }, { idleTimeoutMs });
    await started;
    t.mock.timers.tick(100);
    assert.notEqual(socket.closed, true);
    socket.listeners.message({
      data: JSON.stringify({ type: 'task_status', data: { status: 'COMPLETED' } }),
    });
    assert.equal((await pending).at(-1).data.status, 'COMPLETED');
  }
});

test('Native transport never sends after pre-open cancellation and contains send failures', async () => {
  for (const outcome of ['cancel_before_open', 'preaborted', 'send_error', 'serialization_error']) {
    let socket;
    let sends = 0;
    class FakeWebSocket {
      constructor() {
        socket = this;
        this.listeners = {};
      }
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      }
      send() {
        sends += 1;
        throw new Error('private-unit-token');
      }
      close() {
        this.closed = true;
      }
    }
    const controller = new AbortController();
    if (outcome === 'preaborted') controller.abort();
    const transport = createTacServerTransport({
      WebSocketImpl: FakeWebSocket,
      autoStart: false,
      discoverWsUrls: () => [],
    });
    const command = { type: 'query' };
    if (outcome === 'serialization_error') command.circular = command;
    const pending = transport.sendQuery(command, { signal: controller.signal });
    const rejected = assert.rejects(pending, {
      message:
        outcome.includes('abort') || outcome === 'cancel_before_open'
          ? 'tianxi_tac_server_aborted'
          : 'tianxi_tac_server_send_failed',
    });
    if (outcome === 'cancel_before_open') controller.abort();
    assert.doesNotThrow(() => socket.listeners.open?.());
    await rejected;
    assert.equal(socket.closed, true);
    assert.equal(sends, outcome === 'send_error' ? 1 : 0);
    controller.abort();
    assert.doesNotThrow(() => socket.listeners.open?.());
    assert.equal(sends, outcome === 'send_error' ? 1 : 0);
  }
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
    discoverWsUrls: () => [],
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
    discoverWsUrls: () => [],
  });
  await assert.rejects(
    transport.sendQuery({ type: 'query', data: { text: 'hello' } }, { idleTimeoutMs: 10 }),
    /tianxi_tac_server_idle_timeout/
  );
  await assert.rejects(
    transport.sendQuery(
      { type: 'query', data: { text: 'hello' } },
      { allowPartialOnIdle: true, idleTimeoutMs: 10 }
    ),
    /tianxi_tac_server_idle_timeout/
  );
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
    discoverWsUrls: () => [],
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
