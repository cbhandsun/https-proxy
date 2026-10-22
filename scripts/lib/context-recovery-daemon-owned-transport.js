'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { safePath } = require('./nsis-encrypted-contract');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const { LABELS, response } = require('./context-recovery-daemon-owned-protocol');
const { ownedFailure } = require('./context-recovery-daemon-owned-failure');
const failure = (cause = 'controller_protocol') => ownedFailure('daemon_controller_failed', cause);

// Owns the controller process only. The controller owns each daemon Job; no PID
// search or process-kill fallback exists on either side of this transport.
function startDaemonOwnedController(input, start = spawn) {
  let options;
  try {
    options = dataSnapshot(input, 'daemon_controller_failed');
    if (
      (start === spawn && process.platform !== 'win32') ||
      Object.keys(options).sort().join(',') !==
        'install,manifestSha256,ownedRoot,powershellExecutable'
    )
      throw failure();
    options.ownedRoot = safePath(options.ownedRoot, true);
    options.install = safePath(options.install, true);
    const relative = path.relative(options.ownedRoot, options.install);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative)
    )
      throw failure();
    options.powershellExecutable = safePath(options.powershellExecutable);
    if (
      path.basename(options.powershellExecutable).toLowerCase() !== 'pwsh.exe' ||
      !/^[a-f0-9]{64}$/.test(options.manifestSha256)
    )
      throw failure();
  } catch {
    throw failure('controller_start');
  }
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
    if (process.env[name]) environment[name] = process.env[name];
  let child;
  try {
    child = start(
      options.powershellExecutable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(__dirname, 'context-recovery-daemon-owned-controller.ps1'),
        '-OwnedRoot',
        options.ownedRoot,
        '-InstallDirectory',
        options.install,
        '-ManifestSha256',
        options.manifestSha256,
      ],
      { windowsHide: true, shell: false, env: environment, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch {
    throw failure('controller_start');
  }
  let pending;
  let buffer = Buffer.alloc(0);
  let broken = false;
  let brokenCause;
  let closing = false;
  let lastId = 0;
  let stderrBytes = 0;
  let exited = false;
  let exitResolve;
  const exit = new Promise((resolve) => {
    exitResolve = resolve;
  });
  function abort(cause) {
    if (broken) return;
    broken = true;
    brokenCause = cause;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure(cause));
      pending = undefined;
    }
    buffer = Buffer.alloc(0);
    child.stdin.end(); // EOF makes the controller clean its Job in finally.
  }
  child.on('error', () => abort('controller_exit'));
  child.stdin.on('error', () => abort('controller_pipe'));
  child.stdout.on('error', () => abort('controller_pipe'));
  child.stderr.on('error', () => abort('controller_pipe'));
  child.stderr.on('data', (bytes) => {
    stderrBytes += bytes.length;
    if (stderrBytes > 4096) abort('controller_protocol');
    // Discard the fixed controller error; never forward native exception text.
  });
  child.stdout.on('data', (bytes) => {
    if (broken || !pending || buffer.length + bytes.length > 16385)
      return abort('controller_protocol');
    buffer = Buffer.concat([buffer, bytes]);
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    if (newline !== buffer.length - 1) return abort('controller_protocol');
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline));
      const result = response(text, pending.request);
      const current = pending;
      pending = undefined;
      buffer = Buffer.alloc(0);
      clearTimeout(current.timer);
      if (result.ok === false) current.reject(failure(result.cause));
      else current.resolve(result);
    } catch {
      abort('controller_protocol');
    }
  });
  child.on('close', (code, signal) => {
    exited = true;
    const clean = code === 0 && signal === null && !pending && !broken;
    if (!clean) abort('controller_exit');
    exitResolve(clean);
  });
  return {
    exchange(input) {
      let request;
      try {
        request = dataSnapshot(input, 'daemon_controller_failed');
        const keys = request.op === 'start' ? 'case,op,token' : 'case,op';
        if (
          Object.keys(request).sort().join(',') !== keys ||
          !['start', 'status', 'stop'].includes(request.op) ||
          !LABELS.includes(request.case) ||
          (request.op === 'start' &&
            (typeof request.token !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(request.token)))
        )
          throw failure();
        if (broken || closing || exited || pending || ++lastId > 4096) throw failure();
        request = { ...request, v: 1, id: lastId };
      } catch {
        return Promise.reject(failure(brokenCause ?? 'controller_protocol'));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => abort('rpc_deadline'),
          request.op === 'stop' ? 20000 : 15000
        );
        pending = { resolve, reject, timer, request };
        try {
          child.stdin.write(JSON.stringify(request) + '\n', (error) => {
            if (error) abort('controller_pipe');
          });
        } catch {
          abort('controller_pipe');
        }
      });
    },
    async close() {
      if (!closing) {
        closing = true;
        child.stdin.end();
      }
      let timer;
      try {
        const clean = await Promise.race([
          exit,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 20000);
          }),
        ]);
        if (!clean) throw failure(brokenCause ?? 'rpc_deadline');
        return true;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = { startDaemonOwnedController };
