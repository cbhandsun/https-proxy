'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  safeCompactionFailureReason,
  createCompactionFailure,
  compactionFailureReason,
} = require('../lib/proxy/context-compaction-failure');

test('compaction failures expose only fixed codes and require original error identity', () => {
  const failure = createCompactionFailure('summary_reference_invalid');
  assert.equal(compactionFailureReason(failure), 'summary_reference_invalid');
  assert.equal(
    safeCompactionFailureReason('summary_reference_invalid'),
    'summary_reference_invalid'
  );
  assert.equal(compactionFailureReason({ ...failure }), undefined);
  let hooks = 0;
  const hostile = Object.defineProperty({}, 'reason', {
    get() {
      hooks++;
      throw new Error('SECRET');
    },
  });
  for (const value of [null, undefined, '', 'SECRET', 'x'.repeat(100000), [], hostile, NaN]) {
    assert.equal(safeCompactionFailureReason(value), undefined);
    assert.equal(compactionFailureReason(value), undefined);
    const fallback = createCompactionFailure(value);
    assert.equal(compactionFailureReason(fallback), 'summary_source_invalid');
    assert.ok(!JSON.stringify(fallback).includes('SECRET'));
  }
  assert.equal(hooks, 0);
});
