'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { isDeepStrictEqual, types } = require('node:util');
const { performance } = require('node:perf_hooks');
const { setTimeout: wait } = require('node:timers/promises');
const { safePath, digest, verifyInstallation } = require('./nsis-encrypted-contract');
const {
  executeWorkerDriver,
  inspectOwnedStore,
} = require('./context-recovery-legacy-layout-runtime');
const { createDaemonManagementHttpClient } = require('./context-recovery-daemon-http-client');
const { executeNativeControl } = require('./nsis-native-control-transport');
const { exerciseNativeControl, exact } = require('./nsis-native-control-contract');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const PHASES = [
  'seed',
  'start-1',
  'ready-1',
  'stop-1',
  'read-1',
  'start-2',
  'ready-2',
  'stop-2',
  'read-2',
  'complete',
];
const fail = () => new Error('native_control_probe_failed');

function phaseWriter(root) {
  safePath(root, true);
  const pin = fs.statSync(root, { bigint: true }),
    target = path.join(root, 'native-control-phase.json');
  if (fs.existsSync(target)) throw fail();
  return (phase) => {
    if (!PHASES.includes(phase)) throw fail();
    safePath(root, true);
    const current = fs.statSync(root, { bigint: true });
    if (['dev', 'ino', 'birthtimeNs'].some((key) => current[key] !== pin[key])) throw fail();
    const temporary = path.join(root, 'native-control-phase.tmp');
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, phase }), {
      flag: 'wx',
      mode: 0o600,
    });
    if (fs.existsSync(target)) safePath(target);
    fs.renameSync(temporary, target);
  };
}
async function ports() {
  const held = [];
  try {
    for (let index = 0; index < 2; index++) {
      const server = net.createServer();
      held.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return held.map((server) => server.address().port);
  } finally {
    await Promise.all(
      held.map((server) =>
        server.listening
          ? new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            )
          : undefined
      )
    );
  }
}
function assertWriterOwned(store) {
  const { DatabaseSync } = require('node:sqlite');
  let database,
    blocked = false;
  try {
    database = new DatabaseSync(safePath(path.join(store, '.writer.sqlite')), {
      allowExtension: false,
    });
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');
  } catch (error) {
    if (error?.code !== 'ERR_SQLITE_ERROR' || error.errcode !== 5) throw fail();
    blocked = true;
  } finally {
    database?.close();
  }
  if (!blocked) throw fail();
}
function checkHealth(body, install, managementPort, entryPort) {
  body = dataSnapshot(body, 'native_control_probe_failed');
  const same = (input, expected) =>
    typeof input === 'string' && input.toLowerCase() === expected.toLowerCase();
  const runtime = body?.runtime,
    identity = exact(body?.shutdown, ['pid', 'instanceId']);
  if (
    body.appId !== 'https-proxy-manager' ||
    !Number.isSafeInteger(body.pid) ||
    body.pid < 1 ||
    body.pid > 0xffffffff ||
    body.pid === process.pid ||
    identity.pid !== body.pid ||
    typeof identity.instanceId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(identity.instanceId) ||
    !runtime ||
    !same(runtime.entrypoint, path.join(install, 'openai-proxy.js')) ||
    !same(runtime.cwd, install) ||
    !same(runtime.configDir, install) ||
    !same(runtime.runtimeDir, path.join(install, '.hpm-runtime')) ||
    !same(
      runtime.contextRecoveryDirectory,
      path.join(install, '.hpm-runtime/context-recovery-v1')
    ) ||
    body.ports?.management !== managementPort ||
    !Array.isArray(body.ports.entries) ||
    body.ports.entries.length !== 1 ||
    body.ports.entries[0].host !== '127.0.0.1' ||
    body.ports.entries[0].listenPort !== entryPort ||
    body.ports.entries[0].tls !== false ||
    body.ports.entries[0].protocol !== 'openai-chat'
  )
    throw fail();
  const projection = body.contextRecovery;
  if (
    !projection ||
    projection.configValid !== true ||
    projection.requestedEnabled !== true ||
    projection.restartRetention !== false ||
    ['failed', 'unavailable'].includes(projection.state)
  )
    throw fail();
  return {
    identity,
    ready:
      projection.appliedEnabled === true &&
      projection.storage === 'persistent' &&
      projection.state === 'enabled_restricted',
  };
}

