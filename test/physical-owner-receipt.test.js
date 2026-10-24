'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assertOwnerLaunches } = require('./helpers/physical-owner-receipt.cjs');

function fixture() {
  const launches = ['save-crash', 'read', 'revoke-crash', 'read-revoked'].map((operation, i) => ({
    operation,
    runId: String(i + 1).repeat(32),
  }));
  return { launches, reports: launches.map((launch) => ({ ...launch, pid: 41 })) };
}

test('four independent owner launch receipts permit recycled Windows PID numbers', () => {
  const { reports, launches } = fixture();
  assertOwnerLaunches(reports, launches, 100);
  assertOwnerLaunches(reports.slice(0, 2), launches.slice(0, 2), 100);
});

test('owner receipt challenge rejects replay, substitution, missing and malformed launches', () => {
  for (const mutate of [
    (f) => {
      f.reports[1] = f.reports[0];
    },
    (f) => {
      f.launches[1].runId = f.launches[0].runId;
    },
    (f) => {
      f.reports[1].runId = 'f'.repeat(32);
    },
    (f) => {
      f.reports[1].operation = 'save';
    },
    (f) => {
      f.reports.pop();
    },
    (f) => {
      f.reports[1].pid = 100;
    },
    (f) => {
      f.reports[1].pid = 0;
    },
    (f) => {
      f.reports[1].pid = Number.MAX_SAFE_INTEGER + 1;
    },
    (f) => {
      delete f.reports[1].runId;
    },
    (f) => {
      f.launches[1].runId = '';
    },
    (f) => {
      f.launches[1].operation = 'other';
    },
    (f) => {
      f.launches = [];
      f.reports = [];
    },
    (f) => {
      f.launches = null;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assertOwnerLaunches(f.reports, f.launches, 100));
  }
});

test('owner receipt validation does not execute accessors or proxy traps', () => {
  let hooks = 0;
  const getter = Object.defineProperty({}, 'pid', {
    get() {
      hooks++;
      return 41;
    },
  });
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        hooks++;
        return Object.prototype;
      },
    }
  );
  for (const invalid of [null, [], getter, proxy, Object.create({ pid: 41 })]) {
    const f = fixture();
    f.reports[1] = invalid;
    assert.throws(() => assertOwnerLaunches(f.reports, f.launches, 100));
  }
  assert.equal(hooks, 0);
});
