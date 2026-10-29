'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { createRuntimeSupport } = require('../lib/proxy/runtime-support');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-async-file-log-'));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('File logging yields during ACL work, shares pending setup and leaves console unchanged on failure', async (t) => {
  const directory = fixture(t);
  const original = { log: console.log, warn: console.warn, error: console.error };
  const errors = [];
  let fail,
    calls = 0;
  const blocked = new Promise((_resolve, reject) => {
    fail = reject;
  });
  const support = createRuntimeSupport({
    dataDir: directory,
    secureDirectory() {},
    secureFile() {
      throw Error('synchronous_acl_used');
    },
    secureFileAsync() {
      calls++;
      return blocked;
    },
    logger: {
      error(...args) {
        errors.push(args);
      },
    },
  });
  const result = support.setupFileConsoleTee();
  assert.ok(result instanceof Promise);
  assert.equal(support.setupFileConsoleTee(), result);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(console.log, original.log);
  fail(new Error('fixture_permission_denied'));
  assert.equal(await result, false);
  assert.equal(errors.length, 1);
  assert.deepEqual({ log: console.log, warn: console.warn, error: console.error }, original);
  assert.equal(await support.setupFileConsoleTee(), false);
  assert.equal(calls, 2, 'failed initialization can be retried');
});

test('Successful file logging installs hooks only after both ACLs; disabled logging creates no files', (t) => {
  const directory = fixture(t);
  const script = `const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
    const {createRuntimeSupport}=require('./lib/proxy/runtime-support');
    const dir=process.env.PROXY_RUNTIME_DIR;fs.mkdirSync(dir,{recursive:true});
    (async()=>{const original=console.log;const secured=[];
      const h=createRuntimeSupport({dataDir:dir,secureDirectory(){},async secureFileAsync(file){
        assert.equal(console.log,original);secured.push(path.basename(file));await new Promise(setImmediate);
      }});
      assert.equal(await h.setupFileConsoleTee(),true);
      assert.deepEqual(secured,['proxy.log','proxy.err.log']);assert.notEqual(console.log,original);
      const installed=console.log;assert.equal(await h.setupFileConsoleTee(),true);assert.equal(console.log,installed);
    })().catch(()=>{process.exitCode=1;});`;
  const env = createIsolatedTestEnv(process.env, directory);
  delete env.PROXY_DISABLE_FILE_LOG;
  const result = spawnSync(process.execPath, ['-e', script], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  const disabled = spawnSync(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs');
    const h=require('./lib/proxy/runtime-support').createRuntimeSupport({dataDir:process.env.PROXY_RUNTIME_DIR+'/disabled',secureDirectory(){throw Error('must_not_run')}});
    h.setupFileConsoleTee().then(v=>{if(v!==false||fs.existsSync(process.env.PROXY_RUNTIME_DIR+'/disabled'))process.exitCode=1});`,
    ],
    {
      env: { ...env, PROXY_DISABLE_FILE_LOG: '1' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    }
  );
  assert.equal(disabled.status, 0, disabled.stderr);
});

test('Failure securing the second file never installs partial logging hooks', async (t) => {
  const directory = fixture(t);
  const original = console.log;
  let calls = 0,
    errors = 0;
  const support = createRuntimeSupport({
    dataDir: directory,
    secureDirectory() {},
    async secureFileAsync() {
      if (++calls === 2) throw Error('fixture_second_acl_failed');
    },
    logger: {
      error() {
        errors++;
      },
    },
  });
  assert.equal(await support.setupFileConsoleTee(), false);
  assert.equal(calls, 2);
  assert.equal(errors, 1);
  assert.equal(console.log, original);
});
