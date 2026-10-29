'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setImmediate: flush } = require('node:timers/promises');
const { createRuntimeSupport } = require('../lib/proxy/runtime-support');

function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-credential-write-'));
  t.after(() => {
    assert.equal(path.dirname(value), os.tmpdir());
    fs.rmSync(value, { recursive: true, force: true });
  });
  return value;
}

test(
  'async credentials protect the directory first and join both independent file ACLs',
  { timeout: 10000 },
  async (t) => {
    const dataDir = directory(t);
    const releases = [];
    const protectedFiles = [];
    let releaseDirectory;
    let started;
    const bothStarted = new Promise((resolve) => {
      started = resolve;
    });
    const support = createRuntimeSupport({
      dataDir,
      initialToken: 'synthetic-token',
      secureDirectory() {
        return new Promise((resolve) => {
          releaseDirectory = resolve;
        });
      },
      secureFileAsync(file) {
        protectedFiles.push(path.basename(file));
        return new Promise((resolve) => {
          releases.push(resolve);
          if (releases.length === 2) started();
        });
      },
    });
    const pending = support.writeManagementTokenFileAsync(45678);
    assert.equal(support.writeManagementTokenFileAsync(45678), pending);
    await assert.rejects(support.writeManagementTokenFileAsync(45679), /already in progress/);
    assert.equal(fs.readdirSync(dataDir).length, 0);
    releaseDirectory();
    await bothStarted;
    assert.equal(releases.length, 2);
    assert.deepEqual(protectedFiles.sort(), ['.mgmt-token', '.mgmt-token-45678']);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    releases[0]();
    await flush();
    assert.equal(done, false);
    releases[1]();
    assert.equal(await pending, 'synthetic-token');
    for (const file of protectedFiles)
      assert.equal(fs.readFileSync(path.join(dataDir, file), 'utf8'), 'synthetic-token');
  }
);

test(
  'async credential failure waits for all writers and exposes no native error or token',
  { timeout: 10000 },
  async (t) => {
    for (const failDirectory of [false, true]) {
      const dataDir = directory(t);
      let release,
        fileCalls = 0;
      let started;
      const secondStarted = new Promise((resolve) => {
        started = resolve;
      });
      const logs = [];
      const support = createRuntimeSupport({
        dataDir,
        initialToken: 'PRIVATE_TOKEN',
        logger: {
          error(...args) {
            logs.push(args);
          },
        },
        secureDirectory() {
          if (failDirectory) throw new Error('PRIVATE_DIRECTORY');
        },
        secureFileAsync() {
          fileCalls++;
          if (fileCalls === 1) return Promise.reject(new Error('PRIVATE_ACL'));
          if (fileCalls > 2) return Promise.resolve();
          return new Promise((resolve) => {
            release = resolve;
            started();
          });
        },
      });
      const pending = support.writeManagementTokenFileAsync(45678);
      const rejected = assert.rejects(
        pending,
        (error) => error.message === 'Management credential persistence unavailable'
      );
      if (!failDirectory) {
        await secondStarted;
        assert.equal(typeof release, 'function');
        assert.equal(logs.length, 0);
        release();
      }
      await rejected;
      assert.equal(fileCalls, failDirectory ? 0 : 2);
      assert.deepEqual(logs, [['Failed to secure management token file']]);
      assert.equal(JSON.stringify(logs).includes('PRIVATE'), false);
      if (!failDirectory) {
        assert.equal(await support.writeManagementTokenFileAsync(45678), 'PRIVATE_TOKEN');
        assert.equal(fileCalls, 4);
        assert.equal(logs.length, 1);
      }
    }
  }
);

test('async credentials generate a stable token and keep invalid ports off filenames', async (t) => {
  for (const port of [undefined, 0, 65536, 'invalid', 65535]) {
    const dataDir = directory(t);
    const support = createRuntimeSupport({
      dataDir,
      secureDirectory() {},
      async secureFileAsync() {},
    });
    const token = await support.writeManagementTokenFileAsync(port);
    assert.match(token, /^[a-f0-9]{32}$/);
    assert.equal(await support.writeManagementTokenFileAsync(port), token);
    assert.deepEqual(
      fs.readdirSync(dataDir).sort(),
      port === 65535 ? ['.mgmt-token', '.mgmt-token-65535'] : ['.mgmt-token']
    );
  }
});
