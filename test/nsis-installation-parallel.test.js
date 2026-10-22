'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const { discoverTestFiles } = require('../lib/test-discovery');
const { digest, verifyInstallation } = require('../scripts/lib/nsis-encrypted-contract');
const { verifyTasks } = require('../scripts/lib/nsis-installation-parallel-worker');
const {
  superviseInstallation,
  DEADLINE_MS,
} = require('../scripts/lib/nsis-installation-parallel-supervisor');
const { verifyInstallationParallel } = require('../scripts/lib/nsis-installation-parallel');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-parallel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    'lib/source.js',
    'runtime/node/node.exe',
    'runtime/native/hpm-context-recovery-key.exe',
    'package-lock.json',
  ];
  for (const relative of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'synthetic');
  }
  const manifest = {
    schemaVersion: 2,
    sourceSha256: { 'lib/source.js': hash('synthetic') },
    nodeSha256: hash('synthetic'),
    contextRecoveryNativeSha256: hash('synthetic'),
    packageLockSha256: hash('synthetic'),
  };
  fs.writeFileSync(path.join(root, 'release-runtime-manifest.json'), JSON.stringify(manifest));
  return { root, expected: digest(path.join(root, 'release-runtime-manifest.json')), files };
}

function fakeWorker(options) {
  const worker = new EventEmitter();
  worker.stdout = new PassThrough();
  worker.stderr = new PassThrough();
  worker.options = options;
  worker.terminations = 0;
  worker.autoExit = true;
  worker.terminate = () => {
    worker.terminations++;
    if (worker.autoExit) {
      queueMicrotask(() => worker.emit('exit', 1));
      return Promise.resolve(1);
    }
    return new Promise((resolve) => {
      worker.finishTermination = resolve;
    });
  };
  worker.success = () =>
    worker.emit('message', {
      v: 1,
      ok: true,
      completed: options.workerData.map((task) => task.index),
    });
  worker.finishOutput = () => {
    worker.stdout.end();
    worker.stderr.end();
  };
  return worker;
}

function begin(t) {
  const f = fixture(t),
    workers = [];
  const pending = superviseInstallation(f.root, f.expected, (file, options) => {
    assert.equal(file, path.resolve('scripts/lib/nsis-installation-parallel-worker.js'));
    assert.deepEqual(options.execArgv, []);
    assert.deepEqual(options.env, {});
    const worker = fakeWorker(options);
    workers.push(worker);
    return worker;
  });
  return { ...f, workers, pending };
}

test('lightweight: supervisor requires complete task partitions and two clean exits', async (t) => {
  const f = begin(t);
  assert.equal(f.workers.length, 2);
  assert.deepEqual(
    f.workers.flatMap((worker) => worker.options.workerData.map((task) => task.index)).sort(),
    [0, 1, 2, 3]
  );
  for (const worker of f.workers) {
    worker.success();
    worker.emit('exit', 0);
    worker.finishOutput();
  }
  assert.deepEqual(await f.pending, verifyInstallation(f.root, f.expected));
  assert.equal(
    f.workers.every((worker) => worker.terminations === 0),
    true
  );
});

test('lightweight: worker uses the original guarded digest for every task and rejects invalid input', (t) => {
  const f = fixture(t);
  const task = { index: 0, file: path.join(f.root, 'lib/source.js'), hash: hash('synthetic') };
  assert.deepEqual(verifyTasks([task]), { v: 1, ok: true, completed: [0] });
  fs.appendFileSync(task.file, 'changed');
  assert.throws(() => verifyTasks([task]), /^Error: installation_worker_rejected$/);
  for (const input of [
    null,
    {},
    [],
    Array(2051).fill(task),
    [task, task],
    [{ ...task, index: -1 }],
    [{ ...task, index: 4099 }],
    [{ ...task, file: 'relative' }],
    [{ ...task, hash: 'PRIVATE_HASH' }],
    [{ ...task, token: 'PRIVATE_TOKEN' }],
  ])
    assert.throws(() => verifyTasks(input));
  let calls = 0;
  assert.deepEqual(
    verifyTasks([task], (file) => {
      calls++;
      assert.equal(file, task.file);
      return task.hash;
    }),
    { v: 1, ok: true, completed: [0] }
  );
  assert.equal(calls, 1);
});

