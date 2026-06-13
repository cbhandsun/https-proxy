const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { migrateLegacyRuntimeFiles } = require('../lib/proxy/config');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-runtime-migration-'));
}

function writeFile(filePath, value = 'x') {
  fs.writeFileSync(filePath, value, 'utf8');
}

{
  const root = makeTempRoot();
  const runtime = path.join(root, '.hpm-runtime');
  writeFile(path.join(root, '.mgmt-token'), 'token');
  writeFile(path.join(root, 'proxy.log'), 'log');
  writeFile(path.join(root, 'proxy-events.jsonl.1'), '{}\n');
  fs.mkdirSync(path.join(root, '.certs'));
  writeFile(path.join(root, 'proxy.config.json'), '{}');

  const result = migrateLegacyRuntimeFiles({
    projectRoot: root,
    dataDir: runtime,
    legacyDataDir: '',
  });

  assert.strictEqual(result.enabled, true);
  assert.deepStrictEqual(result.errors, []);
  assert.ok(fs.existsSync(path.join(runtime, '.mgmt-token')));
  assert.ok(fs.existsSync(path.join(runtime, 'proxy.log')));
  assert.ok(fs.existsSync(path.join(runtime, 'proxy-events.jsonl.1')));
  assert.ok(fs.existsSync(path.join(runtime, '.certs')));
  assert.ok(fs.existsSync(path.join(root, 'proxy.config.json')));
  assert.ok(!fs.existsSync(path.join(root, '.mgmt-token')));
  assert.ok(!fs.existsSync(path.join(root, 'proxy.log')));
}

{
  const root = makeTempRoot();
  const runtime = path.join(root, '.hpm-runtime');
  fs.mkdirSync(runtime);
  writeFile(path.join(root, 'proxy.log'), 'old');
  writeFile(path.join(runtime, 'proxy.log'), 'new');

  const result = migrateLegacyRuntimeFiles({
    projectRoot: root,
    dataDir: runtime,
    legacyDataDir: '',
  });

  assert.deepStrictEqual(result.moved, []);
  assert.strictEqual(result.skipped[0].name, 'proxy.log');
  assert.strictEqual(fs.readFileSync(path.join(root, 'proxy.log'), 'utf8'), 'old');
  assert.strictEqual(fs.readFileSync(path.join(runtime, 'proxy.log'), 'utf8'), 'new');
}

{
  const root = makeTempRoot();
  const runtime = path.join(root, '.hpm-runtime');
  writeFile(path.join(root, '.mgmt-token'), 'token');

  const result = migrateLegacyRuntimeFiles({
    projectRoot: root,
    dataDir: runtime,
    legacyDataDir: root,
  });

  assert.strictEqual(result.enabled, false);
  assert.ok(fs.existsSync(path.join(root, '.mgmt-token')));
  assert.ok(!fs.existsSync(runtime));
}

console.log('[runtime-migration.test] ok');
