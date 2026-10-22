'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepareLocalEvidencePlugin } = require('../scripts/prepare-local-evidence-plugin');
const {
  retainLocalEvidencePlugin,
  restoreLocalEvidencePlugin,
} = require('../scripts/lib/local-evidence-plugin-vault');
const { readBundledFile, sha } = require('../scripts/lib/local-evidence-plugin-bundle');
let prepared;
const prepare = () => (prepared ??= prepareLocalEvidencePlugin());

test(
  'actual installer distribution is standalone and restores every byte after source removal',
  { timeout: 60000 },
  async (t) => {
    const artifact = await prepare();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-bundle-contract-'));
    t.after(() => {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('hpm-bundle-contract-'));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const source = path.join(root, 'source');
    fs.cpSync(artifact.packageDirectory, source, { recursive: true });
    assert.equal(fs.existsSync(path.join(source, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(source, 'runtime')), false);
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    const saved = retainLocalEvidencePlugin(source, vault);
    assert.ok(saved.fileCount < 20);
    fs.rmSync(source, { recursive: true });
    assert.deepEqual(restoreLocalEvidencePlugin(vault, saved.snapshotId, source), saved);
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'runtime-manifest.json')));
    assert.equal(manifest.schema, 'hpm.context.plugin-bundle');
    assert.equal(manifest.version, 1);
    assert.ok(manifest.inputs.length > 26);
    const sbom = JSON.parse(fs.readFileSync(path.join(source, 'third-party-notices.json')));
    assert.ok(
      sbom.packages.some(
        (entry) =>
          entry.name === '@modelcontextprotocol/sdk' &&
          entry.version === '1.32.1' &&
          entry.notices.length > 0
      )
    );
    const entry = path.join(source, 'server.cjs');
    fs.appendFileSync(entry, '\n// changed');
    assert.throws(
      () => retainLocalEvidencePlugin(source, vault),
      /^Error: local_evidence_vault_refused$/
    );
  }
);

