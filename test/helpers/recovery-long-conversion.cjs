'use strict';

const assert = require('node:assert/strict');

// Shared admission assertions for each production conversion family. Fixtures
// exceed the old aggregate limit while every individual message remains small.
function exerciseLongHistoryConversion({ kind, create, texts }) {
  const key = kind === 'responses' ? 'input' : 'messages';
  const history = Array.from({ length: 3 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: String(index) + '原文🙂'.repeat(90000),
  }));
  const metadata =
    kind === 'responses'
      ? { instructions: 'policy' }
      : kind === 'claude'
        ? { system: 'policy' }
        : {};
  const body = { model: 'model', ...metadata, [key]: history };
  const conversion = create(3);
  const original = JSON.stringify(body);
  assert.ok(Buffer.byteLength(original) > 2 * 1024 * 1024);
  assert.throws(() => create(2).encodeRequest(body));
  assert.deepEqual(
    texts(conversion.encodeRequest(body)),
    history.map((item) => item.content)
  );
  assert.equal(JSON.stringify(body), original);
  for (const invalid of [
    { ...body, [key]: [] },
    { ...body, [key]: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] },
    { ...body, model: 'x'.repeat(2 * 1024 * 1024) },
    { ...body, historyFormat: 3 },
    {
      ...body,
      [key]: Array.from({ length: 34 }, () => ({ role: 'user', content: 'x'.repeat(1024 * 1024) })),
    },
  ])
    assert.throws(() => conversion.encodeRequest(invalid));
  let touched = false;
  const hostile = { ...body };
  Object.defineProperty(hostile, key, {
    enumerable: true,
    get() {
      touched = true;
      throw Error('private-fixture');
    },
  });
  assert.throws(() => conversion.encodeRequest(hostile));
  assert.equal(touched, false);
  return { body, conversion };
}

module.exports = { exerciseLongHistoryConversion };
