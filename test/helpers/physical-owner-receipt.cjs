'use strict';

const assert = require('node:assert/strict');
const { types } = require('node:util');

// Sequential Windows processes may reuse a PID after the prior owner exits.
// Bind each independently spawned helper's reply to its fresh parent challenge.
function assertOwnerLaunches(reports, launches, parentPid) {
  assert.ok(Array.isArray(reports) && Array.isArray(launches));
  assert.ok([2, 4].includes(launches.length));
  assert.equal(reports.length, launches.length);
  assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0);
  const seen = new Set();
  for (let index = 0; index < launches.length; index++) {
    const report = reports[index];
    const launch = launches[index];
    for (const value of [report, launch]) {
      assert.ok(value && typeof value === 'object' && !types.isProxy(value));
      assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)));
      for (const slot of Object.values(Object.getOwnPropertyDescriptors(value)))
        assert.ok(Object.hasOwn(slot, 'value'));
    }
    assert.match(launch.runId, /^[a-f0-9]{32}$/);
    assert.equal(seen.has(launch.runId), false);
    seen.add(launch.runId);
    assert.ok(
      ['save', 'read', 'save-crash', 'revoke-crash', 'read-revoked'].includes(launch.operation)
    );
    assert.equal(report.runId, launch.runId);
    assert.equal(report.operation, launch.operation);
    assert.ok(Number.isSafeInteger(report.pid) && report.pid > 0 && report.pid !== parentPid);
  }
}

module.exports = { assertOwnerLaunches };
