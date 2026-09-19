'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { setUtf8StreamEncoding } = require('../lib/proxy/utf8-stream');

assert.equal(setUtf8StreamEncoding(null), false);
assert.equal(setUtf8StreamEncoding({}), false);

const stream = new PassThrough();
assert.equal(setUtf8StreamEncoding(stream), true);
const chunks = [];
stream.on('data', (chunk) => chunks.push(chunk));
const bytes = Buffer.from('data: {"text":"中文🙂"}\n\n', 'utf8');
for (const byte of bytes) stream.write(Buffer.from([byte]));
stream.end();
stream.on('end', () => {
  assert.equal(chunks.join(''), 'data: {"text":"中文🙂"}\n\n');
  assert.equal(chunks.join('').includes('�'), false);
  console.log('[utf8-stream.test] ok');
});
