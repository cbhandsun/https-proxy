'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createN09BootstrapContract,
} = require('../../scripts/context-hosted/n09-ack/bootstrap-contract');
const { createN09HostAckClient } = require('../../scripts/context-hosted/n09-ack/bootstrap-client');
const { createN09MailboxFiles } = require('../../scripts/context-hosted/n09-ack/mailbox-files');
const {
  createN09AckContract,
  n09AckFailureStage,
} = require('../../scripts/context-hosted/n09-ack/contract');
const { createN09MailboxControl } = require('../../scripts/context-hosted/n09-ack/mailbox-control');
const config = { token: 'synthetic_'.repeat(4), pid: 123, manifestSha256: 'a'.repeat(64) };
const precondition = (operation = 'arm-save') => ({
  operation,
  rootId: 'hbs_' + 'c'.repeat(32),
  expiresAt: 1000,
  minRevision: 1,
});
function safe(error) {
  assert.equal(error.message, 'n09_host_ack_rejected');
  assert.equal(error.code, error.message);
  assert.equal(error.cause, undefined);
  return true;
}
function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'n09-bootstrap-client-')
  );
  const runtimeDir = path.join(root, 'runtime');
  const directory = path.join(root, 'n09-ack');
  fs.mkdirSync(runtimeDir);
  fs.mkdirSync(directory);
  const bootstrap = createN09BootstrapContract(config);
  const payload = {
    version: 1,
    pid: config.pid,
    epoch: 'b'.repeat(32),
    manifestSha256: config.manifestSha256,
    sourcePins: { 'scripts/context-hosted/n09-ack/host-install.js': 'd'.repeat(64) },
  };
  const file = path.join(directory, 'bootstrap-' + config.pid + '.json');
  const wire = JSON.stringify(bootstrap.sign(payload));
  fs.writeFileSync(file, wire);
  const options = { runtimeDir, ...config };
  const signingKey = bootstrap.mailboxKey(payload);
  bootstrap.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, runtimeDir, directory, file, wire, options, payload, signingKey };
}

test('bootstrap client signs fixed commands with bound epoch and advancing sequence', (t) => {
  const f = fixture(t);
  const client = createN09HostAckClient(f.options);
  const options = {
    directory: f.directory,
    pid: config.pid,
    epoch: f.payload.epoch,
    signingKey: f.signingKey,
  };
  const files = createN09MailboxFiles({ directory: f.directory, pid: config.pid });
  const contract = createN09AckContract({
    pid: options.pid,
    epoch: options.epoch,
    signingKey: options.signingKey,
  });
  const control = createN09MailboxControl({
    pid: options.pid,
    epoch: options.epoch,
    signingKey: options.signingKey,
  });
  t.after(() => {
    client.close();
    files.close();
    contract.close();
    control.close();
  });
  assert.ok(Object.isFrozen(client));
  for (const [index, operation] of ['arm-save', 'revoke-bound-root'].entries()) {
    client.submit(precondition(operation));
    const command = contract.verifyCommand(files.read('command', index + 1));
    assert.equal(command.sequence, index + 1);
    assert.equal(command.epoch, f.payload.epoch);
    assert.equal(command.pid, config.pid);
    assert.equal(client.readReceipt(), null);
    if (index === 0) {
      assert.equal(client.readArmed(), false);
      files.write(
        'control',
        1,
        control.sign({
          version: 1,
          pid: config.pid,
          epoch: f.payload.epoch,
          sequence: 1,
          state: 'armed',
        })
      );
      assert.equal(client.readArmed(), true);
    }
    const receipt = {
      version: 1,
      kind: index ? 'host-revoke-completed' : 'host-save-completed',
      durableBoundary: index ? 'await-revokeAsync' : 'await-reference-save',
      pid: config.pid,
      epoch: f.payload.epoch,
      sequence: index + 1,
      rootId: command.rootId,
      expiresAt: command.expiresAt,
      revision: index ? 1 : 2,
      calls: 1,
      returnedBytes: 0,
      revisionSource: 'validated-reference-save',
      evidenceLevel: 'observer-boundary-only',
      liveDaemonProved: false,
    };
    files.write('receipt', index + 1, contract.signReceipt(receipt));
    assert.deepEqual(client.readReceipt(), receipt);
  }
  client.close();
  client.close();
  for (const operation of [
    () => client.submit(precondition()),
    () => client.readArmed(),
    () => client.readReceipt(),
  ])
    assert.throws(operation, safe);
});

