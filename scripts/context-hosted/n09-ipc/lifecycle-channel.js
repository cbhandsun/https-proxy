'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { types } = require('node:util');
const fail = () => new Error('n09_lifecycle_transport_failed');
const POWERSHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
function snapshot(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !slot || !Object.hasOwn(slot, 'value')) throw fail();
    out[key] = slot.value;
  }
  return out;
}
function exact(input, fields) {
  if (Object.keys(input).sort().join(',') !== fields.split(',').sort().join(',')) throw fail();
}
function absolute(input) {
  return (
    typeof input === 'string' &&
    input.length <= 4096 &&
    input.isWellFormed() &&
    path.isAbsolute(input) &&
    !/^[\\/]{2}/.test(input) &&
    ![...input].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) &&
    !input.split(/[\\/]/).some((part) => part === '.' || part === '..')
  );
}
function launchOptions(input) {
  const out = snapshot(input);
  exact(out, 'ownedRoot,install,manifestSha256');
  if (
    !absolute(out.ownedRoot) ||
    !absolute(out.install) ||
    typeof out.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(out.manifestSha256)
  )
    throw fail();
  out.ownedRoot = path.resolve(out.ownedRoot);
  out.install = path.resolve(out.install);
  const relative = path.relative(out.ownedRoot, out.install);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw fail();
  return out;
}
// Fixed object-only JSON reader, adapted from the existing owned-controller
// reader: rejects duplicate keys, arrays, trailing data and depth > 2.
function parseFrame(text) {
  let index = 0;
  const whitespace = () => {
    while (index < text.length && /[ \t\r\n]/.test(text[index])) index++;
  };
  function string() {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index++] === '"') return JSON.parse(text.slice(start, index));
    }
    throw fail();
  }
  function value(depth) {
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === '{') {
      if (depth > 1) throw fail();
      index++;
      const out = Object.create(null);
      whitespace();
      if (text[index] === '}') {
        index++;
        return out;
      }
      for (;;) {
        whitespace();
        if (text[index] !== '"') throw fail();
        const key = string();
        if (Object.hasOwn(out, key)) throw fail();
        whitespace();
        if (text[index++] !== ':') throw fail();
        out[key] = value(depth + 1);
        whitespace();
        const next = text[index++];
        if (next === '}') return out;
        if (next !== ',') throw fail();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(index)
    );
    if (!match) throw fail();
    index += match[0].length;
    return JSON.parse(match[0]);
  }
  const out = value(0);
  whitespace();
  if (index !== text.length) throw fail();
  return snapshot(out);
}
function validateIdentity(input, options) {
  const out = snapshot(input);
  exact(
    out,
    'pid,entrypoint,cwd,configDir,runtimeDir,managementPort,entryPort,manifestSha256,phase,evidenceLevel,liveDaemonProved'
  );
  if (
    !Number.isSafeInteger(out.pid) ||
    out.pid < 1 ||
    out.manifestSha256 !== options.manifestSha256 ||
    out.phase !== 'running' ||
    out.evidenceLevel !== 'lifecycle-identity-only' ||
    out.liveDaemonProved !== false ||
    out.cwd !== options.install ||
    out.entrypoint !== path.join(options.install, 'openai-proxy.js')
  )
    throw fail();
  for (const key of ['configDir', 'runtimeDir']) {
    if (!absolute(out[key])) throw fail();
    const relative = path.relative(options.ownedRoot, out[key]);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative)
    )
      throw fail();
  }
  if (
    path.dirname(out.configDir) !== path.dirname(out.runtimeDir) ||
    path.basename(out.configDir) !== 'config' ||
    path.basename(out.runtimeDir) !== 'runtime'
  )
    throw fail();
  for (const key of ['managementPort', 'entryPort'])
    if (!Number.isInteger(out[key]) || out[key] < 1024 || out[key] > 65535) throw fail();
  if (out.managementPort === out.entryPort) throw fail();
  return Object.freeze(out);
}
function reply(text, request, options) {
  const out = parseFrame(text);
  const extra = {
    start: 'identity,leaseId',
    restart: 'identity',
    status: 'status',
    stop: 'cleanup',
    remove: '',
  }[request.op];
  exact(out, 'v,id,op,ok' + (extra ? ',' + extra : ''));
  if (out.v !== 1 || out.id !== request.id || out.op !== request.op || out.ok !== true)
    throw fail();
  if (request.op === 'start' && !/^[a-f0-9]{32}$/.test(out.leaseId || '')) throw fail();
  if (out.identity) out.identity = validateIdentity(out.identity, options);
  if (request.op === 'status') {
    out.status = snapshot(out.status);
    exact(out.status, 'alive,credentialsPrivate,preloadPhase');
    if (
      typeof out.status.alive !== 'boolean' ||
      typeof out.status.credentialsPrivate !== 'boolean' ||
      !['unobserved', 'entered', 'passed', 'failed'].includes(out.status.preloadPhase)
    )
      throw fail();
  }
  if (request.op === 'stop') {
    out.cleanup = snapshot(out.cleanup);
    exact(out.cleanup, 'pid,treeEmpty,shutdownInvoked,semantics');
    if (
      !Number.isSafeInteger(out.cleanup.pid) ||
      out.cleanup.pid < 1 ||
      out.cleanup.treeEmpty !== true ||
      out.cleanup.shutdownInvoked !== false ||
      out.cleanup.semantics !== 'forced_cleanup'
    )
      throw fail();
  }
  return Object.freeze(out);
}

