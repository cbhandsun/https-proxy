'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { safePath } = require('./nsis-encrypted-contract');
const {
  methods,
  dataSnapshot,
  settle,
  callable,
} = require('./context-recovery-daemon-http-boundary');
const { parseOwnedStartupProtocols } = require('./context-recovery-daemon-owned-startup');
const { LABELS, identity } = require('./context-recovery-daemon-owned-protocol');
const { createDaemonManagementHttpClient } = require('./context-recovery-daemon-http-client');
const {
  PRELOAD_PHASES,
  ownedFailure,
  ownedDiagnostic,
} = require('./context-recovery-daemon-owned-failure');
const fail = (cause, cleanupCause = null, preloadPhase) =>
  cause === undefined
    ? new Error('daemon_owned_adapter_failed')
    : ownedFailure('daemon_owned_adapter_failed', cause, cleanupCause, preloadPhase);
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}
const pin = (directory) => {
  safePath(directory, true);
  const { dev, ino, birthtimeMs } = fs.lstatSync(directory);
  return { dev, ino, birthtimeMs };
};
function unchanged(directory, expected) {
  const current = pin(directory);
  return (
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.birthtimeMs === expected.birthtimeMs
  );
}

function inspectOwnedStorage(runtimeDir, expected) {
  if (!unchanged(runtimeDir, expected)) throw fail();
  const directory = path.join(runtimeDir, 'context-recovery-v1');
  const present = fs.existsSync(directory);
  const names = new Set([
    '.writer.sqlite',
    '.data-key',
    'checkpoint.sqlite',
    'checkpoint.sqlite-journal',
    '.writer.sqlite-journal',
    '.hpm-secured',
  ]);
  if (present) {
    safePath(directory, true);
    const files = fs.readdirSync(directory);
    if (files.length > names.size) throw fail();
    for (const name of files) {
      if (!names.has(name)) throw fail();
      safePath(path.join(directory, name));
    }
  }
  const has = (name) => present && fs.existsSync(path.join(directory, name));
  return {
    allWithinRoot: true,
    directoryPresent: present,
    checkpointPresent: has('checkpoint.sqlite'),
    writerDatabasePresent: has('.writer.sqlite'),
    wrappedKeyPresent: has('.data-key'),
  };
}

function readyHealth(reply, attested, initialProtocol) {
  if (reply.status !== 200) return false;
  const body = reply.body;
  const runtime = body?.runtime;
  const entry = body?.ports?.entries;
  const policy = body?.contextRecovery;
  if (
    body?.ok !== true ||
    body.appId !== 'https-proxy-manager' ||
    body.status !== 'running' ||
    body.pid !== attested.pid ||
    !runtime ||
    !samePath(runtime.entrypoint, attested.entrypoint) ||
    !samePath(runtime.cwd, attested.cwd) ||
    !samePath(runtime.configDir, attested.configDir) ||
    !samePath(runtime.runtimeDir, attested.runtimeDir) ||
    !samePath(
      runtime.contextRecoveryDirectory,
      path.join(attested.runtimeDir, 'context-recovery-v1')
    ) ||
    body.ports?.management !== attested.managementPort ||
    !Array.isArray(entry) ||
    entry.length !== 1 ||
    entry[0]?.host !== '127.0.0.1' ||
    entry[0]?.listenPort !== attested.entryPort ||
    entry[0]?.protocol !== initialProtocol ||
    entry[0]?.tls !== false ||
    policy?.configValid !== true ||
    policy.requestedEnabled !== false ||
    policy.appliedEnabled !== false ||
    policy.state !== 'disabled' ||
    policy.storage !== 'memory' ||
    policy.restartRetention !== false
  )
    throw fail();
  return true;
}