test('bootstrap client rejects wrong identities and malformed bounded file input', (t) => {
  const f = fixture(t);
  for (const change of [
    { pid: 124 },
    { token: 'wrong_'.repeat(8) },
    { manifestSha256: 'f'.repeat(64) },
  ]) {
    assert.throws(() => createN09HostAckClient({ ...f.options, ...change }), safe);
  }
  for (const bytes of [
    Buffer.from('{'),
    Buffer.from(f.wire + '\n'),
    Buffer.from(' '.repeat(131073)),
    Buffer.from([0xff]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(f.wire)]),
    Buffer.alloc(0),
    Buffer.from(f.wire.replace('"version":1', '"version":2')),
  ]) {
    fs.writeFileSync(f.file, bytes);
    assert.throws(() => createN09HostAckClient(f.options), safe);
  }
  fs.unlinkSync(f.file);
  assert.throws(() => createN09HostAckClient(f.options), safe);
  fs.writeFileSync(f.file, f.wire);
  const link = path.join(f.root, 'bootstrap-hardlink.json');
  fs.linkSync(f.file, link);
  assert.throws(() => createN09HostAckClient(f.options), safe);
  fs.unlinkSync(link);
  const client = createN09HostAckClient(f.options);
  client.close();
});

test('bootstrap client preserves only a verified signed failure stage through its physical-file checks', (t) => {
  const f = fixture(t);
  const client = createN09HostAckClient(f.options);
  const files = createN09MailboxFiles({ directory: f.directory, pid: config.pid });
  const control = createN09MailboxControl({
    pid: config.pid,
    epoch: f.payload.epoch,
    signingKey: f.signingKey,
  });
  t.after(() => {
    client.close();
    files.close();
    control.close();
  });
  client.submit(precondition('revoke-bound-root'));
  files.write(
    'failure',
    1,
    control.sign({
      version: 1,
      pid: config.pid,
      epoch: f.payload.epoch,
      sequence: 1,
      state: 'failed',
      stage: 144,
    })
  );
  assert.throws(
    () => client.readReceipt(),
    (error) => {
      safe(error);
      assert.equal(n09AckFailureStage(error), 144);
      return true;
    }
  );
  const file = path.join(f.directory, 'failure-' + config.pid + '-1.json');
  const forged = JSON.parse(fs.readFileSync(file, 'utf8'));
  forged.payload.stage = 145;
  fs.writeFileSync(file, JSON.stringify(forged));
  assert.throws(
    () => client.readReceipt(),
    (error) => {
      safe(error);
      assert.notEqual(n09AckFailureStage(error), 145);
      return true;
    }
  );
});

test('bootstrap client validates physical runtime and mailbox ancestors', (t) => {
  const f = fixture(t);
  for (const runtimeDir of [
    'runtime',
    '//server/runtime',
    f.root,
    path.join(f.root, 'missing', 'runtime'),
    f.runtimeDir + '\n',
    f.root + path.sep + '..' + path.sep + path.basename(f.root) + path.sep + 'runtime',
  ]) {
    assert.throws(() => createN09HostAckClient({ ...f.options, runtimeDir }), safe);
  }
  const original = path.join(f.root, 'runtime-original');
  fs.renameSync(f.runtimeDir, original);
  fs.symlinkSync(original, f.runtimeDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createN09HostAckClient(f.options), safe);
  if (process.platform === 'win32') fs.rmdirSync(f.runtimeDir);
  else fs.unlinkSync(f.runtimeDir);
  fs.renameSync(original, f.runtimeDir);
  const client = createN09HostAckClient(f.options);
  fs.renameSync(f.runtimeDir, original);
  fs.mkdirSync(f.runtimeDir);
  assert.throws(() => client.submit(precondition()), safe);
  assert.throws(() => client.readReceipt(), safe);
  client.close();
});

test('bootstrap client rejects hostile configuration and preconditions without invoking code', (t) => {
  const f = fixture(t);
  let calls = 0;
  const hostile = () => {
    calls++;
    throw new Error('private sentinel');
  };
  const proxy = new Proxy({}, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile });
  assert.throws(() => createN09HostAckClient(proxy), safe);
  for (const key of Object.keys(f.options)) {
    const options = { ...f.options };
    Object.defineProperty(options, key, { enumerable: true, get: hostile });
    assert.throws(() => createN09HostAckClient(options), safe);
  }
  const client = createN09HostAckClient(f.options);
  for (const value of [
    proxy,
    null,
    {},
    { ...precondition(), selector: 'other' },
    { ...precondition(), operation: 'other' },
    { ...precondition(), rootId: '../other' },
    { ...precondition(), expiresAt: 0 },
    { ...precondition(), minRevision: NaN },
  ]) {
    assert.throws(() => client.submit(value), safe);
  }
  for (const key of Object.keys(precondition())) {
    const value = precondition();
    Object.defineProperty(value, key, { enumerable: true, get: hostile });
    assert.throws(() => client.submit(value), safe);
  }
  assert.equal(calls, 0);
  client.submit(precondition());
  assert.ok(fs.existsSync(path.join(f.directory, 'command-' + config.pid + '-1.json')));
  assert.throws(() => client.submit(precondition()), safe);
  client.close();
});
