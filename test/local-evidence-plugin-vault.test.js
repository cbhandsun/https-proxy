'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  inspectLocalEvidencePlugin,
  retainLocalEvidencePlugin,
  restoreLocalEvidencePlugin,
} = require('../scripts/lib/local-evidence-plugin-vault');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-plugin-vault-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('hpm-plugin-vault-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source'),
    vault = path.join(root, 'vault');
  fs.mkdirSync(source);
  fs.mkdirSync(vault);
  const write = (name, content) => {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const pkg = {
    name: 'hpm-local-evidence',
    version: '0.1.1',
    dependencies: { '@modelcontextprotocol/sdk': '1.31.0' },
  };
  for (const name of ['package.json', '.codex-plugin/plugin.json', 'plugin.portable.json'])
    write(name, pkg);
  write('package-lock.json', {
    ...pkg,
    packages: {
      '': { version: pkg.version },
      'node_modules/@modelcontextprotocol/sdk': { version: '1.31.0' },
    },
  });
  write('node_modules/@modelcontextprotocol/sdk/package.json', { version: '1.31.0' });
  write('node_modules/@modelcontextprotocol/sdk/index.js', 'synthetic dependency\r\n');
  for (const name of ['.mcp.json', 'mcp.json', 'hooks/hooks.json']) write(name, {});
  write('server.cjs', 'synthetic entrypoint\r\n中文🙂');
  write('runtime/lib/client/context-evidence-mcp.js', 'synthetic runtime');
  write('runtime-manifest.json', {
    schema: 'hpm.context.plugin-closure',
    version: 1,
    files: [{ path: 'lib/client/context-evidence-mcp.js', sha256: sha('synthetic runtime') }],
  });
  return { root, source, vault, write };
}

