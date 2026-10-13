'use strict';
const assert = require('node:assert/strict');
const { estimateTokensForValue, isInlineMediaPart } = require('../lib/proxy/inline-media');

// Independent reference retains the former per-node normalization semantics.
function reference(value, charsPerToken = 4) {
  const ratio = Number(charsPerToken) > 0 ? Number(charsPerToken) : 4;
  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / ratio);
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + reference(item, ratio), 0);
  if (typeof value === 'object') {
    if (isInlineMediaPart(value)) return 100;
    return Object.values(value).reduce((sum, item) => sum + reference(item, ratio), 0);
  }
  return Math.ceil(String(value).length / ratio);
}

const payload = Object.freeze({
  text: 'synthetic 中文 😀',
  nested: Object.freeze(['abc', 7, null]),
});
const originalNumber = global.Number;
let conversions = 0;
try {
  global.Number = new Proxy(originalNumber, {
    apply(target, receiver, args) {
      conversions++;
      return Reflect.apply(target, receiver, args);
    },
  });
  assert.equal(estimateTokensForValue(payload, 4), 6);
  assert.equal(conversions, 2, 'Normalize the ratio only at the public entry boundary');
} finally {
  global.Number = originalNumber;
}

const base64 = 'A'.repeat(1024);
const sparse = new Array(8);
sparse[4] = 'four';
const unsafeNames = JSON.parse('{"__proto__":{"text":"plain"},"constructor":"value"}');
const fixtures = [
  undefined,
  null,
  '',
  '中文 😀',
  false,
  true,
  0,
  -1,
  NaN,
  Infinity,
  9n,
  Symbol('synthetic'),
  [],
  {},
  payload,
  sparse,
  unsafeNames,
  { type: 'input_image', image_url: 'data:image/png;base64,' + base64 },
  { inlineData: { mimeType: 'image/png', data: base64 } },
  { source: { type: 'base64', data: base64 } },
  { type: 'input_image', image_url: 'https://example.test/image.png' },
  { type: 'input_image', image_url: '' },
  {
    text: 'x'.repeat(1024 * 1024),
    children: Array.from({ length: 256 }, (_, index) => ({ text: String(index) })),
  },
];
let deep = 'leaf';
for (let index = 0; index < 128; index++) deep = { child: deep };
fixtures.push(deep);
for (const ratio of [undefined, 4, 1, 0.5, '2', 0, -1, NaN, Infinity, null, {}, 8n]) {
  for (const value of fixtures)
    assert.equal(estimateTokensForValue(value, ratio), reference(value, ratio));
}
assert.equal(Object.getPrototypeOf(unsafeNames), Object.prototype);
assert.equal(Object.prototype.text, undefined);
assert.throws(() => estimateTokensForValue('text', Symbol('ratio')), TypeError);
for (const second of [0, -1, NaN, Infinity, 0.5]) {
  const statefulRatio = () => {
    let calls = 0;
    return { valueOf: () => (++calls === 1 ? 1 : second) };
  };
  for (const value of ['abcd', ['abcd'], { text: 'abcd' }]) {
    assert.equal(estimateTokensForValue(value, statefulRatio()), reference(value, statefulRatio()));
  }
}
const failure = new Error('synthetic failure');
assert.throws(
  () =>
    estimateTokensForValue({
      get text() {
        throw failure;
      },
    }),
  (error) => error === failure
);
assert.throws(
  () =>
    estimateTokensForValue('text', {
      valueOf() {
        throw failure;
      },
    }),
  (error) => error === failure
);
// Object.values snapshots all property values before descending into a child.
const order = [];
assert.equal(
  estimateTokensForValue({
    get first() {
      order.push('first');
      return {
        get text() {
          order.push('child');
          return 'abcd';
        },
      };
    },
    get second() {
      order.push('second');
      return 'abcd';
    },
  }),
  2
);
assert.deepEqual(order, ['first', 'second', 'child']);
const cyclic = {};
cyclic.self = cyclic;
assert.throws(() => estimateTokensForValue(cyclic), RangeError);
assert.throws(() => reference(cyclic), RangeError);
console.log('inline-media-estimator.test.js passed');
