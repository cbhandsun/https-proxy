'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const {
  createLazyWebSocketProxy: createWebSocketProxy,
} = require('../lib/proxy/lazy-websocket-proxy');

test('optional recovery transport is loaded only after admission and its load failure cannot bypass recovery', () => {
  for (const mode of ['plain', 'provider-denied', 'recovery']) {
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const http = require('node:http');
      const { EventEmitter } = require('node:events');
      const mode = ${JSON.stringify(mode)};
      const original = Module._load;
      let transportLoads = 0;
      Module._load = function(request) {
        if (request === './context-recovery-websocket-transport' || request === 'ws') {
          transportLoads++;
          throw Error('PRIVATE_TRANSPORT_FAILURE');
        }
        return original.apply(this, arguments);
      };
      const { createWebSocketProxy } = require('./lib/proxy/websocket-proxy');
      assert.equal(transportLoads, 0);
      let requests = 0;
      http.request = () => {
        requests++;
        const request = new EventEmitter();
        request.end = () => {};
        request.destroy = () => {};
        return request;
      };
      const client = new EventEmitter();
      client.write = () => {};
      client.resume = () => {};
      client.destroy = () => { client.destroyed = true; };
      const config = {
        appSettings: { contextRecoveryEnabled: mode !== 'plain' },
        entryAuth: { enabled: true, keys: [{ id: 'owner', key: 'synthetic-entry', enabled: true }] },
      };
      const profile = { id: 'synthetic', protocol: 'openai', targetUrl: 'http://127.0.0.1:1/v1' };
      const handler = createWebSocketProxy({
        getConfig: () => config, getProfiles: () => [profile], getActiveProfile: () => profile,
        contextRecoveryLifecycle: { sessions: {} }, recoveryProviderAllowed: () => mode === 'recovery',
      });
      (async () => {
        await handler({ url: '/v1/responses', headers: { authorization: 'Bearer synthetic-entry' } }, client, Buffer.alloc(0), {});
        assert.equal(transportLoads, mode === 'recovery' ? 1 : 0);
        assert.equal(requests, mode === 'recovery' ? 0 : 1);
        if (mode === 'recovery') assert.equal(client.destroyed, true);
        client.emit('close');
      })().catch(() => { process.stderr.write('boundary_failed\\n'); process.exitCode = 1; });
    `,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, API_KEY: '' } }
    );
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 0, mode + ': ' + probe.stderr);
    assert.doesNotMatch(
      probe.stdout + probe.stderr,
      /PRIVATE_TRANSPORT_FAILURE|Bearer synthetic-entry/
    );
  }
});

function upgradeCancellationFixture(t, resolveOfficialCredentials) {
  const outgoing = [];
  t.mock.method(http, 'request', () => {
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = () => {
      request.destroyed = true;
    };
    outgoing.push(request);
    return request;
  });
  const profile = { id: 'synthetic', targetUrl: 'http://127.0.0.1:1/v1' };
  const handle = createWebSocketProxy({
    getConfig: () => ({ entryAuth: { enabled: false } }),
    getActiveProfile: () => profile,
    resolveOfficialCredentials,
  });
  const client = new EventEmitter();
  client.write = () => {};
  client.resume = () => {};
  client.pause = () => {};
  client.unshift = () => {};
  client.destroy = () => {
    client.destroyed = true;
  };
  return {
    client,
    outgoing,
    run: () => handle({ url: '/v1/responses', headers: {} }, client, Buffer.alloc(0), {}),
  };
}

test('client disconnect while upstream upgrade is pending cancels the request', async (t) => {
  const fixture = upgradeCancellationFixture(t);
  await fixture.run();
  assert.equal(fixture.outgoing.length, 1);
  fixture.client.emit('close');
  assert.equal(fixture.outgoing[0].destroyed, true);
});

test('client disconnect during credential resolution prevents a late upstream request', async (t) => {
  let release;
  const credentials = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = upgradeCancellationFixture(t, () => credentials);
  const pending = fixture.run();
  fixture.client.emit('close');
  release({ profile: { id: 'synthetic', targetUrl: 'http://127.0.0.1:1/v1' } });
  await pending;
  assert.equal(fixture.outgoing.length, 0);
});

test('late upgrade is destroyed after client cancellation', async (t) => {
  const first = upgradeCancellationFixture(t);
  await first.run();
  first.client.emit('close');
  const late = new EventEmitter();
  late.destroy = () => {
    late.destroyed = true;
  };
  first.outgoing[0].emit('upgrade', { statusCode: 101, headers: {} }, late, Buffer.alloc(0));
  assert.equal(late.destroyed, true);
});

test('an upgraded failure cannot write another HTTP response', async (t) => {
  const fixture = upgradeCancellationFixture(t);
  const writes = [];
  fixture.client.write = (value) => writes.push(value);
  fixture.client.pipe = () => {};
  await fixture.run();
  const upstream = new EventEmitter();
  upstream.destroy = () => {
    upstream.destroyed = true;
  };
  upstream.pipe = () => {};
  fixture.outgoing[0].emit('upgrade', { statusCode: 101, headers: {} }, upstream, Buffer.alloc(0));
  fixture.outgoing[0].emit('error', new Error('synthetic private error'));
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^HTTP\/1.1 101 /);
  assert.equal(fixture.client.destroyed, true);
  assert.equal(upstream.destroyed, true);
});

test('upgrade diagnostics exclude paths, query values, profile IDs and native errors', () => {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const http = require('node:http');
       const {EventEmitter} = require('node:events');
       const {createWebSocketProxy} = require('./lib/proxy/websocket-proxy');
       const marker = 'synthetic-private-upgrade-value';
       http.request = () => {
         const req = new EventEmitter();
         req.destroy = () => {};
         req.end = () => req.emit('error',new Error(marker));
         return req;
       };
       const socket = () => {
         const value = new EventEmitter();
         value.write = () => {};
         value.resume = () => {};
         value.destroy = () => {value.destroyed=true;};
         return value;
       };
       const handler = createWebSocketProxy({
         getConfig: () => ({}),
         getActiveProfile: () => ({id:marker,targetUrl:'http://127.0.0.1:1/'+marker}),
         resolveOfficialCredentials: async () => {throw new Error(marker);}
       });
       (async () => {
         await handler({url:'/v1/'+marker,headers:{}},socket(),Buffer.alloc(0),{});
         await handler({url:'/v1/responses?secret='+marker,headers:{}},socket(),Buffer.alloc(0),{});
       })().catch(()=>{process.exitCode=1;});`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 }
  );
  assert.equal(probe.status, 0);
  assert.equal((probe.stdout + probe.stderr).includes('synthetic-private-upgrade-value'), false);
  for (const code of [
    'unsupported_upgrade_path',
    'credential_resolution_failed',
    'upstream_upgrade_failed',
  ])
    assert.equal(probe.stdout.includes(code), true);
});

