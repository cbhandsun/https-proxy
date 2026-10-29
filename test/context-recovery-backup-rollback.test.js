'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  isolateBackupRollbackEnvironment,
  createBackupRollbackFixture,
  digest,
} = require('./helpers/recovery-backup-rollback');

// Isolation precedes all production storage imports, including direct node --test.
const root = isolateBackupRollbackEnvironment(test);
const scope = 'a'.repeat(64);
const unavailable = (error) =>
  error?.code === 'context_recovery_storage_unavailable' &&
  error.message === error.code &&
  error.statusCode === 503 &&
  error.cause === undefined;

async function saveAndRevoke(fixture, backup) {
  const original = `Synthetic backup rollback 中文\r\n🙂 ${randomUUID()}`;
  const state = { original, budget: { calls: 17, returnedBytes: 512 } };
  const expiresAt = Date.now() + 60 * 60 * 1000;
  let owner = await fixture.open();
  assert.equal(
    (await owner.execute({ operation: 'save', scope, expectedRevision: 0, expiresAt, state }))
      .revision,
    1
  );
  const read = await owner.execute({ operation: 'load', scope });
  assert.equal(read.revision, 1);
  assert.equal(digest(read.state.original), digest(original));
  assert.equal(read.expiresAt, expiresAt);
  assert.equal(read.state.budget.calls, 17);
  const wrappedKeyDigest = fixture.wrappedKeyDigest();
  await fixture.close();
  if (backup) assert.deepEqual(fixture.snapshot().files, ['checkpoint.sqlite', '.data-key']);
  owner = await fixture.open();
  // Verify the consistent old backup came from a readable, genuine DPAPI owner.
  assert.equal(
    digest((await owner.execute({ operation: 'load', scope })).state.original),
    digest(original)
  );
  assert.equal(
    (await owner.execute({ operation: 'revoke', scope, expectedRevision: 1 })).revision,
    2
  );
  assert.equal(await owner.execute({ operation: 'load', scope }), null);
  await fixture.close();
  assert.equal(fixture.wrappedKeyDigest(), wrappedKeyDigest);
  return { wrappedKeyDigest, originalDigest: digest(original) };
}

test(
  'real CurrentUser DPAPI owner preserves acknowledged revocation across normal reopen',
  { skip: process.platform !== 'win32', timeout: 120000 },
  async (t) => {
    const fixture = createBackupRollbackFixture(t, root, 'control');
    const saved = await saveAndRevoke(fixture, false);
    const owner = await fixture.open();
    assert.equal(await owner.execute({ operation: 'load', scope }), null);
    assert.equal((await owner.execute({ operation: 'catalog' })).length, 0);
    assert.equal(fixture.wrappedKeyDigest(), saved.wrappedKeyDigest);
    await fixture.close();
  }
);

// May be RED: AEAD/CAS and in-process revision pins do not themselves prevent
// restoring a complete valid pre-revocation DB after every owner has closed.
// Do not weaken the assertion or mark this expected-failure to make CI green.
test(
  'real CurrentUser DPAPI owner must deny revoked originals after restoring its old consistent backup',
  { skip: process.platform !== 'win32', timeout: 120000 },
  async (t) => {
    const fixture = createBackupRollbackFixture(t, root, 'rollback');
    const saved = await saveAndRevoke(fixture, true);
    // First demonstrate normal restart denial on this exact store, without any
    // surviving owner/cache. Only then restore the owned pre-revocation files.
    const control = await fixture.open();
    assert.equal(await control.execute({ operation: 'load', scope }), null);
    await fixture.close();
    fixture.restore();
    assert.equal(fixture.wrappedKeyDigest(), saved.wrappedKeyDigest);
    let owner;
    try {
      owner = await fixture.open();
    } catch (error) {
      assert.ok(
        unavailable(error),
        'rollback rejection must use the safe storage failure contract'
      );
      return;
    }
    let loaded;
    try {
      loaded = await owner.execute({ operation: 'load', scope });
    } catch (error) {
      assert.ok(
        unavailable(error),
        'rollback rejection must use the safe storage failure contract'
      );
      return;
    }
    // Boolean-only failure output: never print recovered user-style text/key or
    // the raw record even if the revoked exact original becomes readable.
    const exactOriginalRevived =
      loaded !== null && digest(loaded.state.original) === saved.originalDigest;
    assert.equal(exactOriginalRevived, false, 'revoked exact original revived from an old backup');
    assert.equal(loaded === null, true, 'a revoked scope must remain unreadable after rollback');
    assert.equal((await owner.execute({ operation: 'catalog' })).length, 0);
    await fixture.close();
  }
);