function startChannelUnsafe(input, token, start) {
  const options = launchOptions(input);
  if (
    (start === spawn && process.platform !== 'win32') ||
    typeof start !== 'function' ||
    types.isProxy(start) ||
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw fail();
  const environment = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
    if (process.env[key]) environment[key] = process.env[key];
  environment.HPM_N09_BOOTSTRAP_TOKEN = token;
  let child;
  try {
    child = start(
      POWERSHELL,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(__dirname, 'n09-ipc-entry.ps1'),
        '-OwnedRoot',
        options.ownedRoot,
        '-InstallDirectory',
        options.install,
        '-ManifestSha256',
        options.manifestSha256,
        '-ParentPid',
        String(process.pid),
      ],
      { windowsHide: true, shell: false, env: environment, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } finally {
    delete environment.HPM_N09_BOOTSTRAP_TOKEN;
  }
  let pending;
  let buffer = Buffer.alloc(0);
  let broken = false;
  let closing = false;
  let closed = false;
  let id = 0;
  let stderrBytes = 0;
  let resolveExit;
  const exit = new Promise((resolve) => {
    resolveExit = resolve;
  });
  function endInput() {
    try {
      child.stdin.end();
    } catch {
      broken = true;
    }
  }
  function abort() {
    if (broken) return;
    broken = true;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(fail());
      pending = undefined;
    }
    buffer = Buffer.alloc(0);
    endInput(); // The controller finally disposes every Job, including partial start.
  }
  child.on('error', abort);
  child.stdin.on('error', abort);
  child.stdout.on('error', abort);
  child.stderr.on('error', abort);
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    // Any stderr is unexpected on a successful session. Drain without decoding.
    if (stderrBytes > 0) abort();
  });
  child.stdout.on('data', (chunk) => {
    if (broken) return; // Listener remains installed: discarded bytes are still drained.
    if (!pending || !Buffer.isBuffer(chunk) || buffer.length + chunk.length > 16384) return abort();
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    if (newline !== buffer.length - 1) return abort();
    try {
      const result = reply(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline)),
        pending.request,
        options
      );
      const current = pending;
      pending = undefined;
      buffer = Buffer.alloc(0);
      clearTimeout(current.timer);
      current.resolve(result);
    } catch {
      abort();
    }
  });
  child.on('close', (code, signal) => {
    closed = true;
    const clean = closing && code === 0 && signal === null && !pending && !broken;
    if (!clean) abort();
    resolveExit(clean);
  });
  return Object.freeze({
    exchange(input) {
      let request;
      try {
        request = snapshot(input);
        exact(request, request.op === 'start' ? 'op' : 'op,leaseId');
        if (
          !['start', 'status', 'stop', 'restart', 'remove'].includes(request.op) ||
          (request.op !== 'start' &&
            (typeof request.leaseId !== 'string' || !/^[a-f0-9]{32}$/.test(request.leaseId))) ||
          pending ||
          broken ||
          closing ||
          closed ||
          id >= 4096
        )
          throw fail();
        request = { ...request, v: 1, id: ++id };
      } catch {
        return Promise.reject(fail());
      }
      return new Promise((resolve, reject) => {
        pending = { request, resolve, reject, timer: setTimeout(abort, 15000) };
        try {
          child.stdin.write(JSON.stringify(request) + '\n', (error) => {
            if (error) abort();
          });
        } catch {
          abort();
        }
      });
    },
    async close() {
      closing = true;
      endInput();
      let timer;
      try {
        const clean = await Promise.race([
          exit,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 20000);
          }),
        ]);
        if (!clean) {
          // Only the exact child handle is signalled. Closing the controller
          // releases its kill-on-close Jobs; this never counts as tree-empty ACK.
          if (!closed) {
            try {
              child.kill();
            } catch {
              /* Report fixed failure below. */
            }
          }
          throw fail();
        }
        return true;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
function startLifecycleChannel(input, token, start = spawn) {
  try {
    return startChannelUnsafe(input, token, start);
  } catch {
    throw fail();
  }
}
module.exports = { startLifecycleChannel, snapshot, launchOptions, validateIdentity };
