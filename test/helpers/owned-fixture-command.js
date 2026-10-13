'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

function terminateFixtureTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1 || child.pid === process.pid)
    return Promise.reject(new Error('Invalid owned fixture PID'));
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return Promise.resolve();
    } catch {
      return Promise.reject(new Error('Owned fixture termination failed'));
    }
  }
  return new Promise((resolve, reject) => {
    execFile(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000 },
      (error) => {
        if (error) reject(new Error('Owned fixture termination failed'));
        else resolve();
      }
    );
  });
}

// spawnSync's timeout kills only the launcher on Windows. Its ESLint/cmd
// descendants can retain the fixture directory and mask the original failure
// with EBUSY. Own a process tree and await BOTH tree termination and pipe close.
function runOwnedFixtureCommand(
  executable,
  args,
  { cwd, env, timeoutMs },
  {
    spawnChild = spawn,
    terminate = terminateFixtureTree,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}
) {
  if (
    typeof executable !== 'string' ||
    !path.isAbsolute(executable) ||
    executable.includes('\0') ||
    !Array.isArray(args) ||
    args.some((value) => typeof value !== 'string' || value.includes('\0')) ||
    typeof cwd !== 'string' ||
    !path.isAbsolute(cwd) ||
    cwd.includes('\0') ||
    !env ||
    typeof env !== 'object' ||
    Array.isArray(env) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000 ||
    [spawnChild, terminate, setTimer, clearTimer].some((value) => typeof value !== 'function')
  )
    throw new TypeError('Invalid owned fixture command');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnChild(executable, args, {
        cwd,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch {
      reject(new Error('Owned fixture launch failed'));
      return;
    }
    let closed = false,
      treeStopped = true,
      failure = null,
      status = null,
      signal = null;
    let bytes = 0,
      stdout = '',
      stderr = '';
    const finish = () => {
      if (!closed || !treeStopped) return;
      clearTimer(timer);
      resolve({ status, signal, failure, stdout, stderr });
    };
    const stop = (reason) => {
      if (failure) return;
      failure = reason;
      treeStopped = false;
      clearTimer(timer);
      Promise.resolve()
        .then(() => terminate(child))
        .then(
          () => {
            treeStopped = true;
            finish();
          },
          () => {
            // Reject rather than pretending it is safe to remove the workspace.
            reject(new Error('Owned fixture termination failed'));
          }
        );
    };
    const collect = (stream, chunk) => {
      if (failure) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1024 * 1024) {
        stop('output_limit');
        return;
      }
      if (stream === 'stdout') stdout += buffer.toString('utf8');
      else stderr += buffer.toString('utf8');
    };
    const timer = setTimer(() => stop('timeout'), timeoutMs);
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.once('error', () => {
      failure = failure || 'launch_failed';
    });
    child.once('close', (code, value) => {
      status = code;
      signal = value;
      closed = true;
      finish();
    });
  });
}

function cleanupHookFixture(directory, primaryFailure, cleanupSafe, remove = fs.rmSync) {
  if (
    typeof directory !== 'string' ||
    path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('hpm-lint-staged-fixture-') ||
    typeof cleanupSafe !== 'boolean' ||
    typeof remove !== 'function'
  )
    throw new TypeError('Invalid hook cleanup input');
  if (!cleanupSafe) {
    throw new AggregateError(
      primaryFailure ? [primaryFailure] : [],
      'Hook termination failed; fixture retained: ' + directory,
      { cause: primaryFailure }
    );
  }
  try {
    remove(directory, { recursive: true, force: true });
  } catch (cleanupFailure) {
    throw new AggregateError(
      primaryFailure ? [primaryFailure, cleanupFailure] : [cleanupFailure],
      'Hook fixture cleanup failed; primary failure preserved',
      { cause: cleanupFailure }
    );
  }
  if (primaryFailure) throw primaryFailure;
}

module.exports = { runOwnedFixtureCommand, cleanupHookFixture };