test(
  'real client cancellation closes a pending upstream upgrade socket',
  { timeout: 10000 },
  async (t) => {
    const sockets = new Set();
    let entered;
    let closed;
    const incoming = new Promise((resolve) => {
      entered = resolve;
    });
    const disconnected = new Promise((resolve) => {
      closed = resolve;
    });
    const upstream = http.createServer();
    upstream.on('upgrade', (_req, socket) => {
      sockets.add(socket);
      socket.resume();
      socket.once('end', () => socket.destroy());
      socket.once('close', closed);
      entered();
    });
    const proxy = http.createServer();
    proxy.on('connection', (socket) => sockets.add(socket));
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      proxy.close();
      upstream.close();
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const handler = createWebSocketProxy({
      getConfig: () => ({}),
      getActiveProfile: () => ({
        id: 'synthetic',
        targetUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      }),
    });
    proxy.on('upgrade', (req, socket, head) => handler(req, socket, head, {}));
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const request = http.request(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
      agent: false,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
    });
    request.on('error', (error) => assert.equal(error.code, 'ECONNRESET'));
    request.end();
    await incoming;
    request.destroy();
    await disconnected;
  }
);

test(
  'real upgrade preserves initial head and bytes received before the upstream handshake',
  { timeout: 10000 },
  async (t) => {
    const sockets = new Set();
    let entered, sawEarly, delivered;
    const incoming = new Promise((resolve) => {
      entered = resolve;
    });
    const early = new Promise((resolve) => {
      sawEarly = resolve;
    });
    const received = new Promise((resolve) => {
      delivered = resolve;
    });
    const first = Buffer.from([0, 255, 1]);
    const second = Buffer.from('early🙂');
    const expected = Buffer.concat([first, second]);
    let upstreamSocket;
    const upstream = http.createServer();
    upstream.on('upgrade', (_req, socket, head) => {
      sockets.add(socket);
      upstreamSocket = socket;
      let bytes = Buffer.from(head);
      const accept = (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length >= expected.length) delivered(bytes);
      };
      socket.on('data', accept);
      entered();
    });
    const proxy = http.createServer();
    proxy.on('connection', (socket) => sockets.add(socket));
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      proxy.close();
      upstream.close();
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const handler = createWebSocketProxy({
      getConfig: () => ({}),
      getActiveProfile: () => ({
        id: 'synthetic',
        targetUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      }),
    });
    proxy.on('upgrade', (req, socket, head) => {
      void handler(req, socket, head, {});
      socket.once('data', sawEarly);
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const client = net.createConnection({ host: '127.0.0.1', port: proxy.address().port });
    sockets.add(client);
    client.resume();
    await new Promise((resolve) => client.once('connect', resolve));
    client.write(
      Buffer.concat([
        Buffer.from(
          'GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
        ),
        first,
      ])
    );
    await incoming;
    client.write(second);
    assert.deepEqual(await early, second);
    upstreamSocket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    );
    assert.deepEqual(await received, expected);
  }
);

