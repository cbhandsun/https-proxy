'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { types } = require('node:util');
const ownedFailureDetails = new WeakMap();

function safeCleanupCode(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return 'unknown';
  try {
    const slot = Object.getOwnPropertyDescriptor(error, 'code');
    const code = slot && Object.hasOwn(slot, 'value') ? slot.value : null;
    return typeof code === 'string' &&
      [
        'EACCES',
        'EBUSY',
        'EEXIST',
        'EINVAL',
        'EIO',
        'EISDIR',
        'EMFILE',
        'ENFILE',
        'ENOENT',
        'ENOSPC',
        'ENOTDIR',
        'ENOTEMPTY',
        'EPERM',
        'EROFS',
      ].includes(code)
      ? code
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function safeTerminationDetails(error) {
  // Proxy descriptors can execute arbitrary traps, even without invoking getters.
  if (types.isProxy(error)) return Object.freeze({ kind: 'unknown', code: null });
  const ownValue = (key) => {
    try {
      if (!error || typeof error !== 'object') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  };
  const rawCode = ownValue('code');
  const allowedCodes = new Set([
    'ETIMEDOUT',
    'ENOENT',
    'EACCES',
    'EPERM',
    'ESRCH',
    'EINVAL',
    'EPIPE',
    'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    'ERR_INVALID_OWNED_PID',
  ]);
  const code =
    typeof rawCode === 'string' && allowedCodes.has(rawCode)
      ? rawCode
      : Number.isSafeInteger(rawCode) && rawCode >= -2147483648 && rawCode <= 4294967295
        ? rawCode
        : null;
  const kind =
    code === 'ERR_INVALID_OWNED_PID'
      ? 'invalid_pid'
      : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'output_limit'
        : code === 'ETIMEDOUT'
          ? 'timeout'
          : ownValue('killed') === true
            ? 'killed'
            : typeof code === 'number'
              ? 'exit_failure'
              : code === null
                ? 'unknown'
                : 'system_error';
  // execFile's killed flag records a signal attempt, not proof of its cause or
  // successful tree termination. Its timeout/max-buffer paths can both set it.
  return Object.freeze({ kind, code });
}

function ownedFixtureFailure(message, failure, termination = null) {
  // Never retain the raw error/cause, command, arguments, output or environment.
  const error = Object.assign(new Error(message), { failure, termination });
  ownedFailureDetails.set(error, Object.freeze({ failure, termination }));
  return error;
}

function terminateFixtureTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1 || child.pid === process.pid)
    return Promise.reject(
      Object.assign(new Error('Invalid owned fixture PID'), { code: 'ERR_INVALID_OWNED_PID' })
    );
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise((resolve, reject) => {
    execFile(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000 },
      (error) => {
        if (error) reject(error);
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
      reject(ownedFixtureFailure('Owned fixture launch failed', 'launch_failed'));
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
          (error) => {
            // Reject rather than pretending it is safe to remove the workspace.
            reject(
              ownedFixtureFailure(
                'Owned fixture termination failed',
                failure,
                safeTerminationDetails(error)
              )
            );
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
    // TAP may omit custom cause fields. Render only our privately signed safe
    // snapshot; never inspect arbitrary error properties, getters or proxies.
    const details = ownedFailureDetails.get(primaryFailure);
    const diagnostic =
      'diagnostic primary=' +
      (details?.failure ?? 'unknown') +
      ' termination=' +
      (details?.termination?.kind ?? 'unknown') +
      ' code=' +
      (details?.termination?.code ?? 'none');
    throw new AggregateError(
      primaryFailure ? [primaryFailure] : [],
      'Hook termination failed; fixture retained: ' + directory + '; ' + diagnostic,
      { cause: primaryFailure }
    );
  }
  try {
    remove(directory, { recursive: true, force: true });
  } catch (cleanupFailure) {
    const details = ownedFailureDetails.get(primaryFailure);
    const diagnostic =
      'diagnostic primaryPresent=' +
      Boolean(primaryFailure) +
      ' primary=' +
      (details?.failure ?? (primaryFailure ? 'unknown' : 'none')) +
      ' cleanupCode=' +
      safeCleanupCode(cleanupFailure);
    throw new AggregateError(
      primaryFailure ? [primaryFailure, cleanupFailure] : [cleanupFailure],
      'Hook fixture cleanup failed; primary failure preserved; ' + diagnostic,
      { cause: cleanupFailure }
    );
  }
  if (primaryFailure) throw primaryFailure;
}

module.exports = { runOwnedFixtureCommand, cleanupHookFixture };
