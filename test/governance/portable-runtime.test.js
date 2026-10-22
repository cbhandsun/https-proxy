'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  copyPortableRuntime,
  verifyPortableRuntime,
} = require('../../lib/release/portable-runtime');
const {
  PACKAGED_GATEWAY_FILES,
  PACKAGED_GATEWAY_INPUTS,
  RELEASE_GATEWAY_MANIFEST,
} = require('../../scripts/lib/evidence-gateway-release-artifact');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = { message: 'portable_runtime_unavailable' };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-portable-runtime-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hpm-portable-runtime-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const stage = path.join(directory, 'stage');
  const output = path.join(directory, 'output');
  fs.mkdirSync(stage);
  fs.mkdirSync(output);
  const write = (name, value) => {
    const file = path.join(stage, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const digest = (name) => hash(fs.readFileSync(path.join(stage, name)));
  const sourceNames = [
    'openai-proxy.js',
    'proxy.bat',
    'proxy.ps1',
    'proxy.config.example.json',
    'lib/proxy/config.js',
    ...PACKAGED_GATEWAY_FILES,
    ...PACKAGED_GATEWAY_INPUTS.filter((name) => name.startsWith('lib/')),
  ];
  for (const name of sourceNames) write(name, 'synthetic staged bytes\n');
  write('proxy.config.example.json', {});
  write('package.json', { version: '0.1.0', dependencies: { alpha: '1.0.0' } });
  write('package-lock.json', { version: '0.1.0' });
  write('node_modules/alpha/package.json', { name: 'alpha', version: '1.0.0' });
  write('runtime/node/node.exe', 'synthetic node');
  write('runtime/native/hpm-context-recovery-key.exe', 'synthetic native');
  const bundle = 'module.exports = {};\n';
  write('runtime/evidence-gateway/gateway-' + hash(bundle) + '.cjs', bundle);
  write(RELEASE_GATEWAY_MANIFEST, {
    schemaVersion: 1,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    bundleSha256: hash(bundle),
    files: PACKAGED_GATEWAY_INPUTS.map((file) => ({ file, sha256: digest(file) })),
  });
  const manifest = {
    schemaVersion: 2,
    applicationVersion: '0.1.0',
    nodeVersion: process.version,
    nodeSha256: digest('runtime/node/node.exe'),
    contextRecoveryNativeSha256: digest('runtime/native/hpm-context-recovery-key.exe'),
    evidenceGatewayBundleSha256: hash(bundle),
    packageLockSha256: digest('package-lock.json'),
    sourceSha256: Object.fromEntries(sourceNames.map((name) => [name, digest(name)])),
    dependencies: { alpha: '1.0.0' },
  };
  const save = () => write('release-runtime-manifest.json', manifest);
  save();
  return { directory, stage, output, write, manifest, save };
}

test('portable runtime copies the complete staged closure, independent of working-tree source bytes', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'openai-proxy.js'), 'newer working-tree bytes');
  const before = verifyPortableRuntime(f.stage);
  assert.deepEqual(copyPortableRuntime(f.stage, f.output), before);
  assert.equal(
    fs.readFileSync(path.join(f.output, 'openai-proxy.js'), 'utf8'),
    'synthetic staged bytes\n'
  );
  assert.ok(fs.existsSync(path.join(f.output, 'package-lock.json')));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.output, 'proxy.config.example.json'), 'utf8')),
    {}
  );
  assert.equal(fs.existsSync(path.join(f.output, 'proxy.config.json')), false);
  for (const file of PACKAGED_GATEWAY_FILES)
    assert.deepEqual(
      fs.readFileSync(path.join(f.output, file)),
      fs.readFileSync(path.join(f.stage, file))
    );
  assert.deepEqual(verifyPortableRuntime(f.output), before);
});

