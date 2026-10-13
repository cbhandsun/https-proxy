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

withFakeProcess(({ timers }) => {
  cp.spawn = () => {
    throw new Error('SECRET-token-cookie-user-content');
  };
  const result = traeDebugCenter.runNativeScan();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.running, false);
  assert.strictEqual(result.scan.running, false);
  assert.strictEqual(traeDebugCenter._test.nativeScanState.child, null);
  assert.ok(result.scan.endedAt >= result.scan.startedAt);
  assert.strictEqual(timers.length, 0);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.strictEqual(traeDebugCenter.runNativeScan().running, false);
});

withFakeProcess(({ timers, spawned }) => {
  traeDebugCenter.runNativeScan();
  spawned[0].emit('error', new Error('SECRET-token-cookie-user-content'));
  const state = traeDebugCenter._test.nativeScanState;
  assert.strictEqual(state.running, false);
  assert.strictEqual(state.child, null);
  assert.strictEqual(state.result.ok, false);
  assert.strictEqual(timers[0].cleared, true);
  assert.ok(!JSON.stringify(state.result).includes('SECRET'));
  const failed = JSON.stringify(state.result);
  spawned[0].emit('exit', 0);
  assert.strictEqual(JSON.stringify(state.result), failed);
  traeDebugCenter._test.resetNativeDebugState();
  assert.strictEqual(traeDebugCenter.runNativeScan().running, true);
  assert.strictEqual(spawned.length, 2);
  spawned[1].emit('exit', 0);
  assert.strictEqual(state.result.ok, true);
});

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
  child.stderr.emit('data', Buffer.from('SECRET-token-cookie-user-content'));
  let snapshot = traeDebugCenter.getNativeDeepEvents({ limit: 10 });
  assert.ok(snapshot.events.some((event) => event.kind === 'native_probe_stderr'));
  assert.ok(!JSON.stringify(snapshot).includes('SECRET-token-cookie-user-content'));

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

withFakeProcess(({ spawned }) => {
  traeDebugCenter._test.nativeScanState.result = null;
  traeDebugCenter.runNativeScan();
  const child = spawned[0];
  child.stdout.emit(
    'data',
    Buffer.from(
      '--- attach 1234\n{"module": "ai_agent.dll"}\nSECRET cookie=private user content\n--- attach 999999999999999999999999999999\n{"module": "aha_net.dll"}'
    )
  );
  child.emit('exit', 0);
  const result = traeDebugCenter._test.nativeScanState.result;
  assert.strictEqual(result.summary.aiAgentPid, 1234);
  assert.strictEqual(result.summary.ahaNetPid, null);
  assert.strictEqual(result.output.includes('SECRET'), false);
  assert.deepStrictEqual(JSON.parse(result.output), result.summary);
});
const originalSpawnSync = cp.spawnSync;
try {
  cp.spawnSync = () => ({ status: 0, stdout: 'SECRET token=user-content', stderr: 'SECRET' });
  assert.strictEqual(traeDebugCenter.nativeDebugStatus().tools.node.output, '');
  cp.spawnSync = () => ({ status: 0, stdout: 'v22.22.3\n' });
  assert.strictEqual(traeDebugCenter.nativeDebugStatus().tools.node.output, 'v22.22.3');
  cp.spawnSync = () => ({ status: 1, stdout: 'v22.22.3', stderr: 'SECRET' });
  assert.strictEqual(traeDebugCenter.nativeDebugStatus().tools.node.output, '');
} finally {
  cp.spawnSync = originalSpawnSync;
}
console.log('[trae-debug-center.test] ok');
