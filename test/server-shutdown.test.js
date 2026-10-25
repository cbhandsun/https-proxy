'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createProxyShutdown } = require('../lib/proxy/server-shutdown');
const { createContextRecoveryLifecycle } = require('../lib/proxy/context-recovery-lifecycle');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { AbortSignal } = globalThis;
const flush = () => new Promise(setImmediate);

test('shutdown revokes immediately but holds listeners until credential writers drain, including failure paths', async () => {
  for (const mode of ['pending', 'false', 'throw', 'thenable']) {
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    let getters = 0;
    const shutdown = createProxyShutdown({
      servers: [
        {
          close(done) {
            calls.push('close');
            done();
          },
        },
      ],
      shutdownRecovery() {
        calls.push('revoke');
        return { ok: true };
      },
      beforeListenersClose() {
        calls.push('credentials');
        if (mode === 'throw') throw new Error('PRIVATE_CREDENTIAL');
        if (mode === 'thenable')
          return {
            get then() {
              getters++;
              throw new Error('PRIVATE_CREDENTIAL');
            },
          };
        return pending;
      },
      stopPid() {
        calls.push('pid');
        return true;
      },
      reportFailure(...args) {
        assert.deepEqual(args, []);
        calls.push('failed');
      },
    });
    const result = shutdown();
    assert.equal(shutdown(), result);
    assert.deepEqual(calls, ['revoke', 'credentials']);
    if (['pending', 'false'].includes(mode)) {
      await flush();
      assert.deepEqual(calls, ['revoke', 'credentials']);
      release(mode === 'pending');
    }
    assert.equal(await result, mode === 'pending');
    assert.deepEqual(
      calls,
      mode === 'pending'
        ? ['revoke', 'credentials', 'close', 'pid']
        : ['revoke', 'credentials', 'close', 'pid', 'failed']
    );
    assert.equal(getters, 0);
  }
  assert.throws(() =>
    createProxyShutdown({ servers: [], beforeListenersClose: 1, stopPid() {}, reportFailure() {} })
  );
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('shutdown stops admission immediately and waits for every listener and recovery before PID cleanup exactly once', async () => {
  const resource = deferred();
  const pid = deferred();
  const callbacks = [];
  const calls = [];
  const servers = [];
  const shutdown = createProxyShutdown({
    servers,
    shutdownRecovery() {
      calls.push('resource');
      return resource.promise;
    },
    stopPid() {
      calls.push('pid');
      return pid.promise;
    },
    reportFailure() {
      calls.push('failure');
    },
  });
  for (let i = 0; i < 3; i++)
    servers.push({
      close(callback) {
        callbacks.push(callback);
      },
    });
  const pending = shutdown();
  assert.equal(shutdown(), pending);
  assert.deepEqual(calls, ['resource']);
  assert.equal(callbacks.length, 3);
  callbacks[0]();
  callbacks[0]();
  callbacks[1]();
  resource.resolve({ ok: true });
  await flush();
  assert.deepEqual(calls, ['resource']);
  callbacks[2]();
  await flush();
  assert.deepEqual(calls, ['resource', 'pid']);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false);
  pid.resolve(true);
  assert.equal(await pending, true);
  assert.equal(shutdown(), pending);
  assert.deepEqual(calls, ['resource', 'pid']);
});

test('shutdown closes empty and synchronous listeners and preserves failed close status while draining other resources', async () => {
  for (const mode of ['empty', 'sync', 'throw', 'callback']) {
    let pids = 0,
      reports = 0,
      recovered = 0;
    const shutdown = createProxyShutdown({
      servers:
        mode === 'empty'
          ? []
          : [
              {
                close(done) {
                  if (mode === 'throw') throw new Error('PRIVATE_NATIVE_DATA');
                  done(mode === 'callback' ? new Error('PRIVATE_NATIVE_DATA') : undefined);
                },
              },
            ],
      shutdownRecovery() {
        recovered++;
        return { ok: true };
      },
      stopPid() {
        pids++;
        return true;
      },
      reportFailure(...args) {
        assert.deepEqual(args, []);
        reports++;
      },
    });
    const success = ['empty', 'sync'].includes(mode);
    assert.equal(await shutdown(), success);
    assert.deepEqual([pids, recovered, reports], [1, 1, success ? 0 : 1]);
  }
});

test('shutdown rejects malformed, rejected and executable recovery ACKs without skipping PID cleanup', async () => {
  for (const mode of [
    'throw',
    'reject',
    'null',
    'false',
    'extra',
    'getter',
    'thenable',
    'promiseGetter',
  ]) {
    let executed = 0,
      pids = 0,
      reports = 0;
    const shutdown = createProxyShutdown({
      servers: [],
      shutdownRecovery() {
        if (mode === 'throw') throw new Error('PRIVATE_NATIVE_DATA');
        if (mode === 'reject') return Promise.reject(new Error('PRIVATE_NATIVE_DATA'));
        if (mode === 'null') return null;
        if (mode === 'false') return { ok: false };
        if (mode === 'extra') return { ok: true, content: 'PRIVATE_NATIVE_DATA' };
        if (mode === 'getter')
          return {
            get ok() {
              executed++;
              return true;
            },
          };
        if (mode === 'promiseGetter') {
          const result = Promise.resolve({ ok: true });
          Object.defineProperty(result, 'constructor', {
            get() {
              executed++;
              return Promise;
            },
          });
          return result;
        }
        return {
          get then() {
            executed++;
            throw new Error('PRIVATE_NATIVE_DATA');
          },
        };
      },
      stopPid() {
        pids++;
        return true;
      },
      reportFailure(...args) {
        assert.deepEqual(args, []);
        reports++;
      },
    });
    assert.equal(await shutdown(), false);
    assert.deepEqual([executed, pids, reports], [0, 1, 1]);
  }
});

test('shutdown requires a successful PID ACK and isolates diagnostic failures', async () => {
  for (const mode of [
    'throw',
    'reject',
    'false',
    'undefined',
    'thenable',
    'report',
    'reportReject',
    'reportThenable',
  ]) {
    let executed = 0,
      reports = 0;
    const shutdown = createProxyShutdown({
      servers: [],
      stopPid() {
        if (mode === 'throw') throw new Error('PRIVATE_NATIVE_DATA');
        if (mode === 'reject') return Promise.reject(new Error('PRIVATE_NATIVE_DATA'));
        if (mode === 'false' || mode.startsWith('report')) return false;
        if (mode === 'undefined') return undefined;
        return {
          get then() {
            executed++;
            throw new Error('PRIVATE_NATIVE_DATA');
          },
        };
      },
      reportFailure(...args) {
        assert.deepEqual(args, []);
        reports++;
        if (mode === 'report') throw new Error('PRIVATE_NATIVE_DATA');
        if (mode === 'reportReject') return Promise.reject(new Error('PRIVATE_NATIVE_DATA'));
        if (mode === 'reportThenable')
          return {
            get then() {
              executed++;
              throw new Error('PRIVATE_NATIVE_DATA');
            },
          };
      },
    });
    assert.equal(await shutdown(), false);
    assert.deepEqual([executed, reports], [0, 1]);
  }
});

test('shutdown rejects invalid trusted composition before running callbacks', () => {
  const valid = { servers: [], stopPid: () => true, reportFailure() {} };
  for (const invalid of [
    { servers: null },
    { stopPid: undefined },
    { shutdownRecovery: null },
    { reportFailure: 1 },
  ])
    assert.throws(
      () => createProxyShutdown({ ...valid, ...invalid }),
      /Invalid proxy shutdown composition/
    );
});

test(
  'real HTTP shutdown disables the actual recovery session before draining an active response and removing PID',
  { timeout: 10000 },
  async (t) => {
    const owner = createContextRecoveryLifecycle();
    await owner.configureAsync(true);
    const entered = deferred();
    let response;
    const server = http.createServer((_req, res) => {
      response = res;
      entered.resolve();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    t.after(() => owner.shutdownAsync());
    const request = http.get('http://127.0.0.1:' + server.address().port, (res) => res.resume());
    t.after(() => request.destroy());
    const finished = once(request, 'close');
    await entered.promise;
    let pids = 0;
    const shutdown = createProxyShutdown({
      servers: [server],
      shutdownRecovery: () => owner.shutdownAsync(),
      stopPid() {
        assert.equal(owner.inspect().state, 'closed');
        pids++;
        return true;
      },
      reportFailure() {
        assert.fail('Expected successful shutdown');
      },
    });
    const pending = shutdown();
    assert.equal(owner.sessions.inspect().closed, true);
    await flush();
    assert.equal(pids, 0);
    response.end('synthetic');
    assert.equal(await pending, true);
    await finished;
    assert.equal(pids, 1);
  }
);

test(
  'actual startup credential failure drains recovery before reporting failed process exit',
  { timeout: 20000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-shutdown-runtime-'));
    const running = {};
    t.after(async () => {
      try {
        if (running.child && running.child.exitCode === null && running.child.signalCode === null)
          running.child.kill();
        if (running.exited) await running.exited;
      } finally {
        const target = path.resolve(root);
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
        assert.ok(path.basename(target).startsWith('hpm-shutdown-runtime-'));
        fs.rmSync(target, { recursive: true, force: true });
      }
    });
    const [management, entry] = await findAvailablePorts(2);
    const script = `
    const {startProxyServers}=require('./lib/proxy/server-lifecycle');
    const {parsePortOrDefault}=require('./lib/proxy/management-utils');
    const {createContextRecoveryLifecycle}=require('./lib/proxy/context-recovery-lifecycle');
    const owner=createContextRecoveryLifecycle(); owner.configure(true);
    const original=owner.shutdownAsync;
    let release;
    const blocked=new Promise(resolve=>{release=resolve;});
    owner.shutdownAsync=async()=>{
      const drained=original();
      process.send({event:'draining',closed:owner.sessions.inspect().closed});
      await blocked; return await drained;
    };
    process.on('message',message=>{if(message==='release') release();});
    startProxyServers({ACTIVE_HTTPS_SERVERS:[],APP_ID:'fixture',DATA_DIR:process.argv[1],
      contextRecoveryLifecycle:owner,exceptionHandlers:{setShutdownHook(){}},
      handleRequest(req,res){res.end('synthetic');},installManagementCorsGuard(){return true;},
      log:{info(){},warn(){},error(){}},parsePortOrDefault,
      writeManagementTokenFile(){throw new Error('PRIVATE_SYNTHETIC_CREDENTIAL_FAILURE');},
      getRuntimeState(){return {ACTIVE_PROFILE:{},CONFIG:{localServer:{managementPort:Number(process.argv[2])}},
        ENTRY_SERVERS:[{host:'127.0.0.1',listenPort:Number(process.argv[3]),tls:false}],
        LOCAL_SERVER:{},MODEL_ROUTES:[],PORT:Number(process.argv[3])};}});
  `;
    const child = spawn(process.execPath, ['-e', script, root, String(management), String(entry)], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...createIsolatedTestEnv(process.env, root), MGMT_PORT: String(management), PORT: '' },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    running.child = child;
    const exited = once(child, 'exit');
    running.exited = exited;
    const message = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    assert.deepEqual(message[0], { event: 'draining', closed: true });
    await flush();
    assert.equal(child.exitCode, null);
    child.send('release');
    assert.equal((await exited)[0], 1);
    assert.equal(fs.existsSync(path.join(root, '.proxy.pid')), false);
  }
);

test('shutdown waits for upgrade drain before PID ACK and preserves all upgrade failure verdicts', async () => {
  for (const mode of ['pending', 'false', 'throw', 'thenable']) {
    const peer = deferred();
    let pids = 0,
      reports = 0,
      touched = 0;
    const stop = createProxyShutdown({
      servers: [],
      shutdownRecovery: () => ({ ok: true }),
      shutdownUpgrades() {
        if (mode === 'false') return false;
        if (mode === 'throw') throw Error('PRIVATE_CLOSE');
        if (mode === 'thenable')
          return {
            get then() {
              touched++;
              throw Error('PRIVATE_THEN');
            },
          };
        return peer.promise;
      },
      stopPid() {
        pids++;
        return true;
      },
      reportFailure() {
        reports++;
      },
    });
    const pending = stop();
    assert.equal(stop(), pending);
    if (mode === 'pending') {
      await flush();
      assert.equal(pids, 0);
      peer.resolve(true);
    }
    assert.equal(await pending, mode === 'pending');
    assert.equal(pids, 1);
    assert.equal(reports, mode === 'pending' ? 0 : 1);
    assert.equal(touched, 0);
  }
  assert.throws(
    () =>
      createProxyShutdown({ servers: [], shutdownUpgrades: 1, stopPid() {}, reportFailure() {} }),
    TypeError
  );
});

test(
  'real HTTP stop drains an encrypted file commit ACK before storage close and preserves its original expiry on reopen',
  { timeout: 10000 },
  async (t) => {
    const { createStoppingAdmission } = require('../lib/proxy/stopping-admission');
    const { performance } = require('node:perf_hooks');
    const { DatabaseSync } = require('node:sqlite');
    const { randomBytes } = require('node:crypto');
    const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
    const { createContextRecoverySessions } = require('../lib/proxy/context-recovery-sessions');
    const directory = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-stop-commit-')
    );
    const file = path.join(directory, 'checkpoint.sqlite');
    const key = randomBytes(32).toString('base64');
    const database = new DatabaseSync(file);
    const engine = createRecoverySqliteStore({ database, dataKey: key, now: () => 100 });
    const entered = deferred(),
      release = deferred();
    let armed = false,
      storageClosed = false,
      storageClosedAt,
      committed,
      scope,
      responseText = '',
      pids = 0;
    const sessions = createContextRecoverySessions({ now: () => 100 });
    const owner = createContextRecoveryLifecycle({
      sessions,
      storage: {
        async execute(request) {
          const result = engine.execute(request);
          if (armed && request.operation === 'save') {
            armed = false;
            scope = request.scope;
            committed = engine.execute({ operation: 'load', scope });
            entered.resolve();
            await release.promise;
          }
          return result;
        },
        close() {
          storageClosed = true;
          storageClosedAt = performance.now();
          engine.close();
          database.close();
        },
      },
    });
    let stopping = false;
    const admission = createStoppingAdmission({
      isStopping: () => stopping,
      closeIdleConnections: () => server.closeIdleConnections(),
      async handleRequest(_req, res) {
        try {
          const result = await view.completeObservedAsync([
            { role: 'assistant', content: 'synthetic answer' },
          ]);
          res.end(result.ok ? 'unexpected publication' : 'closed');
        } catch {
          res.end('failed');
        }
      },
    });
    const server = http.createServer(admission.request);
    let request = null;
    t.after(async () => {
      release.resolve();
      request?.destroy();
      server.closeAllConnections();
      server.close();
      await owner.shutdownAsync();
      assert.equal(fs.realpathSync.native(directory), directory);
      assert.ok(path.basename(directory).startsWith('hpm-stop-commit-'));
      fs.rmSync(directory, { recursive: true });
    });
    assert.deepEqual(await owner.configureAsync(true), { ok: true });
    const view = await sessions.beginAsync(
      {
        principal: 'owner',
        protocol: 'chat',
        target: 'synthetic',
        history: [{ role: 'user', content: 'q' }],
      },
      [],
      () => true
    );
    assert.equal(view.ok, true);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const responseEnded = deferred();
    armed = true;
    request = http.get('http://127.0.0.1:' + server.address().port, (res) => {
      res.setEncoding('utf8');
      res.on('data', (text) => {
        responseText += text;
        assert.ok(responseText.length < 128);
      });
      res.once('end', responseEnded.resolve);
    });
    await entered.promise;
    assert.equal(committed.revision, 1);
    assert.equal(committed.expiresAt, 86400100);
    const stop = createProxyShutdown({
      servers: [server],
      shutdownRecovery: () => owner.shutdownAsync(),
      stopPid() {
        assert.equal(storageClosed, true);
        pids++;
        return true;
      },
      reportFailure() {
        assert.fail('Expected a drained shutdown');
      },
    });
    stopping = true;
    const stopped = stop();
    assert.equal(stop(), stopped);
    assert.equal(sessions.inspect().closed, true);
    await flush();
    assert.equal(storageClosed, false, 'SQL COMMIT alone is not the outstanding storage ACK');
    assert.equal(pids, 0);
    assert.equal(responseText, '');
    const stoppingAt = performance.now();
    release.resolve();
    assert.equal(await stopped, true);
    assert.ok(
      performance.now() - stoppingAt < 4000,
      `natural shutdown exceeded original exit bound; post-storage=${Math.round(performance.now() - storageClosedAt)}ms`
    );
    await responseEnded.promise;
    assert.equal(responseText, 'closed');
    assert.equal(pids, 1);
    const reopenedDb = new DatabaseSync(file);
    const reopened = createRecoverySqliteStore({
      database: reopenedDb,
      dataKey: key,
      now: () => 100,
    });
    try {
      assert.deepEqual(reopened.execute({ operation: 'load', scope }), committed);
      assert.equal(reopenedDb.prepare('PRAGMA synchronous').get().synchronous, 2);
      assert.equal(reopenedDb.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      assert.equal(reopenedDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      reopened.close();
      reopenedDb.close();
    }
  }
);
