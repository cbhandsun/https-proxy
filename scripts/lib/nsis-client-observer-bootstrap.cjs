'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const contract = require('./nsis-client-observer.cjs');
const fail = () => new Error('installed_client_observer_rejected');
function installInstalledClientObserver(input, runtime = process) {
  const value = contract.config(input, runtime);
  const manifest = contract.readInstalledManifest(value);
  for (const name of ['sessions', 'runtime']) {
    const relative = 'lib/proxy/context-recovery-' + name + '.js';
    const file = path.join(value.install, relative);
    contract.physical(file);
    if (
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !==
        manifest.sourceSha256?.[relative] ||
      require.cache[file]
    )
      throw fail();
    const resolved = require.resolve(file);
    if (resolved.toLowerCase() !== file.toLowerCase() || require.cache[resolved]) throw fail();
  }
  const exports = require(path.join(value.install, 'lib/proxy/context-recovery-sessions.js'));
  const runtimeExports = require(path.join(value.install, 'lib/proxy/context-recovery-runtime.js'));
  const sessions = [],
    runtimes = [],
    originals = [];
  let sequence = 0,
    failed = false;
  for (const name of ['createContextRecoverySessions', 'restoreContextRecoverySessions']) {
    const original = exports[name];
    if (typeof original !== 'function') throw fail();
    originals.push([name, original]);
    exports[name] = function (...args) {
      const result = Reflect.apply(original, this, args);
      if (!result || typeof result.inspect !== 'function' || sessions.length >= 16) failed = true;
      else sessions.push(result);
      return result;
    };
  }
  const originalRuntime = runtimeExports.createContextRecoveryRuntime;
  if (typeof originalRuntime !== 'function') throw fail();
  runtimeExports.createContextRecoveryRuntime = function (...args) {
    const result = Reflect.apply(originalRuntime, this, args);
    if (!result || typeof result.inspect !== 'function' || runtimes.length >= 16) failed = true;
    else runtimes.push(result);
    return result;
  };
  // inspect() does not access the lazy sessions getter. A zero factory count
  // qualifies only with an independently captured, hash-pinned real runtime.
  function coldRuntime() {
    return (
      runtimes.length > 0 &&
      runtimes.every((runtime) => {
        const state = runtime.inspect();
        return Object.entries({
          state: 'disabled',
          storage: 'memory',
          appliedEnabled: false,
          requestedEnabled: false,
          requestedPersistence: false,
          appliedPersistence: false,
          restartRetention: false,
        }).every(([key, expected]) => {
          const slot = Object.getOwnPropertyDescriptor(state, key);
          return slot?.enumerable && Object.hasOwn(slot, 'value') && slot.value === expected;
        });
      })
    );
  }
  const dir = contract.directory(value);
  function sample() {
    if (failed) throw fail();
    try {
      const request = contract.authenticate(
        contract.read(path.join(dir, 'request.json')),
        value.token,
        'request'
      );
      contract.record(request, ['version', 'pid', 'manifestSha256', 'sequence']);
      if (request.sequence === sequence) return;
      if (
        request.version !== 1 ||
        request.pid !== value.pid ||
        request.manifestSha256 !== value.manifestSha256 ||
        request.sequence !== sequence + 1 ||
        request.sequence > 100
      )
        throw fail();
      const coldDisabled = sessions.length === 0 && coldRuntime();
      if (sessions.length === 0 && !coldDisabled) throw fail();
      let roots = 0,
        snapshots = 0,
        enabled = false,
        closed = !coldDisabled;
      for (const session of sessions) {
        const state = session.inspect();
        if (
          !Number.isSafeInteger(state.roots) ||
          state.roots < 0 ||
          !Number.isSafeInteger(state.snapshots) ||
          state.snapshots < 0 ||
          typeof state.enabled !== 'boolean' ||
          typeof state.closed !== 'boolean'
        )
          throw fail();
        roots += state.roots;
        snapshots += state.snapshots;
        enabled ||= state.enabled;
        closed &&= state.closed;
      }
      if (!Number.isSafeInteger(roots) || !Number.isSafeInteger(snapshots)) throw fail();
      const payload = {
        ...request,
        roots,
        snapshots,
        enabled,
        closed,
        factoryCalls: sessions.length,
        coldDisabled,
      };
      const temporary = path.join(dir, 'receipt.tmp');
      contract.write(temporary, contract.envelope(payload, value.token, 'receipt'));
      fs.renameSync(temporary, path.join(dir, 'receipt.json'));
      sequence = request.sequence;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      failed = true;
      throw fail();
    }
  }
  const timer = setInterval(() => {
    try {
      sample();
    } catch {
      clearInterval(timer);
    }
  }, 20);
  timer.unref();
  return Object.freeze({
    sample,
    close() {
      clearInterval(timer);
      for (const [name, original] of originals) exports[name] = original;
      runtimeExports.createContextRecoveryRuntime = originalRuntime;
    },
  });
}
module.exports = { installInstalledClientObserver };
