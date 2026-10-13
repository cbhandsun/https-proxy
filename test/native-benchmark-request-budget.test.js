'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createNativeBenchmarkRequestBudget,
} = require('../scripts/lib/native-benchmark-request-budget');

test('authorized cumulative cap includes prior failed requests and cannot release reservations', () => {
  const options = { priorRequests: 17, cumulativeLimit: 30 };
  const budget = createNativeBenchmarkRequestBudget(options);
  options.cumulativeLimit = 1000;
  for (let index = 0; index < 13; index++) assert.equal(budget.admit().ok, true);
  assert.deepEqual(budget.admit(), { ok: false, code: 'benchmark_request_limit' });
  const snapshot = budget.inspect();
  assert.deepEqual(snapshot, {
    cumulativeLimit: 30,
    priorRequests: 17,
    reservedRequests: 13,
    cumulativeRequests: 30,
    remainingRequests: 0,
  });
  snapshot.remainingRequests = 999;
  assert.equal(budget.inspect().remainingRequests, 0);
  assert.equal(budget.admit().ok, false);
});

test('concurrent admissions cannot overbook the last provider request', async () => {
  const budget = createNativeBenchmarkRequestBudget({ priorRequests: 29, cumulativeLimit: 30 });
  const replies = await Promise.all(Array.from({ length: 20 }, async () => budget.admit()));
  assert.equal(replies.filter((reply) => reply.ok).length, 1);
  assert.equal(budget.inspect().cumulativeRequests, 30);
  assert.equal(
    createNativeBenchmarkRequestBudget({ priorRequests: 30, cumulativeLimit: 30 }).admit().ok,
    false
  );
  assert.equal(
    createNativeBenchmarkRequestBudget({ priorRequests: 0, cumulativeLimit: 1 }).admit().ok,
    true
  );
});

test('missing, coerced, negative, extreme, cyclic, accessor and unknown options fail without effects', () => {
  let invoked = 0;
  const unsafe = {
    get priorRequests() {
      invoked++;
      return 0;
    },
    cumulativeLimit: 30,
  };
  const cyclic = { priorRequests: 0, cumulativeLimit: 30 };
  cyclic.self = cyclic;
  for (const input of [
    undefined,
    null,
    [],
    {},
    unsafe,
    cyclic,
    { priorRequests: '17', cumulativeLimit: 30 },
    { priorRequests: -1, cumulativeLimit: 30 },
    { priorRequests: 31, cumulativeLimit: 30 },
    { priorRequests: 0, cumulativeLimit: 0 },
    { priorRequests: 0, cumulativeLimit: 1001 },
    { priorRequests: 0, cumulativeLimit: Infinity },
    { priorRequests: 0, cumulativeLimit: 1.5 },
    { priorRequests: 0, cumulativeLimit: 30, secret: 'private' },
    { priorRequests: Number.MAX_SAFE_INTEGER, cumulativeLimit: 30 },
  ])
    assert.throws(
      () => createNativeBenchmarkRequestBudget(input),
      /Invalid native benchmark request budget/
    );
  assert.equal(invoked, 0);
});
