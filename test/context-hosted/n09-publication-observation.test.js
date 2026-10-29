'use strict';
// Physical signed-query transport tests; no live daemon or model qualification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {
  createN09BootstrapContract,
} = require('../../scripts/context-hosted/n09-ack/bootstrap-contract');
const {
  createPublicationObservationContract,
} = require('../../scripts/context-hosted/n09-business/publication-observation-contract');
const {
  createPublicationObservationHost,
} = require('../../scripts/context-hosted/n09-business/publication-observation-host');
const {
  createPublicationObservationClient,
} = require('../../scripts/context-hosted/n09-business/publication-observation-client');
const {
  createPublicationObservationFiles,
} = require('../../scripts/context-hosted/n09-business/publication-observation-files');
const pid = 17,
  epoch = 'b'.repeat(32),
  signingKey = 'c'.repeat(64);
const query = { version: 1, pid, epoch, sequence: 1, challenge: 'd'.repeat(32) };
const metadata = {
  generation: 1,
  callOrdinal: 2,
  activeCount: 1,
  operation: 'save-reference-state',
  transition: 'prepared',
  rootId: 'hbs_' + 'e'.repeat(32),
  expiresAt: 1000,
  expectedRevision: 3,
  status: 'pending',
};
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-publication-query-'));
  const runtimeDir = path.join(root, 'runtime'),
    ack = path.join(root, 'n09-ack');
  fs.mkdirSync(runtimeDir);
  fs.mkdirSync(ack);
  const token = 't'.repeat(64),
    manifestSha256 = 'a'.repeat(64);
  const bootstrap = createN09BootstrapContract({ token, pid, manifestSha256 });
  const grant = {
    version: 1,
    pid,
    epoch,
    manifestSha256,
    sourcePins: { 'scripts/context-hosted/n09-ack/host-install.js': 'f'.repeat(64) },
  };
  fs.writeFileSync(
    path.join(ack, 'bootstrap-' + pid + '.json'),
    JSON.stringify(bootstrap.sign(grant))
  );
  let state = { ...metadata },
    closes = 0;
  const observer = {
    inspect: () => state,
    close() {
      closes++;
    },
  };
  const host = createPublicationObservationHost(
    { caseRoot: root, pid, epoch, signingKey: bootstrap.mailboxKey(grant) },
    observer
  );
  const client = createPublicationObservationClient({ runtimeDir, pid, manifestSha256, token });
  t.after(() => {
    client.close();
    host.close();
    bootstrap.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    runtimeDir,
    host,
    client,
    directory: path.join(root, 'n09-publication-' + pid + '-' + epoch),
    setState(value) {
      state = value;
    },
    closes: () => closes,
  };
}

test('query and state domains bind exact identity, nonce, bounded counters and target metadata', () => {
  const contract = createPublicationObservationContract({ pid, epoch, signingKey });
  try {
    assert.deepEqual(contract.verifyQuery(contract.signQuery(query)), query);
    assert.deepEqual(contract.verifyState(contract.signState({ ...query, ...metadata })), {
      ...query,
      ...metadata,
    });
    assert.throws(() => contract.verifyQuery(contract.signState({ ...query, ...metadata })));
    assert.throws(() => contract.verifyState(contract.signQuery(query)));
    const other = createPublicationObservationContract({ pid: pid + 1, epoch, signingKey });
    assert.throws(() => other.verifyQuery(contract.signQuery(query)));
    other.close();
    const envelope = contract.signState({ ...query, ...metadata });
    assert.throws(() =>
      contract.verifyState({
        ...envelope,
        payload: { ...envelope.payload, transition: 'withdrawn' },
      })
    );
    for (const patch of [
      { activeCount: 0 },
      { expectedRevision: -1 },
      { rootId: 'PRIVATE' },
      { status: 'unknown' },
      { generation: 17 },
      { callOrdinal: 1025 },
      { sequence: 17 },
      { challenge: '' },
      { extra: true },
    ])
      assert.throws(() => contract.signState({ ...query, ...metadata, ...patch }));
  } finally {
    contract.close();
  }
  assert.throws(() => contract.signQuery(query));
});

