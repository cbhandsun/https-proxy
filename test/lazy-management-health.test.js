'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');

test('production health retains the full response without loading unrelated management features', () => {
  const program = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    let blocked = 0;
    const failure = new Error('synthetic_unrelated_management_unavailable');
    Module._load = function(name) {
      if (['./handlers/management', '../usage', '../prompts-sync'].includes(name)) {
        blocked++;
        throw failure;
      }
      return Reflect.apply(load, this, arguments);
    };
    const {createLazyManagementHandlers} = require('./lib/proxy/lazy-management-handlers');
    const {contextRecoveryDiagnostics} = require('./lib/proxy/context-recovery-diagnostics');
    let current = {appSettings: {contextRecoveryEnabled: false}};
    let entries = [{protocol:'openai-responses',host:'127.0.0.1',listenPort:3445,tls:false}];
    const shutdown = {version:1,owner:'synthetic-owner'};
    const handlers = createLazyManagementHandlers({
      CONFIG: () => current, ENTRY_SERVERS: () => entries,
      APP_ID: 'health-test', PACKAGE_VERSION:'1.2.3', PORT:3443,
      proxyStopControl: {identity:shutdown}
    });
    assert.equal(handlers.isInitialized(), false);
    const health = handlers.health;
    assert.equal(health, handlers.handleLocalHealthRequest);
    let response;
    const res = {
      writeHead(status, headers) { assert.equal(status, 200); assert.deepEqual(headers, {
        'Content-Type':'application/json; charset=utf-8', 'access-control-allow-origin':'*'
      }); },
      end(text) { response = JSON.parse(text); }
    };
    health({}, res);
    assert.deepEqual(Object.keys(response), ['ok','appId','version','status','pid','shutdown','uptimeSec','tianxi','contextRecovery','runtime','ports']);
    assert.equal(response.appId,'health-test');
    assert.equal(response.version,'1.2.3');
    assert.equal(response.pid,process.pid);
    assert.deepEqual(response.shutdown,shutdown);
    assert.deepEqual(response.contextRecovery,contextRecoveryDiagnostics.inspect(current));
    assert.deepEqual(response.ports.entries,[{protocol:'openai-responses',host:'127.0.0.1',listenPort:3445,tls:false}]);
    assert.equal(response.ports.management,3543);
    assert.ok(require('node:path').isAbsolute(response.runtime.runtimeDir));
    assert.equal(handlers.isInitialized(),false);
    assert.equal(blocked,0);
    current = {localServer:{managementPort:4321},appSettings:{contextRecoveryEnabled:true}};
    entries = null;
    health({},res);
    assert.equal(response.ports.management,4321);
    assert.deepEqual(response.ports.entries,[]);
    assert.deepEqual(response.contextRecovery,contextRecoveryDiagnostics.inspect(current));
    assert.throws(() => handlers.initialize(),error=>error===failure);
    assert.equal(blocked,1);
    assert.equal(handlers.isInitialized(),false);
    assert.equal(handlers.health,health);
    health({},res);
  `;
  const result = spawnSync(process.execPath, ['-e', program], {
    cwd: repo,
    env: { ...process.env, MGMT_PORT: '' },
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 16384,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, 'health must preserve its contract without loading the aggregate');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

const { createManagementHealthHandler } = require('../lib/proxy/handlers/management-health');
const { createManagementCoreHandlers } = require('../lib/proxy/handlers/management-core');
const { createManagementBootstrapHandlers } = require('../lib/proxy/handlers/management-bootstrap');

test('extracted health matches the existing core for empty, invalid and extreme snapshots', () => {
  for (const [config, entries] of [
    [null, null],
    [{}, []],
    [{ localServer: { managementPort: 'invalid' } }, false],
    [
      { localServer: { managementPort: 65535 }, appSettings: { contextRecoveryEnabled: true } },
      [{ protocol: 'claude', host: '::1', listenPort: 65535, basePath: '/v1', tls: true }],
    ],
  ]) {
    const replies = [];
    const options = {
      sendJson: (_res, status, value) => replies.push({ status, value }),
      appId: 'health-equivalence',
      packageVersion: '1.2.3',
      defaultPort: 3443,
      currentConfigSnapshot: () => config,
      currentEntryServersSnapshot: () => entries,
      writeConfigFileAtomically: () => assert.fail('health must not write configuration'),
      reloadProxyConfig: () => assert.fail('health must not reload configuration'),
    };
    createManagementHealthHandler(options)({}, {});
    createManagementCoreHandlers(options).handleLocalHealthRequest({}, {});
    assert.equal(replies.length, 2);
    // Wall-clock uptime is sampled independently; all other fields are exact.
    assert.ok(Math.abs(replies[0].value.uptimeSec - replies[1].value.uptimeSec) <= 1);
    delete replies[0].value.uptimeSec;
    delete replies[1].value.uptimeSec;
    assert.deepEqual(replies[0], replies[1]);
  }
});

test('health rejects invalid dependencies and propagates snapshot, diagnostics and response failures', () => {
  for (const value of [undefined, null, [], false, 1, 'invalid'])
    assert.throws(() => createManagementBootstrapHandlers(value), TypeError);
  const valid = {
    sendJson: () => assert.fail('failure must not report health success'),
    currentConfigSnapshot: () => ({}),
    currentEntryServersSnapshot: () => [],
  };
  for (const name of ['sendJson', 'currentConfigSnapshot', 'currentEntryServersSnapshot'])
    for (const value of [undefined, null, false, {}, 'invalid'])
      assert.throws(() => createManagementHealthHandler({ ...valid, [name]: value }), TypeError);
  const failure = new Error('synthetic_health_failure');
  for (const change of [
    {
      currentConfigSnapshot: () => {
        throw failure;
      },
    },
    {
      currentEntryServersSnapshot: () => {
        throw failure;
      },
    },
    {
      recoveryDiagnostics: {
        inspect: () => {
          throw failure;
        },
      },
    },
    {
      sendJson: () => {
        throw failure;
      },
    },
  ]) {
    const handler = createManagementHealthHandler({ ...valid, ...change });
    assert.throws(
      () => handler({}, {}),
      (error) => error === failure
    );
  }
  const handler = createManagementBootstrapHandlers({ CONFIG: {}, ENTRY_SERVERS: [] }).health;
  assert.throws(
    () =>
      handler(
        {},
        {
          writeHead() {
            throw failure;
          },
        }
      ),
    (error) => error === failure
  );
});

test('native token verification and stop share existing handlers without loading writers', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { createIsolatedTestEnv } = require('../lib/test-runtime');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-management-bootstrap-'));
  try {
    const environment = createIsolatedTestEnv(process.env, root);
    const configFile = path.join(environment.PROXY_CONFIG_DIR, 'proxy.config.json');
    fs.mkdirSync(environment.PROXY_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...require('../lib/proxy/config').DEFAULT_CONFIG,
        activeProfile: 'fixture',
        profiles: [
          {
            id: 'fixture',
            name: 'Fixture',
            protocol: 'openai',
            targetUrl: 'https://example.invalid/v1',
            apiKey: 'fixture-private-profile',
          },
        ],
        claudeDesktop: { enabled: false },
        entryAuth: { enabled: true, keys: [{ id: 'fixture', key: 'fixture-private-entry' }] },
      })
    );
    const program = `
      const assert=require('node:assert/strict'),Module=require('node:module');
      const load=Module._load;
      Module._load=function(name){
        if(['./handlers/management','./management-config','./management-context-policy','../prompts-sync'].includes(name))throw Error('unexpected_management_writer');
        return Reflect.apply(load,this,arguments);
      };
      const {createLazyManagementHandlers}=require('./lib/proxy/lazy-management-handlers');
      const request={},stopResponse={};let stopped=0;
      const stop=(req,res)=>{assert.equal(req,request);assert.equal(res,stopResponse);stopped++;};
      const handlers=createLazyManagementHandlers({CONFIG:{},ENTRY_SERVERS:[],proxyStopControl:{handle:stop}});
      let response;
      handlers.getConfig({}, {
        writeHead(status){assert.equal(status,200);},
        end(text){response=JSON.parse(text);}
      });
      assert.equal(response.profiles[0].apiKey,'[redacted]');
      assert.equal(response.entryAuth.enabled,true);
      assert.equal(response.entryAuth.keys[0].key,'[redacted]');
      assert.match(response._revision,/^[a-f0-9]{64}$/);
      assert.equal(handlers.getConfig,handlers.handleLocalGetConfigRequest);
      assert.equal(handlers.proxyStop,stop);
      assert.equal(handlers.handleLocalProxyStopRequest,stop);
      handlers.proxyStop(request,stopResponse);
      assert.equal(stopped,1);
      assert.equal(handlers.isInitialized(),false);
      let unavailable;
      createLazyManagementHandlers({}).proxyStop({}, {
        writeHead(status){assert.equal(status,503);},end(text){unavailable=JSON.parse(text);}
      });
      assert.deepEqual(unavailable,{error:'proxy_stop_unavailable'});
    `;
    const child = spawnSync(process.execPath, ['-e', program], {
      cwd: repo,
      env: environment,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 16384,
      windowsHide: true,
    });
    assert.equal(child.error, undefined);
    assert.equal(
      child.status,
      0,
      'native config/stop must not depend on unrelated feature startup'
    );
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
