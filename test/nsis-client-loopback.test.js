'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  assertEntryRefuses,
  createSyntheticSourceServer,
} = require('../scripts/lib/nsis-client-loopback');
const original =
  'Synthetic original Unicode 中文🙂\r\nfixed\r\nREQUIRED_MARKER=HPM_PRIVATE_' + 'a'.repeat(32);
async function post(url, body = '{}') {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    request.on('error', reject);
    request.end(body);
  });
}
test('source HTTP performs exactly one observed call and rejects replay', async (t) => {
  let calls = 0;
  const server = await createSyntheticSourceServer(original, () => {
    calls++;
  });
  t.after(() => server.close());
  assert.equal(await post(server.url), original);
  assert.equal(calls, 1);
  assert.deepEqual(server.inspect(), { calls: 1, failed: false, closed: false });
  await assert.rejects(post(server.url));
  assert.equal(calls, 1);
  assert.equal(server.inspect().failed, true);
  assert.equal(await server.close(), true);
});
test('source empty/oversize/incorrect requests and observer failure fail without consuming source', async (t) => {
  for (const body of ['', '[]', '{', Buffer.from([0xfb, 0xfd]), 'x'.repeat(16384)]) {
    const server = await createSyntheticSourceServer(original, () => {});
    t.after(() => server.close());
    await assert.rejects(post(server.url, body));
    assert.equal(server.inspect().calls, 0);
    assert.equal(server.inspect().failed, true);
  }
  const server = await createSyntheticSourceServer(original, () => {
    throw Error('private');
  });
  t.after(() => server.close());
  await assert.rejects(post(server.url));
  assert.equal(server.inspect().calls, 0);
  for (const text of ['', null, 'x'.repeat(32001)])
    await assert.rejects(createSyntheticSourceServer(text, () => {}));
});
test('entry authentication checks both missing and wrong key without accepting successful or failed upstream replies', async (t) => {
  let status = 401,
    calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    req.resume();
    req.on('end', () => {
      res.writeHead(status);
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const owner = { identity: { entryPort: server.address().port } };
  for (const client of ['codex', 'claude']) {
    assert.equal(await assertEntryRefuses(owner, client, 'hpm-installed-' + client), true);
  }
  assert.equal(calls, 4);
  for (const value of [200, 400, 500]) {
    status = value;
    await assert.rejects(assertEntryRefuses(owner, 'codex', 'hpm-installed-codex'));
  }
  for (const port of [0, 65536, NaN])
    await assert.rejects(
      assertEntryRefuses({ identity: { entryPort: port } }, 'codex', 'hpm-installed-codex')
    );
});
