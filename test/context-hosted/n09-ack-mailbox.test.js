'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createN09AckContract } = require('../../scripts/context-hosted/n09-ack/contract');
const { createN09MailboxControl } = require('../../scripts/context-hosted/n09-ack/mailbox-control');
const { createN09MailboxFiles } = require('../../scripts/context-hosted/n09-ack/mailbox-files');
const {
  createN09MailboxHost,
  createN09MailboxClient,
} = require('../../scripts/context-hosted/n09-ack/mailbox');
const config = { pid: 123, epoch: 'a'.repeat(32), signingKey: 'b'.repeat(64) };
const command = (extra = {}) => ({
  version: 1,
  operation: 'arm-save',
  pid: config.pid,
  epoch: config.epoch,
  sequence: 1,
  rootId: 'hbs_' + 'c'.repeat(32),
  expiresAt: 1000,
  minRevision: 1,
  ...extra,
});
const receipt = (extra = {}) => ({
  version: 1,
  kind: 'host-save-completed',
  durableBoundary: 'await-reference-save',
  pid: config.pid,
  epoch: config.epoch,
  sequence: 1,
  rootId: command().rootId,
  expiresAt: 1000,
  revision: 2,
  calls: 1,
  returnedBytes: 12,
  revisionSource: 'validated-reference-save',
  evidenceLevel: 'observer-boundary-only',
  liveDaemonProved: false,
  ...extra,
});
const safe = (error) => error.message === 'n09_host_ack_rejected' && error.cause === undefined;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('invalid base promise rejections are consumed while signed failure remains authoritative', async (t) => {
  const f = fixture(t);
  const pending = Promise.reject(new Error('private-rejection-sentinel'));
  Object.defineProperty(pending, 'extra', { value: true });
  const pair = hooks(t, f, { armSave: () => pending });
  pair.client.submit(command());
  assert.throws(() => pair.host.step(), safe);
  await settle();
  assert.throws(() => pair.client.readReceipt(), safe);
});

