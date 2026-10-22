'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

for (const failImport of [false, true]) {
  test(`dedicated persistence entry isolates inherited paths and cleans up on ${failImport ? 'failure' : 'success'}`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-thinking-isolation-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const external = path.join(directory, 'external');
    fs.mkdirSync(external);
    const sentinel = Buffer.from('synthetic sentinel history - do not modify');
    const cache = path.join(external, '.responses_history.cache.json');
    fs.writeFileSync(cache, sentinel);
    const receipt = path.join(directory, 'receipt.json');
    const preload = path.join(directory, 'observe.cjs');
    // Observe environment BEFORE the first production import, without reading
    // config, certificates, or user history. Failure is synthetic and local.
    fs.writeFileSync(
      preload,
      `const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
let observed = false;
Module._load = function (id, ...rest) {
  if (!observed && id.includes('lib/proxy/')) {
    observed = true;
    const config = process.env.PROXY_CONFIG_DIR;
    const runtime = process.env.PROXY_RUNTIME_DIR;
    fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
      config, runtime,
      legacy: process.env.PROXY_DATA_DIR ?? null,
      cert: process.env.PROXY_CERT_DIR ?? null,
      compileCache: process.env.NODE_COMPILE_CACHE,
      nodeEnv: process.env.NODE_ENV,
      privateRoot: path.dirname(runtime),
    }));
    if (${failImport}) throw new Error('synthetic production import failure');
  }
  return load.call(this, id, ...rest);
};
`
    );
    const overrides = {
      PROXY_DATA_DIR: external,
      PROXY_CONFIG_DIR: external,
      PROXY_RUNTIME_DIR: external,
      PROXY_CERT_DIR: external,
      NODE_COMPILE_CACHE: path.join(external, 'compile-cache'),
    };
    const child = spawnSync(
      process.execPath,
      ['--require', preload, path.join(root, 'test/thinking-persistence.test.js')],
      { cwd: root, env: { ...process.env, ...overrides }, encoding: 'utf8', timeout: 20000 }
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, failImport ? 1 : 0);
    const observed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.equal(observed.config, path.join(observed.privateRoot, 'config'));
    assert.equal(observed.runtime, path.join(observed.privateRoot, 'runtime'));
    assert.equal(observed.compileCache, path.join(observed.runtime, '.node-compile-cache'));
    assert.equal(observed.legacy, null);
    assert.equal(observed.cert, null);
    assert.equal(observed.nodeEnv, 'test');
    assert.notEqual(observed.privateRoot, directory);
    assert.equal(path.dirname(observed.privateRoot), os.tmpdir());
    assert.match(path.basename(observed.privateRoot), /^hpm-thinking-runtime-/);
    assert.equal(fs.existsSync(observed.privateRoot), false);
    assert.deepEqual(fs.readFileSync(cache), sentinel);
    // Node may write its own compile cache before/after the entry runs. That
    // startup behavior is not controlled by in-process environment changes;
    // production state, unlike Node's cache, must never enter inherited paths.
    const files = fs.readdirSync(external, { withFileTypes: true });
    assert.deepEqual(
      files.filter((file) => file.isFile()).map((file) => file.name),
      [path.basename(cache)]
    );
    assert.equal(overrides.PROXY_RUNTIME_DIR, external);
  });
}
