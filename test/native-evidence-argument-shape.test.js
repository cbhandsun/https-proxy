'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { nativeEvidenceArgumentShape } = require('../scripts/lib/native-evidence-argument-shape');

test('argument diagnostics classify bounds, without values or unknown names', () => {
  for (const [limit, expected] of [
    [1, 'valid'],
    [16, 'valid'],
    [0, 'out_of_range'],
    [17, 'out_of_range'],
    [Number.MAX_SAFE_INTEGER, 'out_of_range'],
    [1.5, 'not_safe_integer'],
    ['secret-value', 'wrong_type'],
    [null, 'wrong_type'],
  ]) {
    const shape = nativeEvidenceArgumentShape({ limit, 'secret-name': 'secret-value' });
    assert.equal(shape.keyConstraints.limit, expected);
    assert.equal(shape.unknownKeyCount, 1);
    assert.equal(JSON.stringify(shape).includes('secret'), false);
  }
  const shape = nativeEvidenceArgumentShape({
    offsetBytes: 0,
    limitBytes: 65536,
    sourceId: 'hce_' + 'a'.repeat(32),
    digest: 'b'.repeat(64),
    afterSourceId: null,
    document: 'secret',
  });
  assert.deepEqual(shape.keyConstraints, {
    offsetBytes: 'valid',
    limitBytes: 'valid',
    sourceId: 'valid',
    digest: 'valid',
    afterSourceId: 'wrong_type',
  });
  assert.equal(JSON.stringify(shape).includes('secret'), false);
  assert.equal(
    nativeEvidenceArgumentShape({ sourceId: 'private-id', digest: 'private-digest' }).keyConstraints
      .digest,
    'invalid_format'
  );
});

test('empty, scalar, malformed, unsafe and oversized inputs never execute serialization hooks', () => {
  assert.equal(nativeEvidenceArgumentShape(null).argumentsType, 'null');
  assert.equal(nativeEvidenceArgumentShape([]).argumentsType, 'array');
  assert.deepEqual(nativeEvidenceArgumentShape({}).keyConstraints, {});
  let effects = 0;
  const getter = Object.defineProperty({}, 'limit', {
    enumerable: true,
    get() {
      effects++;
      return 17;
    },
  });
  const cycle = {};
  cycle.limit = cycle;
  for (const value of [
    getter,
    cycle,
    {
      toJSON() {
        effects++;
        return {};
      },
    },
    { content: 'x'.repeat(2 * 1024 * 1024 + 1) },
  ]) {
    assert.throws(() => nativeEvidenceArgumentShape(value));
  }
  assert.equal(effects, 0);
});
