'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');

const script = `
const {startProxyServers}=require('./lib/proxy/server-lifecycle');
let release, reject;
process.on('message', message=>{
  if(message==='release')release('synthetic');
  if(message==='reject')reject(new Error('PRIVATE_ACL_ERROR'));
  if(message==='stop') { process.emit('SIGTERM'); process.send('stopping'); }
});
const entry={protocol:'openai-responses',host:'127.0.0.1',listenPort:Number(process.env.PORT),basePath:'/v1',tls:false};
startProxyServers({
  ACTIVE_HTTPS_SERVERS:[], APP_ID:'https-proxy-manager',DATA_DIR:process.env.PROXY_RUNTIME_DIR,
  ensureCert(){throw Error('unexpected TLS');}, exceptionHandlers:{setShutdownHook(){}},
  handleRequest(req,res){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({routed:true}));},
  installManagementCorsGuard(){return true;},log:{info(){},error(...args){if(JSON.stringify(args).includes('PRIVATE'))process.send('private-log');},warn(){}},
  parsePortOrDefault(value,fallback){return Number(value)||fallback;},
  writeManagementTokenFile(){process.send('writing');return new Promise((done,fail)=>{release=done;reject=fail;});},
  onReady(){process.send('ready');},
  contextRecoveryLifecycle:{shutdownAsync(){process.send('revoked');return Promise.resolve({ok:true});}},
  getRuntimeState(){return {ACTIVE_PROFILE:{id:'synthetic',targetUrl:'http://127.0.0.1:9'},CONFIG:{},ENTRY_SERVERS:[entry],LOCAL_SERVER:entry,MODEL_ROUTES:[],PORT:entry.listenPort};}
});`;

function get(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/v1/local/health', agent: false },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          })
        );
        response.on('error', reject);
      }
    );
    request.on('error', reject);
  });
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-credential-startup-'));
  const [port, management] = await findAvailablePorts(2);
  const env = createIsolatedTestEnv(process.env, directory);
  env.PORT = String(port);
  env.MGMT_PORT = String(management);
  fs.mkdirSync(env.PROXY_RUNTIME_DIR, { recursive: true });
  const child = spawn(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  const phases = new Set(),
    waiting = new Map();
  child.on('message', (phase) => {
    phases.add(phase);
    waiting.get(phase)?.resolve();
    waiting.delete(phase);
  });
  child.on('exit', () => {
    for (const waiter of waiting.values())
      waiter.reject(new Error('Startup fixture exited before requested phase'));
    waiting.clear();
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const phase = (name) =>
    phases.has(name)
      ? Promise.resolve()
      : new Promise((resolve, reject) => waiting.set(name, { resolve, reject }));
  await phase('writing');
  return { child, exited, phase, phases, port, management };
}

test(
  'actual management listener rejects requests while credentials are pending and opens entries only after acknowledgement',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const early = await get(f.management);
    assert.equal(early.status, 503);
    assert.equal(early.headers['cache-control'], 'no-store');
    assert.equal(early.body.includes('routed'), false);
    await assert.rejects(get(f.port), (error) => error.code === 'ECONNREFUSED');
    assert.equal(f.phases.has('ready'), false);
    f.child.send('release');
    await f.phase('ready');
    assert.equal((await get(f.management)).status, 200);
    assert.equal((await get(f.port)).status, 200);
    f.child.send('stop');
    assert.equal((await f.exited)[0], 0);
  }
);

test(
  'shutdown retains the actual management port until pending credentials finish and cannot activate late entries',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    f.child.send('stop');
    await f.phase('stopping');
    assert.equal(f.phases.has('revoked'), true);
    assert.equal(f.phases.has('private-log'), false);
    assert.equal((await get(f.management)).status, 503);
    const contender = net.createServer();
    const conflict = once(contender, 'error');
    contender.listen(f.management, '127.0.0.1');
    assert.equal((await conflict)[0].code, 'EADDRINUSE');
    f.child.send('release');
    assert.equal((await f.exited)[0], 0);
    assert.equal(f.phases.has('ready'), false);
    await assert.rejects(get(f.port), (error) => error.code === 'ECONNREFUSED');
  }
);

test(
  'credential rejection exits with failure without exposing the native error or opening entries',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    f.child.send('reject');
    assert.equal((await f.exited)[0], 1);
    assert.equal(f.phases.has('ready'), false);
    assert.equal(f.phases.has('revoked'), true);
    await assert.rejects(get(f.port), (error) => error.code === 'ECONNREFUSED');
  }
);
