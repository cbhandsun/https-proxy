'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { verifyPinnedClosure } = require('../../scripts/context-hosted/n09/owned-entry.js');
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
