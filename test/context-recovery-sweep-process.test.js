'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { runRecoverySweepCrash } = require('./helpers/context-recovery-sweep-process.cjs');

function fixture() {
  let time = 0;
  let next = 0;
  const timers = new Map();
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.sent = [];
  child.kills = [];
  child.send = (message, callback) => {
    child.sent.push(message);
    callback(null);
  };
  child.kill = (signal) => child.kills.push(signal);
  const dependencies = {
    now: () => time,
    forkChild(file, args, options) {
      assert.equal(path.basename(file), 'context-recovery-sweep-crash.cjs');
      assert.deepEqual(args, []);
      assert.deepEqual(options, { silent: true, windowsHide: true, execArgv: [] });
      return child;
    },
    setTimer(callback, delay) {
      const id = ++next;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  };
  return {
    child,
    timers,
    start: (input = { synthetic: true }) => runRecoverySweepCrash(input, dependencies),
    advance(value, fire = true) {
      time += value;
      if (fire)
        for (const [id, timer] of [...timers])
          if (timer.at <= time) {
            timers.delete(id);
            timer.callback();
          }
    },
  };
}

test('preparation longer than five seconds remains allowed below its absolute thirty seconds', async () => {
  const f = fixture();
  const result = f.start();
  assert.equal([...f.timers.values()][0].at, 30000);
  f.advance(6000);
  assert.deepEqual(f.child.kills, []);
  f.child.emit('message', 'ready');
  assert.deepEqual(f.child.sent, ['sweep']);
  assert.equal([...f.timers.values()][0].at, 11000);
  f.child.stdout.write('maintenance-before-commit');
  f.advance(4999);
  f.child.emit('close', 37, null);
  assert.deepEqual(await result, { status: 37, stdout: 'maintenance-before-commit' });
  assert.equal(f.timers.size, 0);
});

test('thirty second preparation deadline is absolute, including delayed timer dispatch', async () => {
  for (const fire of [true, false]) {
    const f = fixture();
    const result = f.start();
    const rejected = assert.rejects(result, /^Error: maintenance_fixture_prepare_timeout$/);
    f.advance(29999);
    assert.deepEqual(f.child.kills, []);
    f.advance(1, fire);
    f.child.emit('message', 'ready');
    assert.deepEqual(f.child.sent, []);
    assert.deepEqual(f.child.kills, ['SIGKILL']);
    f.child.emit('close', null, 'SIGKILL');
    await rejected;
    assert.equal(f.timers.size, 0);
  }
});

test('sweep retains exactly five seconds and timeout waits for owned child close', async () => {
  const f = fixture();
  let terminal = false;
  const result = f.start();
  const rejected = assert.rejects(result, /maintenance_fixture_sweep_timeout/).then(() => {
    terminal = true;
  });
  f.advance(29000);
  f.child.emit('message', 'ready');
  f.advance(4999);
  assert.deepEqual(f.child.kills, []);
  f.advance(1);
  assert.deepEqual(f.child.kills, ['SIGKILL']);
  await Promise.resolve();
  assert.equal(terminal, false);
  f.child.emit('close', null, 'SIGKILL');
  await rejected;
});

test('late close cannot pass the sweep deadline even if timeout callback is delayed', async () => {
  const f = fixture();
  const result = f.start();
  f.child.emit('message', 'ready');
  f.advance(5000, false);
  f.child.emit('close', 37, null);
  await assert.rejects(result, /maintenance_fixture_sweep_timeout/);
});

test('wrong or repeated IPC is rejected without renewing deadlines or authorizing twice', async () => {
  for (const messages of [['invalid'], ['ready', 'ready'], [null], [{ ready: true }]]) {
    const f = fixture();
    const result = f.start();
    for (const message of messages) f.child.emit('message', message);
    assert.deepEqual(f.child.kills, ['SIGKILL']);
    assert.ok(f.child.sent.length <= 1);
    f.child.emit('close', null, 'SIGKILL');
    await assert.rejects(result, /maintenance_fixture_protocol_failed/);
    assert.equal(f.timers.size, 0);
  }
});

test('early exit, wrong exit status, signals and child errors fail closed', async () => {
  for (const variant of ['early', 'wrong', 'signal', 'error', 'stdin']) {
    const f = fixture();
    const result = f.start();
    if (variant !== 'early') f.child.emit('message', 'ready');
    if (variant === 'error') f.child.emit('error', new Error('private diagnostics'));
    if (variant === 'stdin') f.child.stdin.emit('error', new Error('private input'));
    f.child.emit('close', variant === 'wrong' ? 39 : 37, variant === 'signal' ? 'SIGTERM' : null);
    await assert.rejects(result, (error) => {
      assert.match(error.message, /^maintenance_fixture_(exit|process|input)_failed$/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.timers.size, 0);
    assert.equal(f.child.kills.length, ['error', 'stdin'].includes(variant) ? 1 : 0);
  }
});

test('combined output cap and invalid input never expose private content and await cleanup', async () => {
  for (const variant of ['output', 'input']) {
    const f = fixture();
    const result = f.start(variant === 'input' ? 'x'.repeat(65536) : undefined);
    if (variant === 'output') {
      f.child.stderr.write(Buffer.alloc(65536, 120));
      f.child.stdout.write('private');
    }
    assert.deepEqual(f.child.kills, ['SIGKILL']);
    f.child.emit('close', null, 'SIGKILL');
    await assert.rejects(result, new RegExp(`maintenance_fixture_${variant}_`));
    assert.equal(f.timers.size, 0);
  }
  await assert.rejects(
    runRecoverySweepCrash(
      {},
      {
        forkChild() {
          throw new Error('private path');
        },
      }
    ),
    /^Error: maintenance_fixture_spawn_failed$/
  );
});

test('wrong crash marker never exposes captured content in an assertion', async () => {
  for (const output of ['', 'private-key-state', 'maintenance-before-commit\n']) {
    const f = fixture();
    const result = f.start();
    f.child.emit('message', 'ready');
    f.child.stdout.write(output);
    f.child.emit('close', 37, null);
    await assert.rejects(result, /^Error: maintenance_fixture_marker_failed$/);
  }
});

test('synchronous IPC or termination failures remain private and wait for close', async () => {
  for (const operation of ['send', 'kill']) {
    const f = fixture();
    f.child[operation] = () => {
      throw new Error('private process details');
    };
    let settled = false;
    const result = f.start();
    const rejected = assert
      .rejects(
        result,
        new RegExp(
          `^Error: maintenance_fixture_${operation === 'send' ? 'protocol' : 'termination'}_failed$`
        )
      )
      .then(() => {
        settled = true;
      });
    f.child.emit('message', operation === 'send' ? 'ready' : 'invalid');
    await Promise.resolve();
    assert.equal(settled, false);
    f.child.emit('close', null, 'SIGKILL');
    await rejected;
  }
});
