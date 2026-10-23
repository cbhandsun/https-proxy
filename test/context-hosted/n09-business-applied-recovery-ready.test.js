'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  waitForAppliedRecovery,
} = require('../../scripts/context-hosted/n09-business/applied-recovery-ready');
const ready = () => ({
  status: 200,
  body: {
    pid: 101,
    contextRecovery: {
      configValid: true,
      requestedEnabled: true,
      state: 'enabled_restricted',
      appliedEnabled: true,
      storage: 'persistent',
    },
  },
});
const pending = () => ({
  status: 200,
  body: {
    pid: 101,
    contextRecovery: {
      appliedEnabled: false,
      storage: 'persistent',
      configValid: true,
      requestedEnabled: true,
      state: 'pending_application',
    },
  },
});
function fixture() {
  let time = 0;
  return {
    dependencies: {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
    setTime(value) {
      time = value;
    },
  };
}
const phase = (expected) => (error) => {
  assert.equal(error.message, 'n09_applied_recovery_not_ready');
  assert.equal(error.phase, expected);
  assert.equal(error.cause, undefined);
  return true;
};
test('applied recovery accepts ready and waits only for explicit pending application with live ownership', async () => {
  const f = fixture();
  let reads = 0,
    alive = 0;
  assert.equal(
    await waitForAppliedRecovery(
      async () => (++reads < 3 ? pending() : ready()),
      async () => {
        alive++;
        return true;
      },
      101,
      15000,
      f.dependencies
    ),
    true
  );
  assert.equal(reads, 3);
  assert.equal(alive, 2);
});
test('applied recovery rejects disabled, failed, malformed, wrong owner and HTTP errors immediately', async () => {
  for (const [change, expected] of [
    [
      (r) => {
        r.status = 503;
      },
      170,
    ],
    [
      (r) => {
        r.body = null;
      },
      188,
    ],
    [
      (r) => {
        r.body.pid = 999;
      },
      190,
    ],
    [
      (r) => {
        r.body.contextRecovery.state = 'unavailable';
      },
      190,
    ],
    [
      (r) => {
        r.body.contextRecovery.state = 'disabled';
      },
      190,
    ],
    [
      (r) => {
        r.body.contextRecovery.configValid = false;
      },
      190,
    ],
    [
      (r) => {
        r.body.contextRecovery.requestedEnabled = false;
      },
      190,
    ],
    [
      (r) => {
        r.body.contextRecovery.storage = 'unavailable';
      },
      190,
    ],
  ]) {
    let reads = 0;
    const response = pending();
    change(response);
    await assert.rejects(
      waitForAppliedRecovery(
        async () => {
          reads++;
          return response;
        },
        async () => {
          assert.fail('no ownership poll for terminal response');
        },
        101,
        15000,
        fixture().dependencies
      ),
      phase(expected)
    );
    assert.equal(reads, 1);
  }
});
test('applied recovery retains the total deadline and rejects frozen, backward or failed clocks', async () => {
  const f = fixture();
  await assert.rejects(
    waitForAppliedRecovery(
      async () => pending(),
      async () => true,
      101,
      15000,
      f.dependencies
    ),
    phase(189)
  );
  let reads = 0;
  await assert.rejects(
    waitForAppliedRecovery(
      async () => {
        reads++;
        return pending();
      },
      async () => true,
      101,
      15000,
      { now: () => 0, sleep: async () => {} }
    ),
    phase(189)
  );
  assert.equal(reads, 150);
  for (const value of [-1, NaN, Infinity, 15000]) {
    const clock = fixture();
    await assert.rejects(
      waitForAppliedRecovery(
        async () => {
          clock.setTime(value);
          return ready();
        },
        async () => true,
        101,
        15000,
        clock.dependencies
      ),
      phase(189)
    );
  }
  await assert.rejects(
    waitForAppliedRecovery(
      async () => ready(),
      async () => true,
      101,
      15000,
      {
        now() {
          throw new Error('PRIVATE');
        },
      }
    ),
    phase(189)
  );
});
test('applied recovery sanitizes transport, ownership and sleep failures without retrying requests', async () => {
  for (const [read, alive, sleep, expected] of [
    [
      async () => {
        throw Object.assign(new Error('PRIVATE'), { code: 'HPM_DAEMON_HTTP_CONNECTION_REFUSED' });
      },
      async () => true,
      async () => {},
      191,
    ],
    [async () => pending(), async () => false, async () => {}, 190],
    [
      async () => pending(),
      async () => {
        throw new Error('PRIVATE');
      },
      async () => {},
      190,
    ],
    [
      async () => pending(),
      async () => true,
      async () => {
        throw new Error('PRIVATE');
      },
      189,
    ],
  ])
    await assert.rejects(
      waitForAppliedRecovery(read, alive, 101, 15000, { now: () => 0, sleep }),
      phase(expected)
    );
});
test('applied recovery rejects invalid arguments and executable inputs without evaluating traps', async () => {
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        traps++;
        throw new Error('PRIVATE');
      },
    }
  );
  for (const [response, expected] of [
    [null, 188],
    [{}, 173],
    [[], 188],
    [proxy, 188],
    [
      {
        status: 200,
        body: {
          get contextRecovery() {
            traps++;
            throw new Error('PRIVATE');
          },
        },
      },
      188,
    ],
  ])
    await assert.rejects(
      waitForAppliedRecovery(
        async () => response,
        async () => true,
        101,
        15000,
        fixture().dependencies
      ),
      phase(expected)
    );
  for (const deps of [
    null,
    [],
    { extra: () => {} },
    { now: null },
    {
      get now() {
        traps++;
        throw new Error('PRIVATE');
      },
    },
  ])
    await assert.rejects(
      waitForAppliedRecovery(
        async () => ready(),
        async () => true,
        101,
        15000,
        deps
      ),
      phase(188)
    );
  for (const pid of [0, -1, '101', NaN, Infinity])
    await assert.rejects(
      waitForAppliedRecovery(
        async () => ready(),
        async () => true,
        pid,
        15000,
        fixture().dependencies
      ),
      phase(188)
    );
  assert.equal(traps, 0);
});