test('websocket proxy rejects unauthorized request', async () => {
  const handleUpgrade = createWebSocketProxy({
    getConfig: () => ({
      entryAuth: {
        enabled: true,
        keys: [
          {
            id: 'k1',
            key: 'secret-key',
            enabled: true,
            allowedEntryProtocols: [],
            allowedEntryPorts: [],
          },
        ],
      },
    }),
    getProfiles: () => [],
    getActiveProfile: () => null,
    resolveRoute: () => null,
  });

  const server = http.createServer((req, res) => res.end());
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, { protocol: 'openai-responses', listenPort: 3445 });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${port}/v1/responses`, {
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('response', (res) => {
      assert.equal(res.statusCode, 401);
      res.resume();
      req.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    });
    req.end();
  });
});

test('websocket proxy rejects unsupported paths', async () => {
  const handleUpgrade = createWebSocketProxy({
    getConfig: () => ({ entryAuth: { enabled: false } }),
    getProfiles: () => [],
    getActiveProfile: () => null,
    resolveRoute: () => null,
  });

  const server = http.createServer((req, res) => res.end());
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, { protocol: 'openai-responses', listenPort: 3445 });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${port}/v1/unsupported`, {
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('response', (res) => {
      assert.equal(res.statusCode, 404);
      res.resume();
      req.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    });
    req.end();
  });
});

