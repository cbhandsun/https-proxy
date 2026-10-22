'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { validateSemanticHistory } = require(
  path.join(root, 'lib/proxy/responses-semantic-history')
);
const { MAX_INLINE_MEDIA_BYTES } = require(path.join(root, 'lib/proxy/multimodal-content'));
const history = (part) => [{ role: 'user', parts: [part] }];
const part = (kind = 'image', mime = 'image/png', data = 'AA==') => ({
  kind: 'media',
  mediaKind: kind,
  mediaType: mime,
  data,
});
const originalFrom = Buffer.from;
let decodes = 0;
try {
  Buffer.from = function (value, encoding, ...rest) {
    if (encoding === 'base64') decodes++;
    return originalFrom.call(this, value, encoding, ...rest);
  };
  const input = Object.freeze([
    Object.freeze({ role: 'user', parts: Object.freeze([Object.freeze(part())]) }),
  ]);
  assert.equal(validateSemanticHistory(input), input);
  assert.equal(decodes, 1, 'Semantic media validation must not decode the same payload twice');
} finally {
  Buffer.from = originalFrom;
}
for (const [kind, mime] of [
  ['image', 'png'],
  ['image', 'IMAGE/PNG'],
  ['audio', 'wav'],
  ['video', 'mp4'],
])
  for (const data of ['AA==', 'AA']) {
    const input = history(part(kind, mime, data));
    const snapshot = JSON.stringify(input);
    assert.equal(validateSemanticHistory(input), input);
    assert.equal(JSON.stringify(input), snapshot);
  }
const reject = (input) =>
  assert.throws(
    () => validateSemanticHistory(input),
    (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
  );
for (const mime of ['', null, 'audio/wav', 'image/SECRET;evil', 'SECRET', {}, []])
  reject(history(part('image', mime)));
for (const data of [
  '',
  null,
  undefined,
  0,
  true,
  {},
  [],
  'A',
  'AB',
  'AA===',
  'AA== ',
  'A!',
  'https://SECRET.invalid/image',
])
  reject(history({ ...part(), data }));
for (const kind of [null, 'document', 'SECRET', {}, []]) reject(history(part(kind)));
for (const input of [
  null,
  undefined,
  {},
  'SECRET',
  [{ role: 'invalid', parts: [part()] }],
  [{ role: 'user', parts: [null] }],
])
  reject(input);
reject(history({ ...part('image', 'image/png', 'SECRET!'), __hpmValidated: true }));
const result = [
  {
    role: 'user',
    parts: [{ kind: 'result', id: 'call_synthetic', error: false, parts: [part()] }],
  },
];
assert.equal(validateSemanticHistory(result), result);
result[0].parts[0].parts[0].data = 'SECRET!';
reject(result);
for (const bytes of [
  MAX_INLINE_MEDIA_BYTES - 1,
  MAX_INLINE_MEDIA_BYTES,
  MAX_INLINE_MEDIA_BYTES + 1,
]) {
  const input = history(part('image', 'image/png', Buffer.alloc(bytes).toString('base64')));
  if (bytes <= MAX_INLINE_MEDIA_BYTES) assert.equal(validateSemanticHistory(input), input);
  else reject(input);
}
const hostile = part();
Object.defineProperty(hostile, 'data', {
  get() {
    throw new Error('Getter failed');
  },
});
assert.throws(() => validateSemanticHistory(history(hostile)), /Getter failed/);
