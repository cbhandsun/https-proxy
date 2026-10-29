'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { debounceReload } = require('../lib/proxy/config-watcher');

function nextReload(watcher, expected) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('config_replacement_not_observed'));
    }, 1000);
    const onReload = ({ config }) => {
      if (config.activeProfile !== expected) return;
      cleanup();
      resolve();
    };
    function cleanup() {
      clearTimeout(timeout);
      watcher.removeListener('reloaded', onReload);
    }
    watcher.on('reloaded', onReload);
  });
}

function replace(file, value, sequence) {
  const staging = file + '.staging-' + sequence;
  fs.writeFileSync(staging, JSON.stringify({ activeProfile: value }), { flag: 'wx' });
  fs.renameSync(staging, file);
}

test('actual watcher observes repeated atomic replacement and later edits of the replacement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-config-replace-'));
  const file = path.join(root, 'proxy.config.json');
  fs.writeFileSync(file, JSON.stringify({ activeProfile: 'initial' }));
  const applied = [];
  const watcher = debounceReload(
    file,
    (config) => {
      applied.push(config);
    },
    { debounceMs: 20 }
  );
  try {
    for (const [index, profile] of ['first', 'second', 'third'].entries()) {
      const observed = nextReload(watcher, profile);
      replace(file, profile, index);
      await observed;
    }
    const observed = nextReload(watcher, 'edited');
    fs.writeFileSync(file, JSON.stringify({ activeProfile: 'edited' }));
    await observed;
    // File and directory notifications may both describe the same write.
    // Every awaited version must be observed in order; duplicate observations
    // do not imply an extra configuration transition.
    assert.deepEqual(
      applied
        .map((config) => config.activeProfile)
        .filter((profile, index, profiles) => index === 0 || profile !== profiles[index - 1]),
      ['first', 'second', 'third', 'edited']
    );
  } finally {
    watcher.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watcher keeps the last valid config across deletion and malformed replacement, then recovers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-config-recreate-'));
  const file = path.join(root, 'proxy.config.json');
  fs.writeFileSync(file, JSON.stringify({ activeProfile: 'valid' }));
  const applied = [];
  let errors = 0;
  const watcher = debounceReload(
    file,
    (config) => {
      applied.push(config.activeProfile);
    },
    {
      debounceMs: 20,
      onError: () => {
        errors++;
      },
    }
  );
  async function observedError(previous) {
    const deadline = Date.now() + 1000;
    while (errors === previous && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(errors > previous, 'invalid replacement must report failure');
  }
  try {
    fs.unlinkSync(file);
    await observedError(0);
    assert.deepEqual(applied, []);
    const before = errors;
    fs.writeFileSync(file, '{');
    await observedError(before);
    assert.deepEqual(applied, []);
    const observed = nextReload(watcher, 'restored');
    replace(file, 'restored', 'restored');
    await observed;
    assert.equal(applied.at(-1), 'restored');
    watcher.close();
    const count = applied.length;
    replace(file, 'after-close', 'closed');
    watcher.scheduleNow();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(applied.length, count);
  } finally {
    watcher.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory notifications cannot select sibling files or executable filenames', () => {
  const { configWatchEventMatches: matches } = require('../lib/proxy/config-watcher');
  for (const event of ['change', 'rename']) {
    for (const name of ['proxy.config.json', Buffer.from('proxy.config.json'), null, undefined])
      assert.equal(matches('proxy.config.json', event, name, 'linux'), true);
    assert.equal(matches('proxy.config.json', event, 'PROXY.CONFIG.JSON', 'win32'), true);
    assert.equal(matches('proxy.config.json', event, 'PROXY.CONFIG.JSON', 'linux'), false);
    for (const name of [
      '',
      'other.json',
      '../proxy.config.json',
      '/proxy.config.json',
      'x'.repeat(4097),
      Buffer.alloc(4097),
      [],
      {},
      1,
      true,
      {
        toString() {
          throw Error('filename trap');
        },
      },
    ])
      assert.equal(matches('proxy.config.json', event, name), false);
  }
  for (const name of [
    '',
    '.',
    '..',
    null,
    undefined,
    1,
    '../proxy.config.json',
    'a/b',
    'a\\b',
    'a\0b',
    'x'.repeat(4097),
  ])
    assert.equal(matches(name, 'change', null), false);
  for (const event of ['error', '', null, undefined, {}, 'x'.repeat(4097)])
    assert.equal(matches('proxy.config.json', event, null), false);
});

test('sibling writes do not reload configuration and invalid initial targets fail once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-config-events-'));
  const file = path.join(root, 'proxy.config.json');
  fs.writeFileSync(file, '{}');
  let applied = 0;
  const watcher = debounceReload(
    file,
    () => {
      applied++;
    },
    { debounceMs: 20 }
  );
  try {
    fs.writeFileSync(path.join(root, 'unrelated.json'), '{}');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(applied, 0);
    for (const target of [root, path.join(root, 'missing.json')]) {
      let errors = 0;
      const failed = debounceReload(target, () => assert.fail('invalid config must not apply'), {
        onError: () => {
          errors++;
        },
      });
      assert.equal(errors, 1);
      failed.close();
    }
  } finally {
    watcher.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
