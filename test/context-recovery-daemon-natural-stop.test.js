'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { discoverTestFiles } = require('../lib/test-discovery');
const {
  completeDaemonNaturalStop,
} = require('../scripts/lib/context-recovery-daemon-natural-stop');
const { response } = require('../scripts/lib/context-recovery-daemon-owned-protocol');

const target = { pid: 42, instanceId: 'a'.repeat(32) };
const input = () => ({ case: '00', pid: 42, shutdown: { ...target } });
const accepted = () => ({ status: 202, body: { accepted: true, ...target } });
const receipt = () => ({
  v: 1,
  id: 2,
  op: 'reap',
  case: '00',
  ok: true,
  treeEmpty: true,
  cleanupSemantics: 'natural_exit',
  exitCode: 0,
});

test('natural stop waits for independent controller proof after exact authenticated stop intent', async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  let observed = false;
  const result = completeDaemonNaturalStop(
    input(),
    async (request) => {
      assert.deepEqual(
        { ...request, body: { ...request.body } },
        { method: 'POST', route: '/v1/local/runtime/stop', body: target }
      );
      return accepted();
    },
    async (request) => {
      assert.deepEqual(request, { op: 'reap', case: '00' });
      return pending;
    }
  ).then((value) => {
    observed = true;
    return value;
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(observed, false);
  resolve(receipt());
  assert.deepEqual(await result, {
    treeEmpty: true,
    cleanupSemantics: 'natural_exit',
    exitCode: 0,
  });
});

test('invalid, empty, hostile and stale shutdown identities never dispatch HTTP or controller work', async () => {
  let calls = 0;
  const deny = () => {
    calls++;
    throw Error('PRIVATE_UNEXPECTED_CALL');
  };
  const getter = Object.defineProperty({}, 'pid', { enumerable: true, get: deny });
  for (const value of [
    null,
    [],
    {},
    { ...input(), extra: true },
    ...[
      null,
      {},
      [],
      getter,
      new Proxy(target, {}),
      { ...target, pid: 43 },
      { ...target, instanceId: '' },
      { ...target, instanceId: 'A'.repeat(32) },
      { ...target, token: 'PRIVATE_TOKEN' },
    ].map((shutdown) => ({ ...input(), shutdown })),
    ...[0, -1, Infinity, 0x100000000, 1.5].map((pid) => ({
      ...input(),
      pid,
      shutdown: { ...target, pid },
    })),
    { ...input(), case: '12' },
  ]) {
    await assert.rejects(
      completeDaemonNaturalStop(value, deny, deny),
      /^Error: daemon_natural_stop_rejected$/
    );
  }
  assert.equal(calls, 0);
});

test('wrong stop status, stale ACK, extra fields and failures cannot trigger natural-exit credit', async () => {
  let calls = 0;
  const reap = () => {
    calls++;
    return receipt();
  };
  for (const reply of [
    null,
    {},
    { ...accepted(), status: 200 },
    { ...accepted(), status: 409 },
    ...[
      null,
      {},
      { ...accepted().body, accepted: false },
      { ...accepted().body, pid: 41 },
      { ...accepted().body, instanceId: 'b'.repeat(32) },
      { ...accepted().body, token: 'PRIVATE_TOKEN' },
    ].map((body) => ({ status: 202, body })),
  ]) {
    await assert.rejects(
      completeDaemonNaturalStop(input(), async () => reply, reap),
      /^Error: daemon_natural_stop_rejected$/
    );
  }
  await assert.rejects(
    completeDaemonNaturalStop(
      input(),
      () => {
        throw Error('PRIVATE_HTTP_ERROR');
      },
      reap
    ),
    /^Error: daemon_natural_stop_rejected$/
  );
  assert.equal(calls, 0);
});

test('forced cleanup, nonzero exit, nonempty tree or failed observation never qualifies natural completion', async () => {
  for (const reply of [
    null,
    {},
    { ...receipt(), op: 'stop' },
    { ...receipt(), token: 'PRIVATE_TOKEN' },
    { ...receipt(), v: 2 },
    ...[0, 4097, 1.5, Infinity, null].map((id) => ({ ...receipt(), id })),
    { ...receipt(), case: '01' },
    { ...receipt(), ok: false },
    { ...receipt(), exitCode: 1 },
    { ...receipt(), exitCode: null },
    { ...receipt(), treeEmpty: false },
    { ...receipt(), cleanupSemantics: 'forced_cleanup' },
  ]) {
    await assert.rejects(
      completeDaemonNaturalStop(
        input(),
        async () => accepted(),
        async () => reply
      ),
      /^Error: daemon_natural_stop_rejected$/
    );
  }
  await assert.rejects(
    completeDaemonNaturalStop(
      input(),
      async () => accepted(),
      () => {
        throw Error('PRIVATE_NATIVE_ERROR');
      }
    ),
    /^Error: daemon_natural_stop_rejected$/
  );
});

test('wire natural-exit receipt has exact fields and a distinct finite failure cause', () => {
  const request = { v: 1, id: 2, op: 'reap', case: '00' };
  assert.equal(response(JSON.stringify(receipt()), request).exitCode, 0);
  for (const changed of [
    { exitCode: 1 },
    { exitCode: null },
    { cleanupSemantics: 'forced_cleanup' },
    { treeEmpty: false },
    { token: 'PRIVATE_TOKEN' },
    { id: 3 },
  ]) {
    assert.throws(() => response(JSON.stringify({ ...receipt(), ...changed }), request));
  }
  const failed = { ...request, ok: false, cause: 'controller_natural_exit' };
  assert.equal(response(JSON.stringify(failed), request).cause, 'controller_natural_exit');
  for (const cause of ['controller_cleanup', 'setup', 'PRIVATE_NATIVE_ERROR'])
    assert.throws(() => response(JSON.stringify({ ...failed, cause }), request));
  assert.throws(() =>
    response(
      JSON.stringify(receipt()).replace('"exitCode":0', '"exitCode":0,"exitCode":0'),
      request
    )
  );
});

test('PowerShell natural-exit controller preserves failures and never kills to obtain a passing receipt', () => {
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      'test/fixtures/daemon-natural-stop-mocks.ps1',
    ],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 16384 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /naturalExitCases=7; daemonExecutions=0; networkRequests=0/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/);
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/context-recovery-daemon-natural-stop.test.js'
    )
  );
});