test('stateless portable copying refuses local configuration, tokens, logs and private state before writing', async (t) => {
  for (const name of [
    'proxy.config.json',
    '.mgmt-token',
    '.env',
    'proxy.log',
    'proxy.err.log',
    '.certs/private.pem',
    '.hpm-runtime/context.sqlite',
    '.claude/settings.json',
  ])
    await t.test(name, (sub) => {
      const f = fixture(sub);
      f.write(name, 'synthetic private state');
      assert.throws(() => verifyPortableRuntime(f.stage), refused);
      assert.throws(() => copyPortableRuntime(f.stage, f.output), refused);
      assert.deepEqual(fs.readdirSync(f.output), []);
      assert.equal(fs.readFileSync(path.join(f.stage, name), 'utf8'), 'synthetic private state');
    });
});

test('missing and tampered sources, gateway scripts, lockfile and binaries refuse before copying', async (t) => {
  for (const name of [
    'lib/proxy/config.js',
    PACKAGED_GATEWAY_FILES[0],
    'package-lock.json',
    'runtime/node/node.exe',
    'runtime/native/hpm-context-recovery-key.exe',
  ])
    for (const mode of ['missing', 'tampered'])
      await t.test(name + ':' + mode, (sub) => {
        const f = fixture(sub);
        if (mode === 'missing') fs.unlinkSync(path.join(f.stage, name));
        else fs.appendFileSync(path.join(f.stage, name), 'changed');
        assert.throws(() => copyPortableRuntime(f.stage, f.output), refused);
        assert.deepEqual(fs.readdirSync(f.output), []);
      });
});

test('manifest rejects malformed, empty, extreme and escaping inputs without writing output', async (t) => {
  for (const [index, change] of [
    (f) => f.write('release-runtime-manifest.json', '{'),
    (f) => f.write('release-runtime-manifest.json', ' '.repeat(1024 * 1024 + 1)),
    (f) => {
      f.manifest.sourceSha256 = {};
      f.save();
    },
    (f) => {
      f.manifest.sourceSha256['../outside.js'] = 'a'.repeat(64);
      f.save();
    },
    (f) => {
      f.manifest.sourceSha256['lib/proxy/../outside.js'] = 'a'.repeat(64);
      f.save();
    },
    (f) => {
      f.manifest.sourceSha256['lib/proxy/config.js'] = null;
      f.save();
    },
    (f) => {
      delete f.manifest.sourceSha256[PACKAGED_GATEWAY_FILES[0]];
      f.save();
    },
    (f) => {
      f.manifest.dependencies = null;
      f.save();
    },
    (f) => {
      f.manifest.dependencies = { beta: '2.0.0' };
      f.save();
    },
    (f) => {
      f.manifest.evidenceGatewayBundleSha256 = 'a'.repeat(64);
      f.save();
    },
    (f) => f.write('lib/proxy/extra.js', 'undeclared'),
    (f) => f.write('lib/proxy/config.js', 'x'.repeat(2 * 1024 * 1024 + 1)),
  ].entries())
    await t.test('invalid-' + index, (sub) => {
      const f = fixture(sub);
      change(f);
      assert.throws(() => copyPortableRuntime(f.stage, f.output), refused);
      assert.deepEqual(fs.readdirSync(f.output), []);
    });
});

test('links, overlapping or occupied output and invalid paths never overwrite unrelated files', (t) => {
  const f = fixture(t);
  for (const value of [null, '', 'relative', {}, f.stage + '\0', path.parse(f.stage).root])
    assert.throws(() => copyPortableRuntime(value, f.output), refused);
  assert.throws(() => copyPortableRuntime(f.stage, f.stage), refused);
  const nested = path.join(f.stage, 'nested');
  fs.mkdirSync(nested);
  assert.throws(() => copyPortableRuntime(f.stage, nested), refused);
  assert.throws(() => copyPortableRuntime(f.stage, f.directory), refused);
  if (process.platform === 'win32') {
    assert.throws(() => copyPortableRuntime(f.stage, f.stage.toUpperCase()), refused);
    assert.throws(() => copyPortableRuntime(f.stage, nested.toUpperCase()), refused);
    assert.throws(() => copyPortableRuntime(f.stage, f.directory.toUpperCase()), refused);
  }
  fs.writeFileSync(path.join(f.output, 'user.txt'), 'preserve');
  assert.throws(() => copyPortableRuntime(f.stage, f.output), refused);
  assert.equal(fs.readFileSync(path.join(f.output, 'user.txt'), 'utf8'), 'preserve');
  fs.unlinkSync(path.join(f.output, 'user.txt'));
  const linkedOutput = path.join(f.directory, 'linked-output');
  fs.symlinkSync(f.output, linkedOutput, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyPortableRuntime(f.stage, linkedOutput), refused);
  const source = path.join(f.stage, 'lib/proxy/config.js');
  const link = path.join(f.directory, 'source-link.js');
  fs.linkSync(source, link);
  assert.throws(() => copyPortableRuntime(f.stage, f.output), refused);
  fs.unlinkSync(link);
  const proxy = path.join(f.stage, 'lib/proxy');
  const original = path.join(f.directory, 'original-proxy');
  fs.renameSync(proxy, original);
  fs.symlinkSync(original, proxy, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyPortableRuntime(f.stage, f.output), refused);
  assert.deepEqual(fs.readdirSync(f.output), []);
});