test(
  'bundled manifests reject empty, malformed, unsafe, duplicated and extreme declarations before vault writes',
  { timeout: 60000 },
  async (t) => {
    const artifact = await prepare();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-bundle-invalid-'));
    t.after(() => {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('hpm-bundle-invalid-'));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const source = path.join(root, 'source'),
      vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    fs.cpSync(artifact.packageDirectory, source, { recursive: true });
    const file = path.join(source, 'runtime-manifest.json');
    const original = JSON.parse(fs.readFileSync(file));
    const mutate = (change) => {
      const value = JSON.parse(JSON.stringify(original));
      change(value);
      fs.writeFileSync(file, JSON.stringify(value));
      assert.throws(
        () => retainLocalEvidencePlugin(source, vault),
        /^Error: local_evidence_vault_refused$/
      );
      assert.deepEqual(fs.readdirSync(vault), []);
    };
    for (const change of [
      (value) => {
        value.version = 2;
      },
      (value) => {
        value.nodeMajor = 1;
      },
      (value) => {
        value.inputs = [];
      },
      (value) => {
        value.inputs = Array(4097).fill(value.inputs[0]);
      },
      (value) => {
        value.inputs[0].path = '../outside';
      },
      (value) => {
        value.inputs[0].sha256 = null;
      },
      (value) => {
        value.inputs.push(value.inputs[0]);
      },
      (value) => {
        value.files.pop();
      },
      (value) => {
        value.files[0] = null;
      },
      (value) => {
        value.files[1] = value.files[0];
      },
      (value) => {
        value.files[0].sha256 = '0'.repeat(64);
      },
    ])
      mutate(change);
    const noticesPath = path.join(source, 'third-party-notices.json');
    const notices = JSON.parse(fs.readFileSync(noticesPath));
    for (const change of [
      (value) => {
        value.packages = [];
      },
      (value) => {
        value.lockSha256 = '0'.repeat(64);
      },
      (value) => {
        value.packages[0].version = 'invalid';
      },
      (value) => {
        value.packages[0].notices = [1];
      },
      (value) => {
        value.packages.push(value.packages[0]);
      },
    ]) {
      const value = JSON.parse(JSON.stringify(notices));
      change(value);
      fs.writeFileSync(noticesPath, JSON.stringify(value));
      mutate((manifest) => {
        manifest.files.find((entry) => entry.path === 'third-party-notices.json').sha256 = sha(
          fs.readFileSync(noticesPath)
        );
      });
    }
    fs.writeFileSync(noticesPath, JSON.stringify(notices));
    fs.writeFileSync(file, JSON.stringify(original));
    fs.mkdirSync(path.join(source, 'node_modules'));
    fs.writeFileSync(path.join(source, 'node_modules/extra.js'), 'extra');
    assert.throws(
      () => retainLocalEvidencePlugin(source, vault),
      /^Error: local_evidence_vault_refused$/
    );
  }
);

test('bundle file reads reject invalid limits, traversal, links and oversized files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-bundle-files-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hpm-bundle-files-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'entry.js'), 'code');
  assert.equal(readBundledFile(root, 'entry.js').toString(), 'code');
  for (const name of [
    null,
    '',
    '../entry.js',
    '/entry.js',
    'a//b',
    'a/./b',
    'a/../b',
    'a\\b',
    'a\0b',
  ])
    assert.throws(() => readBundledFile(root, name), /bundle_refused/);
  for (const limit of [0, -1, null, '1', Infinity, 8 * 1024 * 1024 + 1, 1])
    assert.throws(() => readBundledFile(root, 'entry.js', limit), /bundle_refused/);
  assert.throws(() => readBundledFile('relative', 'entry.js'), /bundle_refused/);
  fs.linkSync(path.join(root, 'entry.js'), path.join(root, 'hard.js'));
  assert.throws(() => readBundledFile(root, 'hard.js'), /bundle_refused/);
  fs.unlinkSync(path.join(root, 'hard.js'));
  fs.mkdirSync(path.join(root, 'directory'));
  fs.symlinkSync(
    path.join(root, 'directory'),
    path.join(root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  assert.throws(() => readBundledFile(root, 'linked/entry.js'), /bundle_refused/);
});

test('bundle preparation rejects missing and invalid roots before publication', async () => {
  for (const value of [null, 0, {}, '', 'relative'])
    await assert.rejects(prepareLocalEvidencePlugin(value), /bundle_refused/);
});

function buildFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-bundle-build-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hpm-bundle-build-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const pkg = {
    name: 'hpm-local-evidence',
    version: '0.1.1',
    dependencies: { '@modelcontextprotocol/sdk': '1.32.1' },
  };
  const prefix = 'plugins/hpm-local-evidence/';
  for (const name of ['package.json', '.codex-plugin/plugin.json', 'plugin.portable.json'])
    write(prefix + name, pkg);
  write(prefix + 'package-lock.json', {
    ...pkg,
    packages: {
      '': { version: pkg.version },
      'node_modules/@modelcontextprotocol/sdk': { version: '1.32.1' },
    },
  });
  for (const name of ['.mcp.json', 'mcp.json', 'hooks/hooks.json']) write(prefix + name, {});
  write(prefix + 'node_modules/@modelcontextprotocol/sdk/package.json', {
    name: '@modelcontextprotocol/sdk',
    version: '1.32.1',
    exports: { './mock.js': './mock.js' },
  });
  write(prefix + 'node_modules/@modelcontextprotocol/sdk/mock.js', 'module.exports = {};\n');
  write(prefix + 'node_modules/@modelcontextprotocol/sdk/LICENSE', 'Synthetic fixture license');
  write(
    'lib/client/context-evidence-mcp.js',
    "const sdk = require('@modelcontextprotocol/sdk/mock.js'); module.exports = { startContextEvidencePlugin: async () => sdk };\n"
  );
  for (const name of [
    'scripts/prepare-local-evidence-plugin.js',
    'scripts/lib/local-evidence-plugin-build.js',
    'scripts/lib/local-evidence-plugin-bundle.js',
    'scripts/lib/local-evidence-plugin-entry.js',
  ])
    write(name, fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8'));
  write('package.json', { name: 'synthetic-build-root', private: true });
  write('package-lock.json', { name: 'synthetic-build-root', packages: {} });
  return { root, write };
}

test(
  'standalone builds are reproducible without a generated source closure',
  { timeout: 60000 },
  async (t) => {
    const { root } = buildFixture(t);
    const first = await prepareLocalEvidencePlugin(root);
    const second = await prepareLocalEvidencePlugin(root);
    assert.deepEqual(second, first);
    assert.equal(fs.existsSync(path.join(root, 'plugins/hpm-local-evidence/runtime')), false);
    assert.equal(
      fs.existsSync(path.join(root, 'plugins/hpm-local-evidence/runtime-manifest.json')),
      false
    );
  }
);

test('changed build inputs fail before publication', { timeout: 60000 }, async (t) => {
  const { root } = buildFixture(t);
  const target = path.join(root, 'lib/client/context-evidence-mcp.js');
  const read = fs.readFileSync;
  let count = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...options) {
    const value = Reflect.apply(read, this, [file, ...options]);
    if (path.resolve(String(file)) === target && ++count > 1)
      return Buffer.concat([value, Buffer.from('\n// changed')]);
    return value;
  });
  await assert.rejects(prepareLocalEvidencePlugin(root), /bundle_inputs_changed/);
  assert.equal(fs.existsSync(path.join(root, 'runtime/local-evidence-plugin')), false);
});