test(
  'real host answers each fresh challenge from current in-memory state without invoking storage',
  { timeout: 5000 },
  async (t) => {
    const f = setup(t);
    f.host.start();
    const first = await f.client.query();
    assert.equal(first.status, 'pending');
    assert.equal(first.transition, 'prepared');
    assert.equal(first.sequence, 1);
    f.setState({ ...metadata, activeCount: 0, status: 'completed' });
    const second = await f.client.query();
    assert.equal(second.status, 'completed');
    assert.equal(second.sequence, 2);
    assert.notEqual(first.challenge, second.challenge);
    f.client.close();
    await assert.rejects(f.client.query());
    f.host.close();
    assert.equal(f.closes(), 1);
  }
);

test(
  'an authentic old reply cannot satisfy another sequence and fresh challenge',
  { timeout: 5000 },
  async (t) => {
    const f = setup(t);
    f.host.start();
    await f.client.query();
    for (const suffix of ['', '.ready'])
      fs.copyFileSync(
        path.join(f.directory, 'state-1.json' + suffix),
        path.join(f.directory, 'state-2.json' + suffix)
      );
    await assert.rejects(f.client.query());
    await assert.rejects(f.client.query());
  }
);

test(
  'missing, late and closed query channels fail without a retry or extended deadline',
  { timeout: 5000 },
  async (t) => {
    const f = setup(t);
    await assert.rejects(f.client.query(20));
    assert.equal(fs.existsSync(path.join(f.directory, 'query-2.json')), false);
    await assert.rejects(f.client.query());
    const other = setup(t);
    const pending = assert.rejects(other.client.query());
    other.client.close();
    await pending;
    const invalid = setup(t);
    await assert.rejects(invalid.client.query(751));
  }
);

test('readonly file transport rejects aliases, replacement, excessive and malformed data', (t) => {
  const f = setup(t),
    files = createPublicationObservationFiles({ directory: f.directory, pid, epoch });
  t.after(() => files.close());
  assert.equal(files.read('query', 1), null);
  for (const value of [
    '',
    'x',
    '{}\n',
    'x'.repeat(4097),
    {
      toJSON() {
        assert.fail('hook');
      },
    },
  ]) {
    const another = setup(t),
      wire = createPublicationObservationFiles({ directory: another.directory, pid, epoch });
    assert.throws(() => wire.write('query', 1, value));
    wire.close();
  }
  fs.writeFileSync(path.join(f.directory, 'query-1.json'), '{}');
  fs.writeFileSync(path.join(f.directory, 'query-1.json.ready'), '');
  fs.linkSync(path.join(f.directory, 'query-1.json'), path.join(f.root, 'alias'));
  assert.throws(() => files.read('query', 1));
  const other = setup(t),
    pinned = createPublicationObservationFiles({ directory: other.directory, pid, epoch });
  fs.renameSync(other.directory, other.directory + '.old');
  fs.mkdirSync(other.directory);
  assert.throws(() => pinned.read('query', 1));
  pinned.close();
});

test('executable contract fields are refused before getters, proxies or serialization hooks', () => {
  let touched = 0;
  const contract = createPublicationObservationContract({ pid, epoch, signingKey });
  const getter = Object.defineProperty({ ...query }, 'challenge', {
    enumerable: true,
    get() {
      touched++;
      throw Error('PRIVATE');
    },
  });
  const revoked = Proxy.revocable(query, {});
  revoked.revoke();
  for (const value of [
    null,
    {},
    [],
    getter,
    revoked.proxy,
    new Proxy(query, {
      ownKeys() {
        touched++;
        throw Error('PRIVATE');
      },
    }),
  ])
    assert.throws(() => contract.signQuery(value));
  assert.equal(touched, 0);
  contract.close();
});
