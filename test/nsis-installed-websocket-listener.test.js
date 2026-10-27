'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const {
  attachInstalledWebSocketListener,
} = require('../scripts/lib/nsis-installed-websocket-listener');

const TOKEN = 'Bearer hpm-upstream-' + 'a'.repeat(32);
async function fixture(t, prepare, servername = 'api.openai.com') {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  // Plain local wire fixture supplies synthetic SNI only. Actual TLS and
  // installed-daemon qualification remain separate gated Windows evidence.
  server.on('upgrade', (request) => {
    request.socket.servername = servername;
  });
  const lease = attachInstalledWebSocketListener(server, prepare);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await lease.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    lease,
    connect(path = '/v1/responses', authorization = TOKEN) {
      const client = new WebSocket('ws://127.0.0.1:' + server.address().port + path, {
        headers: { authorization },
      });
      client.on('error', () => {});
      const opened = once(client, 'open');
      void opened.catch(() => {});
      const closed = new Promise((resolve) => client.once('close', resolve));
      return { client, opened, closed };
    },
  };
}

test('owned listener authenticates before a real 101 and exchanges bounded WebSocket bytes', async (t) => {
  let prepared = 0;
  const f = await fixture(t, (event) => {
    prepared++;
    assert.equal(
      event.path === '/v1/responses' && event.authorization === TOKEN,
      true,
      'synthetic_upgrade_identity_checked'
    );
    return (peer) => {
      peer.on('message', (bytes, binary) => {
        assert.equal(binary, false);
        peer.send(bytes, { binary: false });
      });
    };
  });
  const c = f.connect();
  await c.opened;
  for (const text of ['HPM_FIXED_SYNTHETIC_FRAME', '', 'x'.repeat(4096)]) {
    const received = once(c.client, 'message');
    c.client.send(text);
    const [bytes, binary] = await received;
    assert.equal(binary, false);
    assert.equal(bytes.equals(Buffer.from(text)), true, 'fixed synthetic frame equality');
  }
  assert.equal(prepared, 1);
  assert.deepEqual(f.lease.inspect(), { accepted: 1, rejected: 0, active: 1, failed: false });
  c.client.close();
  await c.closed;
  assert.equal(await f.lease.close(), true);
  assert.equal(f.lease.inspect().active, 0);
  assert.equal(f.lease.close(), f.lease.close());
});

test('wrong host, path, credentials and refused gates cannot get a 101 or business access', async (t) => {
  for (const fault of ['host', 'path', 'empty', 'arbitrary', 'extreme', 'gate']) {
    let prepared = 0;
    const f = await fixture(
      t,
      () => {
        prepared++;
        return null;
      },
      fault === 'host' ? 'api.anthropic.com' : 'api.openai.com'
    );
    const c = f.connect(
      fault === 'path' ? '/v1/responses?x=1' : '/v1/responses',
      fault === 'empty'
        ? ''
        : fault === 'arbitrary'
          ? 'PRIVATE_SENTINEL'
          : fault === 'extreme'
            ? 'x'.repeat(8192)
            : TOKEN
    );
    await assert.rejects(c.opened);
    await c.closed;
    assert.equal(prepared, fault === 'gate' ? 1 : 0);
    assert.equal(f.lease.inspect().accepted, 0);
    assert.equal(await f.lease.close(), false);
  }
});

test('cleanup waits for a live peer close and a pending owned async handler, once', async (t) => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const f = await fixture(t, () => async () => {
    await pending;
  });
  const c = f.connect();
  await c.opened;
  let finished = false;
  const closing = f.lease.close();
  void closing.then(() => {
    finished = true;
  });
  await c.closed;
  assert.equal(finished, false);
  finish();
  assert.equal(await closing, true);
  assert.equal(f.lease.inspect().active, 0);
});

test('sync and async business failures remain failed cleanup without private error text', async (t) => {
  for (const asyncFailure of [false, true]) {
    const f = await fixture(t, () =>
      asyncFailure
        ? async () => {
            throw Error('PRIVATE_SENTINEL');
          }
        : () => {
            throw Error('PRIVATE_SENTINEL');
          }
    );
    const c = f.connect();
    await c.opened;
    await c.closed;
    assert.equal(await f.lease.close(), false);
    assert.doesNotMatch(JSON.stringify(f.lease.inspect()), /PRIVATE_SENTINEL/);
  }
});

test('oversized peer frames close the owned transport and remain a failed verdict', async (t) => {
  const f = await fixture(t, () => () => {});
  const c = f.connect();
  await c.opened;
  c.client.send('x'.repeat(4097));
  await c.closed;
  assert.equal(f.lease.inspect().failed, true);
  assert.equal(await f.lease.close(), false);
});

