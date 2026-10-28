'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http');
const {
  installPublicationHttpCancellation,
} = require('../../scripts/context-hosted/n09-business/publication-http-cancellation');
const {
  startCancellationObservedContinuation,
} = require('../../scripts/context-hosted/n08/observed-client');
const safe = { message: 'n09_publication_http_cancellation_failed' };
function deferred() {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  return { pending, resolve };
}
async function serverFixture(t, handler) {
  const exported = { tryHandleContextRecoveryHttp: handler },
    original = handler,
    watcher = installPublicationHttpCancellation({ httpExports: exported });
  const server = http.createServer((clientReq, clientRes) => {
    clientReq.resume();
    exported.tryHandleContextRecoveryHttp({ kind: 'responses', clientReq, clientRes });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    watcher.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(exported.tryHandleContextRecoveryHttp, original);
  });
  return {
    watcher,
    start: () =>
      startCancellationObservedContinuation({
        entryPort: server.address().port,
        entryKey: 'a'.repeat(48),
        body: Buffer.from('{}'),
      }),
  };
}
test('real server close is observed after the original abort listener and stays in its own async context', async (t) => {
  const entered = deferred(),
    observed = deferred();
  let originalAborted = false;
  const f = await serverFixture(t, ({ clientRes }) => {
    clientRes.once('close', () => {
      originalAborted = true;
    });
    void (async () => {
      entered.resolve();
      await new Promise((resolve) => clientRes.once('close', resolve));
      observed.resolve({ cancelled: f.watcher.wasCancelled(), originalAborted });
    })();
    return true;
  });
  const client = f.start();
  await entered.pending;
  assert.equal(f.watcher.wasCancelled(), false);
  assert.equal(client.cancel(), true);
  assert.deepEqual(await client.result, { failed: true });
  assert.equal(client.termination(), 'cancelled-transport');
  assert.deepEqual(await observed.pending, { cancelled: true, originalAborted: true });
  assert.equal(client.bytes(), 0);
  assert.equal(f.watcher.wasCancelled(), false);
});
test('a concurrent response close cannot stand in for the target request', async (t) => {
  const entered = [deferred(), deferred()],
    closed = [deferred(), deferred()],
    resume = [deferred(), deferred()],
    done = [deferred(), deferred()];
  let index = 0;
  const f = await serverFixture(t, ({ clientRes }) => {
    const current = index++;
    clientRes.once('close', () => closed[current].resolve());
    void (async () => {
      entered[current].resolve();
      await resume[current].pending;
      done[current].resolve(f.watcher.wasCancelled());
    })();
    return true;
  });
  const first = f.start();
  await entered[0].pending;
  const second = f.start();
  await entered[1].pending;
  second.cancel();
  await second.result;
  await closed[1].pending;
  resume[0].resolve();
  resume[1].resolve();
  assert.equal(await done[0].pending, false);
  assert.equal(await done[1].pending, true);
  first.cancel();
  await first.result;
});
test('a normally finished public response is never a pre-publication cancellation witness', async (t) => {
  const done = deferred();
  const f = await serverFixture(t, ({ clientRes }) => {
    void (async () => {
      await new Promise((resolve) => clientRes.once('close', resolve));
      done.resolve(f.watcher.wasCancelled());
    })();
    clientRes.end('ok');
    return true;
  });
  const client = f.start();
  assert.equal((await client.result).response.status, 200);
  assert.equal(await done.pending, false);
});
test('unsafe descriptor inputs do not run getters and closing restores only the owned slot', () => {
  let touched = 0;
  const exported = { tryHandleContextRecoveryHttp: () => false },
    original = exported.tryHandleContextRecoveryHttp;
  const watcher = installPublicationHttpCancellation({ httpExports: exported });
  assert.throws(() => installPublicationHttpCancellation({ httpExports: exported }), safe);
  const getter = Object.defineProperty({ kind: 'responses' }, 'clientReq', {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  assert.equal(exported.tryHandleContextRecoveryHttp(getter), false);
  assert.equal(touched, 0);
  assert.equal(watcher.wasCancelled(), false);
  watcher.close();
  assert.equal(exported.tryHandleContextRecoveryHttp, original);
  watcher.close();
  const second = installPublicationHttpCancellation({ httpExports: exported });
  const replacement = () => false;
  exported.tryHandleContextRecoveryHttp = replacement;
  assert.throws(() => second.close(), safe);
  assert.equal(exported.tryHandleContextRecoveryHttp, replacement);
});
test('invalid exports and methods cannot install or execute accessor hooks', () => {
  let touched = 0;
  const getter = Object.defineProperty({}, 'tryHandleContextRecoveryHttp', {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
    enumerable: true,
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const httpExports of [
    null,
    {},
    [],
    getter,
    revoked.proxy,
    Object.freeze({ tryHandleContextRecoveryHttp() {} }),
    { async tryHandleContextRecoveryHttp() {} },
  ])
    assert.throws(() => installPublicationHttpCancellation({ httpExports }), safe);
  assert.equal(touched, 0);
});

test('zero body bytes after public headers still cannot qualify as a hidden cancellation', async (t) => {
  const entered = deferred(),
    done = deferred();
  const f = await serverFixture(t, ({ clientRes }) => {
    void (async () => {
      await new Promise((resolve) => clientRes.once('close', resolve));
      done.resolve(f.watcher.wasCancelled());
    })();
    clientRes.writeHead(200);
    clientRes.flushHeaders();
    entered.resolve();
    return true;
  });
  const client = f.start();
  await entered.pending;
  client.cancel();
  await client.result;
  assert.equal(await done.pending, false);
  assert.equal(client.bytes(), 0);
});

test(
  'the witness bounds active native response listeners instead of accumulating unbounded request state',
  { timeout: 5000 },
  async (t) => {
    let calls = 0,
      refused = 0,
      ready;
    const arrived = new Promise((resolve) => {
      ready = resolve;
    });
    const exported = {
        tryHandleContextRecoveryHttp() {
          calls++;
          if (calls === 8) ready();
          return true;
        },
      },
      watcher = installPublicationHttpCancellation({ httpExports: exported }),
      clients = [];
    const server = http.createServer((clientReq, clientRes) => {
      clientReq.resume();
      try {
        exported.tryHandleContextRecoveryHttp({ kind: 'responses', clientReq, clientRes });
      } catch {
        refused++;
        clientRes.destroy();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      watcher.close();
      for (const client of clients) client.cancel();
      await Promise.all(clients.map((c) => c.result));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const start = () => {
      const client = startCancellationObservedContinuation({
        entryPort: server.address().port,
        entryKey: 'a'.repeat(48),
        body: Buffer.from('{}'),
      });
      clients.push(client);
      return client;
    };
    for (let i = 0; i < 8; i++) start();
    await arrived;
    const ninth = start();
    assert.deepEqual(await ninth.result, { failed: true });
    assert.equal(calls, 8);
    assert.equal(refused, 1);
    assert.equal(watcher.wasCancelled(), false);
  }
);
