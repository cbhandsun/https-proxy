'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

// Only this synthetic, descendant-free fixture is launched. Never return until
// close: the caller may then safely reopen/remove its physical SQLite directory.
function runRecoverySweepCrash(input, dependencies = {}) {
  const forkChild = dependencies.forkChild ?? fork;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  const now = dependencies.now ?? (() => performance.now());
  let deadline = now() + 30000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = forkChild(path.join(__dirname, 'context-recovery-sweep-crash.cjs'), [], {
        silent: true,
        windowsHide: true,
        execArgv: [],
      });
    } catch {
      reject(new Error('maintenance_fixture_spawn_failed'));
      return;
    }
    let failure = null;
    let phase = 'preparing';
    let stdout = '';
    let bytes = 0;
    let timer;
    const stop = (code) => {
      if (failure) return;
      failure = code;
      clearTimer(timer);
      // This fixture never starts descendants. A successful kill attempt is not
      // terminal proof; the close handler below remains the only completion.
      try {
        child.kill('SIGKILL');
      } catch {
        failure = 'maintenance_fixture_termination_failed';
      }
    };
    timer = setTimer(
      () => stop('maintenance_fixture_prepare_timeout'),
      Math.max(0, deadline - now())
    );
    child.on('message', (message) => {
      if (failure) return;
      if (now() >= deadline) {
        stop(
          phase === 'preparing'
            ? 'maintenance_fixture_prepare_timeout'
            : 'maintenance_fixture_sweep_timeout'
        );
        return;
      }
      if (phase !== 'preparing' || message !== 'ready') {
        stop('maintenance_fixture_protocol_failed');
        return;
      }
      clearTimer(timer);
      phase = 'sweeping';
      deadline = now() + 5000;
      timer = setTimer(() => stop('maintenance_fixture_sweep_timeout'), 5000);
      try {
        child.send('sweep', (error) => {
          if (error) stop('maintenance_fixture_protocol_failed');
        });
      } catch {
        stop('maintenance_fixture_protocol_failed');
      }
    });
    const collect = (kind, chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) stop('maintenance_fixture_output_limit');
      else if (kind === 'stdout') stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', () => stop('maintenance_fixture_process_failed'));
    child.stdin.on('error', () => stop('maintenance_fixture_input_failed'));
    child.once('close', (status, signal) => {
      clearTimer(timer);
      if (!failure && now() >= deadline)
        failure =
          phase === 'preparing'
            ? 'maintenance_fixture_prepare_timeout'
            : 'maintenance_fixture_sweep_timeout';
      if (failure) reject(new Error(failure));
      else if (phase !== 'sweeping' || signal || status !== 37)
        reject(new Error('maintenance_fixture_exit_failed'));
      else if (stdout !== 'maintenance-before-commit')
        reject(new Error('maintenance_fixture_marker_failed'));
      else resolve({ status, stdout });
    });
    try {
      const encoded = JSON.stringify(input);
      if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 65536)
        throw new Error('invalid');
      child.stdin.end(encoded);
    } catch {
      stop('maintenance_fixture_input_failed');
    }
  });
}

module.exports = { runRecoverySweepCrash };