test('bad capabilities and executable property traps reject without invocation', () => {
  let calls = 0;
  const trap = new Proxy(
    {},
    {
      get() {
        calls++;
        throw Error('PRIVATE_SENTINEL');
      },
      getPrototypeOf() {
        calls++;
        throw Error('PRIVATE_SENTINEL');
      },
    }
  );
  const getters = Object.defineProperty({}, 'on', {
    get() {
      calls++;
      throw Error('PRIVATE_SENTINEL');
    },
  });
  for (const server of [null, {}, trap, getters])
    assert.throws(() => attachInstalledWebSocketListener(server, () => {}), {
      message: 'installed_websocket_listener_failed',
    });
  const server = http.createServer();
  for (const callback of [
    null,
    {},
    async () => {},
    function* () {},
    new Proxy(() => {}, {
      apply() {
        calls++;
      },
    }),
  ])
    assert.throws(() => attachInstalledWebSocketListener(server, callback), {
      message: 'installed_websocket_listener_failed',
    });
  assert.equal(calls, 0);
});

test('gate promises and executable thenables cannot become handshake authority', async (t) => {
  let hooks = 0;
  const executable = Object.defineProperty({}, 'then', {
    get() {
      hooks++;
      throw Error('PRIVATE_SENTINEL');
    },
  });
  for (const make of [
    () => Promise.reject(Error('PRIVATE_SENTINEL')),
    () => Promise.resolve(() => {}),
    () => executable,
    () =>
      new Proxy(() => {}, {
        apply() {
          hooks++;
        },
      }),
  ]) {
    const f = await fixture(t, () => make());
    const c = f.connect();
    await assert.rejects(c.opened);
    await c.closed;
    assert.equal(await f.lease.close(), false);
  }
  assert.equal(hooks, 0);
});

test('a returned handler thenable is rejected without executing its property', async (t) => {
  let hooks = 0;
  const f = await fixture(
    t,
    () => () =>
      Object.defineProperty({}, 'then', {
        get() {
          hooks++;
          throw Error('PRIVATE_SENTINEL');
        },
      })
  );
  const c = f.connect();
  await c.opened;
  await c.closed;
  assert.equal(await f.lease.close(), false);
  assert.equal(hooks, 0);
});

test('installed composition rejects missing, extra and executable capabilities before opening TLS', async () => {
  const {
    createInstalledWebSocketListener,
  } = require('../scripts/lib/nsis-installed-websocket-listener');
  let hooks = 0;
  const input = {
    networkRoot: 'unused',
    ownedNode: 'unused',
    negativeAddress: '127.0.0.1',
    onBusinessRequest() {},
    prepareUpgrade() {},
  };
  for (const value of [
    null,
    {},
    { ...input, extra: true },
    { ...input, prepareUpgrade: null },
    { ...input, prepareUpgrade: async () => {} },
    new Proxy(input, {
      get() {
        hooks++;
        throw Error('PRIVATE_SENTINEL');
      },
    }),
    Object.defineProperty({ ...input }, 'prepareUpgrade', {
      enumerable: true,
      get() {
        hooks++;
        throw Error('PRIVATE_SENTINEL');
      },
    }),
  ])
    await assert.rejects(createInstalledWebSocketListener(value));
  assert.equal(hooks, 0);
});

test('live peer and total handshake limits are bounded and never grant cleanup success', async (t) => {
  for (const simultaneous of [true, false]) {
    const f = await fixture(t, () => () => {});
    const clients = [];
    const maximum = simultaneous ? 4 : 8;
    for (let i = 0; i < maximum; i++) {
      const c = f.connect();
      await c.opened;
      clients.push(c);
      if (!simultaneous) {
        c.client.close();
        await c.closed;
      }
    }
    const excess = f.connect();
    await assert.rejects(excess.opened);
    await excess.closed;
    assert.equal(f.lease.inspect().accepted, maximum);
    assert.equal(f.lease.inspect().active, simultaneous ? 4 : 0);
    for (const c of clients) {
      c.client.close();
      await c.closed;
    }
    const poisoned = f.connect();
    await assert.rejects(poisoned.opened);
    await poisoned.closed;
    assert.equal(f.lease.inspect().accepted, maximum);
    assert.equal(await f.lease.close(), false);
  }
});

test('reentrant close inside the business handler still waits for that owned handler', async (t) => {
  let finish, closing;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const f = await fixture(t, () => () => {
    closing = f.lease.close();
    return pending;
  });
  const c = f.connect();
  await c.closed;
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(settled, false);
  } finally {
    finish();
  }
  assert.equal(await closing, true);
});
