'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const {
  verifyPinnedClosure,
  publicReadFailurePhase,
} = require('../../scripts/context-hosted/n09/owned-entry.js');
test('missing READ diagnostics distinguish reviewed cases without exposing caller data', () => {
  assert.deepEqual([80, 81, 82, 83].map(publicReadFailurePhase), [247, 248, 249, 250]);
  let reads = 0;
  for (const value of [
    null,
    undefined,
    '',
    '80',
    79,
    84,
    80.1,
    10000,
    new Proxy(
      {},
      {
        get() {
          reads++;
          throw Error('PRIVATE');
        },
      }
    ),
  ])
    assert.equal(publicReadFailurePhase(value), 230);
  assert.equal(reads, 0);
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
test('fixed entry verifies every lazy dependency before it can execute', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n09-entry-closure-'));
  const entry = path.join(root, 'entry.js'),
    lazy = path.join(root, 'lazy.js');
  try {
    fs.writeFileSync(entry, "module.exports = () => require('./lazy.js');");
    fs.writeFileSync(lazy, "throw Error('must never execute');");
    const pins = Object.fromEntries(
      [entry, lazy].map((file) => [file, sha(fs.readFileSync(file))])
    );
    assert.equal(verifyPinnedClosure(pins, [entry]).files, 2);
    assert.equal(require.cache[lazy], undefined);
    assert.throws(() => verifyPinnedClosure({ [entry]: pins[entry] }, [entry]));
    fs.appendFileSync(lazy, '// drift');
    assert.throws(() => verifyPinnedClosure(pins, [entry]));
    fs.writeFileSync(entry, 'require(process.env.ARBITRARY_MODULE);');
    assert.throws(() => verifyPinnedClosure({ [entry]: sha(fs.readFileSync(entry)) }, [entry]));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
test('fixed entry refuses proxy or accessor hash maps before traps', () => {
  let traps = 0;
  for (const pins of [
    null,
    [],
    new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          return [];
        },
      }
    ),
    Object.defineProperty({}, '/not-a-source', {
      enumerable: true,
      get() {
        traps++;
        return '0'.repeat(64);
      },
    }),
  ]) {
    assert.throws(() => verifyPinnedClosure(pins, []));
  }
  assert.equal(traps, 0);
});

test('N09 entry accepts the generated real host-install closure before loading installed inventory', () => {
  const { collectClosure } = require('../../scripts/context-hosted/build-plan');
  const repo = path.resolve(__dirname, '../..');
  const roots = [
    'scripts/context-hosted/n09/owned-entry.js',
    'scripts/context-hosted/n09/composition.js',
    'scripts/context-hosted/n09-ack/host-install.js',
    'scripts/context-hosted/n09-ack/bootstrap-contract.js',
  ].map((name) => path.join(repo, name));
  const pins = collectClosure(roots, []);
  const inventory = path.join(repo, 'lib/proxy/context-recovery-storage-inventory.js');
  const cachedInventory = require.cache[inventory];
  assert.ok(Object.keys(pins).length > 10);
  assert.equal(verifyPinnedClosure(pins, roots).files, Object.keys(pins).length);
  assert.equal(
    require.cache[inventory],
    cachedInventory,
    'verification never executes installed imports'
  );
  assert.throws(() => verifyPinnedClosure({ ...pins, [roots[2]]: '0'.repeat(64) }, roots));
  const missing = { ...pins };
  delete missing[roots[2]];
  assert.throws(() => verifyPinnedClosure(missing, roots));
});

test('fixed installed inventory import cannot be copied to an unreviewed entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n09-inventory-closure-'));
  const entry = path.join(root, 'host-install.js');
  try {
    for (const target of [
      'storage-inventory',
      'publication',
      'http-entry',
      'storage-inventory-unknown',
      'publication-unknown',
      'http-entry-unknown',
      '',
    ]) {
      fs.writeFileSync(
        entry,
        `require(path.join(options.install, 'lib/proxy/context-recovery-${target}.js'));`
      );
      assert.throws(() => verifyPinnedClosure({ [entry]: sha(fs.readFileSync(entry)) }, [entry]));
    }
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
