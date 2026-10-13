'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCallIdDigests,
  mergeCallIdDigests,
  MAX_CONTEXT_CALL_ID_DIGESTS,
} = require('../lib/proxy/context-call-id-lineage');

test('call identity lineage is bounded, deduplicated, independent data and rejects hooks and invalid input', () => {
  const first = 'a'.repeat(64),
    second = 'b'.repeat(64);
  const source = [first, first];
  assert.deepEqual(normalizeCallIdDigests(), []);
  assert.deepEqual(normalizeCallIdDigests(source), [first]);
  assert.deepEqual(mergeCallIdDigests(source, [second]), [first, second]);
  assert.deepEqual(source, [first, first]);
  let hooks = 0;
  const getter = Object.defineProperty([], '0', {
    enumerable: true,
    get() {
      hooks++;
      return first;
    },
  });
  const sparse = new Array(MAX_CONTEXT_CALL_ID_DIGESTS + 1);
  const custom = Object.setPrototypeOf([first], null);
  const extra = [first];
  extra.extra = second;
  for (const data of [
    null,
    {},
    'text',
    ['A'.repeat(64)],
    ['a'.repeat(63)],
    [42],
    getter,
    sparse,
    custom,
    extra,
  ])
    assert.throws(() => normalizeCallIdDigests(data), { code: 'invalid_context_call_lineage' });
  for (const maximum of [0, -1, Infinity, MAX_CONTEXT_CALL_ID_DIGESTS + 1])
    assert.throws(() => normalizeCallIdDigests([], maximum), {
      code: 'invalid_context_call_lineage',
    });
  assert.throws(() => normalizeCallIdDigests([first, second], 1), {
    code: 'invalid_context_call_lineage',
  });
  const maximum = Array.from({ length: MAX_CONTEXT_CALL_ID_DIGESTS }, (_value, index) =>
    index.toString(16).padStart(64, '0')
  );
  assert.equal(normalizeCallIdDigests(maximum).length, MAX_CONTEXT_CALL_ID_DIGESTS);
  assert.throws(() => mergeCallIdDigests(maximum, [first]), {
    code: 'invalid_context_call_lineage',
  });
  assert.equal(hooks, 0);
});
