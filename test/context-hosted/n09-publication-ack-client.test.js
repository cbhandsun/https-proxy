'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createN09BootstrapContract,
} = require('../../scripts/context-hosted/n09-ack/bootstrap-contract');
const {
  createPublicationAckHost,
} = require('../../scripts/context-hosted/n09-business/publication-ack-host');
const {
  createPublicationAckClient,
} = require('../../scripts/context-hosted/n09-business/publication-ack-client');
function fixture(t) {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-ack-bootstrap-'));
  const runtimeDir = path.join(caseRoot, 'runtime');
  fs.mkdirSync(runtimeDir);
  fs.mkdirSync(path.join(caseRoot, 'n09-ack'));
  const config = { runtimeDir, pid: 123, manifestSha256: 'a'.repeat(64), token: 't'.repeat(64) };
  const bootstrap = createN09BootstrapContract({
    pid: config.pid,
    manifestSha256: config.manifestSha256,
    token: config.token,
  });
  const grant = {
    version: 1,
    pid: config.pid,
    epoch: 'b'.repeat(32),
    manifestSha256: config.manifestSha256,
    sourcePins: { 'scripts/context-hosted/n09-ack/host-install.js': 'c'.repeat(64) },
  };
  const file = path.join(caseRoot, 'n09-ack', 'bootstrap-123.json');
  fs.writeFileSync(file, JSON.stringify(bootstrap.sign(grant)));
  let observerCloses = 0;
  const host = createPublicationAckHost(
    { caseRoot, pid: config.pid, epoch: grant.epoch, signingKey: bootstrap.mailboxKey(grant) },
    {
      inspect: () => ({
        generation: 1,
        callOrdinal: 1,
        activeCount: 0,
        operation: 'other',
        transition: 'none',
        rootId: '',
        expiresAt: 0,
        expectedRevision: 0,
        status: 'completed',
      }),
      close() {
        observerCloses++;
      },
    }
  );
  host.start();
  t.after(() => {
    host.close();
    bootstrap.close();
    fs.rmSync(caseRoot, { recursive: true, force: true });
    assert.equal(observerCloses, 0);
  });
  return { config, file, caseRoot };
}
const target = {
  generation: 1,
  callOrdinal: 1,
  rootId: 'hbs_' + 'd'.repeat(32),
  expiresAt: 123456,
  expectedRevision: 7,
  transition: 'prepared',
};

test('ACK client derives its private channel only from a verified bootstrap and refuses use after close', async (t) => {
  const { config } = fixture(t);
  const client = createPublicationAckClient(config);
  t.after(() => client.close());
  const armed = await client.arm(target);
  assert.equal(armed.kind, 'armed');
  assert.equal(armed.rootId, target.rootId);
  assert.equal(JSON.stringify(armed).includes(config.token), false);
  client.close();
  client.close();
  await assert.rejects(client.waitHeld(), /n09_publication_ack_client_rejected/);
  assert.throws(() => client.release(), /n09_publication_ack_client_rejected/);
});

test('wrong bootstrap token, manifest, pid and malformed input cannot create a client', (t) => {
  const { config, file } = fixture(t);
  for (const value of [
    null,
    {},
    { ...config, token: 'x'.repeat(64) },
    { ...config, manifestSha256: 'f'.repeat(64) },
    { ...config, pid: 124 },
    { ...config, extra: true },
  ])
    assert.throws(() => createPublicationAckClient(value), /n09_publication_ack_client_rejected/);
  fs.writeFileSync(file, '{}');
  assert.throws(() => createPublicationAckClient(config), /n09_publication_ack_client_rejected/);
});

test('runtime parent replacement after arm cannot receive a held signal or release the host', async (t) => {
  const { config, caseRoot } = fixture(t);
  const client = createPublicationAckClient(config);
  t.after(() => client.close());
  await client.arm(target);
  fs.renameSync(config.runtimeDir, path.join(caseRoot, 'old-runtime'));
  fs.mkdirSync(config.runtimeDir);
  await assert.rejects(client.waitHeld(), /n09_publication_ack_client_rejected/);
  assert.throws(() => client.release(), /n09_publication_ack_client_rejected/);
});