test('host rejects async close before execution and remembers unexpected promise close failure', async (t) => {
  const f = fixture(t);
  let called = 0;
  const supplied = {
    armSave: () => Promise.resolve(),
    revokeBoundRoot: () => Promise.resolve(),
    async close() {
      called++;
      throw new Error('private-close-sentinel');
    },
  };
  assert.throws(() => createN09MailboxHost(f.options, supplied), safe);
  assert.equal(called, 0);
  const host = createN09MailboxHost(f.options, {
    ...supplied,
    close: () => Promise.reject(new Error('private-close-sentinel')),
  });
  assert.throws(() => host.close(), safe);
  await settle();
  assert.throws(() => host.close(), safe);
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'n09-mailbox-'));
  const options = { directory, ...config };
  const contract = createN09AckContract(config),
    control = createN09MailboxControl(config);
  const files = createN09MailboxFiles({ directory, pid: config.pid });
  t.after(() => {
    files.close();
    contract.close();
    control.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, options, contract, control, files };
}
function hooks(t, f, extra = {}) {
  let resolve,
    reject,
    closed = 0;
  const calls = [];
  const supplied = {
    armSave(value) {
      calls.push(value);
      return new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
    async revokeBoundRoot(value) {
      calls.push(value);
      return receipt({
        kind: 'host-revoke-completed',
        durableBoundary: 'await-revokeAsync',
        sequence: value.sequence,
        revision: value.minRevision,
      });
    },
    close() {
      closed++;
    },
    ...extra,
  };
  const host = createN09MailboxHost(f.options, supplied),
    client = createN09MailboxClient(f.options);
  t.after(() => {
    host.close();
    client.close();
  });
  return {
    host,
    client,
    calls,
    finish: (value) => resolve(value),
    fail: () => reject(new Error('private failure')),
    closed: () => closed,
  };
}

test('armed control has a separate signature domain and cannot become a durable ACK', (t) => {
  const f = fixture(t);
  const value = { version: 1, pid: config.pid, epoch: config.epoch, sequence: 1, state: 'armed' };
  const signed = f.control.sign(value);
  assert.deepEqual(f.control.verify(signed), value);
  assert.throws(() => f.contract.verifyReceipt(signed), safe);
  assert.throws(() => f.control.verify(f.contract.signReceipt(receipt())), safe);
  for (const extra of [
    { pid: 124 },
    { epoch: 'c'.repeat(32) },
    { sequence: 0 },
    { sequence: 17 },
    { state: 'host-save-completed' },
    { version: 2 },
  ])
    assert.throws(() => f.control.sign({ ...value, ...extra }), safe);
  assert.throws(() => f.control.verify({ ...signed, signature: '0'.repeat(64) }), safe);
  f.control.close();
  assert.throws(() => f.control.verify(signed), safe);
});

test('fixed filesystem mailbox waits for flushed payload publication and preserves collisions', (t) => {
  const f = fixture(t),
    file = path.join(f.directory, 'command-123-1.json');
  assert.equal(f.files.read('command', 1), null);
  fs.writeFileSync(file, '{');
  assert.equal(f.files.read('command', 1), null);
  assert.throws(() => f.files.write('command', 1, f.contract.signCommand(command())), safe);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
  fs.unlinkSync(file);
  f.files.write('command', 1, f.contract.signCommand(command()));
  assert.deepEqual(f.contract.verifyCommand(f.files.read('command', 1)), command());
  assert.throws(() => f.files.write('command', 1, f.contract.signCommand(command())), safe);
  for (const [kind, sequence] of [
    ['../escape', 1],
    ['command', 0],
    ['command', 17],
    ['command', Number.MAX_SAFE_INTEGER + 1],
  ])
    assert.throws(() => f.files.read(kind, sequence), safe);
  f.files.close();
  assert.throws(() => f.files.read('command', 1), safe);
});

test('filesystem rejects accessors before evaluation, wrong identity and malformed published bytes', (t) => {
  const f = fixture(t);
  let traps = 0;
  const hostile = Object.defineProperty({}, 'payload', {
    enumerable: true,
    get() {
      traps++;
      return {};
    },
  });
  assert.throws(() => f.files.write('command', 1, hostile), safe);
  assert.throws(
    () =>
      f.files.write(
        'command',
        1,
        new Proxy(
          {},
          {
            ownKeys() {
              traps++;
              return [];
            },
          }
        )
      ),
    safe
  );
  assert.equal(traps, 0);
  assert.throws(
    () => f.files.write('command', 1, f.contract.signCommand(command({ sequence: 2 }))),
    safe
  );
  const file = path.join(f.directory, 'command-123-1.json');
  for (const bytes of [
    Buffer.from('{'),
    Buffer.from([0xff]),
    Buffer.alloc(4097),
    Buffer.from('{"x":1,"x":2}'),
  ]) {
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(file + '.ready', '');
    assert.throws(() => f.files.read('command', 1), safe);
  }
  fs.unlinkSync(file);
  assert.throws(() => f.files.read('command', 1), safe);
});

test('filesystem refuses hardlinked payload/marker and directory replacement', (t) => {
  const f = fixture(t);
  f.files.write('command', 1, f.contract.signCommand(command()));
  const file = path.join(f.directory, 'command-123-1.json'),
    alias = path.join(f.directory, 'alias');
  for (const target of [file, file + '.ready']) {
    fs.linkSync(target, alias);
    assert.throws(() => f.files.read('command', 1), safe);
    fs.unlinkSync(alias);
  }
  const moved = f.directory + '-moved';
  fs.renameSync(f.directory, moved);
  try {
    fs.mkdirSync(f.directory);
    assert.throws(() => f.files.read('command', 1), safe);
    assert.throws(
      () => f.files.write('command', 2, f.contract.signCommand(command({ sequence: 2 }))),
      safe
    );
  } finally {
    fs.rmdirSync(f.directory);
    fs.renameSync(moved, f.directory);
  }
});

test('save requires armed and later signed real hook completion; revoke remains a separate boundary', async (t) => {
  const f = fixture(t),
    h = hooks(t, f);
  assert.equal(h.host.step(), 'idle');
  h.client.submit(command());
  assert.equal(h.client.readArmed(), false);
  assert.equal(h.client.readReceipt(), null);
  assert.equal(h.host.step(), 'armed');
  assert.equal(h.host.step(), 'pending');
  assert.equal(h.client.readArmed(), true);
  assert.equal(h.client.readReceipt(), null);
  assert.throws(() => h.client.submit(command({ sequence: 2 })), safe);
  h.finish(receipt());
  await settle();
  assert.deepEqual(h.client.readReceipt(), receipt());
  assert.throws(() => h.client.readReceipt(), safe);
  h.client.submit(command({ operation: 'revoke-bound-root', sequence: 2, minRevision: 2 }));
  assert.throws(() => h.client.readArmed(), safe);
  assert.equal(h.host.step(), 'revoking');
  await settle();
  assert.equal(h.client.readReceipt().kind, 'host-revoke-completed');
  assert.equal(h.calls.length, 2);
  assert.equal(h.host.step(), 'idle');
});

for (const invalid of [
  { sequence: 2 },
  { rootId: 'hbs_' + 'd'.repeat(32) },
  { revision: 1 },
  { epoch: 'd'.repeat(32) },
  { liveDaemonProved: true },
])
  test(
    'invalid hook completion cannot publish a receipt: ' + Object.keys(invalid)[0],
    async (t) => {
      const f = fixture(t),
        h = hooks(t, f);
      h.client.submit(command());
      h.host.step();
      h.finish(receipt(invalid));
      await settle();
      assert.throws(() => h.client.readReceipt(), safe);
      assert.equal(f.files.read('receipt', 1), null);
      assert.equal(f.control.verify(f.files.read('failure', 1)).state, 'failed');
      assert.throws(() => h.host.step(), safe);
    }
  );

test('rejection, cancellation and late completion cannot publish success or leak exceptions', async (t) => {
  const f = fixture(t),
    h = hooks(t, f);
  h.client.submit(command());
  h.host.step();
  h.fail();
  await settle();
  assert.throws(() => h.client.readReceipt(), safe);
  const data = fs
    .readdirSync(f.directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => fs.readFileSync(path.join(f.directory, name), 'utf8'))
    .join('');
  assert.equal(data.includes('private failure'), false);
  const late = fixture(t),
    other = hooks(t, late);
  other.client.submit(command());
  other.host.step();
  other.host.close();
  other.finish(receipt());
  await settle();
  assert.equal(late.files.read('receipt', 1), null);
  assert.equal(other.closed(), 1);
  other.host.close();
});

test('unknown then getters and Promise species never execute; failed close remains failed', (t) => {
  const f = fixture(t);
  let traps = 0;
  const h = hooks(t, f, {
    armSave() {
      return Object.defineProperty({}, 'then', {
        get() {
          traps++;
          return undefined;
        },
      });
    },
  });
  h.client.submit(command());
  assert.throws(() => h.host.step(), safe);
  assert.equal(traps, 0);
  const second = fixture(t);
  class Hostile extends Promise {
    static get [Symbol.species]() {
      traps++;
      return Promise;
    }
  }
  const other = hooks(t, second, {
    armSave() {
      return new Hostile(() => {});
    },
  });
  other.client.submit(command());
  assert.throws(() => other.host.step(), safe);
  assert.equal(traps, 0);
  const third = fixture(t);
  const failed = createN09MailboxHost(third.options, {
    armSave() {},
    revokeBoundRoot() {},
    close() {
      throw new Error('private close');
    },
  });
  assert.throws(() => failed.close(), safe);
  assert.throws(() => failed.close(), safe);
});
