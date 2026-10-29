'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const { discoverTestFiles } = require('../lib/test-discovery');
const {
  inventoryStore,
  isStorageRefusal,
  assertLegacyRefusal,
  assertUnknownFormatRefusal,
} = require('../scripts/lib/nsis-legacy-refusal');
const refusal = () =>
  Object.assign(new Error('context_recovery_storage_unavailable'), {
    code: 'context_recovery_storage_unavailable',
    statusCode: 503,
  });
const inventory = () => [
  { name: '.data-key', size: 1, sha256: 'a'.repeat(64) },
  { name: '.writer.sqlite', size: 2, sha256: 'b'.repeat(64) },
  { name: 'checkpoint.sqlite', size: 3, sha256: 'c'.repeat(64) },
];
const evidence = () => ({
  nativeCalls: 1,
  missingAnchorReads: 1,
  anchorWrites: 0,
  databaseOpened: true,
  engineReady: false,
});
function input(extra = {}) {
  return {
    open() {
      throw refusal();
    },
    inventory,
    evidence,
    verifyClosed() {},
    ...extra,
  };
}

test('only a fixed 503 after missing anchor observation and closed-byte preservation qualifies', () => {
  assert.deepEqual(assertLegacyRefusal(input()), {
    refused: true,
    preserved: true,
    statusCode: 503,
    fileCount: 3,
  });
  for (const changed of [
    { nativeCalls: 0 },
    { nativeCalls: undefined },
    { missingAnchorReads: 0 },
    { missingAnchorReads: 2 },
    { anchorWrites: 1 },
    { databaseOpened: false },
    { engineReady: true },
  ])
    assert.throws(() =>
      assertLegacyRefusal(input({ evidence: () => ({ ...evidence(), ...changed }) }))
    );
});

test('old baseline must refuse the new format without anchor calls, byte changes or an engine-ready result', () => {
  const oldEvidence = () => ({ ...evidence(), missingAnchorReads: 0 });
  assert.deepEqual(assertUnknownFormatRefusal(input({ evidence: oldEvidence })), {
    refused: true,
    preserved: true,
    statusCode: 503,
    fileCount: 3,
  });
  for (const changed of [
    { nativeCalls: 0 },
    { missingAnchorReads: 1 },
    { anchorWrites: 1 },
    { databaseOpened: false },
    { engineReady: true },
  ]) {
    assert.throws(() =>
      assertUnknownFormatRefusal(
        input({
          evidence: () => ({ ...oldEvidence(), ...changed }),
        })
      )
    );
  }
  assert.throws(() =>
    assertUnknownFormatRefusal(
      input({
        evidence: oldEvidence,
        open: () => ({ close() {} }),
      })
    )
  );
  let count = 0;
  assert.throws(() =>
    assertUnknownFormatRefusal(
      input({
        evidence: oldEvidence,
        inventory: () => (++count === 1 ? inventory() : []),
      })
    )
  );
});

test('arbitrary errors, successful opens and close failures cannot impersonate admission refusal', () => {
  for (const error of [null, undefined, new Error('private details'), { statusCode: 503 }])
    assert.throws(() =>
      assertLegacyRefusal(
        input({
          open() {
            throw error;
          },
        })
      )
    );
  let closed = 0;
  for (const close of [
    () => {
      closed++;
    },
    () => {
      closed++;
      throw refusal();
    },
  ])
    assert.throws(() => assertLegacyRefusal(input({ open: () => ({ close }) })));
  assert.equal(closed, 2);
  for (const change of [{ code: 'other' }, { statusCode: 500 }, { cause: 'private' }])
    assert.equal(isStorageRefusal(Object.assign(refusal(), change)), false);
  const hostile = Object.defineProperty({}, 'message', {
    get() {
      throw new Error('private');
    },
  });
  assert.equal(isStorageRefusal(hostile), false);
  assert.equal(
    isStorageRefusal(
      new Proxy(
        {},
        {
          get() {
            throw new Error('private');
          },
        }
      )
    ),
    false
  );
});

test('changed names, lengths, hashes and inventory failures refuse a successful receipt', () => {
  for (const mutate of [
    (rows) => rows.slice(1),
    (rows) => [...rows, { name: 'extra', size: 0, sha256: 'd'.repeat(64) }],
    (rows) => rows.map((row) => ({ ...row, size: row.size + 1 })),
    (rows) => rows.map((row) => ({ ...row, sha256: 'd'.repeat(64) })),
  ]) {
    let calls = 0;
    assert.throws(() =>
      assertLegacyRefusal(
        input({ inventory: () => (++calls === 1 ? inventory() : mutate(inventory())) })
      )
    );
    assert.equal(calls, 2);
  }
  assert.throws(() =>
    assertLegacyRefusal(
      input({
        inventory() {
          throw new Error('read failed');
        },
      })
    )
  );
  assert.throws(() =>
    assertLegacyRefusal(
      input({
        verifyClosed() {
          throw new Error('lock retained');
        },
      })
    )
  );
});

test('physical closed-store inventory covers every file and refuses missing, linked or excessive entries', (t) => {
  const temporary = resolvePhysicalTestTempDirectory();
  const root = fs.mkdtempSync(path.join(temporary, 'hpm-legacy-refusal-'));
  t.after(() => {
    assert.equal(path.dirname(root), temporary);
    assert.equal(fs.realpathSync.native(root), root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.throws(() => inventoryStore(root));
  for (const name of ['.data-key', '.writer.sqlite', 'checkpoint.sqlite'])
    fs.writeFileSync(path.join(root, name), name);
  const before = inventoryStore(root);
  assert.equal(before.length, 3);
  assert.deepEqual(inventoryStore(root), before);
  fs.appendFileSync(path.join(root, 'checkpoint.sqlite'), 'changed');
  assert.notDeepEqual(inventoryStore(root), before);
  fs.mkdirSync(path.join(root, 'directory'));
  assert.throws(() => inventoryStore(root));
  fs.rmdirSync(path.join(root, 'directory'));
  fs.linkSync(path.join(root, '.data-key'), path.join(root, 'linked'));
  assert.throws(() => inventoryStore(root));
  fs.unlinkSync(path.join(root, 'linked'));
  for (let i = 0; i < 14; i++) fs.writeFileSync(path.join(root, 'extra-' + i), '');
  assert.throws(() => inventoryStore(root));
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes('test/nsis-legacy-refusal.test.js')
  );
});
