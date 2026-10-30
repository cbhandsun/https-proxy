'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  discoverReachableTianxiCommandPorts,
  isLoopbackPortReachable,
  selectBindableTianxiPort,
} = require('../lib/proxy/tianxi-local-port-probe');
const {
  discoverTianxiTacServerWsUrls,
  createTacServerTransport,
  ensureTianxiTacServer,
  isTcpPortListening,
} = require('../lib/proxy/tianxi-agentcore-local');

test('Startup selects a bindable fallback without accepting arbitrary probe output', () => {
  for (const port of [63982, 49306, 49307])
    assert.equal(
      selectBindableTianxiPort(63982, { forceWindows: true, execFileSync: () => String(port) }),
      port
    );
  for (const output of ['', '0', '65536', '12345', '49306\n49307', 'x'.repeat(1025)])
    assert.throws(
      () => selectBindableTianxiPort(63982, { forceWindows: true, execFileSync: () => output }),
      /port_unavailable/
    );
  for (const port of [null, '', '63982', -1, 0, 65536, NaN, Infinity])
    assert.throws(() => selectBindableTianxiPort(port), /port_invalid/);
  assert.throws(
    () =>
      selectBindableTianxiPort(63982, {
        forceWindows: true,
        execFileSync() {
          throw new Error('private');
        },
      }),
    /port_unavailable/
  );
});

test('Transport follows the startup fallback port and propagates startup failures', async () => {
  let selectedUrl;
  class Socket {
    constructor(url) {
      selectedUrl = url;
      this.listeners = {};
      setImmediate(() => this.listeners.open());
    }
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    }
    send() {
      this.listeners.message({
        data: JSON.stringify({ type: 'task_status', data: { status: 'COMPLETED' } }),
      });
    }
    close() {}
  }
  const transport = createTacServerTransport({
    WebSocketImpl: Socket,
    discoverWsUrls: () => [],
    ensureServer: () => ({ port: 49306 }),
  });
  await transport.sendQuery({ type: 'query' });
  assert.equal(selectedUrl, 'ws://127.0.0.1:49306/ws/connect');
  selectedUrl = null;
  const failed = createTacServerTransport({
    WebSocketImpl: Socket,
    discoverWsUrls: () => [],
    ensureServer() {
      throw new Error('tianxi_tac_server_port_unavailable');
    },
  });
  await assert.rejects(failed.sendQuery({ type: 'query' }), /port_unavailable/);
  assert.equal(selectedUrl, null);
});

