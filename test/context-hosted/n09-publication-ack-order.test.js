'use strict';

// Real sessions, encrypted SQLite, HTTP publication and ACK hooks. The response
// emitter and storage reply gates are synthetic; no native host/model is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { installN09RuntimeHooks } = require('../../scripts/context-hosted/n09-ack/runtime-hooks');
const { n09AckFailureStage } = require('../../scripts/context-hosted/n09-ack/contract');
const ackExports = require('../../lib/proxy/context-recovery-durable-ack');
const lifecycleApi = require('../../lib/proxy/context-recovery-lifecycle');
const { createContextRecoverySessions } = require('../../lib/proxy/context-recovery-sessions');
const { createRecoverySqliteStore } = require('../../lib/proxy/context-recovery-storage-sqlite');
const {
  declareRecoverySourcePages,
  declareRecoveryReaderSettlement,
  declareRecoveryReferenceStates,
} = require('../../lib/proxy/context-recovery-storage-contract');
const { tryHandleContextRecoveryHttp } = require('../../lib/proxy/context-recovery-http-entry');
const { READ_EVIDENCE_TOOL: READ } = require('../../lib/proxy/context-evidence-tools');
const {
  createContextRecoveryDiagnostics,
} = require('../../lib/proxy/context-recovery-diagnostics');
const {
  recoveryCompletionSnapshot,
  waitForRecoveryCompletion,
} = require('../../scripts/context-hosted/n09-business/recovery-completion-ready');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('HTTP finish, SQLite COMMIT and original ACK are distinct; only post-publication outcome permits a stable revoke baseline', async () => {
  const database = new DatabaseSync(':memory:');
  const store = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  const beforeCommit = deferred(),
    afterCommit = deferred();
  const allowCommit = deferred(),
    allowAck = deferred(),
    outcome = deferred(),
    nextPoll = deferred();
  let scope,
    targetSnapshot,
    latestAck,
    lifecycle,
    rounds = 0;
  const originalAck = ackExports.createRecoveryDurableAck;
  ackExports.createRecoveryDurableAck = (reference, revision) => {
    const token = originalAck(reference, revision);
    latestAck = { reference, revision };
    return token;
  };
  const storage = {
    execute: declareRecoverySourcePages(async (request) => {
      if (request.scope) scope = request.scope;
      const held =
        request.operation === 'save-reference-state' &&
        targetSnapshot &&
        request.reference.publications.some(
          (entry) => entry.snapshotId === targetSnapshot && entry.state === 'transport-finished'
        );
      if (held) {
        beforeCommit.resolve();
        await allowCommit.promise;
      }
      const result = store.execute(request);
      if (held) {
        afterCommit.resolve();
        await allowAck.promise;
      }
      return result;
    }),
    close() {},
  };
  declareRecoveryReaderSettlement(storage.execute);
  declareRecoveryReferenceStates(storage.execute);
  const lifecycleExports = {
    createContextRecoveryLifecycle() {
      return lifecycleApi.createContextRecoveryLifecycle({
        sessions: createContextRecoverySessions({ now: () => 100 }),
        storage,
      });
    },
  };
  const directory = path.join(os.tmpdir(), 'n09-publication-order-no-files');
  const identity = { pid: 123, epoch: 'a'.repeat(32) };
  const hooks = installN09RuntimeHooks({
    ackExports,
    lifecycleExports,
    expectedDirectory: directory,
    ...identity,
  });
  const snapshot = () => store.execute({ operation: 'load-reference', scope });
  const command = (revision) => ({
    version: 1,
    operation: 'revoke-bound-root',
    ...identity,
    sequence: 1,
    rootId: latestAck.reference.metadata.rootId,
    expiresAt: latestAck.reference.metadata.expiresAt,
    minRevision: revision,
  });
  try {
    lifecycle = lifecycleExports.createContextRecoveryLifecycle({ directory });
    assert.deepEqual(await lifecycle.configureAsync(true), { ok: true });
    const binding = { principal: 'owner', protocol: 'responses', target: 'target' };
    const user = { role: 'user', content: 'synthetic question' };
    const external = {
      type: 'function_call',
      call_id: 'external',
      name: 'lookup',
      arguments: '{}',
    };
    const first = lifecycle.sessions.begin({ ...binding, history: [user] });
    assert.equal(
      (
        await first.completeObservedAsync(
          [external],
          [{ callId: 'external', toolName: 'lookup', arguments: {}, output: '', completed: true }],
          'first'
        )
      ).ok,
      true
    );
    const original = 'synthetic exact original';
    const history = [
      user,
      external,
      { type: 'function_call_output', call_id: 'external', output: original },
    ];
    const session = lifecycle.sessions.begin({ ...binding, history }, [
      { callId: 'external', output: original },
    ]);
    const listed = JSON.parse((await session.replyAsync('hpm_list_retained_evidence', {})).text);
    const source = listed.sources[0];
    targetSnapshot = session.snapshotId;
    const response = new EventEmitter();
    response.writeHead = () => {
      response.headersSent = true;
    };
    response.end = () => {
      response.writableEnded = true;
      response.emit('finish');
      response.emit('close');
    };
    response.destroy = () => {
      response.destroyed = true;
      response.emit('close');
    };
    const body = { model: 'synthetic', input: history };
    const diagnostics = createContextRecoveryDiagnostics();
    diagnostics.attachLifecycle(lifecycle);
    diagnostics.configure(true);
    const health = () => ({
      status: 200,
      body: {
        pid: identity.pid,
        ok: true,
        appId: 'https-proxy-manager',
        status: 'running',
        contextRecovery: diagnostics.inspect({ appSettings: { contextRecoveryEnabled: true } }),
      },
    });
    const baseline = recoveryCompletionSnapshot(health(), identity.pid);
    diagnostics.record('responses', 'bound');
    assert.equal(
      tryHandleContextRecoveryHttp({
        kind: 'responses',
        session,
        observer: { detach: () => true },
        clientReq: new EventEmitter(),
        clientRes: response,
        prepared: { buffer: Buffer.from(JSON.stringify(body)) },
        requestOptions: { headers: {} },
        authorized: () => true,
        stream: false,
        setActive() {},
        onOutcome(value) {
          diagnostics.record('responses', value.ok ? 'completed' : 'failed');
          outcome.resolve(value);
        },
        dispatch(request) {
          if (rounds === 1)
            assert.equal(JSON.parse(request.input.at(-1).output).page.text, original);
          const output =
            rounds++ === 0
              ? [
                  {
                    type: 'function_call',
                    call_id: 'read-original',
                    name: READ,
                    arguments: JSON.stringify({ sourceId: source.sourceId, digest: source.digest }),
                  },
                ]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'done' }],
                  },
                ];
          return {
            statusCode: 200,
            stream: false,
            wire: Buffer.from(
              JSON.stringify({
                id: 'final',
                status: 'completed',
                output,
                usage: { input_tokens: 2, output_tokens: 1 },
              })
            ),
          };
        },
      }),
      true
    );
    await beforeCommit.promise;
    assert.equal(response.writableEnded, true);
    let ready = false;
    const readiness = waitForRecoveryCompletion(
      health,
      baseline,
      identity.pid,
      Date.now() + 15000,
      { sleep: () => nextPoll.promise }
    ).then((value) => {
      ready = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false);
    const stale = snapshot().revision;
    assert.equal(stale, latestAck.revision);
    allowCommit.resolve();
    await afterCommit.promise;
    assert.equal(snapshot().revision, stale + 1);
    assert.equal(latestAck.revision, stale);
    assert.equal(ready, false);
    assert.throws(
      () => hooks.revokeBoundRoot(command(stale + 1)),
      (error) => n09AckFailureStage(error) === 144
    );
    allowAck.resolve();
    assert.equal((await outcome.promise).ok, true);
    nextPoll.resolve();
    assert.deepEqual(await readiness, { completed: true, hostDurableAck: false });
    assert.equal(latestAck.revision, stale + 1);
    assert.throws(
      () => hooks.revokeBoundRoot(command(stale)),
      (error) => n09AckFailureStage(error) === 144
    );
    const receipt = await hooks.revokeBoundRoot(command(snapshot().revision));
    assert.equal(receipt.kind, 'host-revoke-completed');
    assert.equal(receipt.revision, stale + 1);
    assert.equal(lifecycle.sessions.inspect().roots, 0);
  } finally {
    allowCommit.resolve();
    allowAck.resolve();
    nextPoll.resolve();
    await lifecycle?.shutdownAsync();
    hooks.close();
    ackExports.createRecoveryDurableAck = originalAck;
    store.close();
    database.close();
  }
});
