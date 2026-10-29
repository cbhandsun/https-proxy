'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  fail,
  n09AckFailureStage,
  wrapN09AckFailure,
  isN09AckFailureStage,
} = require('../../scripts/context-hosted/n09-ack/contract');
const { createN09MailboxControl } = require('../../scripts/context-hosted/n09-ack/mailbox-control');
const { createN09MailboxFiles } = require('../../scripts/context-hosted/n09-ack/mailbox-files');
const {
  createN09MailboxHost,
  createN09MailboxClient,
} = require('../../scripts/context-hosted/n09-ack/mailbox');
const {
  performN09DurableCommand,
} = require('../../scripts/context-hosted/n09-ack/durable-command');
const identity = { pid: 123, epoch: 'a'.repeat(32), signingKey: 'b'.repeat(64) };
const command = {
  pid: 123,
  operation: 'revoke',
  rootId: 'hbs_' + 'c'.repeat(32),
  expiresAt: 1000,
  minRevision: 2,
};
const rejectedAt = (stage) => (error) => {
  assert.equal(error.message, 'n09_host_ack_rejected');
  assert.equal(error.code, error.message);
  assert.equal(error.cause, undefined);
  assert.equal(n09AckFailureStage(error), stage);
  return true;
};

test('failure stages are finite local brands, never properties read from unknown errors', () => {
  let traps = 0;
  const trap = () => {
    traps++;
    throw Error('PRIVATE_SENTINEL');
  };
  const hostile = new Proxy(
    {},
    { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap }
  );
  const forged = Object.defineProperty({}, 'stage', { get: trap });
  for (const input of [null, undefined, 144, '144', hostile, forged, { stage: 144 }]) {
    assert.equal(n09AckFailureStage(input), undefined);
    rejectedAt(155)(wrapN09AckFailure(input, 155));
  }
  for (const stage of [139, 158, -1, NaN, Infinity, '144', 144.1]) {
    assert.equal(isN09AckFailureStage(stage), false);
    assert.equal(n09AckFailureStage(fail(stage)), undefined);
  }
  for (let stage = 140; stage <= 157; stage++) {
    const error = fail(stage);
    error.stage = 'PRIVATE_SENTINEL';
    rejectedAt(stage)(wrapN09AckFailure(error, 155));
  }
  assert.equal(traps, 0);
});

test('signed failure stages cannot be forged, added to armed controls, or supply executable fields', () => {
  const control = createN09MailboxControl(identity);
  const base = { version: 1, pid: 123, epoch: identity.epoch, sequence: 1, state: 'failed' };
  let traps = 0;
  try {
    for (let stage = 140; stage <= 157; stage++) {
      const signed = control.sign({ ...base, stage });
      assert.equal(control.verify(signed).stage, stage);
      assert.throws(() =>
        control.verify({
          ...signed,
          payload: { ...signed.payload, stage: stage === 144 ? 145 : 144 },
        })
      );
    }
    assert.deepEqual(control.verify(control.sign(base)), base);
    for (const stage of [undefined, null, 139, 158, NaN, Infinity, '144', 144.1])
      assert.throws(() => control.sign({ ...base, stage }));
    assert.throws(() => control.sign({ ...base, state: 'armed', stage: 144 }));
    assert.throws(() => control.sign({ ...base, stage: 144, extra: 'PRIVATE_SENTINEL' }));
    const hostile = Object.defineProperty({ ...base }, 'stage', {
      enumerable: true,
      get() {
        traps++;
        return 144;
      },
    });
    assert.throws(() => control.sign(hostile));
    assert.throws(() =>
      control.sign(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              traps++;
              return undefined;
            },
          }
        )
      )
    );
    assert.equal(traps, 0);
  } finally {
    control.close();
  }
});

test('original host rejection survives signed filesystem, client and durable command without becoming an ACK', async (t) => {
  for (const asynchronous of [false, true]) {
    const directory = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), 'n09-failure-stage-')
    );
    const config = { directory, ...identity };
    const client = createN09MailboxClient(config);
    const files = createN09MailboxFiles({ directory, pid: identity.pid });
    const host = createN09MailboxHost(config, {
      armSave() {
        throw Error('unexpected-save');
      },
      revokeBoundRoot() {
        const error = fail(144);
        error.private = 'PRIVATE_SENTINEL';
        if (asynchronous) return Promise.reject(error);
        throw error;
      },
      close() {},
    });
    t.after(() => {
      host.close();
      client.close();
      files.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    let submitted = 0,
      now = 0;
    const facade = {
      submit(value) {
        submitted++;
        client.submit({
          version: 1,
          pid: identity.pid,
          epoch: identity.epoch,
          sequence: 1,
          ...value,
        });
        if (asynchronous) assert.equal(host.step(), 'revoking');
        else assert.throws(() => host.step(), rejectedAt(144));
      },
      readArmed: () => client.readArmed(),
      readReceipt: () => client.readReceipt(),
      close: () => client.close(),
    };
    await assert.rejects(
      performN09DurableCommand(
        command,
        {
          client: facade,
          startSave() {
            assert.fail();
          },
        },
        {
          now: () => now,
          pause: () =>
            new Promise((resolve) =>
              setImmediate(() => {
                now += 10;
                resolve();
              })
            ),
        }
      ),
      rejectedAt(144)
    );
    assert.equal(submitted, 1);
    assert.equal(files.read('receipt', 1), null);
    assert.equal(files.read('failure', 1).payload.stage, 144);
    for (const name of fs.readdirSync(directory))
      assert.doesNotMatch(fs.readFileSync(path.join(directory, name), 'utf8'), /PRIVATE_SENTINEL/);
  }
});

test('fixed operation deadline has its own stage and does not resubmit or reset', async () => {
  let now = 0,
    submitted = 0,
    reads = 0;
  await assert.rejects(
    performN09DurableCommand(
      command,
      {
        client: {
          submit() {
            submitted++;
          },
          readArmed() {
            assert.fail();
          },
          readReceipt() {
            reads++;
            return null;
          },
          close() {},
        },
        startSave() {
          assert.fail();
        },
      },
      {
        now: () => now,
        pause: async () => {
          now += 5000;
        },
      }
    ),
    rejectedAt(153)
  );
  assert.equal(submitted, 1);
  assert.equal(reads, 3);
  assert.equal(now, 15000);
});
