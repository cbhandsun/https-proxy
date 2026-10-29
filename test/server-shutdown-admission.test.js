'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { AbortSignal } = globalThis;

for (const kind of ['http', 'upgrade', 'idle']) {
  test(
    kind === 'idle'
      ? 'actual stopping listener closes the newly idle keep-alive connection after its active response'
      : `actual stopping listener rejects a new ${kind} request on an active connection`,
    { timeout: 15000 },
    async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-shutdown-admission-'));
      const running = {};
      t.after(async () => {
        running.socket?.destroy();
        if (running.child && running.child.exitCode === null && running.child.signalCode === null)
          running.child.kill();
        if (running.exited) await running.exited;
        fs.rmSync(root, { recursive: true, force: true });
      });
      const [management, entry] = await findAvailablePorts(2);
      const script = `
      const {startProxyServers}=require('./lib/proxy/server-lifecycle');
      const {parsePortOrDefault}=require('./lib/proxy/management-utils');
      let stop, response, late=0, upgrades=0;
      process.on('message', message=>{
        if(message==='stop') {stop();process.send({event:'stopping'});}
        if(message==='release') {response.end('done');}
      });
      startProxyServers({ACTIVE_HTTPS_SERVERS:[],APP_ID:'synthetic',DATA_DIR:process.argv[1],
        exceptionHandlers:{setShutdownHook(){}},
        proxyStopControl:{bind(callback){stop=callback;}},
        onReady(){process.send({event:'ready'});},
        handleRequest(req,res){
          if(req.url==='/hold') {
            response=res;
            req.socket.once('data',()=>setImmediate(()=>process.send({event:'parsed',late,upgrades})));
            res.write('held');process.send({event:'held'});
          } else {late++;res.end('unexpected');}
        },
        handleUpgrade(){upgrades++;},
        installManagementCorsGuard(){return true;},
        log:{info(){},warn(){},error(){}},parsePortOrDefault,
        writeManagementTokenFile(){return 'synthetic';},
        getRuntimeState(){return {ACTIVE_PROFILE:{},CONFIG:{localServer:{managementPort:Number(process.argv[2])}},
          ENTRY_SERVERS:[{host:'127.0.0.1',listenPort:Number(process.argv[3]),tls:false}],
          LOCAL_SERVER:{},MODEL_ROUTES:[],PORT:Number(process.argv[3])};}});
    `;
      const child = spawn(
        process.execPath,
        ['-e', script, root, String(management), String(entry)],
        {
          cwd: path.resolve(__dirname, '..'),
          env: {
            ...createIsolatedTestEnv(process.env, root),
            MGMT_PORT: String(management),
            PORT: '',
          },
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        }
      );
      running.child = child;
      const exited = once(child, 'exit');
      running.exited = exited;
      const message = async () =>
        (await once(child, 'message', { signal: AbortSignal.timeout(5000) }))[0];
      assert.deepEqual(await message(), { event: 'ready' });
      const socket = net.createConnection({ host: '127.0.0.1', port: entry });
      running.socket = socket;
      socket.on('error', () => {});
      let wire = '';
      socket.on('data', (chunk) => {
        wire += chunk.toString('ascii');
        assert.ok(wire.length < 4096);
      });
      const socketClosed = once(socket, 'close', { signal: AbortSignal.timeout(4000) });
      socketClosed.catch(() => {});
      await once(socket, 'connect');
      const held = message();
      socket.write('GET /hold HTTP/1.1\r\nHost: localhost\r\n\r\n');
      assert.deepEqual(await held, { event: 'held' });
      const stopping = message();
      child.send('stop');
      assert.deepEqual(await stopping, { event: 'stopping' });
      if (kind === 'idle') child.send('release');
      else {
        const parsed = message();
        socket.write(
          kind === 'http'
            ? 'GET /late HTTP/1.1\r\nHost: localhost\r\n\r\n'
            : 'GET /late HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
        );
        const receipt = await parsed;
        child.send('release');
        assert.deepEqual(receipt, { event: 'parsed', late: 0, upgrades: 0 });
      }
      await socketClosed;
      assert.equal((await exited)[0], 0);
      assert.match(wire, /HTTP\/1.1 200 OK/);
      if (kind === 'idle') assert.equal(wire.includes('HTTP/1.1 503'), false);
      else assert.match(wire, /HTTP\/1.1 503 Service Unavailable/);
      assert.ok(wire.indexOf('held') < wire.indexOf('done'));
      if (kind !== 'idle') assert.ok(wire.indexOf('done') < wire.indexOf('HTTP/1.1 503'));
      assert.equal(wire.includes('unexpected'), false);
      assert.equal(fs.existsSync(path.join(root, '.proxy.pid')), false);
    }
  );
}

