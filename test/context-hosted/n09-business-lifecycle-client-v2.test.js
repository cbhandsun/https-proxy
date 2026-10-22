'use strict';
// Pure source: EventEmitter child + fake HTTP. No executable, socket or model.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createN09LifecycleClient,
} = require('../../scripts/context-hosted/n09-business/lifecycle-client-v2.js');
const synthetic = () => ({ entryKey: '1'.repeat(48), upstreamKey: '2'.repeat(48) });
function fixture(t, mutation = () => {}) {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'n09-channel-pure-'));
  t.after(() => fs.rmSync(ownedRoot, { force: true, recursive: true }));
  const install = path.join(ownedRoot, 'installed');
  fs.mkdirSync(install);
  const caseRoot = path.join(ownedRoot, 'daemon-http-pure');
  fs.mkdirSync(caseRoot);
  const configDir = path.join(caseRoot, 'config');
  fs.mkdirSync(configDir);
  const runtimeDir = path.join(caseRoot, 'runtime');
  fs.mkdirSync(runtimeDir);
  const input = { ownedRoot, install, manifestSha256: 'a'.repeat(64) };
  const state = {
    commands: [],
    requests: [],
    token: undefined,
    environment: undefined,
    child: undefined,
    pid: 101,
    config: {
      _revision: 'r1',
      appSettings: { contextRecoveryEnabled: false, contextRecoveryPersistenceEnabled: false },
    },
  };
  const identity = () => ({
    pid: state.pid,
    entrypoint: path.join(install, 'openai-proxy.js'),
    cwd: install,
    configDir,
    runtimeDir,
    managementPort: 12345,
    entryPort: 12346,
    manifestSha256: input.manifestSha256,
    phase: 'running',
    evidenceLevel: 'lifecycle-identity-only',
    liveDaemonProved: false,
  });
  const start = (executable, args, options) => {
    state.token = options.env.HPM_N09_BOOTSTRAP_TOKEN;
    state.environment = options.env;
    state.launch = { executable, args, shell: options.shell, windowsHide: options.windowsHide };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    state.child = child;
    let ended = false;
    child.stdin.end = () => {
      if (!ended) {
        ended = true;
        queueMicrotask(() => child.emit('close', 0, null));
      }
    };
    child.kill = () => {
      ended = true;
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    child.stdin.write = (frame, callback) => {
      assert.equal(frame.includes(state.token), false);
      const request = JSON.parse(frame);
      state.commands.push(request);
      const out = { v: 1, id: request.id, op: request.op, ok: true };
      if (request.op === 'start') {
        out.leaseId = 'b'.repeat(32);
        out.identity = identity();
      }
      if (request.op === 'restart') {
        state.pid++;
        out.identity = identity();
      }
      if (request.op === 'status')
        out.status = { alive: true, credentialsPrivate: true, preloadPhase: 'passed' };
      if (request.op === 'stop')
        out.cleanup = {
          pid: state.pid,
          treeEmpty: true,
          shutdownInvoked: false,
          semantics: 'forced_cleanup',
        };
      mutation('reply', out, state);
      queueMicrotask(() => {
        if (!ended) child.stdout.emit('data', Buffer.from(JSON.stringify(out) + '\n'));
        callback?.();
      });
      return true;
    };
    return child;
  };
  const httpRequest = (options, accept) => {
    assert.equal(options.hostname, '127.0.0.1');
    assert.equal(options.port, 12345);
    assert.equal(options.headers['x-mgmt-token'] === state.token, true);
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = (body) =>
      queueMicrotask(() => {
        state.requests.push({ path: options.path, method: options.method });
        let value;
        if (options.path === '/v1/local/health')
          value = {
            ok: true,
            appId: 'https-proxy-manager',
            status: 'running',
            pid: state.pid,
            runtime: {
              entrypoint: path.join(install, 'openai-proxy.js'),
              cwd: install,
              configDir,
              runtimeDir,
            },
            ports: { management: 12345 },
            contextRecovery: {
              appliedEnabled: state.config.appSettings.contextRecoveryEnabled,
              storage: state.config.appSettings.contextRecoveryEnabled ? 'persistent' : 'memory',
            },
          };
        else if (options.path === '/v1/local/config' && options.method === 'GET')
          value = state.config;
        else if (options.path === '/v1/local/config' && options.method === 'POST') {
          state.config = { ...JSON.parse(body), _revision: 'r2' };
          value = { ok: true, revision: 'r2' };
        } else if (options.path === '/v1/local/context-recovery/clear') {
          assert.equal(body, '{"confirm":true}');
          value = { ok: true, scope: 'proxy_context_recovery' };
        } else throw new Error('unexpected_test_route');
        mutation('http', value, state);
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json' };
        response.destroy = () => {};
        accept(response);
        response.emit('data', Buffer.from(JSON.stringify(value)));
        response.emit('end');
      });
    return request;
  };
  const client = createN09LifecycleClient(input, { spawn: start, httpRequest });
  return { client, state, input, runtimeDir };
}
test('actual lifecycle composition uses fixed entry, private bootstrap token, physical pins, fixed config/clear', async (t) => {
  const f = fixture(t);
  const first = await f.client.startLifecycle();
  assert.equal(first.evidenceLevel, 'lifecycle-identity-only');
  assert.equal(first.liveDaemonProved, false);
  assert.equal(JSON.stringify(first).includes(f.state.token), false);
  assert.equal(
    f.state.launch.args.some((argument) => argument.includes(f.state.token)),
    false
  );
  assert.equal(Object.hasOwn(f.state.environment, 'HPM_N09_BOOTSTRAP_TOKEN'), false);
  assert.equal(f.state.launch.shell, false);
  assert.equal(f.state.launch.windowsHide, true);
  assert.equal(f.state.launch.executable, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  await f.client.setCombination(first, '11');
  const clear = f.client.getClearCapability(first);
  assert.equal((await clear()).durableBoundary, 'await-clearAsync');
  assert.equal((await f.client.stopLifecycle(first)).treeEmpty, true);
  const next = await f.client.restartLifecycle(first);
  assert.notEqual(next.pid, first.pid);
  assert.equal(next.configDir, first.configDir);
  assert.equal(next.runtimeDir, first.runtimeDir);
  await assert.rejects(clear(), /^Error: n09_lifecycle_client_failed$/);
  await f.client.close();
  await f.client.close();
  assert.equal(f.state.commands.filter((value) => value.op === 'remove').length, 1);
  assert.deepEqual(
    f.state.commands.map((value) => value.op),
    ['start', 'status', 'status', 'stop', 'restart', 'remove']
  );
});
test('directory substitution rejects restart without a new child and finally removes owner', async (t) => {
  const f = fixture(t);
  const first = await f.client.startLifecycle();
  await f.client.stopLifecycle(first);
  fs.renameSync(f.runtimeDir, f.runtimeDir + '-original');
  fs.mkdirSync(f.runtimeDir);
  await assert.rejects(f.client.restartLifecycle(first), /^Error: n09_lifecycle_client_failed$/);
  await f.client.close();
  assert.equal(
    f.state.commands.some((value) => value.op === 'restart'),
    false
  );
  assert.equal(f.state.commands.at(-1).op, 'remove');
});
test('invalid/reused restart PID triggers owned cleanup without false live branding', async (t) => {
  const f = fixture(t, (at, packet) => {
    if (at === 'reply' && packet.op === 'restart') packet.identity.pid = 101;
  });
  const first = await f.client.startLifecycle();
  await f.client.stopLifecycle(first);
  await assert.rejects(f.client.restartLifecycle(first), /^Error: n09_lifecycle_client_failed$/);
  // Test fake reports actual pid 102 in cleanup; that mismatch remains a failure,
  // but independent remove and controller close must still execute.
  await f.client.close();
  assert.equal(
    f.state.commands.some((value) => value.op === 'remove'),
    true
  );
});
test('unknown stdout/stderr fails closed and child exit remains failure', async (t) => {
  const f = fixture(t);
  await f.client.startLifecycle();
  f.state.child.stdout.emit('data', Buffer.from('PRIVATE-unknown'));
  f.state.child.stderr.emit('data', Buffer.from('PRIVATE-stderr'));
  await assert.rejects(f.client.close(), /^Error: n09_lifecycle_client_failed$/);
  await assert.rejects(f.client.close(), /^Error: n09_lifecycle_client_failed$/);
});
test('config or health mismatch never returns a usable clear completion', async (t) => {
  const f = fixture(t, (at, value) => {
    if (at === 'http' && value.appId) value.pid = 999;
  });
  const first = await f.client.startLifecycle();
  await assert.rejects(
    f.client.getClearCapability(first)(),
    /^Error: n09_lifecycle_client_failed$/
  );
  assert.equal(
    f.state.requests.some((value) => value.path.endsWith('/clear')),
    false
  );
  await f.client.close();
});

test('fixed synthetic configuration uses private management and owner port with revision/application evidence', async (t) => {
  const f = fixture(t),
    first = await f.client.startLifecycle();
  const result = await f.client.configureSyntheticBusiness(first, synthetic());
  assert.deepEqual(result, {
    configured: true,
    evidenceLevel: 'synthetic-management-configuration',
    dailyConfigurationUsed: false,
  });
  assert.equal(JSON.stringify(result).includes(f.state.token), false);
  assert.equal(f.state.config.profiles[0].targetUrl, 'https://api.openai.com/v1');
  assert.equal(f.state.config.profiles[0].apiKey, synthetic().upstreamKey);
  assert.deepEqual(f.state.config.entryAuth.keys[0].allowedEntryPorts, [12346]);
  assert.equal(f.state.config.appSettings.contextRecoveryPersistenceEnabled, true);
  assert.equal(f.state.config.appSettings.verifyUpstreamTls, true);
  assert.deepEqual(await f.client.attestSyntheticBusiness(first), {
    ready: true,
    syntheticBusinessConfigured: true,
  });
  await f.client.stopLifecycle(first);
  const next = await f.client.restartLifecycle(first);
  const writes = f.state.requests.filter((value) => value.method === 'POST').length;
  assert.equal((await f.client.attestSyntheticBusiness(next)).ready, true);
  assert.equal(f.state.requests.filter((value) => value.method === 'POST').length, writes);
  await f.client.close();
});
test('toggle preserves private synthetic credentials rather than redacted GET values', async (t) => {
  const f = fixture(t, (at, value, state) => {
    if (at === 'http' && value._revision && value.profiles) {
      // The fake GET mutates its own config too; toggle must rebuild from its
      // private synthetic closure rather than trust these redacted strings.
      value.profiles[0].apiKey = '<redacted>';
      value.entryAuth.keys[0].key = '<redacted>';
    }
    if (at === 'http' && value.ok === true && value.revision) {
      state.lastSavedSecrets = [
        state.config.profiles[0].apiKey,
        state.config.entryAuth.keys[0].key,
      ];
    }
  });
  const first = await f.client.startLifecycle();
  await f.client.configureSyntheticBusiness(first, synthetic());
  for (const combination of ['00', '01', '10', '11']) {
    await f.client.setCombination(first, combination);
    assert.deepEqual(f.state.lastSavedSecrets, [synthetic().upstreamKey, synthetic().entryKey]);
  }
  await f.client.close();
});
test('synthetic fixture rejects extra fields, getters, proxy and unsafe size before management writes', async (t) => {
  const f = fixture(t),
    first = await f.client.startLifecycle();
  let traps = 0;
  const cases = [
    null,
    {},
    { ...synthetic(), targetUrl: 'https://PRIVATE.invalid' },
    { entryKey: '', upstreamKey: '2'.repeat(48) },
    { entryKey: '1'.repeat(100000), upstreamKey: '2'.repeat(48) },
    {
      get entryKey() {
        traps++;
        return '1'.repeat(48);
      },
      upstreamKey: '2'.repeat(48),
    },
    new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          return [];
        },
      }
    ),
  ];
  for (const value of cases)
    await assert.rejects(
      f.client.configureSyntheticBusiness(first, value),
      /^Error: n09_lifecycle_client_failed$/
    );
  assert.equal(traps, 0);
  assert.equal(f.state.requests.length, 0);
  await f.client.close();
});
test('a second synthetic authority cannot replace the already pinned fixture', async (t) => {
  const f = fixture(t),
    first = await f.client.startLifecycle();
  await f.client.configureSyntheticBusiness(first, synthetic());
  await assert.rejects(
    f.client.configureSyntheticBusiness(first, {
      entryKey: '3'.repeat(48),
      upstreamKey: '4'.repeat(48),
    }),
    /^Error: n09_lifecycle_client_failed$/
  );
  await f.client.close();
});
test('unexpected management application or revision fails with fixed error', async (t) => {
  const f = fixture(t, (at, value) => {
    if (at === 'http' && value._revision === 'r2') value.activeProfile = 'PRIVATE';
  });
  const first = await f.client.startLifecycle();
  await assert.rejects(
    f.client.configureSyntheticBusiness(first, synthetic()),
    /^Error: n09_lifecycle_client_failed$/
  );
  await f.client.close();
});
