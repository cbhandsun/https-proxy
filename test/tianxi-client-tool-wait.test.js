'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const {
  createTianxiClientToolWait,
  hasNativeProgress,
} = require('../lib/proxy/tianxi-client-tool-wait');
const {
  createTianxiClientToolSessions,
  serveTianxiClientToolLease,
} = require('../lib/proxy/tianxi-client-tool-sessions');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');

function clock() {
  let time = 0,
    id = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(callback, delay) {
      timers.set(++id, { callback, due: time + delay });
      return id;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    advance(ms) {
      const target = time + ms;
      for (let i = 0; i < 1024; i++) {
        const next = [...timers.entries()]
          .filter(([, value]) => value.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) {
          time = target;
          return;
        }
        time = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      assert.fail('unexpected unbounded timer loop');
    },
  };
}

test('client wait notices once, times out once and ignores stale callbacks', () => {
  const timer = clock(),
    notices = [];
  const wait = createTianxiClientToolWait({
    ...timer,
    idleTimeoutMs: 100,
    noticeAfterMs: 30,
    onWaiting: () => notices.push('waiting'),
    onTimeout: () => notices.push('timeout'),
  });
  wait.resume();
  const stale = [...timer.timers.values()].map((value) => value.callback);
  timer.advance(29);
  assert.deepEqual(notices, []);
  timer.advance(1);
  assert.deepEqual(notices, ['waiting']);
  timer.advance(70);
  assert.deepEqual(notices, ['waiting', 'timeout']);
  for (const callback of stale) callback();
  timer.advance(1000);
  assert.deepEqual(notices, ['waiting', 'timeout']);
  assert.equal(timer.timers.size, 0);
});

test('real output resets inactivity; status and proxy-generated idle summaries cannot extend it', () => {
  const timer = clock(),
    notices = [];
  const wait = createTianxiClientToolWait({
    ...timer,
    idleTimeoutMs: 100,
    noticeAfterMs: 30,
    onWaiting() {},
    onTimeout: () => notices.push('timeout'),
  });
  wait.resume();
  for (let i = 0; i < 10; i++) {
    timer.advance(90);
    wait.progress({ type: 'task_output', data: { delta: 'actual provider output' } });
  }
  assert.deepEqual(notices, []);
  timer.advance(90);
  for (const frame of [
    { type: 'task_status', data: { status: 'WORKING' } },
    { type: 'task_output', data: { content: '   ' } },
    {
      type: 'task_output',
      data: {
        content_type: 'summary',
        content: 'Tianxi native stream is still open; waiting for further output.\n',
      },
    },
  ])
    wait.progress(frame);
  timer.advance(10);
  assert.deepEqual(notices, ['timeout']);
  wait.close();
});

test('client execution pauses the provider deadline and closing clears all timers', () => {
  const timer = clock();
  let deadlines = 0;
  const wait = createTianxiClientToolWait({
    ...timer,
    idleTimeoutMs: 100,
    noticeAfterMs: 30,
    onWaiting() {},
    onTimeout: () => deadlines++,
  });
  wait.resume();
  timer.advance(25);
  wait.pause();
  timer.advance(1000000);
  wait.progress({ type: 'act_resp' });
  assert.equal(timer.timers.size, 0);
  assert.equal(deadlines, 0);
  wait.resume();
  timer.advance(99);
  assert.equal(deadlines, 0);
  const stale = [...timer.timers.values()].map((value) => value.callback);
  wait.close();
  wait.resume();
  for (const callback of stale) callback();
  timer.advance(1000000);
  assert.equal(deadlines, 0);
  assert.equal(timer.timers.size, 0);
});

test('native progress parses empty, malformed and structured output without coercing unknown values', () => {
  for (const frame of [
    null,
    [],
    'SECRET',
    {},
    { type: 'task_output', data: null },
    { type: 'task_output', data: { content: 42 } },
    { type: 'task_output', data: { content: [{ text: 42 }] } },
  ])
    assert.equal(hasNativeProgress(frame), false);
  for (const frame of [
    { type: 'act_exec' },
    { type: 'act_resp' },
    { type: 'task_output', data: { content: [{ text: 'output' }] } },
  ])
    assert.equal(hasNativeProgress(frame), true);
  for (const options of [
    { idleTimeoutMs: 0 },
    { idleTimeoutMs: Infinity },
    { idleTimeoutMs: 3600001 },
    { noticeAfterMs: 0 },
    { noticeAfterMs: 300000 },
    { noticeAfterMs: '30' },
    { setTimer: null },
    { clearTimer: null },
    { onWaiting: null },
  ])
    assert.throws(
      () => createTianxiClientToolWait({ onWaiting() {}, onTimeout() {}, ...options }),
      /Invalid Tianxi client wait policy/
    );
});

test('HTTP continuation shows waiting then fails safely without rerunning a client read', async () => {
  const timer = clock(),
    diagnostics = [];
  let context,
    replies = 0,
    queries = 0;
  const manager = createTianxiClientToolSessions({
    compile: () => ({ cmd: 'safe' }),
    nativeIdleTimeoutMs: 100,
    waitNoticeMs: 30,
    setProgressTimer: timer.setTimer,
    clearProgressTimer: timer.clearTimer,
    onDiagnostic: (value) => diagnostics.push(value),
  });
  const lease = manager.start({
    owner: 'owner',
    model: 'tianxi/super',
    payload: {},
    nativeTools: { cwd: 'C:\\repo', disallowedTools: [] },
    run(_, value) {
      context = value;
      queries++;
      return new Promise((_, reject) => {
        value.signal.addEventListener('abort', () => reject(new Error('SECRET token prompt')), {
          once: true,
        });
        value.onExternalToolCall({ data: { actions: [{ id: 'a' }] } }, () => {
          replies++;
          return true;
        });
      });
    },
  });
  const call = (await lease.promise).output[0];
  timer.advance(10000);
  assert.equal(context.signal.aborted, false);
  const continued = manager.resume('owner', [
    { type: 'custom_tool_call_output', call_id: call.call_id, output: 'SECRET tool result' },
  ]);
  const res = new EventEmitter();
  Object.assign(res, {
    body: '',
    writableEnded: false,
    writeHead() {},
    write(text) {
      this.body += text;
    },
    end(text) {
      this.body += text;
      this.writableEnded = true;
      this.emit('close');
    },
  });
  const served = serveTianxiClientToolLease(res, continued, true);
  timer.advance(30);
  assert.ok(res.body.includes('仍在等待天禧'));
  context.onFrame({ type: 'task_status', data: { status: 'WORKING' } });
  timer.advance(70);
  const final = await served;
  assert.equal(final.status, 'failed');
  assert.equal(context.signal.aborted, true);
  assert.equal(queries, 1);
  assert.equal(replies, 1);
  assert.ok(res.body.includes('response.failed'));
  assert.ok(res.body.includes('持续未返回有效进展'));
  assert.ok(!JSON.stringify({ final, diagnostics, body: res.body }).includes('SECRET'));
  assert.deepEqual(diagnostics, [{ category: 'tianxi_client_progress_timeout', clientCalls: 1 }]);
  assert.equal(timer.timers.size, 0);
  assert.equal(res.listenerCount('close'), 0);
  manager.close();
});

test('a waiting-notice write failure terminates the task and clears timers', async () => {
  const timer = clock();
  const manager = createTianxiClientToolSessions({
    nativeIdleTimeoutMs: 100,
    waitNoticeMs: 30,
    setProgressTimer: timer.setTimer,
    clearProgressTimer: timer.clearTimer,
  });
  const lease = manager.start({
    owner: 'owner',
    model: 'tianxi/super',
    payload: {},
    nativeTools: { cwd: 'C:\\repo', disallowedTools: [] },
    run(_, context) {
      return new Promise((_, reject) =>
        context.signal.addEventListener('abort', () => reject(new Error('SECRET')), { once: true })
      );
    },
  });
  lease.subscribe((code) => {
    if (code === 'waiting') throw new Error('SECRET write failure');
  });
  await Promise.resolve();
  timer.advance(30);
  const result = await lease.promise;
  assert.equal(result.status, 'failed');
  assert.equal(timer.timers.size, 0);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  manager.close();
});

test('wait regressions participate in the unified unit-test entry', () => {
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(require('node:path').resolve(__dirname, '..'))).includes(
      'test/tianxi-client-tool-wait.test.js'
    )
  );
});
