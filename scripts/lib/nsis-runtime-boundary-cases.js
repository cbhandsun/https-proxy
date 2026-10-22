'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');
const { safePath } = require('./nsis-encrypted-contract');

const IMPLEMENTED = ['defaults-migration', 'settings-matrix', 'initialization-failure'];
const UNAVAILABLE = 'context_recovery_storage_unavailable';
const fail = () => new Error('nsis_runtime_boundary_case_failed');

function record(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail();
  return value;
}
function own(value, key) {
  const slot = Object.getOwnPropertyDescriptor(record(value), key);
  if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
  return slot.value;
}
function method(value, key) {
  const fn = own(value, key);
  if (typeof fn !== 'function' || types.isProxy(fn)) throw fail();
  return (...args) => Reflect.apply(fn, value, args);
}
function equalPath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function validate(input) {
  record(input);
  const keys = ['caseId', 'caseRoot', 'configApi', 'runtimeApi'];
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    Reflect.ownKeys(input).some((key) => !keys.includes(key))
  )
    throw fail();
  const caseId = own(input, 'caseId');
  if (!IMPLEMENTED.includes(caseId)) throw fail();
  const root = safePath(own(input, 'caseRoot'), true);
  const configApi = own(input, 'configApi');
  const runtimeApi = own(input, 'runtimeApi');
  const configDirectory = safePath(own(configApi, 'CONFIG_DIR'), true);
  const dataDirectory = safePath(own(configApi, 'DATA_DIR'), true);
  const configFile = own(configApi, 'CONFIG_FILE');
  if (
    !equalPath(configDirectory, path.join(root, 'config')) ||
    !equalPath(dataDirectory, path.join(root, 'data')) ||
    typeof configFile !== 'string' ||
    !equalPath(configFile, path.join(configDirectory, 'proxy.config.json')) ||
    fs.readdirSync(configDirectory).length ||
    fs.readdirSync(dataDirectory).length
  )
    throw fail();
  return {
    caseId,
    configDirectory,
    dataDirectory,
    loadConfig: method(configApi, 'loadConfig'),
    settings: method(runtimeApi, 'recoveryStorageSettings'),
    createRuntime: method(runtimeApi, 'createContextRecoveryRuntime'),
  };
}
function assertReply(reply, failed = false) {
  record(reply);
  const keys = Reflect.ownKeys(reply);
  if (
    failed
      ? keys.length !== 2 ||
        !keys.includes('ok') ||
        !keys.includes('code') ||
        own(reply, 'ok') !== false ||
        own(reply, 'code') !== UNAVAILABLE
      : keys.length !== 1 || keys[0] !== 'ok' || own(reply, 'ok') !== true
  )
    throw fail();
}
function assertPolicy(value, enabled, persistent, failed = false) {
  const expected = {
    requestedEnabled: enabled,
    requestedPersistence: persistent,
    appliedEnabled: failed ? false : enabled,
    appliedPersistence: enabled && persistent,
    storage: enabled && persistent ? 'persistent' : 'memory',
    state: failed ? 'failed' : enabled ? 'enabled' : 'disabled',
    restartRetention: false,
  };
  if (Reflect.ownKeys(record(value)).length !== Object.keys(expected).length) throw fail();
  for (const [key, wanted] of Object.entries(expected))
    if (own(value, key) !== wanted) throw fail();
}
const policy = (enabled, persistent) => ({
  appSettings: {
    contextRecoveryEnabled: enabled,
    contextRecoveryPersistenceEnabled: persistent,
  },
});

async function exercise(api, config, enabled, persistent, failed = false) {
  const owner = api.createRuntime({ dataDirectory: api.dataDirectory });
  // All methods are resolved before invoking any of them; malformed capabilities
  // are not accepted as a runtime. These are trusted installed-module exports,
  // not a bridge for caller-provided executable scripts.
  const shutdown = method(owner, 'shutdownAsync');
  let failedCheck = false;
  try {
    const configure = method(owner, 'configureSettings');
    const ready = method(owner, 'ready');
    const inspect = method(owner, 'inspect');
    configure(config);
    assertReply(await ready(), failed);
    assertPolicy(inspect(), enabled, persistent, failed);
    if (failed) {
      configure(policy(true, true));
      assertReply(await ready(), true);
      assertPolicy(inspect(), true, true, true);
    }
  } catch {
    failedCheck = true;
  }
  try {
    // A failed cleanup prevents a completed result and remains sanitized by
    // the public boundary. Do not hide shutdown failures to manufacture green.
    assertReply(await shutdown(), failed);
    const terminal = method(owner, 'inspect')();
    if (
      own(terminal, 'state') !== (failed ? 'failed' : 'closed') ||
      own(terminal, 'appliedEnabled') !== false
    )
      throw fail();
  } catch {
    failedCheck = true;
  }
  if (failedCheck) throw fail();
}

// This module executes assertions only. It does not attest installation identity,
// launch the daemon, apply management HTTP settings, or issue acceptance receipts.
// A future installed composition runner must verify/revalidate owned directories
// and installed hashes before loading these trusted APIs, and supervise deadlines.
async function runRuntimeBoundaryCase(input) {
  try {
    const api = validate(input);
    let checks;
    if (api.caseId === 'defaults-migration') {
      const config = api.loadConfig({ throwOnError: true });
      const defaults = api.settings(config);
      if (own(defaults, 'enabled') !== false || own(defaults, 'persistent') !== false) throw fail();
      await exercise(api, config, false, false);
      if (
        fs.readdirSync(safePath(api.configDirectory, true)).length ||
        fs.readdirSync(safePath(api.dataDirectory, true)).length
      )
        throw fail();
      checks = [
        'empty_config_directory',
        'default_policy_disabled',
        'runtime_disabled',
        'shutdown_acknowledged',
      ];
    } else if (api.caseId === 'settings-matrix') {
      for (const [enabled, persistent] of [
        [false, false],
        [false, true],
        [true, false],
        [true, true],
      ]) {
        await exercise(api, policy(enabled, persistent), enabled, persistent);
      }
      checks = [
        'settings_00',
        'settings_01',
        'settings_10',
        'settings_11',
        'shutdown_acknowledged',
      ];
    } else {
      // Deliberate real filesystem obstruction, not an injected initialization
      // exception. With the default storage owner this fails at path validation,
      // before database creation or DPAPI key protection. Never overwrite a path.
      safePath(api.dataDirectory, true);
      if (fs.readdirSync(api.dataDirectory).length) throw fail();
      fs.closeSync(fs.openSync(path.join(api.dataDirectory, 'context-recovery-v1'), 'wx', 0o600));
      await exercise(api, policy(true, true), true, true, true);
      checks = [
        'storage_directory_blocked',
        'initialization_failed_closed',
        'reenable_rejected',
        'shutdown_failure_acknowledged',
      ];
    }
    return Object.freeze({
      caseId: api.caseId,
      scope: 'module_api',
      complete: api.caseId !== 'defaults-migration',
      checks: Object.freeze(checks),
    });
  } catch {
    throw fail();
  }
}

module.exports = { runRuntimeBoundaryCase };
