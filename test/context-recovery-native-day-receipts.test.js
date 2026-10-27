'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { createNativeDayReceipts } = require('../scripts/lib/context-recovery-native-day-receipts');

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-day-receipts-test-')
  );
  const receipts = createNativeDayReceipts(root);
  t.after(() => {
    try {
      receipts.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, receipts, file: path.join(receipts.directory, 'progress.jsonl') };
}
const read = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const write = (line) => Buffer.byteLength(line);

test('child journal is fresh, bounded, and records a result without claiming actual exit', (t) => {
  const { root, receipts, file } = fixture(t);
  const events = [];
  receipts.emit({ event: 'capacity_tick', elapsedMs: 300001 }, (line) => {
    events.push(line);
    return write(line);
  });
  receipts.finish(0);
  assert.equal(read(file).length, 2);
  assert.deepEqual(read(file)[0], JSON.parse(events[0]));
  assert.equal(read(file)[1].exitCode, 0);
  assert.equal(read(file)[1].actualExitVerified, false);
  assert.equal(read(file)[1].pid, process.pid);
  assert.throws(() => receipts.finish(0));
  assert.throws(() => receipts.emit({}, write));
  const another = createNativeDayReceipts(root);
  assert.notEqual(another.directory, receipts.directory);
  another.finish(1);
  another.close();
  receipts.close();
  receipts.close();
});

test('broken supervisor pipe preserves its prior event and independent failure result', (t) => {
  const { receipts, file } = fixture(t);
  assert.throws(
    () =>
      receipts.emit({ event: 'capacity_tick', elapsedMs: 900001 }, () => {
        throw Error('PRIVATE_PIPE_EXCEPTION');
      }),
    /^Error: native_day_receipts_failed$/
  );
  assert.throws(() => receipts.finish(0));
  receipts.finish(1);
  assert.deepEqual(
    read(file).map((v) => v.event),
    ['capacity_tick', 'native_day_process_result']
  );
  assert.equal(read(file).at(-1).exitCode, 1);
  assert.equal(fs.readFileSync(file, 'utf8').includes('PRIVATE_PIPE_EXCEPTION'), false);
});

test('short writes reject success rather than silently dropping output', (t) => {
  const { receipts, file } = fixture(t);
  assert.throws(() => receipts.emit({ event: 'startup' }, () => 0));
  assert.throws(() => receipts.finish(0));
  receipts.finish(1);
  assert.equal(read(file).at(-1).exitCode, 1);
});

test('invalid and inherited parent paths are refused before any file creation', (t) => {
  const { root } = fixture(t);
  const before = fs.readdirSync(root);
  for (const value of [null, undefined, '', '.', {}, root + '/..', root + '\n', 'x'.repeat(4097)]) {
    assert.throws(() => createNativeDayReceipts(value));
  }
  assert.deepEqual(fs.readdirSync(root), before);
});

test('directory and journal replacement reject further writes without modifying replacements', (t) => {
  for (const replace of ['file', 'directory']) {
    const { receipts, file } = fixture(t);
    if (replace === 'file') {
      fs.renameSync(file, file + '.original');
      fs.writeFileSync(file, 'replacement');
    } else {
      fs.renameSync(receipts.directory, receipts.directory + '.original');
      fs.mkdirSync(receipts.directory);
      fs.writeFileSync(file, 'replacement');
    }
    assert.throws(() => receipts.emit({ event: 'startup' }, write));
    assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
    assert.throws(() => receipts.close());
  }
});

test('hard-linked journal and linked parent are rejected without writing through them', (t) => {
  const { root, receipts, file } = fixture(t);
  fs.linkSync(file, path.join(root, 'linked-journal'));
  assert.throws(() => receipts.emit({ event: 'startup' }, write));
  assert.equal(fs.statSync(file).size, 0);
  assert.throws(() => receipts.close());
  const target = path.join(root, 'target'),
    link = path.join(root, 'linked-parent');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createNativeDayReceipts(link));
  assert.deepEqual(fs.readdirSync(target), []);
});

test('line overflow and malformed writer fail closed', (t) => {
  const { receipts, file } = fixture(t);
  for (const writer of [undefined, null, async () => {}, function* () {}, new Proxy(write, {})]) {
    assert.throws(() => receipts.emit({ event: 'startup' }, writer));
  }
  assert.equal(fs.statSync(file).size, 0);
  assert.throws(() => receipts.emit({ event: 'startup', fixed: 'a'.repeat(65536) }, write));
  assert.equal(fs.statSync(file).size, 0);
  assert.throws(() => receipts.finish(1));
});

test('total journal size cannot exceed sixteen MiB', (t) => {
  const { receipts, file } = fixture(t);
  const event = { event: 'capacity_tick', fixed: 'a'.repeat(65000) };
  let count = 0;
  while (count < 300) {
    try {
      receipts.emit(event, write);
      count++;
    } catch {
      break;
    }
  }
  assert.ok(count > 250 && count < 300);
  assert.ok(fs.statSync(file).size <= 16 * 1024 * 1024);
  const size = fs.statSync(file).size;
  assert.throws(() => receipts.emit({ event: 'startup' }, write));
  assert.equal(fs.statSync(file).size, size);
});

