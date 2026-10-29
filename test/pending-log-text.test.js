'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPendingLogText } = require('./helpers/pending-log-text.cjs');

test('an asynchronous log may be absent before its first append, then yields exactly its persisted text', (t) => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'hpm-pending-log-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.equal(fs.realpathSync.native(root), root);
    fs.rmSync(root, { recursive: true });
  });
  const file = path.join(root, 'events.jsonl');
  assert.equal(readPendingLogText(file), '');
  const text = '{"kind":"request_end","statusCode":200}\n';
  fs.appendFileSync(file, text, 'utf8');
  assert.equal(readPendingLogText(file), text);
  fs.writeFileSync(file, '', 'utf8');
  assert.equal(readPendingLogText(file), '');
  fs.writeFileSync(file, 'malformed complete JSON\n', 'utf8');
  assert.throws(() => JSON.parse(readPendingLogText(file)), SyntaxError);
});

test('permission, I/O, malformed arguments and executable exceptions cannot become empty pending logs', (t) => {
  let failure;
  let touched = 0;
  t.mock.method(fs, 'readFileSync', () => {
    throw failure;
  });
  const cases = ['EACCES', 'EIO', 'EISDIR', 'ERR_INVALID_ARG_TYPE'].map((code) =>
    Object.assign(Error('PRIVATE_READ_ERROR'), { code })
  );
  cases.push(Object.create({ code: 'ENOENT' }));
  cases.push(
    Object.defineProperty(Error('PRIVATE'), 'code', {
      get() {
        touched++;
        return 'ENOENT';
      },
    })
  );
  cases.push(
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          touched++;
          throw Error('PRIVATE');
        },
      }
    )
  );
  cases.push(null, undefined, 1, 'PRIVATE');
  for (const value of cases) {
    failure = value;
    assert.throws(
      () => readPendingLogText('owned-fixture'),
      (error) => error === failure
    );
  }
  assert.equal(touched, 0);
});
