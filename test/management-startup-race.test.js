'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { createRequire } = require('node:module');
const { authorizeManagementRequest } = require('../lib/proxy/management-auth');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');

const filename = path.resolve(__dirname, '../lib/proxy/server-lifecycle.js');
const source = fs.readFileSync(filename, 'utf8');
const localRequire = createRequire(filename);

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function harness(port, entryPort) {
  const runtimeDirectory = fs.mkdtempSync(
    path.join(resolvePhysicalTestTempDirectory(), 'hpm-management-race-')
  );
  const pidOwners = [];
  const warnings = [];
  const servers = [];
  const writes = [];
  const exits = [];
  const readiness = [];
  let diskToken = '';
  let failWrite = false;
  const module = { exports: {} };
  const testingHttp = {
    ...http,
    // Both processes pass the advisory health probe before either has bound.
    request() {
      const request = new EventEmitter();
      request.end = () => process.nextTick(() => request.emit('error', new Error('not listening')));
      request.destroy = () => {};
      return request;
    },
    createServer(handler) {
      const server = http.createServer(handler);
      servers.push(server);
      return server;
    },
  };
  vm.runInNewContext(
    source,
    {
      module,
      require(name) {
        if (name === 'http') return testingHttp;
        const loaded = localRequire(name);
        if (name !== './proxy-pid-persistence') return loaded;
        return {
          ...loaded,
          createProxyPidPersistence(options) {
            const owner = loaded.createProxyPidPersistence(options);
            pidOwners.push(owner);
            return owner;
          },
        };
      },
      process: {
        pid: process.pid,
        env: {},
        nextTick: process.nextTick,
        on() {},
        exit: (code) => exits.push(code),
      },
      setImmediate,
      setTimeout,
      clearTimeout,
    },
    { filename }
  );

  function start(name) {
    let token = '';
    module.exports.startProxyServers({
      ACTIVE_HTTPS_SERVERS: [],
      APP_ID: 'test-proxy',
      DATA_DIR: runtimeDirectory,
      ensureCert: () => {
        throw new Error('HTTP-only startup must not generate TLS credentials');
      },
      exceptionHandlers: {},
      handleRequest(req, res) {
        res.writeHead(authorizeManagementRequest(req, token) ? 200 : 401);
        res.end();
      },
      installManagementCorsGuard: () => true,
      log: {
        info(message) {
          if (message.includes('Mgmt:'))
            readiness.push(servers.filter((server) => server.listening).length);
        },
        error() {},
        warn() {
          warnings.push(true);
        },
      },
      parsePortOrDefault: (value, fallback) => value || fallback,
      writeManagementTokenFile() {
        if (failWrite) throw new Error('ACL failure');
        token = `test-token-${name}`;
        writes.push(name);
        diskToken = token;
      },
      getRuntimeState: () => ({
        ACTIVE_PROFILE: {},
        CONFIG: { localServer: { managementPort: port } },
        ENTRY_SERVERS: entryPort
          ? [
              {
                host: '127.0.0.1',
                listenPort: entryPort,
                tls: false,
                protocol: 'openai-chat',
                basePath: '/v1',
              },
            ]
          : [],
        LOCAL_SERVER: {},
        MODEL_ROUTES: [],
        PORT: port - 100,
      }),
    });
  }

  async function settle() {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
  }
  async function status(token) {
    return new Promise((resolve, reject) => {
      const request = http.get(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/local/config',
          headers: token ? { 'x-mgmt-token': token } : {},
          timeout: 3000,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('test request timed out')));
    });
  }
  async function close() {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          })
      )
    );
    assert.ok((await Promise.all(pidOwners.map((owner) => owner.stop()))).every(Boolean));
    assert.equal(fs.existsSync(path.join(runtimeDirectory, '.proxy.pid')), false);
    assert.equal(
      fs.readdirSync(runtimeDirectory).some((name) => name.startsWith('.proxy.pid.')),
      false
    );
    assert.equal(warnings.length, 0, 'owned PID persistence must not fail silently');
  }
  async function dispose() {
    try {
      await close();
    } finally {
      fs.rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  }
  return {
    start,
    settle,
    status,
    close,
    dispose,
    writes,
    exits,
    readiness,
    token: () => diskToken,
    failWrites: () => {
      failWrite = true;
    },
  };
}

(async () => {
  const test = harness(await freePort(), await freePort());
  try {
    test.start('winner');
    test.start('contender');
    await test.settle();
    assert.equal(
      test.writes.length,
      1,
      'a process that loses the port must not overwrite credentials'
    );
    assert.deepEqual(test.exits, [1]);
    assert.deepEqual(test.readiness, [2], 'readiness requires management and model listeners');
    assert.equal(await test.status(test.token()), 200);
    assert.equal(await test.status(''), 401);
    assert.equal(await test.status('wrong-token'), 401);
    const oldToken = test.token();
    await test.close();
    test.start('restart');
    await test.settle();
    assert.notEqual(test.token(), oldToken);
    assert.equal(await test.status(oldToken), 401);
    assert.equal(await test.status(test.token()), 200);
  } finally {
    await test.dispose();
  }

  const failure = harness(await freePort());
  try {
    failure.failWrites();
    failure.start('failure');
    await failure.settle();
    assert.deepEqual(failure.exits, [1], 'credential persistence failures must fail startup');
    assert.equal(failure.writes.length, 0);
  } finally {
    await failure.dispose();
  }
  console.log('[management-startup-race.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