test(
  'actual stop closes an already admitted upgrade before natural exit and still waits for recovery drain',
  { timeout: 15000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-shutdown-upgraded-'));
    const running = {};
    t.after(async () => {
      if (running.child?.connected) running.child.send('release');
      running.socket?.destroy();
      running.backendPeer?.destroy();
      running.backend?.close();
      // Failure cleanup only: the passing path requires natural exit before this hook.
      if (running.child && running.child.exitCode === null && running.child.signalCode === null)
        running.child.kill('SIGKILL');
      if (running.exited) await running.exited;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const backend = net.createServer();
    running.backend = backend;
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    const backendOpened = once(backend, 'connection', { signal: AbortSignal.timeout(5000) });
    backendOpened.catch(() => {});
    backend.on('connection', (peer) => {
      running.backendPeer = peer;
      peer.on('error', () => {});
    });
    const [management, entry] = await findAvailablePorts(2);
    const script = `
    const {startProxyServers}=require('./lib/proxy/server-lifecycle');
    const {parsePortOrDefault}=require('./lib/proxy/management-utils');
    const {createWebSocketLifecycle}=require('./lib/proxy/websocket-lifecycle');
    const net=require('node:net');
    let stop, release;
    const drained=new Promise(resolve=>{release=resolve;});
    process.on('message',message=>{if(message==='stop')stop();if(message==='release')release({ok:true});});
    startProxyServers({ACTIVE_HTTPS_SERVERS:[],APP_ID:'synthetic',DATA_DIR:process.argv[1],
      exceptionHandlers:{setShutdownHook(){}},proxyStopControl:{bind(callback){stop=callback;}},
      contextRecoveryLifecycle:{shutdownAsync(){process.send({event:'draining'});return drained;}},
      onReady(){process.send({event:'ready'});},handleRequest(_req,res){res.end('synthetic');},
      handleUpgrade(_req,socket,head){const lifecycle=createWebSocketLifecycle(socket,head);const upstream=net.connect({host:'127.0.0.1',port:Number(process.argv[4])});lifecycle.attachSocket(upstream);socket.pipe(upstream).pipe(socket);socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');process.send({event:'upgraded'});},
      installManagementCorsGuard(){return true;},log:{info(){},warn(){},error(){}},parsePortOrDefault,
      writeManagementTokenFile(){return 'synthetic';},
      getRuntimeState(){return {ACTIVE_PROFILE:{},CONFIG:{localServer:{managementPort:Number(process.argv[2])}},
        ENTRY_SERVERS:[{host:'127.0.0.1',listenPort:Number(process.argv[3]),tls:false}],LOCAL_SERVER:{},MODEL_ROUTES:[],PORT:Number(process.argv[3])};}});
  `;
    const child = spawn(
      process.execPath,
      ['-e', script, root, String(management), String(entry), String(backend.address().port)],
      {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...createIsolatedTestEnv(process.env, root),
          MGMT_PORT: String(management),
          PORT: '',
        },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }
    );
    running.child = child;
    const exited = once(child, 'exit');
    running.exited = exited;
    const message = async () =>
      (await once(child, 'message', { signal: AbortSignal.timeout(5000) }))[0];
    assert.deepEqual(await message(), { event: 'ready' });
    const socket = net.createConnection({ host: '127.0.0.1', port: entry });
    running.socket = socket;
    socket.on('error', () => {});
    socket.resume();
    const socketClosed = once(socket, 'close', { signal: AbortSignal.timeout(4000) });
    // Keep the observation rejection owned even when a preceding assertion fails.
    socketClosed.catch(() => {});
    await once(socket, 'connect');
    const upgraded = message();
    socket.write(
      'GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    );
    assert.deepEqual(await upgraded, { event: 'upgraded' });
    const [peer] = await backendOpened;
    const peerClosed = once(peer, 'close', { signal: AbortSignal.timeout(4000) });
    peerClosed.catch(() => {});
    const draining = message();
    child.send('stop');
    assert.deepEqual(await draining, { event: 'draining' });
    await socketClosed;
    await peerClosed;
    assert.equal(child.exitCode, null, 'socket closure does not acknowledge pending recovery');
    child.send('release');
    assert.equal((await exited)[0], 0);
    assert.equal(fs.existsSync(path.join(root, '.proxy.pid')), false);
  }
);