// Trusted dependency injection permits offline protocol/HTTP tests. Production
// uses startDaemonOwnedController as channel; no arbitrary executable crosses it.
function createDaemonOwnedAdapter(input, channel, dependencies) {
  let options, wire, io, initialProtocols;
  try {
    options = dataSnapshot(input, 'daemon_owned_adapter_failed');
    if (
      !['install,ownedRoot', 'initialEntryProtocols,install,ownedRoot'].includes(
        Object.keys(options).sort().join(',')
      )
    )
      throw fail();
    initialProtocols = parseOwnedStartupProtocols(options.initialEntryProtocols);
    options.ownedRoot = safePath(options.ownedRoot, true);
    options.install = safePath(options.install, true);
    if (!inside(options.ownedRoot, options.install)) throw fail();
    wire = methods(channel, ['exchange', 'close'], 'daemon_owned_adapter_failed');
    io =
      dependencies === undefined
        ? {
            now: () => performance.now(),
            wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
            token: () => randomBytes(24).toString('base64url'),
            client: createDaemonManagementHttpClient,
          }
        : methods(dependencies, ['now', 'wait', 'token', 'client'], 'daemon_owned_adapter_failed');
  } catch {
    throw fail();
  }
  const attestations = new WeakMap();
  const usedDirectories = new Set();
  const usedPorts = new Set();
  let next = 0;
  let active = null;
  let activeLabel = null;
  let blocked = false;
  async function exchange(request) {
    return dataSnapshot(
      (await settle(wire.exchange(request), 'daemon_owned_adapter_failed')).value,
      'daemon_owned_adapter_failed'
    );
  }
  async function stop(label) {
    try {
      const reply = await exchange({ op: 'stop', case: label });
      if (
        reply.ok !== true ||
        reply.case !== label ||
        reply.op !== 'stop' ||
        reply.treeEmpty !== true ||
        reply.cleanupSemantics !== 'forced_cleanup'
      )
        throw fail();
      active = null;
      activeLabel = null;
      return true;
    } catch (error) {
      blocked = true;
      throw fail(ownedDiagnostic(error)?.cause ?? 'stop_failed');
    }
  }
  async function launch(input) {
    let label;
    let attempted = false;
    let stage = 'launch_input';
    let preloadPhase;
    try {
      const request = dataSnapshot(input, 'daemon_owned_adapter_failed');
      if (
        Object.keys(request).sort().join(',') !== 'initialEnabled,initialPersistence,label' ||
        request.initialEnabled !== false ||
        request.initialPersistence !== false ||
        blocked ||
        active !== null ||
        request.label !== LABELS[next]
      )
        throw fail();
      label = request.label;
      const token = io.token();
      if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw fail();
      attempted = true;
      stage = 'start_rpc';
      const reply = await exchange({ op: 'start', case: label, token });
      stage = 'identity_rejected';
      const attested = identity(reply.identity);
      if (
        reply.ok !== true ||
        reply.op !== 'start' ||
        reply.case !== label ||
        !samePath(attested.cwd, options.install) ||
        !samePath(attested.entrypoint, path.join(options.install, 'openai-proxy.js'))
      )
        throw fail();
      const caseRoot = path.dirname(attested.configDir);
      if (
        !inside(options.ownedRoot, caseRoot) ||
        inside(options.install, caseRoot) ||
        samePath(options.install, caseRoot) ||
        !samePath(attested.configDir, path.join(caseRoot, 'config')) ||
        !samePath(attested.runtimeDir, path.join(caseRoot, 'runtime'))
      )
        throw fail();
      for (const directory of [attested.configDir, attested.runtimeDir]) {
        safePath(directory, true);
        if (
          [...usedDirectories].some(
            (used) =>
              samePath(directory, used) || inside(used, directory) || inside(directory, used)
          )
        )
          throw fail();
        usedDirectories.add(directory);
      }
      for (const port of [attested.managementPort, attested.entryPort]) {
        if (usedPorts.has(port)) throw fail();
        usedPorts.add(port);
      }
      const runtimePin = pin(attested.runtimeDir);
      const configPin = pin(attested.configDir);
      const http = io.client({ port: attested.managementPort, token });
      if (!callable(http)) throw fail();
      const owner = {
        identity: attested,
        async isAlive() {
          if (active !== owner || blocked) return false;
          const status = await exchange({ op: 'status', case: label });
          if (
            status.ok !== true ||
            status.op !== 'status' ||
            status.case !== label ||
            typeof status.alive !== 'boolean' ||
            (Object.hasOwn(status, 'preloadPhase') && !PRELOAD_PHASES.includes(status.preloadPhase))
          )
            throw fail();
          if (Object.hasOwn(status, 'preloadPhase')) preloadPhase = status.preloadPhase;
          credentialBoundary = status.credentialsPrivate === true;
          return status.alive;
        },
        request: (request) => http(request),
        inspectStorage: () => inspectOwnedStorage(attested.runtimeDir, runtimePin),
        async stop() {
          if (active !== owner) throw fail();
          return stop(label);
        },
      };
      let credentialBoundary = false;
      active = owner;
      activeLabel = label;
      attestations.set(owner, { attested, runtimePin, configPin });
      const start = io.now();
      let readinessCause = 'readiness_deadline';
      if (!Number.isFinite(start)) throw fail();
      let previous = start;
      for (let polls = 0; polls < 300; polls++) {
        stage = readinessCause;
        const now = io.now();
        if (!Number.isFinite(now) || now < previous || now - start >= 15000) throw fail();
        previous = now;
        stage = 'status_rpc';
        if (!(await owner.isAlive())) throw fail('daemon_exited');
        let health;
        try {
          health = dataSnapshot(
            (
              await settle(
                http({ method: 'GET', route: '/v1/local/health' }),
                'daemon_owned_adapter_failed'
              )
            ).value,
            'daemon_owned_adapter_failed'
          );
        } catch {
          health = null;
          readinessCause = 'health_request_failed';
        }
        stage = readinessCause;
        const after = io.now();
        if (!Number.isFinite(after) || after < previous || after - start >= 15000) throw fail();
        previous = after;
        stage = 'ready_health_rejected';
        if (health && readyHealth(health, attested, initialProtocols[next])) {
          stage = 'config_rejected';
          const config = dataSnapshot(
            (
              await settle(
                http({ method: 'GET', route: '/v1/local/config' }),
                'daemon_owned_adapter_failed'
              )
            ).value,
            'daemon_owned_adapter_failed'
          );
          if (
            config.status !== 200 ||
            typeof config.body?._revision !== 'string' ||
            !config.body._revision ||
            config.body._revision.length > 256 ||
            config.body.appSettings?.contextRecoveryEnabled !== false ||
            config.body.appSettings.contextRecoveryPersistenceEnabled !== false
          )
            throw fail();
          stage = 'status_rpc';
          if (!(await owner.isAlive())) throw fail('daemon_exited');
          if (!credentialBoundary) throw fail('credentials_rejected');
          stage = 'readiness_deadline';
          const readyAt = io.now();
          if (!Number.isFinite(readyAt) || readyAt < previous || readyAt - start >= 15000)
            throw fail();
          next++;
          return owner;
        }
        if (health) readinessCause = 'ready_health_rejected';
        stage = readinessCause;
        await settle(io.wait(50), 'daemon_owned_adapter_failed');
      }
      throw fail();
    } catch (error) {
      // Keep the first trusted failure. Cleanup is a separate observation and
      // must never replace the reason that launch failed.
      const cause = ownedDiagnostic(error)?.cause ?? stage;
      let cleanupCause = null;
      blocked = true;
      if (attempted) {
        try {
          await stop(label);
        } catch (cleanupError) {
          cleanupCause = ownedDiagnostic(cleanupError)?.cause ?? 'stop_failed';
          try {
            await settle(wire.close(), 'daemon_owned_adapter_failed');
          } catch {
            // The first cleanup failure remains the cleanup cause.
          }
        }
      }
      throw fail(cause, cleanupCause, preloadPhase);
    }
  }
  return {
    launch,
    verifyOwnedIdentity(owner) {
      const proof = attestations.get(owner);
      return (
        !!proof &&
        active === owner &&
        !blocked &&
        owner.identity === proof.attested &&
        unchanged(proof.attested.runtimeDir, proof.runtimePin) &&
        unchanged(proof.attested.configDir, proof.configPin)
      );
    },
    now: () => io.now(),
    wait: (milliseconds) => io.wait(milliseconds),
    async close() {
      let cause = null;
      try {
        if (active !== null) await stop(activeLabel);
      } catch (error) {
        cause = ownedDiagnostic(error)?.cause ?? 'stop_failed';
      }
      blocked = true;
      try {
        if ((await settle(wire.close(), 'daemon_owned_adapter_failed')).value !== true)
          cause ??= 'close_failed';
      } catch (error) {
        cause ??= ownedDiagnostic(error)?.cause ?? 'close_failed';
      }
      if (cause !== null) throw fail(cause);
      return true;
    },
  };
}

module.exports = { createDaemonOwnedAdapter };
