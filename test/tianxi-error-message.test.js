'use strict';

const assert = require('node:assert/strict');
const {
  selectTianxiErrorMessage,
  sanitizeTianxiErrorText,
} = require('../lib/proxy/tianxi-error-message');

assert.equal(
  selectTianxiErrorMessage({ error_detail: 'detail', error: 'fallback' }, 'FAILED'),
  'detail'
);
assert.equal(
  selectTianxiErrorMessage({ error_detail: {}, error: 'model unavailable' }, 'FAILED'),
  'model unavailable'
);
assert.equal(
  selectTianxiErrorMessage({ error_detail: { detail: { message: 'nested' } } }, 'FAILED'),
  'nested'
);
for (const value of [null, undefined, '', '  ', 42, true, [], {}, Symbol('invalid')]) {
  assert.equal(selectTianxiErrorMessage({ error_detail: value }, 'FAILED'), 'FAILED');
}
assert.equal(selectTianxiErrorMessage(null, null), 'FAILED');
assert.equal(selectTianxiErrorMessage({ error: 'x'.repeat(20000) }, 'FAILED').length, 8192);
const cycle = {};
assert.equal(selectTianxiErrorMessage({ message: { errors: ['expired'] } }, 'FAILED'), 'expired');
cycle.message = cycle;
assert.equal(
  selectTianxiErrorMessage({ error_detail: cycle, error: 'fallback' }, 'FAILED'),
  'fallback'
);
const hostile = {
  toString() {
    throw new Error('coercion executed');
  },
};
Object.defineProperty(hostile, 'message', {
  get() {
    throw new Error('getter executed');
  },
});
assert.equal(
  selectTianxiErrorMessage({ error_detail: hostile, error: 'fallback' }, 'FAILED'),
  'fallback'
);
assert.equal(
  selectTianxiErrorMessage(
    {
      error_detail: new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('proxy');
          },
        }
      ),
      error: 'fallback',
    },
    'FAILED'
  ),
  'fallback'
);
assert.equal(
  selectTianxiErrorMessage({ error_detail: Object.create({ message: 'inherited' }) }, 'FAILED'),
  'FAILED'
);
console.log('tianxi-error-message tests passed');
const revoked = Proxy.revocable({}, {});
revoked.revoke();
assert.equal(
  selectTianxiErrorMessage({ error_detail: revoked.proxy, error: 'fallback' }, 'FAILED'),
  'fallback'
);
assert.equal(sanitizeTianxiErrorText('model unavailable'), 'model unavailable');
assert.equal(sanitizeTianxiErrorText(null), '');
assert.ok(
  !sanitizeTianxiErrorText('api_key="' + 'private value '.repeat(2000)).includes('private')
);