test('lightweight: malformed, duplicate, missing, extra and foreign task results fail closed', async (t) => {
  for (const mode of [
    'empty',
    'failed',
    'partial',
    'foreign',
    'duplicate-index',
    'extra-key',
    'duplicate-message',
    'getter',
    'proxy',
  ]) {
    const f = begin(t);
    const ids = f.workers[0].options.workerData.map((task) => task.index);
    let message = { v: 1, ok: true, completed: ids };
    let accesses = 0;
    if (mode === 'empty') message = null;
    if (mode === 'failed') message = { v: 1, ok: false };
    if (mode === 'partial') message.completed = ids.slice(1);
    if (mode === 'foreign') message.completed = ids.map((index) => index + 1);
    if (mode === 'duplicate-index') message.completed = ids.map(() => ids[0]);
    if (mode === 'extra-key') message.error = 'PRIVATE_ERROR';
    if (mode === 'getter')
      Object.defineProperty(message, 'completed', {
        enumerable: true,
        get() {
          accesses++;
          throw Error('PRIVATE_GETTER');
        },
      });
    if (mode === 'proxy')
      message = new Proxy(message, {
        get() {
          accesses++;
          throw Error('PRIVATE_PROXY');
        },
      });
    const rejected = assert.rejects(f.pending, /^Error: installation_parallel_failed$/);
    f.workers[0].emit('message', message);
    if (mode === 'duplicate-message') f.workers[0].emit('message', message);
    await rejected;
    assert.equal(accesses, 0);
    assert.equal(
      f.workers.every((worker) => worker.terminations === 1),
      true
    );
  }
});

test('lightweight: worker error, early exit, nonzero exit, output and messageerror trigger cleanup', async (t) => {
  for (const mode of [
    'error',
    'early-exit',
    'nonzero-exit',
    'stdout',
    'stderr',
    'messageerror',
    'pipe-error',
  ]) {
    const f = begin(t);
    const rejected = assert.rejects(f.pending, /^Error: installation_parallel_failed$/);
    if (mode === 'error') f.workers[0].emit('error', new Error('PRIVATE_NATIVE_ERROR'));
    else if (mode === 'messageerror')
      f.workers[0].emit('messageerror', new Error('PRIVATE_MESSAGE'));
    else if (mode === 'stdout' || mode === 'stderr') f.workers[0][mode].write('PRIVATE_OUTPUT');
    else if (mode === 'pipe-error') f.workers[0].stderr.emit('error', new Error('PRIVATE_PIPE'));
    else {
      if (mode === 'nonzero-exit') f.workers[0].success();
      f.workers[0].emit('exit', mode === 'early-exit' ? 0 : 1);
    }
    await rejected;
    assert.equal(f.workers[1].terminations, 1);
  }
});

test('lightweight: failure waits for termination acknowledgement AND actual exit', async (t) => {
  const f = begin(t);
  f.workers.forEach((worker) => {
    worker.autoExit = false;
  });
  let settled = false;
  const rejected = assert.rejects(f.pending, /^Error: installation_parallel_failed$/).then(() => {
    settled = true;
  });
  f.workers[0].emit('error', new Error('PRIVATE_ERROR'));
  await Promise.resolve();
  assert.equal(settled, false);
  f.workers.forEach((worker) => worker.finishTermination(1));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  f.workers.forEach((worker) => worker.emit('exit', 1));
  await rejected;
});

test('lightweight: success messages cannot replace either clean exit', async (t) => {
  const f = begin(t);
  let settled = false;
  const completed = f.pending.then(() => {
    settled = true;
  });
  f.workers.forEach((worker) => worker.success());
  f.workers[0].emit('exit', 0);
  await Promise.resolve();
  assert.equal(settled, false);
  f.workers[1].emit('exit', 0);
  f.workers.forEach((worker) => worker.finishOutput());
  await completed;
  assert.equal(settled, true);
});

test('lightweight: exit cannot hide buffered output or output errors before EOF', async (t) => {
  for (const mode of ['stdout', 'stderr', 'stdout-error', 'stderr-error', 'early-close']) {
    const f = begin(t);
    const rejected = assert.rejects(f.pending, /^Error: installation_parallel_failed$/);
    for (const worker of f.workers) {
      worker.success();
      worker.emit('exit', 0);
    }
    await Promise.resolve();
    await Promise.resolve();
    if (mode === 'early-close') f.workers[0].stdout.emit('close');
    else if (mode.endsWith('-error'))
      f.workers[0][mode.split('-')[0]].emit('error', Error('PRIVATE_BUFFERED_ERROR'));
    else f.workers[0][mode].write('PRIVATE_BUFFERED_OUTPUT');
    f.workers.forEach((worker) => worker.finishOutput());
    await rejected;
  }
});

test('lightweight: success waits for all four output EOFs after both clean exits', async (t) => {
  const f = begin(t);
  let settled = false;
  const completed = f.pending.then(() => {
    settled = true;
  });
  for (const worker of f.workers) {
    worker.success();
    worker.emit('exit', 0);
  }
  f.workers[0].finishOutput();
  f.workers[1].stdout.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  f.workers[1].stderr.end();
  await completed;
  assert.equal(settled, true);
});

