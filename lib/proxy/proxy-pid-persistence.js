'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AbortController } = globalThis;
const {
  ensurePrivateDirectorySync,
  ensurePrivateFileAsync,
  renamePrivateFileSync,
} = require('./secure-files');

async function writeProxyPidFileAsync(dataDir, pid = process.pid, options = {}) {
  if (
    typeof dataDir !== 'string' ||
    !dataDir.trim() ||
    dataDir.includes('\0') ||
    dataDir.length > 32000 ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    pid > 4294967295
  )
    throw new TypeError('Invalid proxy pid destination');
  const io = options.io || fs.promises;
  const secureDirectory = options.secureDirectory || ensurePrivateDirectorySync;
  const secureFile = options.secureFile || ensurePrivateFileAsync;
  const promote = options.promote || renamePrivateFileSync;
  const check = () => options.signal?.throwIfAborted();
  check();
  secureDirectory(dataDir);
  const target = path.join(dataDir, '.proxy.pid');
  const temporary = path.join(dataDir, `.proxy.pid.${randomUUID()}.tmp`);
  let handle,
    failure,
    failed = false,
    owned = false;
  try {
    handle = await io.open(temporary, 'wx', 0o600);
    owned = true;
    await handle.writeFile(String(pid) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await secureFile(temporary);
    check();
    promote(temporary, target);
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanup = [];
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (owned) {
    try {
      await io.unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') cleanup.push(error);
    }
  }
  if (cleanup.length)
    throw new AggregateError(
      [...(failed ? [failure] : []), ...cleanup],
      'Proxy pid cleanup failed'
    );
  if (failed) throw failure;
  return true;
}

function createProxyPidPersistence({ write, clear, warn }) {
  if ([write, clear, warn].some((value) => typeof value !== 'function'))
    throw new TypeError('Invalid proxy pid persistence callbacks');
  const controller = new AbortController();
  let pending, stopping;
  return {
    start() {
      if (stopping) return stopping.then(() => false);
      return (pending ||= Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return write(controller.signal);
        })
        .catch((error) => {
          if (!controller.signal.aborted || error !== controller.signal.reason) warn();
          return false;
        }));
    },
    stop() {
      controller.abort();
      return (stopping ||= Promise.resolve(pending).then(() => clear()));
    },
  };
}
module.exports = { writeProxyPidFileAsync, createProxyPidPersistence };
