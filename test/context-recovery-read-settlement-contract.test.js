'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const {
  storageRequest,
  storageWorkerRequest,
  storageReadSettlementResult,
  declareRecoveryReadSettlement,
  supportsRecoveryReadSettlement,
} = require('../lib/proxy/context-recovery-storage-contract');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const source = {
  sourceId: 'hce_' + 'a'.repeat(32),
  digest: 'b'.repeat(64),
  bytes: 1,
  callId: 'call',
  toolName: 'lookup',
  argumentsDigest: 'c'.repeat(64),
  expiresAt: 1000,
  trust: 'tool_data_not_instructions',
};
const request = () => ({
  operation: 'read-source-and-settle',
  scope: 'd'.repeat(64),
  expectedRevision: 2,
  source,
  arguments: { sourceId: source.sourceId, digest: source.digest },
  maxResultBytes: 16224,
  beforeBudget: { version: 2, calls: 0, returnedBytes: 0, successfulReads: 0 },
  observedAt: 100,
});
const response = () => ({
  page: { ok: false, error: 'context_artifact_invalid_range' },
  revision: 3,
  settlement: {
    version: 2,
    kind: 'recovery-reader-settlement',
    rootId: 'hbs_' + 'e'.repeat(32),
    observedAt: 100,
    budget: { version: 2, calls: 1, returnedBytes: 100, successfulReads: 0 },
    ledger: { readCount: 0, sources: [] },
  },
});
const safe = { code: 'context_recovery_storage_unavailable' };

test('compound request and reply contracts are bounded, immutable and explicit capabilities', () => {
  const input = request();
  const parsed = storageRequest(input);
  input.beforeBudget.calls = 9;
  assert.equal(parsed.beforeBudget.calls, 0);
  assert.ok(Object.isFrozen(parsed.beforeBudget));
  assert.deepEqual(storageWorkerRequest({ id: 1, request: parsed }).parseRequest(), parsed);
  const execute = () => {};
  assert.equal(supportsRecoveryReadSettlement(execute), false);
  assert.equal(supportsRecoveryReadSettlement(declareRecoveryReadSettlement(execute)), true);
  let invoked = 0;
  const getter = () => {};
  Object.defineProperty(getter, 'recoveryReadSettlementVersion', {
    get() {
      invoked++;
      return 1;
    },
  });
  assert.equal(supportsRecoveryReadSettlement(getter), false);
  assert.equal(invoked, 0);
  assert.equal(storageReadSettlementResult(response()).revision, 3);
});

test('compound contracts reject empty, executable, illegal and extreme fields', () => {
  const variants = [
    null,
    [],
    {},
    { ...request(), extra: true },
    ...[0, -1, 16225, Infinity, '16224'].map((maxResultBytes) => ({
      ...request(),
      maxResultBytes,
    })),
    ...[0, -1, Number.MAX_SAFE_INTEGER].map((expectedRevision) => ({
      ...request(),
      expectedRevision,
    })),
    { ...request(), observedAt: -1 },
    { ...request(), observedAt: '100' },
    { ...request(), beforeBudget: {} },
    { ...request(), source: { ...source, trust: 'trusted' } },
    { ...request(), arguments: { sourceId: source.sourceId, digest: 'f'.repeat(64) } },
  ];
  let invoked = 0;
  variants.push(
    Object.defineProperty({ ...request() }, 'beforeBudget', {
      enumerable: true,
      get() {
        invoked++;
        return {};
      },
    })
  );
  for (const value of variants) assert.throws(() => storageRequest(value), safe);
  assert.equal(invoked, 0);
  for (const value of [
    null,
    [],
    {},
    { ...response(), extra: true },
    ...[0, -1, Number.MAX_SAFE_INTEGER + 1].map((revision) => ({ ...response(), revision })),
    { ...response(), page: { ok: false, error: 'unknown' } },
    { ...response(), settlement: { ...response().settlement, observedAt: -1 } },
    { ...response(), settlement: { ...response().settlement, budget: {} } },
  ])
    assert.throws(() => storageReadSettlementResult(value), safe);
});

test('actual worker transport requires the exact compound revision ACK and becomes terminal on mismatch', async () => {
  for (const wrong of [false, true]) {
    class FixtureWorker extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => this.emit('message', { id: 0, ok: true }));
      }
      postMessage({ id, request: value }) {
        queueMicrotask(() => {
          if (value.operation === 'close') {
            this.emit('message', { id, ok: true, result: null });
            this.emit('exit', 0);
          } else
            this.emit('message', {
              id,
              ok: true,
              result: { ...response(), revision: wrong ? 4 : 3 },
            });
        });
      }
      terminate() {
        return Promise.resolve(0);
      }
    }
    const service = await openContextRecoveryStorage({
      directory: path.join(os.tmpdir(), 'hpm-unused-compound-transport'),
      WorkerType: FixtureWorker,
    });
    assert.equal(supportsRecoveryReadSettlement(service.execute), true);
    if (wrong) {
      await assert.rejects(service.execute(request()), safe);
      await assert.rejects(service.execute(request()), safe);
      await assert.rejects(service.close(), safe);
    } else {
      assert.equal((await service.execute(request())).revision, 3);
      await service.close();
    }
  }
});
