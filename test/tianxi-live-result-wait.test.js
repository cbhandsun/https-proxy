'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createTianxiToolResultCache } = require('../lib/proxy/tianxi-tool-result-cache');
const {
  waitTianxiResultContinuation,
  trackTianxiNativeTask,
  getActiveTianxiNativeTasks,
} = require('../lib/proxy/tianxi-live-result-wait');

test('health task count remains active through HTTP handoff and cleanup is idempotent', () => {
  const baseline = getActiveTianxiNativeTasks();
  const end = trackTianxiNativeTask();
  assert.equal(getActiveTianxiNativeTasks(), baseline + 1);
  end();
  end();
  assert.equal(getActiveTianxiNativeTasks(), baseline);
});

function setup() {
  const cache = createTianxiToolResultCache();
  const task = cache.begin('owner', {
    serialResultTool: { namespace: 'mcp__tianxi_progress', name: 'read_result' },
  });
  const first = cache.start('owner', task, 'one', 'Read');
  cache.finish('owner', task, 'one', 'completed');
  let cancels = 0;
  cache.enableLive('owner', task, 'super', () => cancels++);
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    body: '',
    writeHead() {
      this.headersSent = true;
    },
    write(text) {
      this.body += text;
    },
  });
  return {
    cache,
    task,
    first,
    res,
    get cancels() {
      return cancels;
    },
  };
}

test('live waiting emits heartbeats, returns the next finished operation and preserves retry identity', async () => {
  const h = setup();
  const second = h.cache.start('owner', h.task, 'two', 'Grep');
  const pending = waitTianxiResultContinuation(h.cache, 'owner', [h.first.reference], h.res, {
    stream: true,
  });
  assert.ok(h.res.body.startsWith(': tianxi-result-waiting'));
  assert.equal(h.cache.continuation('owner', [h.first.reference]).nextCall, undefined);
  h.cache.finish('owner', h.task, 'two', 'completed');
  const result = await pending;
  assert.equal(result.status, 'in_progress');
  assert.equal(JSON.parse(result.nextCall.arguments).reference, second.reference);
  assert.equal(
    h.cache.continuation('owner', [h.first.reference]).nextCall.call_id,
    result.nextCall.call_id
  );
  assert.equal(h.res.listenerCount('close'), 0);
  assert.equal(h.cancels, 0);
  h.cache.discard('owner', h.task);
});

test('live disconnect and deadline cancel the native task exactly once and release listeners', async (t) => {
  // Freeze wall time until the intended deadline branch. Coverage/host load
  // must not let a 1-ms deadline win before this test emits disconnect.
  // Production deadlines and both terminal-contract assertions stay unchanged.
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  for (const mode of ['disconnect', 'deadline', 'already-closed']) {
    const h = setup();
    if (mode === 'already-closed') h.res.destroyed = true;
    const pending = waitTianxiResultContinuation(h.cache, 'owner', [h.first.reference], h.res, {
      timeoutMs: 1,
    });
    if (mode === 'disconnect') {
      h.res.destroyed = true;
      h.res.emit('close');
    }
    if (mode === 'deadline') t.mock.timers.tick(1);
    const result = await pending;
    if (mode === 'deadline') assert.equal(result.status, 'canceled');
    else assert.equal(result, null);
    assert.equal(h.cancels, 1);
    assert.equal(h.cache.lookup('owner', h.first.reference).taskStatus, 'canceled');
    assert.equal(h.res.listenerCount('close'), 0);
    h.cache.cancelContinuation('owner', [h.first.reference]);
    assert.equal(h.cancels, 1);
  }
});

test('invalid, empty, foreign, unissued and mixed references cannot cancel another task', async () => {
  const h = setup();
  const unissued = h.cache.start('owner', h.task, 'two', 'Grep');
  const otherTask = h.cache.begin('owner');
  const other = h.cache.start('owner', otherTask, 'three', 'Read');
  for (const refs of [
    [],
    ['invalid'],
    [unissued.reference],
    [h.first.reference, other.reference],
    Array(129).fill(h.first.reference),
  ]) {
    assert.equal(h.cache.cancelContinuation('owner', refs), false);
    assert.equal(await waitTianxiResultContinuation(h.cache, 'owner', refs, h.res), null);
  }
  assert.equal(
    await waitTianxiResultContinuation(h.cache, 'foreign', [h.first.reference], h.res),
    null
  );
  assert.equal(h.cancels, 0);
  assert.equal(h.res.listenerCount('close'), 0);
  h.cache.discard('owner', h.task);
  h.cache.discard('owner', otherTask);
});

test('live enable rejects unsafe metadata and active lease expiry stops abandoned native work', (t) => {
  const h = setup();
  for (const model of [null, {}, '', 'x'.repeat(257), 'secret\nheader'])
    assert.equal(
      h.cache.enableLive('owner', h.task, model, () => {}),
      false
    );
  assert.equal(
    h.cache.enableLive('foreign', h.task, 'super', () => {}),
    false
  );
  assert.equal(h.cache.enableLive('owner', h.task, 'super', null), false);
  h.cache.discard('owner', h.task);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const abandoned = setup();
  t.mock.timers.tick(60000);
  assert.equal(abandoned.cancels, 1);
  assert.equal(abandoned.cache.lookup('owner', abandoned.first.reference).taskStatus, 'canceled');
});

test('unexpected cache failures propagate and release the close listener', async () => {
  const h = setup();
  const broken = {
    continuation() {
      throw new Error('Cache failed');
    },
    cancelContinuation() {
      throw new Error('Unexpected cancel');
    },
  };
  await assert.rejects(
    waitTianxiResultContinuation(broken, 'owner', [h.first.reference], h.res),
    /Cache failed/
  );
  assert.equal(h.res.listenerCount('close'), 0);
  h.cache.discard('owner', h.task);
});
