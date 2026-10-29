'use strict';

// Invoked by the Rust integration suite against its just-built executable.
// No registry, keys, database, network or caller-selected resource is touched.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

function start(executable, probe = true) {
  return spawn(
    executable,
    [probe ? '--hpm-context-anchor-owner-probe-v1' : '--hpm-context-anchor-owned-stream-v1'],
    {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env:
        process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot }
          : {},
    }
  );
}
function ready(child) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('owner_probe_ready_timeout')), 5000);
    child.once('close', () => clearTimeout(timer));
    child.on('error', reject);
    child.on('exit', () => reject(new Error('owner_probe_exited_before_ready')));
    child.stderr.on('data', () => reject(new Error('owner_probe_unexpected_stderr')));
    child.stdout.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 8 || bytes.some((byte) => byte !== 0))
        reject(new Error('owner_probe_invalid_ready'));
      else if (bytes.length === 8) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
async function checkClosure(executable, action, expected) {
  const child = start(executable, action !== 'graceful');
  const closed = once(child, 'close');
  let closeTimer;
  try {
    await ready(child);
    const started = performance.now();
    if (action === 'graceful') child.stdin.end();
    else if (action === 'data') child.stdio[3].write(Buffer.from([1]));
    else child.stdio[3].destroy();
    const [code, signal] = await Promise.race([
      closed,
      new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('owner_probe_close_timeout')), 5000);
      }),
    ]);
    assert.equal(signal, null);
    assert.equal(code, expected);
    assert.ok(
      performance.now() - started < 5000,
      'owner loss must interrupt the blocked main thread'
    );
  } finally {
    clearTimeout(closeTimer);
    // Only the held ChildProcess handle, never a PID-based termination fallback.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}
async function checkWorker(executable) {
  const worker = new Worker(__filename, { workerData: { executable } });
  let pid;
  try {
    [pid] = await once(worker, 'message', { signal: global.AbortSignal.timeout(5000) });
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const started = performance.now();
    await worker.terminate();
    let alive = true;
    while (performance.now() - started < 5000) {
      try {
        process.kill(pid, 0); // Read-only existence check of this newly created child.
        if (process.platform !== 'win32') {
          // Node's terminated Worker may leave its already-exited child as a
          // zombie until the enclosing Node process exits. That is not a live
          // native thread or a Windows reaping qualification.
          const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], {
            encoding: 'utf8',
            timeout: 1000,
            maxBuffer: 128,
          }).trim();
          if (/^Z/.test(state)) {
            alive = false;
            break;
          }
        }
      } catch (error) {
        if (error.code !== 'ESRCH') {
          try {
            process.kill(pid, 0);
          } catch (again) {
            if (again.code === 'ESRCH') {
              alive = false;
              break;
            }
            throw again;
          }
          throw error;
        }
        alive = false;
        break;
      }
      await delay(20);
    }
    assert.equal(alive, false, 'native child outlived its terminated worker');
  } finally {
    await worker.terminate();
    // The probe has its own 10s ceiling even when the lifecycle guard is broken.
    // No numeric PID is ever killed or reused as process authority.
  }
}
async function main() {
  const executable = process.argv[2];
  assert.equal(typeof executable, 'string');
  await checkClosure(executable, 'graceful', 0);
  await checkClosure(executable, 'eof', 1);
  await checkClosure(executable, 'data', 1);
  await checkWorker(executable);
  process.stdout.write('native_owner_lifecycle_verified\n');
}
if (isMainThread) {
  main().catch(() => {
    process.stderr.write('native_owner_lifecycle_failed\n');
    process.exitCode = 1;
  });
} else {
  const child = start(workerData.executable);
  ready(child).then(
    () => parentPort.postMessage(child.pid),
    () => process.exit(1)
  );
}