function parseProbeArguments(input, checkedPath = safePath) {
  if (
    types.isProxy(input) ||
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length !== 6 ||
    Reflect.ownKeys(input).length !== 7
  )
    throw fail();
  const values = Array.from({ length: 6 }, (_, index) => {
    const slot = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      !slot?.enumerable ||
      !Object.hasOwn(slot, 'value') ||
      typeof slot.value !== 'string' ||
      slot.value.length > 4096
    )
      throw fail();
    return slot.value;
  });
  if (
    !values
      .slice(3)
      .every((v, index) => new RegExp(index === 1 ? '^[a-f0-9]{40}$' : '^[a-f0-9]{64}$').test(v))
  )
    throw fail();
  const [root, install, executor] = values.slice(0, 3).map((value) => checkedPath(value, true));
  if (
    ![install, executor].every((p) => p.toLowerCase().startsWith(root.toLowerCase() + path.sep)) ||
    install.toLowerCase() === executor.toLowerCase() ||
    install.toLowerCase().startsWith(executor.toLowerCase() + path.sep) ||
    executor.toLowerCase().startsWith(install.toLowerCase() + path.sep)
  )
    throw fail();
  return {
    root,
    install,
    executor,
    manifest: values[3],
    sourceCommit: values[4],
    appHash: values[5],
  };
}

async function run(args) {
  if (
    process.platform !== 'win32' ||
    process.execArgv.length ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.env.NODE_V8_COVERAGE ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.CI !== 'true'
  )
    throw fail();
  const { install, executor, manifest, sourceCommit, appHash } = parseProbeArguments(args);
  if (sourceCommit !== process.env.GITHUB_SHA || process.env.RUNNER_OS !== 'Windows') throw fail();
  const installation = verifyInstallation(install, manifest),
    program = path.join(install, 'https-proxy-manager.exe');
  if (
    fs.realpathSync.native(process.execPath).toLowerCase() !==
      fs.realpathSync.native(installation.node).toLowerCase() ||
    digest(program) !== appHash
  )
    throw fail();
  const verify = () => {
    if (
      !isDeepStrictEqual(installation, verifyInstallation(install, manifest)) ||
      digest(program) !== appHash
    )
      throw fail();
  };
  const config = path.join(install, 'proxy.config.json'),
    original = fs.readFileSync(safePath(config));
  if (
    !original.equals(
      fs.readFileSync(path.resolve(__dirname, '../fixtures/nsis-lifecycle-offline-config.json'))
    )
  )
    throw fail();
  const runtime = path.join(install, '.hpm-runtime'),
    store = path.join(runtime, 'context-recovery-v1');
  if (fs.existsSync(store)) throw fail();
  if (!fs.existsSync(runtime)) fs.mkdirSync(runtime);
  safePath(runtime, true);
  fs.mkdirSync(store);
  const environment = {};
  for (const name of [
    'SystemRoot',
    'WINDIR',
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
  ])
    if (process.env[name]) environment[name] = process.env[name];
  const token = randomBytes(24).toString('hex'),
    nativeEnv = { ...environment, MGMT_TOKEN: token, PROXY_DISABLE_CONVERSATION_AUDIT: '1' };
  const [managementPort, entryPort] = await ports();
  const configuration = JSON.parse(original.toString('utf8'));
  configuration.localServer = {
    host: '127.0.0.1',
    listenPort: entryPort,
    managementPort,
    basePath: '/v1',
    protocol: 'openai-chat',
  };
  configuration.entryServers = [{ ...configuration.localServer, tls: false }];
  configuration.appSettings.contextRecoveryEnabled = true;
  configuration.appSettings.contextRecoveryPersistenceEnabled = true;
  const phase = phaseWriter(executor),
    client = createDaemonManagementHttpClient({ port: managementPort, token });
  const owned = {
    store,
    verify: () => {
      safePath(runtime, true);
      safePath(store, true);
    },
    environment: () => environment,
  };
  const ready = async () => {
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      const response = await client({ method: 'GET', route: '/v1/local/health' });
      if (response.status !== 200) throw fail();
      const result = checkHealth(response.body, install, managementPort, entryPort);
      if (result.ready && fs.existsSync(path.join(runtime, `.mgmt-token-${managementPort}`))) {
        safePath(path.join(runtime, `.mgmt-token-${managementPort}`));
        assertWriterOwned(store);
        return result.identity;
      }
      await wait(50);
    }
    throw fail();
  };
  fs.writeFileSync(safePath(config), JSON.stringify(configuration));
  const receipt = await exerciseNativeControl(
    {
      fixture: (operation) => executeWorkerDriver({ installation, install, operation, owned }),
      control: (command) => executeNativeControl(program, command, nativeEnv, install),
      ready,
      inspect: () => inspectOwnedStore(owned),
      verify,
      phase,
    },
    installation
  );
  // No restoration or deletion occurs after a failed/unconfirmed stop. The
  // owning Job then performs explicitly failed cleanup before uninstall.
  fs.writeFileSync(safePath(config), original);
  if (!fs.readFileSync(config).equals(original)) throw fail();
  verify();
  return { ...receipt, sourceCommit, manifestSha256: manifest, applicationSha256: appHash };
}
module.exports = { run, phaseWriter, assertWriterOwned, checkHealth, parseProbeArguments, PHASES };