test('applied combination requires matching config, terminal state and enabled storage mode', async () => {
  for (const enabled of [false, true])
    for (const persistent of [false, true]) {
      const f = fixture();
      const response = ready();
      Object.assign(response.body.contextRecovery, {
        requestedEnabled: enabled,
        appliedEnabled: enabled,
        state: enabled ? 'enabled_restricted' : 'disabled',
        storage: enabled && persistent ? 'persistent' : 'memory',
      });
      assert.equal(
        await waitForAppliedRecovery(
          async () => response,
          async () => true,
          101,
          15000,
          f.dependencies,
          { enabled, persistent }
        ),
        true
      );
      for (const change of [
        { state: 'unavailable' },
        { configValid: false },
        { requestedEnabled: !enabled },
        ...(enabled ? [{ storage: persistent ? 'memory' : 'persistent' }] : []),
      ]) {
        const bad = JSON.parse(JSON.stringify(response));
        Object.assign(bad.body.contextRecovery, change);
        await assert.rejects(
          waitForAppliedRecovery(
            async () => bad,
            async () => true,
            101,
            15000,
            fixture().dependencies,
            { enabled, persistent }
          ),
          phase(190)
        );
      }
    }
  let traps = 0;
  const getter = Object.defineProperty({}, 'enabled', {
    enumerable: true,
    get() {
      traps++;
      return true;
    },
  });
  for (const expected of [
    null,
    {},
    getter,
    { enabled: true, persistent: 'yes' },
    { enabled: true, persistent: true, extra: true },
  ])
    await assert.rejects(
      waitForAppliedRecovery(
        async () => ready(),
        async () => true,
        101,
        15000,
        fixture().dependencies,
        expected
      ),
      phase(188)
    );
  assert.equal(traps, 0);
});