test('copy failure propagates a fixed error and preserves unrelated data without a source fallback', (t) => {
  const f = fixture(t);
  const sentinel = path.join(f.directory, 'unrelated.txt');
  fs.writeFileSync(sentinel, 'preserve');
  const copy = fs.cpSync;
  let copied = 0;
  t.mock.method(fs, 'cpSync', function (...args) {
    if (++copied === 2) throw Error('private filesystem diagnostic');
    return Reflect.apply(copy, this, args);
  });
  assert.throws(() => copyPortableRuntime(f.stage, f.output), refused);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
  assert.equal(
    fs.readFileSync(path.join(f.output, 'openai-proxy.js'), 'utf8'),
    'synthetic staged bytes\n'
  );
});

test('opened-file substitution and hard-link races refuse before any copy', async (t) => {
  for (const change of [
    (stat) => Object.assign(Object.create(stat), { nlink: 2 }),
    (stat) => {
      // NTFS identifiers may exceed Number.MAX_SAFE_INTEGER; adding one can
      // round back to the original value and stop exercising substitution.
      const ino = stat.ino === 0 ? 1 : 0;
      assert.notEqual(ino, stat.ino);
      return Object.assign(Object.create(stat), { ino });
    },
    (stat) => Object.assign(Object.create(stat), { isFile: () => false }),
  ])
    await t.test('changed opened identity', (sub) => {
      const f = fixture(sub);
      const inspect = fs.fstatSync;
      sub.mock.method(fs, 'fstatSync', function (...args) {
        return change(Reflect.apply(inspect, this, args));
      });
      assert.throws(() => copyPortableRuntime(f.stage, f.output), refused);
      assert.deepEqual(fs.readdirSync(f.output), []);
    });
});

test('source mutation during copy and destination tampering are rejected by post-copy verification', async (t) => {
  for (const destination of [false, true])
    await t.test(destination ? 'destination' : 'source', (sub) => {
      const f = fixture(sub);
      const copy = fs.cpSync;
      sub.mock.method(fs, 'cpSync', function (source, output, options) {
        Reflect.apply(copy, this, [source, output, options]);
        if (path.basename(source) === 'scripts')
          fs.appendFileSync(
            path.join(destination ? f.output : f.stage, 'openai-proxy.js'),
            'changed'
          );
      });
      assert.throws(() => copyPortableRuntime(f.stage, f.output), refused);
    });
});

test('portable copy CLI uses the supplied staged closure and reports failures without filesystem details', (t) => {
  const f = fixture(t);
  const script = path.resolve(__dirname, '../../lib/release/portable-runtime.js');
  const run = (args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
  const valid = run([f.stage, f.output]);
  assert.equal(valid.error, undefined);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), verifyPortableRuntime(f.stage));
  for (const args of [[], [f.stage], [f.stage, f.output], [f.stage, f.output, 'extra']]) {
    const failed = run(args);
    assert.equal(failed.error, undefined);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.equal(failed.stderr, 'portable_runtime_unavailable\n');
  }
});
