'use strict';
const assert = require('node:assert/strict');
const {
  createFrameReader,
  WBIPC_MAX_FRAME_BYTES: limit,
} = require('../lib/proxy/workbuddy-wbipc-frame-reader');
function fixture() {
  const frames = [],
    errors = [];
  const push = createFrameReader(
    (frame) => frames.push(frame),
    (error) => errors.push(error)
  );
  return { frames, errors, push };
}
const huge = fixture();
huge.push(Buffer.from(JSON.stringify({ pad: 'x'.repeat(limit) }) + '\n'));
assert.equal(huge.frames.length, 0, 'complete oversized frames must not parse');
assert.equal(huge.errors.length, 1);
const bad = fixture();
bad.push(Buffer.from('broken SECRET\n{}\n'));
bad.push(Buffer.from('{}\n'));
assert.equal(bad.frames.length, 0, 'failure must stop every later frame');
assert.equal(bad.errors.length, 1);
assert.equal(bad.errors[0].message.includes('SECRET'), false);
const crlf = fixture();
crlf.push(Buffer.from('\r\n{}\r\n\r\n'));
assert.deepEqual(crlf.frames, [{}]);
assert.equal(crlf.errors.length, 0);
const invalidEncoding = fixture();
invalidEncoding.push(
  Buffer.concat([Buffer.from('{"text":"'), Buffer.from([255]), Buffer.from('"}\n{}\n')])
);
assert.equal(invalidEncoding.errors.length, 1);
assert.equal(invalidEncoding.frames.length, 0);
const normal = fixture();
const wire = Buffer.from(
  '\n' + JSON.stringify({ text: '中文 😀', nested: { ok: true } }) + '\r\n{}\n'
);
for (const byte of wire) normal.push(Buffer.from([byte]));
assert.deepEqual(normal.frames, [{ text: '中文 😀', nested: { ok: true } }, {}]);
assert.equal(normal.errors.length, 0);
const exact = fixture();
const exactWire = Buffer.from(JSON.stringify({ pad: 'x'.repeat(limit - 10) }));
assert.equal(exactWire.length, limit);
exact.push(exactWire);
assert.equal(exact.frames.length, 0);
exact.push(Buffer.from('\n'));
assert.equal(exact.frames.length, 1);
const fragmented = fixture();
fragmented.push(Buffer.alloc(limit, 32));
fragmented.push(Buffer.from(' \n{}\n'));
assert.equal(fragmented.frames.length, 0);
assert.equal(fragmented.errors.length, 1);
for (const chunk of [null, {}, [], 'SECRET', new Uint8Array([10])]) {
  const f = fixture();
  f.push(chunk);
  assert.equal(f.errors.length, 1);
  assert.equal(f.frames.length, 0);
  assert.equal(f.errors[0].message.includes('SECRET'), false);
}
for (const value of [null, [], 1, true, 'SECRET']) {
  const f = fixture();
  f.push(Buffer.from(JSON.stringify(value) + '\n{}\n'));
  assert.equal(f.errors.length, 1);
  assert.equal(f.frames.length, 0);
  assert.equal(f.errors[0].message.includes('SECRET'), false);
}
const empty = fixture();
empty.push(Buffer.alloc(0));
assert.deepEqual(empty.frames, []);
assert.deepEqual(empty.errors, []);
const owned = fixture();
const fragment = Buffer.from('{"ok":');
owned.push(fragment);
fragment.fill(32);
owned.push(Buffer.from('true}\n'));
assert.deepEqual(owned.frames, [{ ok: true }]);
const thrown = [];
let callbacks = 0;
const push = createFrameReader(
  () => {
    callbacks++;
    throw new Error('SECRET');
  },
  (error) => thrown.push(error)
);
push(Buffer.from('{}\n{}\n'));
assert.equal(callbacks, 1);
assert.equal(thrown.length, 1);
assert.equal(thrown[0].message.includes('SECRET'), false);
assert.throws(() => createFrameReader(null, () => {}), TypeError);
assert.throws(() => createFrameReader(() => {}, null), TypeError);
const many = fixture();
many.push(Buffer.from('{}\n'.repeat(1000)));
assert.equal(many.frames.length, 1000);
assert.equal(many.errors.length, 0);
process.stdout.write('workbuddy-wbipc-frame-reader.test.js passed\n');
