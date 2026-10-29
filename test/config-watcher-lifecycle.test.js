'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(options = {}) {
  const reads = [],
    timers = [],
    watchers = [],
    applied = [],
    errors = [],
    reloaded = [];
  const fakeFs = {
    statSync: () => ({ isFile: () => true, dev: 1n, ino: 2n, birthtimeNs: 3n }),
    watch() {
      const w = new EventEmitter();
      w.close = () => {
        w.closed = true;
      };
      watchers.push(w);
      return w;
    },
    readFile(_file, _encoding, callback) {
      reads.push(callback);
    },
  };
  const target = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '../lib/proxy/config-watcher.js'), 'utf8'),
    {
      module: target,
      require: (name) => (name === 'fs' ? fakeFs : require(name)),
      Buffer,
      setTimeout(fn, delay) {
        const timer = { fn, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) {
        timer.cleared = true;
      },
    }
  );
  const watcher = target.exports.debounceReload(
    path.resolve('synthetic-config.json'),
    (cfg) => {
      applied.push(cfg);
      return options.apply ? options.apply(cfg) : cfg;
    },
    { ...options, onError: (error) => errors.push(error) }
  );
  watcher.on('reloaded', (value) => reloaded.push(value));
  return { watcher, reads, timers, watchers, applied, errors, reloaded };
}
test('close during an in-flight config read prevents later normalization, application and events', async () => {
  let normalized = 0;
  const f = fixture({
    loadConfigFn: (cfg) => {
      normalized++;
      return cfg;
    },
  });
  f.watcher.scheduleNow();
  assert.equal(f.reads.length, 1);
  f.watcher.close();
  f.reads[0](null, '{"activeProfile":"synthetic"}');
  await turn();
  assert.equal(normalized, 0);
  assert.equal(f.applied.length, 0);
  assert.equal(f.reloaded.length, 0);
  assert.equal(f.errors.length, 0);
  assert.ok(f.watchers.every((w) => w.closed));
});
test('close while normalized configuration is pending prevents a new apply without cancelling an entered callback', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({ loadConfigFn: () => pending });
  f.watcher.scheduleNow();
  f.reads[0](null, '{"activeProfile":"synthetic"}');
  await turn();
  f.watcher.close();
  release({ activeProfile: 'normalized' });
  await turn();
  assert.equal(f.applied.length, 0);
  assert.equal(f.reloaded.length, 0);
  assert.equal(f.errors.length, 0);
});
test('close cancels pending retry work and suppresses errors from outstanding reads', async () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'ENOENT']) {
    const f = fixture();
    f.watcher.scheduleNow();
    if (code !== 'ENOENT') {
      f.reads[0]({ code });
      assert.equal(f.timers[0].delay, 60);
      f.watcher.close();
      if (!f.timers[0].cleared) f.timers[0].fn();
    } else {
      f.watcher.close();
      f.reads[0]({ code });
    }
    await turn();
    assert.equal(f.reads.length, 1);
    assert.equal(f.errors.length, 0);
    assert.equal(f.applied.length, 0);
  }
});
test('normal valid application and invalid JSON retain their original outcomes before close', async () => {
  const valid = fixture();
  valid.watcher.scheduleNow();
  valid.reads[0](null, '{"activeProfile":"synthetic"}');
  await turn();
  assert.equal(valid.applied.length, 1);
  assert.equal(valid.reloaded.length, 1);
  assert.equal(valid.errors.length, 0);
  valid.watcher.close();
  const invalid = fixture();
  invalid.watcher.scheduleNow();
  invalid.reads[0](null, '{');
  await turn();
  assert.equal(invalid.applied.length, 0);
  assert.equal(invalid.errors.length, 1);
  invalid.watcher.close();
});

test('closing an already entered apply suppresses later success or rejection events without applying again', async () => {
  for (const rejected of [false, true]) {
    let finish;
    const pending = new Promise((resolve, reject) => {
      finish = rejected ? reject : resolve;
    });
    const f = fixture({ apply: () => pending });
    f.watcher.scheduleNow();
    f.reads[0](null, '{"activeProfile":"synthetic"}');
    await turn();
    assert.equal(f.applied.length, 1);
    f.watcher.scheduleNow();
    f.watcher.close();
    f.watcher.close();
    finish(rejected ? new Error('PRIVATE') : { activeProfile: 'synthetic' });
    await turn();
    assert.equal(f.applied.length, 1);
    assert.equal(f.reloaded.length, 0);
    assert.equal(f.errors.length, 0);
    assert.equal(f.reads.length, 1);
  }
});
test('a normalized configuration rejection after close remains observed without a late error callback', async () => {
  let reject;
  const pending = new Promise((_resolve, fail) => {
    reject = fail;
  });
  const f = fixture({ loadConfigFn: () => pending });
  f.watcher.scheduleNow();
  f.reads[0](null, '{}');
  await turn();
  f.watcher.close();
  reject(new Error('PRIVATE'));
  await turn();
  assert.equal(f.errors.length, 0);
  assert.equal(f.applied.length, 0);
  assert.equal(f.reloaded.length, 0);
});
test('original retry delay and five-retry bound still apply while the watcher is open', async () => {
  const f = fixture();
  f.watcher.scheduleNow();
  for (let index = 0; index < 6; index++) {
    f.reads[index]({ code: 'EBUSY' });
    if (index < 5) {
      assert.equal(f.timers[index].delay, 60);
      f.timers[index].fn();
    }
  }
  await turn();
  assert.equal(f.reads.length, 6);
  assert.equal(f.timers.length, 5);
  assert.equal(f.errors.length, 1);
  assert.equal(f.applied.length, 0);
  f.watcher.close();
});
