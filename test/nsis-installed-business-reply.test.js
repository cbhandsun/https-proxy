'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeInstalledBusinessReply } = require('../scripts/lib/nsis-installed-business-reply');

function fixture(afterPrefix, prefixBytes = 3) {
  const current = { afterPrefix, prefixBytes };
  const active = { current };
  const writes = [];
  const response = {
    destroyed: false,
    writeHead(status, headers) {
      assert.equal(status, 200);
      assert.equal(headers['content-type'], 'text/event-stream; charset=utf-8');
    },
    write(bytes) {
      writes.push(bytes.toString());
    },
    end(bytes) {
      writes.push(bytes.toString());
    },
  };
  const reply = {
    stream: true,
    wire: Buffer.from('prefix-suffix'),
    contentType: 'text/event-stream; charset=utf-8',
  };
  return {
    active,
    current,
    response,
    reply,
    writes,
    run: () => writeInstalledBusinessReply(active, current, response, reply),
  };
}

test('SSE fixture writes only a bounded prefix until the native hold resolves true', async () => {
  let release;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    7
  );
  const pending = f.run();
  assert.deepEqual(f.writes, ['prefix-']);
  release(true);
  await pending;
  assert.deepEqual(f.writes, ['prefix-', 'suffix']);
});

test('invalid prefix extents are rejected before any streaming bytes', async () => {
  for (const prefix of [-1, 0, NaN, Infinity, 1.5, '1', 13, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(async () => true, prefix);
    await assert.rejects(f.run(), /^Error: installed_client_matrix_failed$/);
    assert.deepEqual(f.writes, []);
  }
});

test('SSE fixture cannot release a suffix after failed or hostile hold, destroyed response or owner change', async () => {
  let traps = 0;
  const hostile = Object.defineProperty({}, 'then', {
    get() {
      traps++;
      throw new Error('PRIVATE');
    },
  });
  for (const callback of [
    () => false,
    () => null,
    () => hostile,
    () => Promise.reject(new Error('PRIVATE')),
    new Proxy(() => {
      traps++;
    }, {}),
  ]) {
    const f = fixture(callback);
    await assert.rejects(f.run(), /^Error: installed_client_matrix_failed$/);
    assert.ok(f.writes.length <= 1);
    assert.equal(f.writes.includes('fix-suffix'), false);
  }
  assert.equal(traps, 0);
  for (const change of ['owner', 'destroyed']) {
    const f = fixture(async () => {
      if (change === 'owner') f.active.current = null;
      else f.response.destroyed = true;
      return true;
    });
    await assert.rejects(f.run(), /^Error: installed_client_matrix_failed$/);
    assert.deepEqual(f.writes, ['pre']);
  }
});
