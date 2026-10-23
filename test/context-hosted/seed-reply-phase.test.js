'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  seedReplyFailurePhase,
} = require('../../scripts/context-hosted/shared/seed-reply-phase.js');
test('seed reply phase accepts only integer HTTP status and never accesses supplied values', () => {
  assert.equal(seedReplyFailurePhase(200), null);
  for (const [index, status] of [400, 401, 403, 409, 413, 429, 500, 502, 503, 504].entries())
    assert.equal(seedReplyFailurePhase(status), 162 + index);
  for (const value of [100, 199, 201, 299, 300, 399, 418, 599])
    assert.equal(seedReplyFailurePhase(value), 172);
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error('PRIVATE_SENTINEL');
      },
    }
  );
  for (const value of [undefined, null, '503', NaN, Infinity, 99, 600, 200.5, [], {}, hostile, 2n])
    assert.equal(seedReplyFailurePhase(value), 173);
  assert.equal(traps, 0);
});
