'use strict';

const { spawn } = require('node:child_process');

// A disposable two-process fixture. The tree terminator remains the operation
// under test. IPC and the watchdog only clean up after its failure; neither can
// turn that failure into a successful termination assertion.
const script = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.once('close', () => process.exit(73));
    child.kill('SIGKILL');
    if (child.exitCode !== null || child.signalCode !== null) process.exit(73);
  };
  process.on('message', (value) => { if (value === 'dispose_owned_pipe_fixture') stop(); });
  process.on('disconnect', stop);
  // Bound the fixture's lifetime even if its test owner cannot send cleanup.
  setTimeout(stop, 20000);
  process.stdout.write(JSON.stringify({ descendant: child.pid }));
  setInterval(() => {}, 1000);
`;

function createPipeHoldingFixture(launch = spawn) {
  if (typeof launch !== 'function') throw new TypeError('Invalid disposable fixture launcher');
  let child,
    closed,
    cleanup,
    disposed = false;
  return {
    args: ['-e', script],
    spawnChild(executable, args, options) {
      if (
        disposed ||
        child ||
        executable !== process.execPath ||
        !Array.isArray(args) ||
        args.length !== 2 ||
        args[0] !== '-e' ||
        args[1] !== script
      )
        throw new TypeError('Invalid disposable fixture launch');
      child = launch(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      closed = new Promise((resolve) => child.once('close', resolve));
      return child;
    },
    close() {
      if (cleanup) return cleanup;
      disposed = true;
      cleanup = (async () => {
        if (!child) return;
        if (child.exitCode === null && child.signalCode === null && child.connected) {
          // This channel controls only our fixed synthetic launcher. The
          // launcher retains the descendant's native ChildProcess handle.
          await new Promise((resolve, reject) => {
            child.send('dispose_owned_pipe_fixture', (error) => {
              if (error) reject(new Error('Disposable fixture cleanup signal failed'));
              else resolve();
            });
          });
        }
        await closed;
      })();
      return cleanup;
    },
  };
}

module.exports = { createPipeHoldingFixture };
