'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTrackedFiles,
  captureSourceIdentity,
} = require('../../scripts/context-hosted/source-identity');
const { prepare } = require('../../scripts/prepare-context-hosted-run');
test('tracked source names are bounded, normalized and independent of workspace absolute paths', () => {
  assert.deepEqual(parseTrackedFiles(Buffer.from('scripts/a.js\0lib/b.js\0')), [
    'lib/b.js',
    'scripts/a.js',
  ]);
  for (const value of [
    null,
    Buffer.alloc(0),
    Buffer.from('no-terminator'),
    Buffer.from('../outside\0'),
    Buffer.from('a\0A\0'),
    Buffer.from('/absolute\0'),
    Buffer.from('foo\\bar\0'),
    Buffer.from('line\nbreak\0'),
    Buffer.from([0xff, 0]),
  ])
    assert.throws(() => parseTrackedFiles(value));
});
test('identity capture and preparation refuse invalid inputs before starting processes or touching paths', () => {
  assert.throws(() => captureSourceIdentity(null, 'bad'));
  assert.throws(() => captureSourceIdentity('/not-used', 'bad'));
  assert.throws(() => prepare('arbitrary'));
  assert.throws(() =>
    prepare({
      toString() {
        throw Error('must not coerce');
      },
    })
  );
});

test('tracked paths reject each control code but retain printable and supplementary characters', () => {
  for (const code of [...Array.from({ length: 31 }, (_, index) => index + 1), 127])
    assert.throws(() => parseTrackedFiles(Buffer.from('a' + String.fromCharCode(code) + 'b\0')));
  assert.deepEqual(parseTrackedFiles(Buffer.from('space name~😀.js\0')), ['space name~😀.js']);
});
