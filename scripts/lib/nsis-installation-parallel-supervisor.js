'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const { visitInstallationFiles } = require('./nsis-encrypted-contract');
const DEADLINE_MS = 12000;
const fail = () => new Error('installation_parallel_failed');

// The factory is trusted test injection only. The production executable and
// module paths, pool width and worker flags are fixed in this module.
async function superviseInstallation(
  install,
  expected,
  createWorker = (file, options) => new Worker(file, options)
) {
  const tasks = [];
  const receipt = visitInstallationFiles(install, expected, (file, hash) => {
    tasks.push({ file, hash, index: tasks.length });
  });
  const groups = [
    tasks.filter((task) => task.index % 2 === 0),
    tasks.filter((task) => task.index % 2 === 1),
  ];
  const states = [];
  let failed = false;
  let stopping;
  let failureResolve;
  const failure = new Promise((resolve) => {
    failureResolve = resolve;
  });
  const stopAll = () => {
    failed = true;
    failureResolve();
    if (!stopping)
      stopping = Promise.allSettled(
        states.map(async (state) => {
          if (!state.exited) await state.worker.terminate();
        })
      );
  };
  const timer = setTimeout(stopAll, DEADLINE_MS);
  try {
    for (const group of groups) {
      if (failed) break;
      const worker = createWorker(path.join(__dirname, 'nsis-installation-parallel-worker.js'), {
        workerData: group,
        execArgv: [],
        env: {},
        stdout: true,
        stderr: true,
      });
      let exitResolve;
      const state = {
        worker,
        messages: 0,
        complete: false,
        exited: false,
        exitCode: null,
        outputEnds: [],
        exit: new Promise((resolve) => {
          exitResolve = resolve;
        }),
      };
      states.push(state);
      worker.on('message', (input) => {
        try {
          const message = dataSnapshot(input, 'installation_parallel_failed');
          if (
            ++state.messages !== 1 ||
            state.exited ||
            !message ||
            Array.isArray(message) ||
            Object.keys(message).sort().join(',') !== 'completed,ok,v' ||
            message.v !== 1 ||
            message.ok !== true ||
            !Array.isArray(message.completed) ||
            message.completed.length !== group.length ||
            message.completed.some((index, offset) => index !== group[offset].index)
          )
            throw fail();
          state.complete = true;
        } catch {
          stopAll();
        }
      });
      worker.on('error', stopAll);
      worker.on('messageerror', stopAll);
      for (const stream of [worker.stdout, worker.stderr]) {
        let ended = false;
        state.outputEnds.push(
          new Promise((resolve) => {
            stream.on('end', () => {
              ended = true;
              resolve();
            });
          })
        );
        stream.on('data', stopAll);
        stream.on('error', stopAll);
        stream.on('close', () => {
          if (!ended) stopAll();
        });
      }
      worker.on('exit', (code) => {
        state.exited = true;
        state.exitCode = code;
        exitResolve();
        if (code !== 0 || !state.complete || state.messages !== 1) stopAll();
      });
    }
    await Promise.all(states.map((state) => state.exit));
    // Exit alone does not establish that redirected output has drained. Keep
    // listening until both streams of both workers reach EOF, or fail/expire.
    if (!failed)
      await Promise.race([Promise.all(states.flatMap((state) => state.outputEnds)), failure]);
  } catch {
    stopAll();
  } finally {
    if (failed) stopAll();
    if (stopping) await stopping;
    // A terminate() acknowledgement alone is insufficient: actual exit must
    // also be observed before success or a failure receipt can leave here.
    await Promise.all(states.map((state) => state.exit));
    clearTimeout(timer);
  }
  if (
    failed ||
    states.length !== 2 ||
    states.some((state) => !state.complete || state.messages !== 1 || state.exitCode !== 0)
  )
    throw fail();
  return receipt;
}

async function runSupervisor() {
  const chunks = [];
  let size = 0;
  for await (const bytes of process.stdin) {
    size += bytes.length;
    if (size > 8192) throw fail();
    chunks.push(bytes);
  }
  const frame = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const request = JSON.parse(frame);
  if (
    !request ||
    Array.isArray(request) ||
    Object.keys(request).sort().join(',') !== 'install,manifestSha256' ||
    frame !== JSON.stringify({ install: request.install, manifestSha256: request.manifestSha256 })
  )
    throw fail();
  const receipt = await superviseInstallation(request.install, request.manifestSha256);
  process.stdout.write(JSON.stringify({ v: 1, ok: true, sourceCount: receipt.sourceCount }) + '\n');
}
if (require.main === module) {
  runSupervisor().catch(() => {
    process.stdout.write('{"v":1,"ok":false}\n');
    process.exitCode = 1;
  });
}
module.exports = { superviseInstallation, DEADLINE_MS };
