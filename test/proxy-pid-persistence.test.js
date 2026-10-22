'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { AbortController, AbortSignal } = globalThis;
const { findAvailablePorts } = require('./helpers/test-ports');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { clearProxyPidFile } = require('../lib/proxy/server-lifecycle');
const {
  writeProxyPidFileAsync,
  createProxyPidPersistence,
} = require('../lib/proxy/proxy-pid-persistence');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-pid-persistence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('PID cleanup accepts an unpublished or already removed file and rejects filesystem read errors', (t) => {
  const dir = fixture(t);
  const target = path.join(dir, '.proxy.pid');
  assert.equal(clearProxyPidFile(dir, 123), true);
  fs.writeFileSync(target, '123\n');
  assert.equal(clearProxyPidFile(dir, 123), true);
  assert.equal(clearProxyPidFile(dir, 123), true);
  fs.mkdirSync(target);
  assert.equal(clearProxyPidFile(dir, 123), false);
  assert.equal(fs.statSync(target).isDirectory(), true);
});
test('PID promotion waits for private ACLs while the event loop remains responsive', async (t) => {
  const dir = fixture(t),
    target = path.join(dir, '.proxy.pid');
  fs.writeFileSync(target, 'old');
  let release, ready;
  const securing = new Promise((resolve) => {
    ready = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let promoted = false;
  const pending = writeProxyPidFileAsync(dir, 123, {
    secureDirectory() {},
    async secureFile(file) {
      assert.equal(fs.readFileSync(file, 'utf8'), '123\n');
      ready();
      await blocked;
    },
    promote(source, destination) {
      promoted = true;
      fs.renameSync(source, destination);
    },
  });
  await securing;
  await new Promise(setImmediate);
  assert.equal(promoted, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  release();
  assert.equal(await pending, true);
  assert.equal(fs.readFileSync(target, 'utf8'), '123\n');
  assert.deepEqual(fs.readdirSync(dir), ['.proxy.pid']);
});
test('PID ACL, promotion and abort failures retain the previous file and clean owned temporaries', async (t) => {
  const dir = fixture(t),
    target = path.join(dir, '.proxy.pid');
  fs.writeFileSync(target, 'old');
  for (const stage of ['acl', 'promote', 'abort']) {
    const controller = new AbortController();
    const failure = Error(stage);
    await assert.rejects(
      writeProxyPidFileAsync(dir, 321, {
        signal: controller.signal,
        secureDirectory() {},
        async secureFile() {
          if (stage === 'acl') throw failure;
          if (stage === 'abort') controller.abort(failure);
        },
        promote() {
          throw failure;
        },
      }),
      (error) => error === failure
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), ['.proxy.pid']);
  }
});
test('PID writer rejects malformed paths, unsafe PIDs and pre-aborted writes before IO', async () => {
  for (const dir of [null, '', ' ', 'x\0y', 'x'.repeat(32001)])
    await assert.rejects(writeProxyPidFileAsync(dir, 1), /Invalid proxy pid/);
  for (const pid of [null, 0, -1, 1.1, '1', NaN, Infinity, 4294967296])
    await assert.rejects(writeProxyPidFileAsync('uncreated', pid), /Invalid proxy pid/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(writeProxyPidFileAsync('uncreated', 1, { signal: controller.signal }), {
    name: 'AbortError',
  });
});
test('Shutdown aborts and waits for the pending writer before clearing PID, once', async () => {
  let finish,
    signal,
    writes = 0,
    clears = 0,
    warnings = 0;
  const persistence = createProxyPidPersistence({
    write(value) {
      writes++;
      signal = value;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    clear() {
      clears++;
      return true;
    },
    warn() {
      warnings++;
    },
  });
  const pending = persistence.start();
  assert.equal(persistence.start(), pending);
  await Promise.resolve();
  const stopped = persistence.stop();
  assert.equal(persistence.stop(), stopped);
  assert.equal(signal.aborted, true);
  assert.equal(clears, 0);
  finish(true);
  assert.equal(await stopped, true);
  assert.equal(await persistence.start(), false);
  assert.deepEqual([writes, clears, warnings], [1, 1, 0]);
});
test('PID persistence reports failures without private data and does not restart after stopping', async () => {
  let clears = 0,
    warnings = 0;
  const persistence = createProxyPidPersistence({
    write() {
      throw Error('PRIVATE_PATH');
    },
    clear() {
      clears++;
    },
    warn(...args) {
      assert.deepEqual(args, []);
      warnings++;
    },
  });
  assert.equal(await persistence.start(), false);
  await persistence.stop();
  assert.deepEqual([clears, warnings], [1, 1]);
  for (const callbacks of [{}, { write() {}, clear() {}, warn: 1 }])
    assert.throws(() => createProxyPidPersistence(callbacks), /Invalid proxy pid/);
});

test('PID writer preserves foreign collisions and reports write, fsync, close and cleanup failures', async (t) => {
  const dir = fixture(t);
  let unlinks = 0;
  const collision = Object.assign(Error('collision'), { code: 'EEXIST' });
  await assert.rejects(
    writeProxyPidFileAsync(dir, 1, {
      secureDirectory() {},
      io: {
        async open() {
          throw collision;
        },
        async unlink() {
          unlinks++;
        },
      },
    }),
    (error) => error === collision
  );
  assert.equal(unlinks, 0);
  for (const stage of ['writeFile', 'sync', 'close']) {
    const failure = Error(stage);
    let failed = false;
    await assert.rejects(
      writeProxyPidFileAsync(dir, 1, {
        secureDirectory() {},
        secureFile() {
          assert.fail('unflushed file must not be promoted');
        },
        io: {
          ...fs.promises,
          async open(...args) {
            const handle = await fs.promises.open(...args);
            return Object.fromEntries(
              ['writeFile', 'sync', 'close'].map((name) => [
                name,
                async (...values) => {
                  if (stage === name && !failed) {
                    failed = true;
                    throw failure;
                  }
                  return handle[name](...values);
                },
              ])
            );
          },
        },
      }),
      (error) => error === failure
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  }
  await assert.rejects(
    writeProxyPidFileAsync(dir, 1, {
      secureDirectory() {},
      async secureFile() {
        throw Error('acl');
      },
      io: {
        ...fs.promises,
        async unlink() {
          throw Error('cleanup');
        },
      },
    }),
    (error) => error instanceof AggregateError && error.errors.length === 2
  );
});

test('Falsy rejection values remain failures and are reported instead of becoming success', async (t) => {
  const dir = fixture(t);
  for (const failure of [undefined, null, false, 0, '']) {
    await assert.rejects(
      writeProxyPidFileAsync(dir, 1, {
        secureDirectory() {},
        async secureFile() {
          throw failure;
        },
      }),
      (error) => error === failure
    );
    let warnings = 0;
    const persistence = createProxyPidPersistence({
      async write() {
        throw failure;
      },
      clear() {},
      warn() {
        warnings++;
      },
    });
    assert.equal(await persistence.start(), false);
    assert.equal(warnings, 1);
    await persistence.stop();
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('Actual listeners serve health during PID ACL work and shutdown waits without recreating PID', async (t) => {
  const dir = fixture(t);
  const [management, entry] = await findAvailablePorts(2);
  const script = `
    const secure=require('./lib/proxy/secure-files');
    const dir=process.argv[1];
    secure.ensurePrivateDirectorySync(dir);
    let release, shutdown;
    const blocked=new Promise(resolve=>{release=resolve;});
    secure.ensurePrivateFileAsync=async()=>{process.send('securing');await blocked;};
    const {startProxyServers}=require('./lib/proxy/server-lifecycle');
    const {createContextRecoveryLifecycle}=require('./lib/proxy/context-recovery-lifecycle');
    const contextRecoveryLifecycle=createContextRecoveryLifecycle();
    contextRecoveryLifecycle.configure(true);
    const {parsePortOrDefault}=require('./lib/proxy/management-utils');
    process.on('message',message=>{
      if(message==='shutdown') {shutdown();setImmediate(()=>process.send({event:'shutdown_waiting',recoveryClosed:contextRecoveryLifecycle.sessions.inspect().closed}));}
      if(message==='release') release();
    });
    startProxyServers({ACTIVE_HTTPS_SERVERS:[],APP_ID:'fixture',DATA_DIR:dir,
      contextRecoveryLifecycle,
      exceptionHandlers:{setShutdownHook(fn){shutdown=fn;}},
      handleRequest(req,res){res.end('healthy');},installManagementCorsGuard(){return true;},
      log:{info(){},warn(){},error(){}},parsePortOrDefault,writeManagementTokenFile(){},
      getRuntimeState(){return {ACTIVE_PROFILE:{},CONFIG:{localServer:{managementPort:Number(process.argv[2])}},
        ENTRY_SERVERS:[{host:'127.0.0.1',listenPort:Number(process.argv[3]),tls:false}],
        LOCAL_SERVER:{},MODEL_ROUTES:[],PORT:Number(process.argv[3])};}});
  `;
  const child = spawn(process.execPath, ['-e', script, dir, String(management), String(entry)], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...createIsolatedTestEnv(process.env, dir), MGMT_PORT: String(management), PORT: '' },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  assert.deepEqual(await once(child, 'message', { signal: AbortSignal.timeout(15000) }), [
    'securing',
    undefined,
  ]);
  const response = await fetch('http://127.0.0.1:' + management + '/v1/local/health', {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(await response.text(), 'healthy');
  assert.equal(fs.existsSync(path.join(dir, '.proxy.pid')), false);
  const waiting = once(child, 'message', { signal: AbortSignal.timeout(5000) });
  child.send('shutdown');
  assert.deepEqual((await waiting)[0], { event: 'shutdown_waiting', recoveryClosed: true });
  assert.equal(child.exitCode, null);
  child.send('release');
  assert.equal((await exited)[0], 0);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.startsWith('.proxy.pid')),
    false
  );
});