test(
  'publication failure cleans only its own staging and preserves source bytes',
  { timeout: 60000 },
  async (t) => {
    const { root } = buildFixture(t);
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', function (source, destination) {
      if (path.dirname(destination) === path.join(root, 'runtime/local-evidence-plugin'))
        throw Object.assign(new Error('synthetic_publication_failure'), { code: 'EACCES' });
      return Reflect.apply(rename, this, [source, destination]);
    });
    await assert.rejects(prepareLocalEvidencePlugin(root), /synthetic_publication_failure/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'runtime/local-evidence-plugin')), []);
    assert.ok(fs.existsSync(path.join(root, 'lib/client/context-evidence-mcp.js')));
  }
);

test(
  'a concurrent publication is reused only when the entire winning package is identical',
  { timeout: 60000 },
  async (t) => {
    for (const code of ['EEXIST', 'ENOTEMPTY', 'EPERM'])
      for (const tampered of [false, true])
        await t.test(
          `${code}: ${tampered ? 'changed winner fails closed' : 'identical winner is reused'}`,
          async (sub) => {
            const { root } = buildFixture(sub);
            const parent = path.join(root, 'runtime/local-evidence-plugin');
            const rename = fs.renameSync;
            sub.mock.method(fs, 'renameSync', function (source, destination) {
              if (path.dirname(destination) !== parent)
                return Reflect.apply(rename, this, [source, destination]);
              fs.cpSync(source, destination, { recursive: true });
              if (tampered)
                fs.appendFileSync(
                  path.join(destination, 'package/server.cjs'),
                  '\n// changed winner'
                );
              throw Object.assign(new Error('synthetic_concurrent_publication'), { code });
            });
            if (code === 'EPERM' && process.platform !== 'win32')
              await assert.rejects(prepareLocalEvidencePlugin(root), { code });
            else if (tampered)
              await assert.rejects(prepareLocalEvidencePlugin(root), /vault_refused/);
            else assert.equal((await prepareLocalEvidencePlugin(root)).fileCount, 10);
            const retained = fs.readdirSync(parent);
            assert.equal(retained.length, 1);
            assert.match(retained[0], /^[a-f0-9]{64}$/);
          }
        );
  }
);

test(
  'publication permission failures without a verified winner propagate',
  { timeout: 60000 },
  async (t) => {
    for (const [code, winner] of [
      ['EPERM', false],
      ['EACCES', false],
      ['EACCES', true],
    ])
      await t.test(`${code}, winner ${winner}`, async (sub) => {
        const { root } = buildFixture(sub);
        const parent = path.join(root, 'runtime/local-evidence-plugin');
        const rename = fs.renameSync;
        sub.mock.method(fs, 'renameSync', function (source, destination) {
          if (path.dirname(destination) !== parent)
            return Reflect.apply(rename, this, [source, destination]);
          if (winner) fs.cpSync(source, destination, { recursive: true });
          throw Object.assign(new Error('synthetic_permission_failure'), { code });
        });
        await assert.rejects(prepareLocalEvidencePlugin(root), { code });
        assert.equal(fs.readdirSync(parent).length, winner ? 1 : 0);
      });
  }
);

