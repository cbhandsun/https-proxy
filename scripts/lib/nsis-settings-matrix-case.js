'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');
const { safePath } = require('./nsis-encrypted-contract');
const fail = () => new Error('nsis_settings_matrix_failed');
const combinations = Object.freeze(['00', '01', '10', '11']);
const checks = Object.freeze(['policy_applied', 'storage_boundary', 'shutdown_acknowledged']);

function record(value) {
  if (
    !value ||
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
function exact(value, expected) {
  if (Reflect.ownKeys(record(value)).length !== Object.keys(expected).length) throw fail();
  for (const [key, wanted] of Object.entries(expected))
    if (own(value, key) !== wanted) throw fail();
}
function pin(directory) {
  safePath(directory, true);
  const stat = fs.statSync(directory);
  return () => {
    safePath(directory, true);
    const current = fs.statSync(directory);
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.birthtimeMs !== stat.birthtimeMs
    )
      throw fail();
  };
}
function storageBoundary(data, persistent) {
  safePath(data, true);
  if (!persistent) {
    if (fs.readdirSync(data).length) throw fail();
    return;
  }
  if (fs.readdirSync(data).join(',') !== 'context-recovery-v1') throw fail();
  const directory = safePath(path.join(data, 'context-recovery-v1'), true);
  const allowed = new Map([
    ['.data-key', 17000],
    ['.writer.sqlite', 1048576],
    ['checkpoint.sqlite', 512 * 1024 * 1024],
    ['checkpoint.sqlite-journal', 512 * 1024 * 1024],
    ['.writer.sqlite-journal', 1048576],
    ['.hpm-secured', 1024],
  ]);
  const names = fs.readdirSync(directory);
  for (const name of names) {
    if (!allowed.has(name)) throw fail();
    const file = safePath(path.join(directory, name));
    if (fs.statSync(file).size > allowed.get(name)) throw fail();
  }
  for (const name of ['.data-key', '.writer.sqlite', 'checkpoint.sqlite'])
    if (!names.includes(name)) throw fail();
  const wrapped = fs.readFileSync(safePath(path.join(directory, '.data-key')), 'utf8');
  if (!/^hpm-context-dpapi-v1:[A-Za-z0-9+/]+={0,2}$/.test(wrapped)) throw fail();
  // The dedicated writer-lock database may legitimately remain zero bytes:
  // BEGIN EXCLUSIVE acquires ownership without creating application tables.
  for (const name of ['checkpoint.sqlite']) {
    const fd = fs.openSync(safePath(path.join(directory, name)), 'r');
    try {
      const header = Buffer.alloc(16);
      if (fs.readSync(fd, header, 0, 16, 0) !== 16 || header.toString() !== 'SQLite format 3\0')
        throw fail();
    } finally {
      fs.closeSync(fd);
    }
  }
}

// Trusted verified payload API only. No storage, lifecycle, directory or key
// dependency is supplied to the runtime. No restart/retention claim is made.
async function runSettingsCombination(input) {
  try {
    if (Reflect.ownKeys(record(input)).sort().join(',') !== 'caseRoot,combination,runtimeApi')
      throw fail();
    const combination = own(input, 'combination');
    if (!combinations.includes(combination)) throw fail();
    const root = safePath(own(input, 'caseRoot'), true);
    const config = safePath(path.join(root, 'config'), true);
    const data = safePath(path.join(root, 'data'), true);
    const pins = [pin(root), pin(config), pin(data)];
    if (fs.readdirSync(config).length || fs.readdirSync(data).length) throw fail();
    const factory = own(own(input, 'runtimeApi'), 'createContextRecoveryRuntime');
    if (typeof factory !== 'function') throw fail();
    const runtime = factory({ dataDirectory: data });
    const methods = Object.create(null);
    const shutdown = own(runtime, 'shutdownAsync');
    if (typeof shutdown !== 'function') throw fail();
    methods.shutdownAsync = shutdown.bind(runtime);
    const enabled = combination[0] === '1',
      persistence = combination[1] === '1';
    let failure = false;
    try {
      for (const key of ['configureSettings', 'ready', 'inspect']) {
        const fn = own(runtime, key);
        if (typeof fn !== 'function') throw fail();
        methods[key] = fn.bind(runtime);
      }
      methods.configureSettings({
        appSettings: {
          contextRecoveryEnabled: enabled,
          contextRecoveryPersistenceEnabled: persistence,
        },
      });
      exact(await methods.ready(), { ok: true });
      exact(methods.inspect(), {
        requestedEnabled: enabled,
        requestedPersistence: persistence,
        appliedEnabled: enabled,
        appliedPersistence: enabled && persistence,
        storage: enabled && persistence ? 'persistent' : 'memory',
        state: enabled ? 'enabled' : 'disabled',
        restartRetention: false,
      });
      pins.forEach((verify) => verify());
      if (fs.readdirSync(config).length) throw fail();
      storageBoundary(data, enabled && persistence);
    } catch {
      failure = true;
    }
    try {
      exact(await methods.shutdownAsync(), { ok: true });
      const terminal = methods.inspect();
      if (own(terminal, 'state') !== 'closed' || own(terminal, 'appliedEnabled') !== false)
        throw fail();
      pins.forEach((verify) => verify());
      storageBoundary(data, enabled && persistence);
      if (fs.readdirSync(config).length) throw fail();
    } catch {
      failure = true;
    }
    if (failure) throw fail();
    return Object.freeze({ combination, checks, restartRetention: false });
  } catch {
    throw fail();
  }
}
module.exports = { combinations, checks, runSettingsCombination };
