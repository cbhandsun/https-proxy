'use strict';

const path = require('node:path');
const { ownedDiagnostic } = require('./context-recovery-daemon-owned-failure');
const {
  fail,
  failureCode,
  record,
  own,
  methods,
  settle,
  dataSnapshot,
} = require('./context-recovery-daemon-http-boundary');

const CASES = Object.freeze(['00', '01', '10', '11']);
function absolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
}

function samePath(left, right) {
  return absolute(left) && absolute(right) && normalizedPath(left) === normalizedPath(right);
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function overlappingPaths(left, right) {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  return contains(a, b) || contains(b, a);
}

function validIdentity(identity) {
  return (
    record(identity) &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    absolute(identity.entrypoint) &&
    path.basename(normalizedPath(identity.entrypoint)) === 'openai-proxy.js' &&
    absolute(identity.cwd) &&
    samePath(path.dirname(identity.entrypoint), identity.cwd) &&
    absolute(identity.configDir) &&
    absolute(identity.runtimeDir) &&
    !overlappingPaths(identity.configDir, identity.runtimeDir) &&
    [identity.managementPort, identity.entryPort].every(
      (port) => Number.isSafeInteger(port) && port >= 1024 && port <= 65535
    ) &&
    identity.managementPort !== identity.entryPort
  );
}

function verifyHealth(body, identity) {
  const runtime = body?.runtime;
  const entries = body?.ports?.entries;
  if (
    !record(body) ||
    body.ok !== true ||
    body.appId !== 'https-proxy-manager' ||
    body.status !== 'running' ||
    body.pid !== identity.pid ||
    !record(runtime) ||
    !samePath(runtime.entrypoint, identity.entrypoint) ||
    !samePath(runtime.cwd, identity.cwd) ||
    !samePath(runtime.configDir, identity.configDir) ||
    !samePath(runtime.runtimeDir, identity.runtimeDir) ||
    !samePath(
      runtime.contextRecoveryDirectory,
      path.join(identity.runtimeDir, 'context-recovery-v1')
    ) ||
    body.ports?.management !== identity.managementPort ||
    !Array.isArray(entries) ||
    entries.length !== 1 ||
    entries[0]?.host !== '127.0.0.1' ||
    entries[0]?.listenPort !== identity.entryPort ||
    entries[0]?.protocol !== 'openai-responses' ||
    entries[0]?.tls !== false
  )
    fail('identity_mismatch');
  return body.contextRecovery;
}

function applied(projection, enabled, persistence) {
  return (
    record(projection) &&
    projection.configValid === true &&
    projection.restartRetention === false &&
    projection.requestedEnabled === enabled &&
    projection.appliedEnabled === enabled &&
    projection.state === (enabled ? 'enabled_restricted' : 'disabled') &&
    projection.storage === (enabled && persistence ? 'persistent' : 'memory')
  );
}

async function request(owner, method, route, body) {
  if ((await settle(owner.isAlive(), 'process_exited')).value !== true) fail('process_exited');
  let response;
  try {
    response = (
      await settle(
        owner.request({ method, route, ...(body === undefined ? {} : { body }) }),
        'invalid_response'
      )
    ).value;
  } catch {
    fail('http_failed');
  }
  response = dataSnapshot(response, 'invalid_response');
  if (!record(response) || !Number.isInteger(response.status) || !record(response.body))
    fail('invalid_response');
  return response;
}

async function health(owner) {
  const response = await request(owner, 'GET', '/v1/local/health');
  if (response.status !== 200) fail('http_failed');
  return verifyHealth(response.body, owner.identity);
}

async function config(owner) {
  const response = await request(owner, 'GET', '/v1/local/config');
  if (
    response.status !== 200 ||
    !record(response.body.appSettings) ||
    typeof response.body._revision !== 'string' ||
    response.body._revision.length === 0 ||
    response.body._revision.length > 256
  )
    fail('invalid_response');
  return response.body;
}

async function runCase(adapter, label, options, usedDirectories) {
  let owner;
  let ownerReturned = false;
  let stop;
  let failure = null;
  let diagnostic = null;
  let saved = false;
  let observed = false;
  let storageVerified = false;
  let stopped = false;
  try {
    const launched = adapter.launch({
      label,
      initialEnabled: false,
      initialPersistence: false,
    });
    const rawOwner = (await settle(launched, 'identity_mismatch')).value;
    ownerReturned = true;
    stop = methods(rawOwner, ['stop'], 'identity_mismatch').stop;
    owner = {
      ...methods(rawOwner, ['request', 'isAlive', 'inspectStorage'], 'identity_mismatch'),
      stop,
      identity: dataSnapshot(own(rawOwner, 'identity', 'identity_mismatch'), 'identity_mismatch'),
    };
    if (
      !record(owner) ||
      !validIdentity(owner.identity) ||
      !['request', 'isAlive', 'inspectStorage', 'stop'].every(
        (name) => typeof owner[name] === 'function'
      )
    )
      fail('identity_mismatch');
    // The owned adapter must attest the process it launched. Health alone cannot
    // prove that this harness launched or exclusively owns the process.
    if ((await settle(adapter.verifyOwnedIdentity(rawOwner), 'identity_mismatch')).value !== true)
      fail('identity_mismatch');
    for (const directory of [owner.identity.configDir, owner.identity.runtimeDir]) {
      const normalized = normalizedPath(directory);
      if ([...usedDirectories].some((used) => overlappingPaths(used, normalized)))
        fail('identity_mismatch');
      usedDirectories.add(normalized);
    }
    if (!applied(await health(owner), false, false)) fail('identity_mismatch');
    const before = await config(owner);
    const enabled = label[0] === '1';
    const persistence = label[1] === '1';
    const updated = {
      ...before,
      appSettings: {
        ...before.appSettings,
        contextRecoveryEnabled: enabled,
        contextRecoveryPersistenceEnabled: persistence,
      },
    };
    const response = await request(owner, 'POST', '/v1/local/config', updated);
    if (
      response.status !== 200 ||
      response.body.ok !== true ||
      typeof response.body.revision !== 'string' ||
      response.body.revision.length === 0 ||
      response.body.revision.length > 256
    )
      fail('save_failed');
    saved = true;
    const start = adapter.now();
    if (!Number.isFinite(start)) fail('invalid_adapter');
    let previous = start;
    for (let polls = 0; polls < options.maxPolls; polls++) {
      const now = adapter.now();
      if (!Number.isFinite(now) || now < previous) fail('invalid_adapter');
      previous = now;
      if (now - start >= options.timeoutMs) break;
      const projection = await health(owner);
      const returnedAt = adapter.now();
      if (!Number.isFinite(returnedAt) || returnedAt < previous) fail('invalid_adapter');
      previous = returnedAt;
      if (returnedAt - start >= options.timeoutMs) break;
      if (applied(projection, enabled, persistence)) {
        observed = true;
        break;
      }
      await settle(adapter.wait(options.pollMs), 'invalid_adapter');
    }
    if (!observed) fail('application_timeout');
    const after = await config(owner);
    if (
      after._revision !== response.body.revision ||
      after.appSettings.contextRecoveryEnabled !== enabled ||
      after.appSettings.contextRecoveryPersistenceEnabled !== persistence
    )
      fail('saved_config_mismatch');
    const storage = dataSnapshot(
      (await settle(owner.inspectStorage(), 'storage_mismatch')).value,
      'storage_mismatch'
    );
    const persistent = enabled && persistence;
    if (
      !record(storage) ||
      storage.allWithinRoot !== true ||
      storage.directoryPresent !== persistent ||
      storage.checkpointPresent !== persistent ||
      storage.writerDatabasePresent !== persistent ||
      storage.wrappedKeyPresent !== persistent
    )
      fail('storage_mismatch');
    storageVerified = true;
  } catch (error) {
    failure = failureCode(error, 'launch_failed');
    diagnostic = ownedDiagnostic(error);
  } finally {
    if (ownerReturned) {
      try {
        stopped =
          typeof stop === 'function' && (await settle(stop(), 'cleanup_failed')).value === true;
      } catch {
        stopped = false;
      }
      if (!stopped) failure = 'cleanup_failed';
    }
  }
  return {
    label,
    configSaved: saved,
    applicationObserved: observed,
    storageVerified,
    ownedStopAcknowledged: stopped,
    cleanupSemantics: 'forced_cleanup',
    passed: failure === null,
    failure,
    ...(diagnostic === null ? {} : diagnostic),
  };
}

function plan() {
  return {
    schemaVersion: 1,
    scope: 'daemon-management-http-settings',
    mode: 'dry-run',
    cases: [...CASES],
    requiresReviewedOwnedAdapter: true,
    modelRequests: 0,
    retentionQualified: false,
    clientQualified: false,
    gracefulDrainQualified: false,
  };
}

async function runDaemonHttpSettingsMatrix(adapter, options = {}) {
  options = dataSnapshot(options, 'invalid_options');
  if (!record(options) || !['dry-run', 'execute'].includes(options.mode ?? 'dry-run'))
    fail('invalid_options');
  if ((options.mode ?? 'dry-run') === 'dry-run') return plan();
  const settings = {
    timeoutMs: options.timeoutMs ?? 15000,
    pollMs: options.pollMs ?? 50,
    maxPolls: options.maxPolls ?? 400,
  };
  if (
    !Number.isInteger(settings.timeoutMs) ||
    settings.timeoutMs < 1 ||
    settings.timeoutMs > 60000 ||
    !Number.isInteger(settings.pollMs) ||
    settings.pollMs < 1 ||
    settings.pollMs > 1000 ||
    !Number.isInteger(settings.maxPolls) ||
    settings.maxPolls < 1 ||
    settings.maxPolls > 2000
  )
    fail('invalid_options');
  adapter = methods(adapter, ['launch', 'verifyOwnedIdentity', 'now', 'wait'], 'invalid_adapter');
  const results = [];
  const usedDirectories = new Set();
  for (const label of CASES) {
    const result = await runCase(adapter, label, settings, usedDirectories);
    results.push(result);
    // Failed cleanup must prevent further process launches.
    if (!result.passed) break;
  }
  return {
    ...plan(),
    mode: 'execute',
    cases: results,
    passed: results.length === CASES.length && results.every((result) => result.passed),
  };
}

module.exports = { runDaemonHttpSettingsMatrix };