test('lightweight: missing output EOF fails at deadline after both clean exits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = begin(t);
  const rejected = assert.rejects(f.pending, /^Error: installation_parallel_failed$/);
  for (const worker of f.workers) {
    worker.success();
    worker.emit('exit', 0);
  }
  await Promise.resolve();
  t.mock.timers.tick(DEADLINE_MS);
  await rejected;
});

test('lightweight: rejected termination still requires actual exits before failure', async (t) => {
  const f = begin(t);
  let settled = false;
  for (const worker of f.workers)
    worker.terminate = () => Promise.reject(Error('PRIVATE_TERMINATE'));
  const rejected = assert.rejects(f.pending, /^Error: installation_parallel_failed$/).then(() => {
    settled = true;
  });
  f.workers[0].emit('error', Error('PRIVATE_WORKER'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  f.workers.forEach((worker) => worker.emit('exit', 1));
  await rejected;
});

test('lightweight: deadline is bounded and cannot succeed before cleanup exits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = begin(t);
  const rejected = assert.rejects(f.pending, /^Error: installation_parallel_failed$/);
  assert.equal(DEADLINE_MS, 12000);
  t.mock.timers.tick(DEADLINE_MS);
  await rejected;
  assert.equal(
    f.workers.every((worker) => worker.terminations === 1),
    true
  );
});

test('lightweight: second worker construction failure joins the first worker before rejecting', async (t) => {
  const f = fixture(t);
  let first;
  const pending = superviseInstallation(f.root, f.expected, (file, options) => {
    if (first) throw Error('PRIVATE_CONSTRUCTION');
    first = fakeWorker(options);
    return first;
  });
  await assert.rejects(pending, /^Error: installation_parallel_failed$/);
  assert.equal(first.terminations, 1);
});

test('lightweight: synchronous boundary fixes execution, environment, input and strict result schema', (t) => {
  const f = fixture(t);
  const start = (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, [path.resolve('scripts/lib/nsis-installation-parallel-supervisor.js')]);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 15000);
    assert.equal(options.maxBuffer, 8192);
    assert.equal(
      Object.keys(options.env).every((key) => ['SystemRoot', 'WINDIR'].includes(key)),
      true
    );
    assert.deepEqual(JSON.parse(options.input), { install: f.root, manifestSha256: f.expected });
    return { status: 0, signal: null, stdout: '{"v":1,"ok":true,"sourceCount":1}\n', stderr: '' };
  };
  assert.deepEqual(
    verifyInstallationParallel(f.root, f.expected, start),
    verifyInstallation(f.root, f.expected)
  );
  for (const result of [
    { status: 1 },
    { error: Error('PRIVATE_NATIVE') },
    { signal: 'SIGTERM' },
    { stderr: 'PRIVATE_STDERR' },
    { stdout: '{"v":1,"ok":false}\n' },
    { stdout: '{"v":1,"ok":true,"sourceCount":0}\n' },
    { stdout: '{"v":1,"ok":true,"sourceCount":4097}\n' },
    { stdout: '{"v":1,"v":1,"ok":true,"sourceCount":1}\n' },
    { stdout: '{"v":1,"ok":true,"sourceCount":1,"error":"PRIVATE_ERROR"}\n' },
    { stdout: ' '.repeat(8193) },
  ])
    assert.throws(
      () =>
        verifyInstallationParallel(f.root, f.expected, (...args) => ({
          ...start(...args),
          ...result,
        })),
      /^Error: installation_parallel_failed$/
    );
  for (const bad of ['', null, {}, 'A'.repeat(64)])
    assert.throws(() =>
      verifyInstallationParallel(f.root, bad, () => assert.fail('must not spawn'))
    );
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/nsis-installation-parallel.test.js'
    )
  );
});

test('isolated real: parallel verifier matches serial receipt and rejects tampered, hardlinked and junction artifacts', (t) => {
  const f = fixture(t);
  assert.deepEqual(
    verifyInstallationParallel(f.root, f.expected),
    verifyInstallation(f.root, f.expected)
  );
  const file = path.join(f.root, 'lib/source.js');
  fs.appendFileSync(file, 'changed');
  assert.throws(() => verifyInstallationParallel(f.root, f.expected));
  fs.writeFileSync(file, 'synthetic');
  const link = path.join(f.root, 'hardlink');
  fs.linkSync(file, link);
  assert.throws(() => verifyInstallationParallel(f.root, f.expected));
  fs.unlinkSync(link);
  const moved = path.join(f.root, 'moved-lib');
  fs.renameSync(path.dirname(file), moved);
  fs.symlinkSync(moved, path.dirname(file), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyInstallationParallel(f.root, f.expected));
});