test('websocket proxy tunnels upgrade to upstream', async () => {
  let upstreamSocketRef;
  const upstream = http.createServer();
  upstream.on('upgrade', (req, socket, _head) => {
    upstreamSocketRef = socket;
    assert.equal(req.url, '/backend/responses?model=gpt-6.1-sol');
    assert.equal(req.headers['authorization'], 'Bearer upstream-key');

    const response =
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n';
    socket.write(response);

    socket.on('data', (data) => {
      socket.write(Buffer.from('echo:' + data.toString()));
    });
  });

  await new Promise((resolve) => upstream.listen(0, resolve));
  const upstreamPort = upstream.address().port;

  const handleUpgrade = createWebSocketProxy({
    getConfig: () => ({ entryAuth: { enabled: false } }),
    getProfiles: () => [
      {
        id: 'test-profile',
        targetUrl: `http://127.0.0.1:${upstreamPort}/backend`,
        apiKey: 'upstream-key',
      },
    ],
    getActiveProfile: () => ({
      id: 'test-profile',
      targetUrl: `http://127.0.0.1:${upstreamPort}/backend`,
      apiKey: 'upstream-key',
    }),
    resolveRoute: () => ({ profileId: 'test-profile' }),
  });

  const proxy = http.createServer();
  proxy.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, { protocol: 'openai-responses', listenPort: 3445 });
  });

  await new Promise((resolve) => proxy.listen(0, resolve));
  const proxyPort = proxy.address().port;

  await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${proxyPort}/v1/responses?model=gpt-6.1-sol`, {
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (res, clientSocket, _head) => {
      assert.equal(res.statusCode, 101);
      assert.equal(res.headers.upgrade, 'websocket');

      clientSocket.write('hello');
      clientSocket.on('data', (chunk) => {
        assert.equal(chunk.toString(), 'echo:hello');
        clientSocket.destroy();
        if (upstreamSocketRef) upstreamSocketRef.destroy();
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
        resolve();
      });
    });

    req.end();
  });
});

test('websocket proxy resolves official credentials and rewrites targetUrl', async () => {
  let upstreamSocketRef;
  const upstream = http.createServer();
  upstream.on('upgrade', (req, socket, _head) => {
    upstreamSocketRef = socket;
    assert.equal(req.url, '/backend-api/codex/responses');
    assert.equal(req.headers['authorization'], 'Bearer official-oauth-token');

    const response =
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n';
    socket.write(response);

    socket.on('data', (data) => {
      socket.write(Buffer.from('echo:' + data.toString()));
    });
  });

  await new Promise((resolve) => upstream.listen(0, resolve));
  const upstreamPort = upstream.address().port;

  const handleUpgrade = createWebSocketProxy({
    getConfig: () => ({ entryAuth: { enabled: false } }),
    getProfiles: () => [
      {
        id: 'openai-official',
        targetUrl: 'https://api.openai.com/v1',
        authMode: 'official-login',
      },
    ],
    getActiveProfile: () => ({
      id: 'openai-official',
      targetUrl: 'https://api.openai.com/v1',
      authMode: 'official-login',
    }),
    resolveRoute: () => ({
      profile: {
        id: 'openai-official',
        targetUrl: 'https://api.openai.com/v1',
        authMode: 'official-login',
      },
      route: { from: 'gpt-6.1-sol', to: 'gpt-6.1-sol', profileId: 'openai-official' },
    }),
    resolveOfficialCredentials: async ({ profile }) => {
      return {
        profile: {
          ...profile,
          apiKey: 'official-oauth-token',
          targetUrl: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
        },
      };
    },
  });

  const proxy = http.createServer();
  proxy.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, { protocol: 'openai-responses', listenPort: 3445 });
  });

  await new Promise((resolve) => proxy.listen(0, resolve));
  const proxyPort = proxy.address().port;

  await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (res, clientSocket, _head) => {
      assert.equal(res.statusCode, 101);
      assert.equal(res.headers.upgrade, 'websocket');

      clientSocket.write('ping');
      clientSocket.on('data', (chunk) => {
        assert.equal(chunk.toString(), 'echo:ping');
        clientSocket.destroy();
        if (upstreamSocketRef) upstreamSocketRef.destroy();
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        proxy.close();
        upstream.close();
        resolve();
      });
    });

    req.end();
  });
});
