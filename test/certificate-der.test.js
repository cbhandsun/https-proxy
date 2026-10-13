'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const der = require('../lib/proxy/certificate-der');

test('DER canonical framing and positive integer sign protection', () => {
  for (const size of [0, 1, 127, 128, 255, 256, 1000, der.MAX_DER_BYTES - 4]) {
    const content = Buffer.alloc(size, 42);
    const encoded = der.encode(4, content);
    const node = der.read(encoded);
    assert.equal(node.tag, 4);
    assert.equal(node.end, encoded.length);
    assert.deepEqual(encoded.subarray(node.content, node.end), content);
  }
  assert.equal(der.positiveInteger(Buffer.from([128])).toString('hex'), '02020080');
  assert.equal(der.positiveInteger(Buffer.from([0, 0, 1])).toString('hex'), '020101');
  assert.equal(der.positiveInteger(Buffer.from([0])).toString('hex'), '020100');
  const encoded = der.sequence(
    der.encode(4, Buffer.from('one')),
    der.encode(4, Buffer.from('two'))
  );
  assert.equal(der.children(encoded, der.read(encoded)).length, 2);
  assert.throws(() => der.children(encoded, der.read(encoded), 1), /certificate_der_invalid/);
});

test('DER rejects empty, indefinite, noncanonical, truncated and oversized inputs without getters', () => {
  for (const value of [
    null,
    undefined,
    '',
    [],
    {},
    Buffer.alloc(0),
    Buffer.from('04800000', 'hex'),
    Buffer.from('04810100', 'hex'),
    Buffer.from('0482008000', 'hex'),
    Buffer.from('0483000100', 'hex'),
    Buffer.from('1f00', 'hex'),
    Buffer.from('0000', 'hex'),
    Buffer.from('0402ff', 'hex'),
    Buffer.alloc(der.MAX_DER_BYTES + 1),
  ]) {
    assert.throws(() => der.read(value), /certificate_der_invalid/);
  }
  for (const [offset, limit] of [
    [-1, 2],
    [0.5, 2],
    [0, 3],
    [0, -1],
    [Infinity, 2],
  ]) {
    assert.throws(() => der.read(Buffer.from([4, 0]), offset, limit), /certificate_der_invalid/);
  }
  for (const [tag, content] of [
    [0, Buffer.alloc(0)],
    [31, Buffer.alloc(0)],
    [256, Buffer.alloc(0)],
    [4, 'secret'],
    [4, Buffer.alloc(der.MAX_DER_BYTES)],
  ]) {
    assert.throws(() => der.encode(tag, content), /certificate_der_invalid/);
  }
  for (const value of [undefined, '', Buffer.alloc(0), Buffer.alloc(21)]) {
    assert.throws(() => der.positiveInteger(value), /certificate_der_invalid/);
  }
  assert.throws(() => der.sequence('secret'), /certificate_der_invalid/);
  let accessed = false;
  assert.throws(
    () =>
      der.read({
        get length() {
          accessed = true;
          return 2;
        },
      }),
    /certificate_der_invalid/
  );
  assert.equal(accessed, false);
});