test('vault command retains and restores exact bytes and rejects invalid input without leaking it', (t) => {
  const { root, source, vault } = fixture(t);
  const command = path.resolve(__dirname, '../scripts/local-evidence-plugin-vault.js');
  const invoke = (...args) =>
    spawnSync(process.execPath, [command, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
  const inspect = invoke('inspect', source);
  assert.equal(inspect.status, 0);
  assert.equal(inspect.stderr, '');
  const expected = JSON.parse(inspect.stdout);
  const saved = invoke('retain', source, vault);
  assert.equal(saved.status, 0);
  assert.deepEqual(JSON.parse(saved.stdout), expected);
  const target = path.join(root, 'restored-by-command');
  const restored = invoke('restore', vault, expected.snapshotId, target);
  assert.equal(restored.status, 0);
  assert.deepEqual(JSON.parse(restored.stdout), expected);
  assert.equal(inspectLocalEvidencePlugin(target).snapshotId, expected.snapshotId);
  const before = fs.readdirSync(root).sort();
  for (const args of [
    [],
    ['unknown-private-value'],
    ['inspect'],
    ['inspect', 'private-value'],
    ['inspect', source, 'extra-private-value'],
    ['retain', source],
    ['restore', vault, '../private-value', path.join(root, 'absent')],
    ['restore', vault, expected.snapshotId, target],
    ['restore', vault, expected.snapshotId, path.join(vault, 'forbidden')],
    ['inspect', 'x'.repeat(4096)],
  ]) {
    const refused = invoke(...args);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.equal(refused.stderr, 'local_evidence_vault_command_failed\n');
  }
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.equal(inspectLocalEvidencePlugin(target).snapshotId, expected.snapshotId);
});

test('vault preserves every exact package byte independently of a pruned source and restores without overwriting', (t) => {
  const { root, source, vault } = fixture(t);
  const saved = retainLocalEvidencePlugin(source, vault);
  assert.equal(saved.version, '0.1.1');
  assert.match(saved.snapshotId, /^[a-f0-9]{64}$/);
  assert.deepEqual(retainLocalEvidencePlugin(source, vault), saved);
  const original = fs.readFileSync(path.join(source, 'server.cjs'));
  assert.equal(path.dirname(source), root);
  fs.rmSync(source, { recursive: true });
  const restored = path.join(root, 'restored');
  assert.deepEqual(restoreLocalEvidencePlugin(vault, saved.snapshotId, restored), saved);
  assert.deepEqual(fs.readFileSync(path.join(restored, 'server.cjs')), original);
  assert.equal(retainLocalEvidencePlugin(restored, vault).snapshotId, saved.snapshotId);
  assert.throws(
    () => restoreLocalEvidencePlugin(vault, saved.snapshotId, restored),
    /^Error: local_evidence_vault_refused$/
  );
});

test('identity, closure, dependency, empty and unsafe package inputs fail before publication', (t) => {
  const { root, source, vault, write } = fixture(t);
  for (const value of [null, undefined, '', 1, {}, 'relative', path.join(root, 'missing')]) {
    assert.throws(() => retainLocalEvidencePlugin(value, vault), /local_evidence_vault_refused/);
    assert.throws(() => retainLocalEvidencePlugin(source, value), /local_evidence_vault_refused/);
  }
  assert.throws(() => retainLocalEvidencePlugin(source, source), /local_evidence_vault_refused/);
  const nested = path.join(source, 'vault');
  fs.mkdirSync(nested);
  assert.throws(() => retainLocalEvidencePlugin(source, nested), /local_evidence_vault_refused/);
  fs.rmdirSync(nested);
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  assert.throws(() => retainLocalEvidencePlugin(empty, vault), /local_evidence_vault_refused/);
  write('runtime/lib/client/context-evidence-mcp.js', 'tampered');
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  write('runtime/lib/client/context-evidence-mcp.js', 'synthetic runtime');
  write('node_modules/@modelcontextprotocol/sdk/package.json', { version: 'wrong' });
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  write('node_modules/@modelcontextprotocol/sdk/package.json', { version: '1.31.0' });
  write('.codex-plugin/plugin.json', { name: 'hpm-local-evidence', version: '0.1.0' });
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  assert.deepEqual(fs.readdirSync(vault), []);
});

test('tampered index, added files, modified dependencies and traversal ids cannot restore any bytes', (t) => {
  const { root, source, vault } = fixture(t);
  const saved = retainLocalEvidencePlugin(source, vault);
  const target = path.join(root, 'restored');
  for (const value of [null, undefined, {}, '', '../source', 'a'.repeat(65), 'A'.repeat(64)])
    assert.throws(
      () => restoreLocalEvidencePlugin(vault, value, target),
      /local_evidence_vault_refused/
    );
  const index = path.join(vault, saved.snapshotId, 'index.json');
  const original = fs.readFileSync(index);
  fs.writeFileSync(index, '{}');
  assert.throws(
    () => restoreLocalEvidencePlugin(vault, saved.snapshotId, target),
    /local_evidence_vault_refused/
  );
  fs.writeFileSync(index, original);
  const extra = path.join(vault, saved.snapshotId, 'package/node_modules/extra.js');
  fs.writeFileSync(extra, 'added');
  assert.throws(
    () => restoreLocalEvidencePlugin(vault, saved.snapshotId, target),
    /local_evidence_vault_refused/
  );
  fs.unlinkSync(extra);
  const dependency = path.join(
    vault,
    saved.snapshotId,
    'package/node_modules/@modelcontextprotocol/sdk/index.js'
  );
  fs.writeFileSync(dependency, 'tampered');
  assert.throws(
    () => restoreLocalEvidencePlugin(vault, saved.snapshotId, target),
    /local_evidence_vault_refused/
  );
  assert.equal(fs.existsSync(target), false);
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
});

test('unknown roots, symlinks, hardlinks, excessive depth and oversized files are refused', (t) => {
  const { root, source, vault, write } = fixture(t);
  write('.env', 'synthetic forbidden content');
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  fs.unlinkSync(path.join(source, '.env'));
  const link = path.join(source, 'node_modules/linked');
  fs.symlinkSync(vault, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  fs.unlinkSync(link);
  fs.linkSync(path.join(source, 'server.cjs'), path.join(source, 'node_modules/hardlinked.js'));
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  fs.unlinkSync(path.join(source, 'node_modules/hardlinked.js'));
  const large = path.join(source, 'node_modules/large.js');
  const fd = fs.openSync(large, 'wx');
  fs.ftruncateSync(fd, 16 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  fs.unlinkSync(large);
  const nested = path.join(source, 'node_modules', ...Array(34).fill('d'));
  fs.mkdirSync(nested, { recursive: true });
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  assert.deepEqual(fs.readdirSync(vault), []);
  assert.equal(path.dirname(source), root);
});

test('failed retain and restore writes expose fixed errors and remove only owned staging', (t) => {
  const { root, source, vault } = fixture(t);
  const originalWrite = fs.writeFileSync;
  const failWrites = () => {
    fs.writeFileSync = function (file, ...args) {
      if (typeof file === 'string' && file.includes('.staging-'))
        throw new Error('synthetic private path and content must not escape');
      return originalWrite.call(this, file, ...args);
    };
  };
  try {
    failWrites();
    assert.throws(
      () => retainLocalEvidencePlugin(source, vault),
      /^Error: local_evidence_vault_refused$/
    );
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.deepEqual(fs.readdirSync(vault), []);
  const saved = retainLocalEvidencePlugin(source, vault);
  try {
    failWrites();
    assert.throws(
      () => restoreLocalEvidencePlugin(vault, saved.snapshotId, path.join(root, 'output')),
      /^Error: local_evidence_vault_refused$/
    );
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.equal(fs.existsSync(path.join(root, 'output')), false);
  assert.deepEqual(fs.readdirSync(root).sort(), ['source', 'vault']);
  assert.deepEqual(fs.readdirSync(vault), [saved.snapshotId]);
});

test('invalid closure records, JSON and linked directory boundaries cannot become rollback packages', (t) => {
  const { root, source, vault, write } = fixture(t);
  const manifest = path.join(source, 'runtime-manifest.json');
  const original = fs.readFileSync(manifest);
  const entries = JSON.parse(original).files;
  for (const files of [
    [],
    [null],
    [{ path: '../outside', sha256: entries[0].sha256 }],
    [entries[0], entries[0]],
  ]) {
    write('runtime-manifest.json', { schema: 'hpm.context.plugin-closure', version: 1, files });
    assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  }
  fs.writeFileSync(manifest, original);
  write('runtime/lib/client/extra.js', 'unlisted module');
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  fs.unlinkSync(path.join(source, 'runtime/lib/client/extra.js'));
  const pkg = fs.readFileSync(path.join(source, 'package.json'));
  write('package.json', 'invalid JSON');
  assert.throws(() => retainLocalEvidencePlugin(source, vault), /local_evidence_vault_refused/);
  fs.writeFileSync(path.join(source, 'package.json'), pkg);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => retainLocalEvidencePlugin(alias, vault), /local_evidence_vault_refused/);
  const saved = retainLocalEvidencePlugin(source, vault);
  for (const destination of [
    undefined,
    null,
    {},
    '',
    'relative',
    vault,
    path.join(vault, 'nested'),
    path.join(alias, 'nested'),
    path.join(root, 'absent', 'nested'),
  ])
    assert.throws(
      () => restoreLocalEvidencePlugin(vault, saved.snapshotId, destination),
      /local_evidence_vault_refused/
    );
});
