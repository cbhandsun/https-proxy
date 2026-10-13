'use strict';
const assert = require('node:assert/strict');
const { mergeResponsesChatHistory } = require('../lib/proxy/responses-history-merge');
const previous = Object.freeze(
  [
    { role: 'system', content: 'old' },
    { role: 'user', content: 'ask' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call' }] },
  ].map(Object.freeze)
);
const current = Object.freeze(
  [
    { role: 'system', content: 'new' },
    { role: 'developer', content: 'policy' },
    { role: 'tool', tool_call_id: 'call', content: 'result' },
    { role: 'user', content: 'continue' },
  ].map(Object.freeze)
);
const before = JSON.stringify([previous, current]);
const merged = mergeResponsesChatHistory(previous, current);
assert.deepEqual(
  merged.map((message) => message.role),
  ['system', 'system', 'developer', 'user', 'assistant', 'tool', 'user']
);
assert.equal(merged[4], previous[2]);
assert.equal(merged[5], current[2]);
assert.equal(JSON.stringify([previous, current]), before);
assert.deepEqual(mergeResponsesChatHistory([], []), []);
assert.deepEqual(mergeResponsesChatHistory(previous, []), previous);
assert.deepEqual(mergeResponsesChatHistory([], current), current);
assert.deepEqual(
  mergeResponsesChatHistory([{ role: 'system', content: 'summary' }], current).map(
    (message) => message.role
  ),
  ['system', 'system', 'developer', 'tool', 'user']
);
for (const value of [
  null,
  undefined,
  {},
  'SECRET',
  [null],
  [[]],
  [{ role: 'SECRET' }],
  [{ role: '__proto__' }],
]) {
  for (const pair of [
    [value, []],
    [[], value],
  ])
    assert.throws(
      () => mergeResponsesChatHistory(...pair),
      (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
    );
}
const large = Array.from({ length: 10000 }, () => ({ role: 'user', content: 'synthetic' }));
assert.equal(mergeResponsesChatHistory(large, [{ role: 'system', content: 'new' }]).length, 10001);
assert.equal(
  mergeResponsesChatHistory(large, [{ role: 'system', content: 'new' }])[0].content,
  'new'
);