for (const mode of ['success', 'private-failure', 'broken-pipes']) {
  test('actual day entry preserves independent result: ' + mode, async (t) => {
    const { root } = fixture(t);
    const filename = path.resolve(__dirname, '../scripts/qualify-context-recovery-native-day.js');
    const original = createRequire(filename);
    const state = { platform: 'win32', argv: ['node', filename], exitCode: undefined };
    let journal;
    await vm.runInNewContext(
      fs.readFileSync(filename, 'utf8'),
      {
        process: state,
        require(name) {
          if (name === 'node:os') return { tmpdir: () => root };
          if (name === 'node:fs')
            return {
              ...fs,
              writeSync(fd, ...args) {
                if (fd === 1 || fd === 2) {
                  if (mode === 'broken-pipes') throw Error('PRIVATE_BROKEN_PIPE');
                  return Buffer.byteLength(args[0]);
                }
                return fs.writeSync(fd, ...args);
              },
            };
          if (name === './lib/context-recovery-native-day')
            return {
              async runNativeCapacityDay(directory, emit) {
                assert.equal(directory, path.join(journal.directory, 'context'));
                emit({ event: 'capacity_tick', elapsedMs: 900001 });
                if (mode === 'private-failure') throw Error('PRIVATE_STORAGE_EXCEPTION');
              },
            };
          if (name === './lib/context-recovery-native-day-receipts')
            return {
              createNativeDayReceipts(parent) {
                journal = createNativeDayReceipts(parent);
                return journal;
              },
            };
          return original(name);
        },
      },
      { filename }
    );
    const text = fs.readFileSync(path.join(journal.directory, 'progress.jsonl'), 'utf8');
    const result = JSON.parse(text.trim().split('\n').at(-1));
    assert.equal(result.exitCode, mode === 'success' ? 0 : 1);
    assert.equal(state.exitCode, mode === 'success' ? undefined : 1);
    assert.equal(text.includes('PRIVATE_'), false);
    assert.equal(result.actualExitVerified, false);
  });
}

// Real OS pipe teardown, without starting a capacity test or native storage.
test(
  'real child retains failure after its supervisor closes stdout',
  { timeout: 10000 },
  async (t) => {
    const { root } = fixture(t);
    const code = `
    const fs = require('node:fs');
    const { createNativeDayReceipts } = require(process.argv[1]);
    const journal = createNativeDayReceipts(process.argv[2]);
    process.once('message', () => {
      let exitCode = 0;
      try { journal.emit({ event: 'capacity_tick', elapsedMs: 900001 }, (line) => fs.writeSync(1, line)); }
      catch { exitCode = 1; }
      finally { try { journal.finish(exitCode); } finally { journal.close(); } }
      process.exitCode = exitCode;
      process.disconnect();
    });
    process.send({ directory: journal.directory });
  `;
    const child = spawn(
      process.execPath,
      ['-e', code, require.resolve('../scripts/lib/context-recovery-native-day-receipts'), root],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      }
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const exited = once(child, 'exit');
    const [ready] = await once(child, 'message');
    assert.equal(path.dirname(ready.directory), root);
    const closed = once(child.stdout, 'close');
    child.stdout.destroy();
    await closed;
    child.send('go');
    const [exitCode, signal] = await exited;
    assert.equal(exitCode, 1);
    assert.equal(signal, null);
    const events = read(path.join(ready.directory, 'progress.jsonl'));
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'capacity_tick');
    assert.equal(events[1].exitCode, 1);
    assert.equal(events[1].actualExitVerified, false);
  }
);

test('physical short file writes are completed, while flush failure never falls back to pipes', (t) => {
  const filename = require.resolve('../scripts/lib/context-recovery-native-day-receipts');
  const original = createRequire(filename);
  for (const mode of ['partial', 'flush-failure']) {
    const { root } = fixture(t);
    const loaded = { exports: {} };
    let writes = 0,
      pipeWrites = 0;
    vm.runInNewContext(
      fs.readFileSync(filename, 'utf8'),
      {
        module: loaded,
        process,
        Buffer,
        require(name) {
          if (name !== 'node:fs') return original(name);
          return {
            ...fs,
            writeSync(fd, buffer, offset, length) {
              writes++;
              return fs.writeSync(
                fd,
                buffer,
                offset,
                mode === 'partial' ? Math.min(7, length) : length
              );
            },
            fsyncSync(fd) {
              if (mode === 'flush-failure') throw Error('PRIVATE_FLUSH_FAILURE');
              fs.fsyncSync(fd);
            },
          };
        },
      },
      { filename }
    );
    const journal = loaded.exports.createNativeDayReceipts(root);
    const emit = () =>
      journal.emit({ event: 'capacity_tick', elapsedMs: 900001 }, (line) => {
        pipeWrites++;
        return write(line);
      });
    if (mode === 'partial') {
      emit();
      journal.finish(0);
      assert.ok(writes > 2);
      assert.equal(pipeWrites, 1);
      assert.equal(read(path.join(journal.directory, 'progress.jsonl')).at(-1).exitCode, 0);
    } else {
      assert.throws(emit, /^Error: native_day_receipts_failed$/);
      assert.equal(pipeWrites, 0);
      assert.throws(() => journal.finish(0));
      assert.throws(() => journal.finish(1));
      assert.equal(read(path.join(journal.directory, 'progress.jsonl')).length, 1);
    }
    journal.close();
  }
});