test(
  'an existing winner cannot replace marketplace bytes or redirect through a link',
  { timeout: 60000 },
  async (t) => {
    for (const kind of ['marketplace', 'link'])
      await t.test(kind, async (sub) => {
        const { root } = buildFixture(sub);
        const parent = path.join(root, 'runtime/local-evidence-plugin');
        const rename = fs.renameSync;
        const outside = path.join(root, 'outside-generation');
        sub.mock.method(fs, 'renameSync', function (source, destination) {
          if (path.dirname(destination) !== parent)
            return Reflect.apply(rename, this, [source, destination]);
          if (kind === 'marketplace') {
            fs.cpSync(source, destination, { recursive: true });
            fs.appendFileSync(path.join(destination, '.agents/plugins/marketplace.json'), '\n');
          } else {
            fs.cpSync(source, outside, { recursive: true });
            fs.symlinkSync(outside, destination, process.platform === 'win32' ? 'junction' : 'dir');
          }
          throw Object.assign(new Error('synthetic_concurrent_publication'), {
            code: process.platform === 'win32' ? 'EPERM' : 'EEXIST',
          });
        });
        await assert.rejects(prepareLocalEvidencePlugin(root), /(?:bundle|vault).*refused/);
        const retained = fs.readdirSync(parent);
        assert.equal(retained.length, 1);
        assert.match(retained[0], /^[a-f0-9]{64}$/);
        if (kind === 'link')
          assert.equal(fs.lstatSync(path.join(parent, retained[0])).isSymbolicLink(), true);
      });
  }
);

test(
  'separate processes safely publish the same immutable generation concurrently',
  { timeout: 60000 },
  async (t) => {
    const { root } = buildFixture(t);
    const builder = path.resolve(__dirname, '../scripts/prepare-local-evidence-plugin.js');
    const child = `
    const fs = require('node:fs');
    const path = require('node:path');
    const [builder, root, index] = process.argv.slice(1);
    const parent = path.join(root, 'runtime/local-evidence-plugin');
    const rename = fs.renameSync;
    const pause = new Int32Array(new SharedArrayBuffer(4));
      let collisionCode = null;
    fs.renameSync = function(source, destination) {
      if (path.dirname(destination) !== parent) return rename(source, destination);
      fs.writeFileSync(path.join(root, 'publisher-ready-' + index), 'ready', { flag: 'wx' });
      const deadline = Date.now() + 15000;
      while (![0, 1].every(i => fs.existsSync(path.join(root, 'publisher-ready-' + i)))) {
        if (Date.now() >= deadline) throw new Error('synthetic_publisher_barrier_timeout');
        Atomics.wait(pause, 0, 0, 10);
      }
        try { return rename(source, destination); }
        catch (error) { collisionCode = error.code; throw error; }
    };
    require(builder).prepareLocalEvidencePlugin(root).then(result => {
        process.stdout.write(JSON.stringify({ generation: path.basename(result.marketplaceDirectory), fileCount: result.fileCount, collisionCode }));
    }).catch(error => { process.stderr.write(String(error.code || error.message)); process.exitCode = 1; });
  `;
    const execute = promisify(execFile);
    const results = await Promise.allSettled(
      [0, 1].map((index) =>
        execute(process.execPath, ['-e', child, builder, root, String(index)], {
          windowsHide: true,
          timeout: 45000,
        })
      )
    );
    for (const result of results) assert.equal(result.status, 'fulfilled');
    const reports = results.map((result) => JSON.parse(result.value.stdout));
    assert.equal(reports[0].generation, reports[1].generation);
    assert.equal(reports[1].fileCount, 10);
    assert.equal(reports.filter((report) => report.collisionCode === null).length, 1);
    const collision = reports.find((report) => report.collisionCode !== null).collisionCode;
    assert.ok(
      (process.platform === 'win32'
        ? ['EPERM', 'EEXIST', 'ENOTEMPTY']
        : ['EEXIST', 'ENOTEMPTY']
      ).includes(collision)
    );
    assert.equal(reports[0].fileCount, 10);
    assert.match(reports[0].generation, /^[a-f0-9]{64}$/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'runtime/local-evidence-plugin')), [
      reports[0].generation,
    ]);
  }
);
