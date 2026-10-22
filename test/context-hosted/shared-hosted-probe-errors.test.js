'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedSocketError } = require('../../scripts/context-hosted/shared/hosted-probes.js');

test('only explicit access denial can prove an immediate blocked connect', () => {
  for (const code of ['EACCES', 'EPERM']) assert.equal(isBlockedSocketError({ code }), true);
  for (const code of [
    'ECONNREFUSED',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ECONNRESET',
    'ETIMEDOUT',
    '',
    'eacces',
  ]) {
    assert.equal(isBlockedSocketError({ code }), false);
  }
});
test('missing, inherited and accessor socket codes fail closed without reading getters', () => {
  let read = false;
  const accessor = Object.defineProperty({}, 'code', {
    get() {
      read = true;
      return 'EACCES';
    },
  });
  for (const value of [
    null,
    undefined,
    1,
    'EACCES',
    {},
    [],
    Object.create({ code: 'EACCES' }),
    accessor,
  ]) {
    assert.equal(isBlockedSocketError(value), false);
  }
  assert.equal(read, false);
});
