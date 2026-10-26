'use strict';

const path = require('node:path');
const { spawn, ChildProcess } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const { storageFailure } = require('./context-recovery-storage-contract');
const {
  MAX_WIRE_BYTES,
  ownAnchorRecord,
  encodeRecoveryAnchorFrame,
  parseRecoveryAnchorReply,
} = require('./context-recovery-anchor-protocol');

const DEADLINE_MS = 10000;

// Internal transport only: the repository must still pin both physical paths
// before/after dispatch and check its exact CAS revision/value. Not wired into
// the synchronous default owner until its async lifecycle is composed safely.
function createRecoveryAnchorChannel(input, dependencies = {}) {
  let options, tools;
  try {
    options = ownAnchorRecord(input, ['executable', 'systemRoot']);
    if (
      typeof options.executable !== 'string' ||
      options.executable.length > 4096 ||
      !path.isAbsolute(options.executable) ||
      /^[\\/]{2}/.test(options.executable) ||
      /[\0\r\n]/.test(options.executable) ||
      typeof options.systemRoot !== 'string' ||
      options.systemRoot.length > 4096 ||
      !/^[A-Za-z]:[\\/]/.test(options.systemRoot) ||
      /[\0\r\n]/.test(options.systemRoot)
    )
      throw storageFailure();
    if (!dependencies || types.isProxy(dependencies)) throw storageFailure();
    const names = Reflect.ownKeys(dependencies);
    if (
      names.some(
        (name) => !['spawnChild', 'scheduleTimer', 'cancelTimer', 'monotonic'].includes(name)
      )
    )
      throw storageFailure();
    const supplied = ownAnchorRecord(dependencies, names);
    tools = {
      spawnChild: spawn,
      scheduleTimer: setTimeout,
      cancelTimer: clearTimeout,
      monotonic: () => performance.now(),
      ...supplied,
    };
    if (
      Object.values(tools).some(
        (value) =>
          typeof value !== 'function' ||
          types.isProxy(value) ||
          types.isAsyncFunction(value) ||
          types.isGeneratorFunction(value)
      )
    )
      throw storageFailure();
  } catch {
    throw storageFailure();
  }

  let child, pending, closeTimer;
  let sequence = 1,
    terminal = false,
    killSent = false,
    didClose = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let lastTime = 0;
  function clock() {
    const time = tools.monotonic();
    if (!Number.isFinite(time) || time < lastTime || time > Number.MAX_SAFE_INTEGER - DEADLINE_MS)
      throw storageFailure();
    lastTime = time;
    return time;
  }
  function clearTimer(timer) {
    try {
      if (timer !== undefined) tools.cancelTimer(timer);
      return true;
    } catch {
      return false;
    }
  }
  function finishClosed() {
    if (didClose) return;
    didClose = terminal = true;
    clearTimer(closeTimer);
    if (pending) {
      clearTimer(pending.timer);
      const reject = pending.reject;
      pending = undefined;
      reject(storageFailure());
    }
    resolveClosed();
  }
  function stop() {
    if (didClose) return;
    terminal = true;
    if (pending) clearTimer(pending.timer);
    clearTimer(closeTimer);
    if (!child) return finishClosed();
    if (!killSent) {
      killSent = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Retain ownership until close even if termination failed. Never kill
        // a numerical PID or claim cleanup merely because kill was requested.
      }
    }
  }
  function data(chunk) {
    if (terminal) return;
    if (!pending || !Buffer.isBuffer(chunk)) return stop();
    let offset = 0;
    const current = pending;
    try {
      if (clock() >= current.deadline) return stop();
    } catch {
      return stop();
    }
    if (current.headerUsed < 8) {
      const count = Math.min(8 - current.headerUsed, chunk.length);
      chunk.copy(current.header, current.headerUsed, 0, count);
      current.headerUsed += count;
      offset += count;
      if (current.headerUsed < 8) return;
      const length = current.header.readUInt32LE(4);
      if (current.header.readUInt32LE(0) !== current.sequence || !length || length > MAX_WIRE_BYTES)
        return stop();
      current.body = Buffer.allocUnsafe(length);
    }
    const count = Math.min(current.body.length - current.bodyUsed, chunk.length - offset);
    chunk.copy(current.body, current.bodyUsed, offset, offset + count);
    current.bodyUsed += count;
    offset += count;
    if (offset !== chunk.length) return stop();
    if (current.bodyUsed !== current.body.length) return;
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(current.body);
      parseRecoveryAnchorReply(text);
    } catch {
      return stop();
    }
    try {
      if (clock() >= current.deadline) return stop();
    } catch {
      return stop();
    }
    if (!clearTimer(current.timer)) return stop();
    pending = undefined;
    current.resolve(text);
  }
  function start() {
    child = tools.spawnChild(options.executable, ['--hpm-context-anchor-stream-v1'], {
      windowsHide: true,
      shell: false,
      env: { SystemRoot: options.systemRoot, WINDIR: options.systemRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!child || types.isProxy(child) || !(child instanceof ChildProcess)) {
      child = undefined;
      throw storageFailure();
    }
    child.on('error', stop);
    child.on('close', finishClosed);
    child.stdout.on('data', data);
    child.stdout.on('error', stop);
    child.stdout.on('end', () => {
      if (!terminal) stop();
    });
    child.stderr.on('data', stop); // Discard bytes; ordinary mode has no diagnostics.
    child.stderr.on('error', stop);
    child.stdin.on('error', stop);
  }
  function execute(text) {
    if (terminal || pending) return Promise.reject(storageFailure());
    let frame;
    let deadline;
    try {
      frame = encodeRecoveryAnchorFrame(sequence, text);
    } catch {
      return Promise.reject(storageFailure());
    }
    try {
      deadline = clock() + DEADLINE_MS;
    } catch {
      stop();
      return closed.then(() => {
        throw storageFailure();
      });
    }
    const result = new Promise((resolve, reject) => {
      pending = {
        resolve,
        reject,
        sequence: sequence++,
        deadline,
        header: Buffer.alloc(8),
        headerUsed: 0,
        bodyUsed: 0,
      };
    });
    try {
      const current = pending;
      const timer = tools.scheduleTimer(() => {
        if (pending === current && !terminal) stop();
      }, DEADLINE_MS);
      // A trusted test scheduler may invoke its callback synchronously.
      if (pending !== current || terminal) {
        clearTimer(timer);
        return result;
      }
      current.timer = timer;
      if (!child) start();
      if (clock() >= current.deadline) stop();
      if (!terminal) child.stdin.write(frame);
    } catch {
      stop();
    }
    return result;
  }
  function close() {
    if (terminal) return closed;
    terminal = true;
    if (pending) stop();
    else if (!child) finishClosed();
    else {
      try {
        closeTimer = tools.scheduleTimer(stop, DEADLINE_MS);
        if (didClose || killSent) clearTimer(closeTimer);
        else child.stdin.end();
      } catch {
        stop();
      }
    }
    return closed;
  }
  return Object.freeze({ execute, close });
}

module.exports = { createRecoveryAnchorChannel };
