'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectNativeCheckpointReuse } = require('../scripts/lib/native-checkpoint-reuse');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const path = require('node:path');
const checkpoint = { type: 'compaction', id: 'synthetic', encrypted_content: 'opaque-secret' };

test('checkpoint diagnostics distinguish complete equality from extra-field differences without leaking fields or values', () => {
  const same = inspectNativeCheckpointReuse([{ ...checkpoint }], checkpoint);
  assert.equal(same.exactItemEqual, true);
  assert.equal(same.opaqueReused, true);
  const previous = { ...checkpoint, 'private-name-secret': { nested: 'old-secret' } };
  const current = { ...checkpoint, 'private-name-secret': { nested: 'new-secret' }, extra: true };
  const changed = inspectNativeCheckpointReuse([current], previous);
  assert.equal(changed.exactItemEqual, false);
  assert.equal(changed.opaqueReused, true);
  assert.deepEqual(changed.changedKnownFields, []);
  assert.equal(changed.addedOtherFields, 1);
  assert.equal(changed.changedOtherFields, 1);
  assert.equal(inspectNativeCheckpointReuse([checkpoint], previous).removedOtherFields, 1);
  assert.doesNotMatch(JSON.stringify(changed), /secret|nested|extra/);
});

test('known field changes and explicit null versus absent are observable without any values', () => {
  const result = inspectNativeCheckpointReuse(
    [{ ...checkpoint, id: 'other', summary: null }],
    checkpoint
  );
  assert.equal(result.exactItemEqual, false);
  assert.deepEqual(result.changedKnownFields, ['id', 'summary']);
  assert.doesNotMatch(JSON.stringify(result), /other|opaque-secret/);
});

test('missing, replaced and duplicate opaque state cannot qualify a unique exact reuse', () => {
  for (const items of [
    [],
    [{ type: 'message' }],
    [{ ...checkpoint, encrypted_content: 'replaced' }],
    [checkpoint, checkpoint],
  ]) {
    const result = inspectNativeCheckpointReuse(items, checkpoint);
    assert.equal(result.opaqueReused, false);
    assert.equal(result.exactItemEqual, false);
  }
  assert.equal(
    inspectNativeCheckpointReuse([checkpoint, checkpoint], checkpoint).matchingOpaqueItems,
    2
  );
});

test('unknown, hostile, cyclic and oversized checkpoint input fails without evaluating accessors', () => {
  let invoked = 0;
  const hostile = Object.defineProperty({}, 'type', {
    enumerable: true,
    get() {
      invoked++;
      return 'compaction';
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const items of [null, {}, '', [hostile], [cyclic], ['x'.repeat(2 * 1024 * 1024)]])
    assert.throws(() => inspectNativeCheckpointReuse(items, checkpoint));
  for (const value of [null, {}, [], hostile, { ...checkpoint, encrypted_content: '' }])
    assert.throws(() => inspectNativeCheckpointReuse([], value));
  assert.equal(invoked, 0);
});

test('native aliases, large valid state and unified CI discovery remain supported', () => {
  const alias = { ...checkpoint, type: 'compaction_summary' };
  assert.equal(inspectNativeCheckpointReuse([alias], alias).exactItemEqual, true);
  const large = { ...checkpoint, encrypted_content: 'x'.repeat(1024 * 1024 + 1) };
  assert.equal(inspectNativeCheckpointReuse([large], large).exactItemEqual, true);
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..'))).includes(
      'test/native-checkpoint-reuse.test.js'
    )
  );
});
