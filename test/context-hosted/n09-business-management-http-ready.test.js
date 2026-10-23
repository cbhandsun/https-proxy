'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  waitForManagementHttp,
} = require('../../scripts/context-hosted/n09-business/management-http-ready.js');
const error = (suffix) =>
  Object.assign(new Error('PRIVATE'), { code: 'HPM_DAEMON_HTTP_' + suffix });
const refused = () => {
  throw error('CONNECTION_REFUSED');
};
const rejected = (phase) => ({ message: 'n09_management_http_not_ready', phase });
function fixture() {
  const f = { time: 0, sleeps: [] };
  f.dependencies = {
    now: () => f.time,
    sleep: async (ms) => {
      f.sleeps.push(ms);
      f.time += ms;
    },
  };
  return f;
}
test('management listen readiness accepts immediate response and refused connections before listen', async () => {
  for (const failures of [0, 2]) {
    const f = fixture();
    let reads = 0;
    const response = { status: 200, body: { ok: true } };
    assert.equal(
      await waitForManagementHttp(
        async () => {
          if (reads++ < failures) refused();
          return response;
        },
        15000,
        f.dependencies
      ),
      response
    );
    assert.equal(reads, failures + 1);
    assert.deepEqual(f.sleeps, Array(failures).fill(50));
  }
});
test('management listen readiness never retries other transport or HTTP application replies', async () => {
  for (const [suffix, phase] of [
    ['DEADLINE', 185],
    ['UNKNOWN', 186],
    ['CONNECTION_RESET', 192],
    ['ABORTED', 193],
    ['INVALID_REPLY', 194],
    ['REPLY_LIMIT', 195],
  ]) {
    const f = fixture();
    let reads = 0;
    await assert.rejects(
      waitForManagementHttp(
        async () => {
          reads++;
          throw error(suffix);
        },
        15000,
        f.dependencies
      ),
      rejected(phase)
    );
    assert.equal(reads, 1);
    assert.deepEqual(f.sleeps, []);
  }
  for (const status of [200, 400, 401, 503]) {
    const f = fixture();
    const response = { status, body: {} };
    assert.equal(
      await waitForManagementHttp(async () => response, 15000, f.dependencies),
      response
    );
    assert.deepEqual(f.sleeps, []);
  }
});

test('management readiness waits for the fixed credential initialization response only within the original deadline', async () => {
  const f = fixture();
  let reads = 0;
  const ready = { status: 200, body: { ok: true } };
  const pending = { status: 503, body: { error: 'Management initialization unavailable' } };
  assert.equal(
    await waitForManagementHttp(async () => (++reads < 3 ? pending : ready), 15000, f.dependencies),
    ready
  );
  assert.equal(reads, 3);
  assert.deepEqual(f.sleeps, [50, 50]);
  const expired = fixture();
  await assert.rejects(
    waitForManagementHttp(async () => pending, 125, expired.dependencies),
    rejected(189)
  );
  assert.deepEqual(expired.sleeps, [50, 50, 25]);
});

test('management initialization detection never retries other bodies or invokes getters and proxies', async () => {
  let traps = 0;
  // A top-level async result must allow the language's Promise then lookup.
  // Keep ownership/prototype traps armed; nested bodies also arm get traps.
  const opaqueProxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        traps++;
        throw new Error('PRIVATE');
      },
      ownKeys() {
        traps++;
        throw new Error('PRIVATE');
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error('PRIVATE');
      },
    }
  );
  const getter = Object.defineProperty({}, 'error', {
    get() {
      traps++;
      throw new Error('PRIVATE');
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error('PRIVATE');
      },
      ownKeys() {
        traps++;
        throw new Error('PRIVATE');
      },
    }
  );
  for (const response of [
    { status: 503, body: { error: 'other' } },
    { status: 401, body: { error: 'Management initialization unavailable' } },
    { status: 503, body: { error: 'Management initialization unavailable', extra: true } },
    { status: 503, body: getter },
    { status: 503, body: proxy },
    opaqueProxy,
    null,
  ]) {
    const f = fixture();
    let calls = 0;
    assert.equal(
      await waitForManagementHttp(
        async () => {
          calls++;
          return response;
        },
        15000,
        f.dependencies
      ),
      response
    );
    assert.equal(calls, 1);
    assert.deepEqual(f.sleeps, []);
  }
  assert.equal(traps, 0);
});
test('management listen readiness retains the original total deadline and bounded frozen-clock polls', async () => {
  const f = fixture();
  let reads = 0;
  await assert.rejects(
    waitForManagementHttp(
      async () => {
        reads++;
        refused();
      },
      125,
      f.dependencies
    ),
    rejected(189)
  );
  assert.equal(reads, 3);
  assert.deepEqual(f.sleeps, [50, 50, 25]);
  let frozenReads = 0;
  await assert.rejects(
    waitForManagementHttp(
      async () => {
        frozenReads++;
        refused();
      },
      15000,
      { now: () => 0, sleep: async () => {} }
    ),
    rejected(189)
  );
  assert.equal(frozenReads, 300);
});
test('management listen readiness rejects late replies, backward clocks, invalid deadlines and clock/sleep failures', async () => {
  for (const time of [15000, -1, NaN, Infinity]) {
    const f = fixture();
    await assert.rejects(
      waitForManagementHttp(
        async () => {
          f.time = time;
          return {};
        },
        15000,
        f.dependencies
      ),
      rejected(189)
    );
  }
  for (const deadline of [0, -1, NaN, Infinity, 15001, '15000', null]) {
    const f = fixture();
    let reads = 0;
    await assert.rejects(
      waitForManagementHttp(
        async () => {
          reads++;
        },
        deadline,
        f.dependencies
      ),
      rejected(189)
    );
    assert.equal(reads, 0);
  }
  const throws = () => {
    throw new Error('PRIVATE');
  };
  await assert.rejects(
    waitForManagementHttp(async () => ({}), 15000, { now: throws }),
    rejected(186)
  );
  await assert.rejects(
    waitForManagementHttp(refused, 15000, { now: () => 0, sleep: throws }),
    rejected(186)
  );
});
test('management listen readiness rejects invalid dependencies and hooks without invoking traps', async () => {
  let traps = 0;
  const proxy = new Proxy(() => {}, {
    get() {
      traps++;
      throw new Error('PRIVATE');
    },
  });
  for (const dependencies of [
    null,
    [],
    { extra: true },
    { now: null },
    { sleep: 1 },
    { now: proxy },
    {
      get now() {
        traps++;
        return () => 0;
      },
    },
  ]) {
    await assert.rejects(
      waitForManagementHttp(async () => ({}), 15000, dependencies),
      rejected(186)
    );
  }
  for (const read of [null, 1, {}, proxy])
    await assert.rejects(waitForManagementHttp(read, 15000), rejected(186));
  assert.equal(traps, 0);
});