test('Command-port fallback emits bounded numeric loopback endpoints only', () => {
  let script;
  const ports = discoverReachableTianxiCommandPorts({
    forceWindows: true,
    execFileSync(command, args, options) {
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
      assert.equal(options.windowsHide, true);
      assert.equal(options.maxBuffer, 1024);
      assert.equal(options.timeout, 10000);
      script = args[3];
      return '60840\r\n60840\r\n65535\r\n';
    },
  });
  assert.deepEqual(ports, [60840, 65535]);
  assert.match(script, /ExecutablePath -eq 'C:\\Program Files\\Lenovo/);
  assert.match(script, /Select-Object -First 8/);
  assert.match(script, /ConnectAsync\('127\.0\.0\.1', \$port\)/);
  assert.match(script, /\[Console\]::WriteLine\(\$port\)/);
  assert.match(script, /finally \{ \$client\.Dispose\(\) \}/);
});

test('Fallback rejects empty, malformed, oversized, unsafe and invalid probe output', () => {
  for (const output of [
    '',
    ' ',
    null,
    Buffer.from('60840'),
    '0',
    '65536',
    '-1',
    '1.5',
    '1e3',
    '60840\nsecret=synthetic',
    '60840; Remove-Item',
    'ws://remote:60840',
    '60840\u0000',
    '60840\n'.repeat(9),
    '1'.repeat(1025),
  ]) {
    assert.deepEqual(
      discoverReachableTianxiCommandPorts({ forceWindows: true, execFileSync: () => output }),
      []
    );
  }
  assert.deepEqual(
    discoverReachableTianxiCommandPorts({
      forceWindows: true,
      execFileSync() {
        throw new Error('synthetic failure containing sensitive material');
      },
    }),
    []
  );
});

test('Reachability probe validates ports before spawning and requires exact confirmation', () => {
  for (const port of [0, -1, 65536, 1.2, NaN, Infinity, '60840', '1; unsafe', null, {}]) {
    assert.equal(
      isLoopbackPortReachable(port, {
        forceWindows: true,
        execFileSync() {
          assert.fail('invalid port must not reach a shell');
        },
      }),
      false
    );
  }
  for (const port of [1, 60840, 65535]) {
    assert.equal(
      isLoopbackPortReachable(port, {
        forceWindows: true,
        execFileSync: () => String(port) + '\r\n',
      }),
      true
    );
  }
  for (const output of ['', '60841', '60840\n60841', 'true']) {
    assert.equal(
      isLoopbackPortReachable(60840, { forceWindows: true, execFileSync: () => output }),
      false
    );
  }
});

test('Discovery falls back when listener enumeration is empty or unavailable', () => {
  for (const unavailable of [false, true]) {
    const urls = discoverTianxiTacServerWsUrls({
      forceWindows: true,
      execFileSync(command) {
        if (command === 'tasklist') return '"tac-server.exe","20776","Console"\r\n';
        if (command === 'netstat') {
          if (unavailable) throw new Error('enumeration unavailable');
          return '';
        }
        return '60840\r\n';
      },
    });
    assert.deepEqual(urls, ['ws://127.0.0.1:60840/ws/connect']);
  }
});

test('A reachable port prevents duplicate startup despite empty listener enumeration', () => {
  const options = {
    forceWindows: true,
    execFileSync(command) {
      return command === 'powershell.exe' ? '60840\r\n' : '';
    },
    spawn() {
      assert.fail('reachable native service must not be launched again');
    },
  };
  assert.equal(isTcpPortListening(60840, options), true);
  assert.deepEqual(ensureTianxiTacServer({ ...options, port: 60840 }), {
    attempted: false,
    status: 'already_listening',
    port: 60840,
  });
  assert.equal(isTcpPortListening(65536, options), false);
});

test('Successful listener enumeration retains the fast path without a new child', () => {
  assert.equal(
    isTcpPortListening(60840, {
      execFileSync(command) {
        assert.equal(command, 'netstat');
        return ' TCP 127.0.0.1:60840 0.0.0.0:0 LISTENING 20776';
      },
    }),
    true
  );
});

test('Transport uses the command-port fallback and does not start another native process', async () => {
  const options = {
    forceWindows: true,
    execFileSync(command) {
      if (command === 'tasklist') return '"tac-server.exe","20776","Console"';
      if (command === 'netstat') return '';
      return '60840\r\n';
    },
    spawn() {
      assert.fail('a live service must not be restarted');
    },
  };
  let selectedUrl;
  class FakeWebSocket {
    constructor(url) {
      selectedUrl = url;
      this.listeners = {};
      setImmediate(() => this.listeners.open());
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send() {
      this.listeners.message({
        data: JSON.stringify({ type: 'task_status', data: { status: 'COMPLETED' } }),
      });
    }
    close() {}
  }
  const transport = createTacServerTransport({
    WebSocketImpl: FakeWebSocket,
    discoverWsUrls: () => discoverTianxiTacServerWsUrls(options),
    ensureServer: (request) => ensureTianxiTacServer({ ...request, ...options }),
  });
  const frames = await transport.sendQuery({ type: 'query' });
  assert.equal(selectedUrl, 'ws://127.0.0.1:60840/ws/connect');
  assert.equal(frames.at(-1).data.status, 'COMPLETED');
});
