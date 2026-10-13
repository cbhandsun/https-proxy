'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createNativeBenchmarkToolConcurrency,
} = require('../scripts/lib/native-benchmark-tool-concurrency');

test('sequential, irrelevant, empty and unsafe reads do not prove parallel branch execution', () => {
  const observer = createNativeBenchmarkToolConcurrency();
  for (const document of [
    undefined,
    null,
    {},
    '',
    'release',
    '../secret',
    'design',
    'verification',
  ]) {
    const finish = observer.begin(document);
    finish();
    finish();
  }
  assert.deepEqual(observer.diagnostics(), {
    parallelBranchesObserved: false,
    maxPendingBranches: 1,
    pendingBranches: 0,
  });
});

test('two genuinely pending independent branches prove overlap; duplicate branch fails closed', () => {
  const observer = createNativeBenchmarkToolConcurrency();
  const a = observer.begin('design');
  assert.throws(() => observer.begin('design'), /duplicate_pending_branch/);
  const b = observer.begin('verification');
  assert.deepEqual(observer.diagnostics(), {
    parallelBranchesObserved: true,
    maxPendingBranches: 2,
    pendingBranches: 2,
  });
  a();
  b();
  assert.equal(observer.diagnostics().pendingBranches, 0);
  assert.equal(observer.diagnostics().parallelBranchesObserved, true);
});

test('a repeated old completion cannot remove a newer pending read', () => {
  const observer = createNativeBenchmarkToolConcurrency();
  const first = observer.begin('design');
  first();
  const second = observer.begin('design');
  first();
  assert.equal(observer.diagnostics().pendingBranches, 1);
  second();
  assert.equal(observer.diagnostics().pendingBranches, 0);
});
