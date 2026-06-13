const assert = require('assert');
const cp = require('child_process');
const { EventEmitter } = require('events');

const traeDebugCenter = require('../lib/proxy/trae-debug-center');

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 24680;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function withFakeProcess(callback) {
  const originalSpawn = cp.spawn;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  const spawned = [];
  try {
    cp.spawn = (...args) => {
      const child = createFakeChild();
      child.spawnArgs = args;
      spawned.push(child);
      return child;
    };
    global.setTimeout = (fn, delay) => {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    };
    global.clearTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };
    traeDebugCenter._test.resetNativeDebugState();
    callback({ timers, spawned });
  } finally {
    traeDebugCenter._test.resetNativeDebugState();
    cp.spawn = originalSpawn;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

withFakeProcess(({ timers, spawned }) => {
  const result = traeDebugCenter.runNativeScan();
  assert.strictEqual(result.running, true);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(timers[0].delay, 30000);

  timers[0].fn();
  const child = spawned[0];
  assert.strictEqual(child.killed, true);
  assert.strictEqual(traeDebugCenter._test.nativeScanState.running, false);
  assert.strictEqual(traeDebugCenter._test.nativeScanState.result.timedOut, true);
  assert.match(traeDebugCenter._test.nativeScanState.error, /timed out/);

  child.emit('exit', 0);
  assert.strictEqual(traeDebugCenter._test.nativeScanState.result.ok, false);
  assert.strictEqual(traeDebugCenter._test.nativeScanState.result.timedOut, true);
});

withFakeProcess(({ timers, spawned }) => {
  const result = traeDebugCenter.startNativeDeepProbe({ pid: 1234, durationSeconds: 5 });
  assert.strictEqual(result.running, true);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(timers[0].delay, 15000);

  const child = spawned[0];
  child.stderr.emit('data', Buffer.from('frida attach warning'));
  let snapshot = traeDebugCenter.getNativeDeepEvents({ limit: 10 });
  assert.ok(snapshot.events.some((event) => event.kind === 'native_probe_stderr'));

  timers[0].fn();
  assert.strictEqual(child.killed, true);
  snapshot = traeDebugCenter.getNativeDeepEvents({ limit: 10 });
  assert.strictEqual(snapshot.status, 'error');
  assert.strictEqual(snapshot.running, false);
  assert.match(snapshot.error, /timed out/);
  assert.ok(snapshot.events.some((event) => event.kind === 'native_probe_timeout'));

  child.emit('exit', 0);
  snapshot = traeDebugCenter.getNativeDeepEvents({ limit: 10 });
  assert.strictEqual(snapshot.status, 'error');
  assert.match(snapshot.error, /timed out/);
});

console.log('[trae-debug-center.test] ok');
