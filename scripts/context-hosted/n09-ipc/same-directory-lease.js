'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');
const fail = () => new Error('n09_same_directory_rejected');
function snapshot(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !slot || !Object.hasOwn(slot, 'value')) throw fail();
    result[key] = slot.value;
  }
  return result;
}
function method(object, name) {
  const descriptor = object && Object.getOwnPropertyDescriptor(object, name);
  if (typeof descriptor?.value !== 'function' || types.isProxy(descriptor.value)) throw fail();
  return (...args) => Reflect.apply(descriptor.value, undefined, args);
}
function pinDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /^[\\/]{2}/.test(input)) throw fail();
  const root = path.resolve(input);
  const pins = [];
  for (let current = root; ; current = path.dirname(current)) {
    const value = fs.lstatSync(current, { bigint: true });
    if (
      !value.isDirectory() ||
      value.isSymbolicLink() ||
      fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()
    )
      throw fail();
    pins.push({ path: current, dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs });
    if (current === path.dirname(current)) break;
  }
  return () => {
    for (const original of pins) {
      const value = fs.lstatSync(original.path, { bigint: true });
      if (
        !value.isDirectory() ||
        value.isSymbolicLink() ||
        value.dev !== original.dev ||
        value.ino !== original.ino ||
        value.birthtimeNs !== original.birthtimeNs ||
        fs.realpathSync.native(original.path).toLowerCase() !== original.path.toLowerCase()
      )
        throw fail();
    }
  };
}
function createSameDirectoryLeaseUnsafe(input) {
  const config = snapshot(input);
  const ownedRoot = config.ownedRoot;
  const operations = snapshot(config.operations);
  if (typeof ownedRoot !== 'string' || ownedRoot.length > 4096) throw fail();
  const root = path.resolve(ownedRoot);
  const verifyRoot = pinDirectory(root);
  const start = method(operations, 'startFreshOwnedCase');
  const restart = method(operations, 'restartExistingOwnedCase');
  const kill = method(operations, 'stopOwnedCase');
  const dispose = method(operations, 'closeOwnedHandle');
  const attest = method(operations, 'attestLifecycleIdentity');
  const handles = new Set();
  let closing;
  let active;
  let previous;
  let verifyDirectories;
  let phase = 'fresh';
  function contained(file) {
    const relative = path.relative(root, file);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith('..' + path.sep)
    )
      throw fail();
  }
  function match(input, captured) {
    input = snapshot(input);
    if (
      !input ||
      !captured ||
      ['pid', 'manifestSha256', 'configDir', 'runtimeDir'].some(
        (key) => input[key] !== captured.identity[key]
      )
    )
      throw fail();
  }
  async function accept(handle, older) {
    handles.add(handle);
    try {
      verifyRoot();
      const identity = snapshot(await attest(handle));
      if (
        !identity ||
        identity.evidenceLevel !== 'lifecycle-identity-only' ||
        !Number.isSafeInteger(identity.pid) ||
        identity.pid < 1 ||
        !/^[a-f0-9]{64}$/.test(identity.manifestSha256 || '') ||
        typeof identity.configDir !== 'string' ||
        typeof identity.runtimeDir !== 'string'
      )
        throw fail();
      contained(identity.configDir);
      contained(identity.runtimeDir);
      if (older) {
        if (
          identity.pid === older.identity.pid ||
          ['manifestSha256', 'configDir', 'runtimeDir'].some(
            (key) => identity[key] !== older.identity[key]
          )
        )
          throw fail();
        verifyDirectories();
      } else {
        const config = pinDirectory(identity.configDir);
        const runtime = pinDirectory(identity.runtimeDir);
        verifyDirectories = () => {
          verifyRoot();
          config();
          runtime();
        };
      }
      verifyDirectories();
      active = { handle, identity: Object.freeze({ ...identity }) };
      phase = 'running';
      return active.identity;
    } catch {
      phase = 'failed';
      // A failed stop never suppresses the independent owner/Job disposal.
      try {
        await kill(handle);
      } catch {
        // Continue disposal; rejected acceptance always fails below.
      }
      try {
        if ((await dispose(handle)) === true) handles.delete(handle);
      } catch {
        // Continue disposal; rejected acceptance always fails below.
      }
      throw fail();
    }
  }
  const implementation = {
    async startFreshBusinessHost() {
      if (phase !== 'fresh') throw fail();
      phase = 'starting';
      return accept(await start(), null);
    },
    async killOwnedJob(input) {
      if (phase !== 'running') throw fail();
      match(input, active);
      const current = active;
      phase = 'stopping';
      let invalid = false;
      try {
        verifyDirectories();
      } catch {
        invalid = true;
      }
      let stopped;
      try {
        stopped = (await kill(current.handle)) === true;
      } catch {
        stopped = false;
      }
      if (!stopped) {
        phase = 'failed';
        try {
          if ((await dispose(current.handle)) === true) handles.delete(current.handle);
        } catch {
          /* Fixed error below, retained handle for close retry. */
        }
        throw fail();
      }
      try {
        verifyDirectories();
      } catch {
        invalid = true;
      }
      previous = current;
      active = undefined;
      phase = invalid ? 'failed' : 'stopped';
      if (invalid) throw fail();
      return Object.freeze({
        pid: input.pid,
        treeEmpty: true,
        shutdownInvoked: false,
        semantics: 'forced_cleanup',
      });
    },
    async restartSameBusinessHost(input) {
      if (phase !== 'stopped') throw fail();
      match(input, previous);
      verifyDirectories();
      phase = 'restarting';
      // Exact private captured lease, never caller-provided paths/ports/programs.
      return accept(await restart(previous.handle), previous);
    },
    async close() {
      if (!closing) {
        phase = 'closing';
        closing = (async () => {
          let failed = false;
          for (const handle of [...handles]) {
            try {
              if ((await dispose(handle)) !== true) failed = true;
              else handles.delete(handle);
            } catch {
              failed = true;
            }
          }
          active = undefined;
          previous = undefined;
          phase = failed ? 'failed' : 'closed';
          if (failed) throw fail();
        })();
      }
      try {
        await closing;
      } finally {
        closing = undefined;
      }
    },
  };
  return Object.freeze(
    Object.fromEntries(
      Object.entries(implementation).map(([key, operation]) => [
        key,
        async (...args) => {
          try {
            return await operation(...args);
          } catch {
            throw fail();
          }
        },
      ])
    )
  );
}
function createSameDirectoryLease(input) {
  try {
    return createSameDirectoryLeaseUnsafe(input);
  } catch {
    throw fail();
  }
}
module.exports = { createSameDirectoryLease };
