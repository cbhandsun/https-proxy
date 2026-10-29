'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const { createUpgradeGuard } = require('../lib/proxy/inbound-controls');
const { createLazyWebSocketProxy } = require('../lib/proxy/lazy-websocket-proxy');

test('actual HTTP upgrade returns a terminal sanitized 503 when lazy loading fails', async (t) => {
  const sockets = new Set();
  const server = http.createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on(
    'upgrade',
    createUpgradeGuard(
      createLazyWebSocketProxy(
        {},
        {
          loadModule() {
            throw Error('SYNTHETIC_PRIVATE_MODULE_FAILURE');
          },
        }
      )
    )
  );
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/v1/responses',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
    });
    request.setTimeout(2000, () => request.destroy(new Error('upgrade response deadline')));
    request.once('error', reject);
    request.once('response', (reply) => {
      const chunks = [];
      reply.on('data', (chunk) => chunks.push(chunk));
      reply.once('error', reject);
      reply.once('end', () =>
        resolve({ status: reply.statusCode, body: Buffer.concat(chunks).toString() })
      );
    });
    request.end();
  });
  assert.equal(response.status, 503);
  assert.equal(response.body, '');
});

test('WebSocket composition stays cold and preserves dependency, receiver and argument identities', async () => {
  const dependencies = { contextRecoveryLifecycle: {} };
  let loads = 0;
  const receiver = {};
  const args = [{}, {}, Buffer.alloc(0), {}];
  const result = Promise.resolve('completed');
  const handler = createLazyWebSocketProxy(dependencies, {
    loadModule() {
      loads++;
      return {
        createWebSocketProxy(actual) {
          assert.equal(actual, dependencies);
          return function (...actualArgs) {
            assert.equal(this, receiver);
            assert.deepEqual(actualArgs, args);
            return result;
          };
        },
      };
    },
  });
  assert.equal(loads, 0);
  assert.equal(handler.apply(receiver, args), result);
  assert.equal(await handler.apply(receiver, args), 'completed');
  assert.equal(loads, 1);
});

test('invalid construction is rejected and initialization failures close the upgrade without fallback', () => {
  for (const input of [undefined, null, 0, '', []])
    assert.throws(() => createLazyWebSocketProxy(input), TypeError);
  for (const loadModule of [1, {}, 'invalid'])
    assert.throws(() => createLazyWebSocketProxy({}, { loadModule }), TypeError);
  for (const candidate of [
    null,
    {},
    { createWebSocketProxy: true },
    { createWebSocketProxy: () => null },
  ]) {
    let ended = '';
    const handler = createLazyWebSocketProxy({}, { loadModule: () => candidate });
    handler(
      {},
      {
        end(value) {
          ended = value;
        },
      },
      Buffer.alloc(0),
      {}
    );
    assert.match(ended, /^HTTP\/1\.1 503 /);
    assert.doesNotMatch(ended, /Invalid|module|createWebSocketProxy/);
  }
  let loads = 0,
    forwarded = 0,
    destroyed = 0;
  const handler = createLazyWebSocketProxy(
    {},
    {
      loadModule() {
        loads++;
        if (loads === 1) throw Error('SYNTHETIC_PRIVATE_FAILURE');
        return {
          createWebSocketProxy: () => () => {
            forwarded++;
          },
        };
      },
    }
  );
  handler(
    {},
    {
      end() {
        throw Error('socket unavailable');
      },
      destroy() {
        destroyed++;
      },
    }
  );
  assert.equal(destroyed, 1);
  assert.equal(forwarded, 0);
  handler({}, {});
  assert.equal(loads, 2);
  assert.equal(forwarded, 1);
});

test('actual cold WebSocket implementation retains live entry authentication before routing', () => {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const {createLazyWebSocketProxy} = require('./lib/proxy/lazy-websocket-proxy');
    const file = require.resolve('./lib/proxy/websocket-proxy');
    let key = 'synthetic-first';
    const handler = createLazyWebSocketProxy({getConfig:()=>({entryAuth:{enabled:true,keys:[{id:'owner',key,enabled:true}]}})});
    assert.equal(require.cache[file], undefined);
    async function request(token, expected) {
      let wire=''; let closed=false;
      await handler({url:'/unsupported', headers:{host:'localhost',authorization:'Bearer '+token}}, {write(value){wire+=value;},destroy(){closed=true;}}, Buffer.alloc(0), {});
      assert.match(wire,new RegExp('^HTTP/1.1 '+expected)); assert.equal(closed,true);
      assert.equal(wire.includes(token),false);
    }
    (async()=>{
      await request('wrong-synthetic-key',401);
      assert.ok(require.cache[file]);
      await request('synthetic-first',404);
      key='synthetic-second';
      await request('synthetic-first',401);
      await request('synthetic-second',404);
    })().catch(()=>{process.stderr.write('websocket_cold_boundary_failed\\n');process.exitCode=1;});
  `,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 }
  );
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stderr);
  assert.doesNotMatch(
    probe.stdout + probe.stderr,
    /synthetic-first|synthetic-second|wrong-synthetic-key/
  );
});
