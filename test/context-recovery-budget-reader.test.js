'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../lib/proxy/context-recovery-storage-sqlite');
const { createContextEvidenceLedger } = require('../lib/proxy/context-evidence-ledger');
const { createDurableEvidenceTools } = require('../lib/proxy/context-recovery-budget-reader');
const { openContextRecoveryStorage } = require('../lib/proxy/context-recovery-storage');
const {
  createContextEvidenceTools,
  createContextEvidenceBudget,
  exportContextEvidenceBudget,
  restoreContextEvidenceBudget,
  reserveContextEvidenceBudget,
  readContextEvidenceReservationAsync,
  exportContextEvidenceReservation,
  settleContextEvidenceReservation,
  LIST_EVIDENCE_TOOL,
  READ_EVIDENCE_TOOL,
} = require('../lib/proxy/context-evidence-tools');
const {
  MAX_READER_BYTES,
  MAX_READER_CALLS,
  MAX_READER_RESULT_BYTES,
} = require('../lib/proxy/context-evidence-page');

const scope = 'b'.repeat(64),
  expiresAt = 100000;
const json = (value) => JSON.parse(JSON.stringify(value));
const empty = () => ({ version: 1, calls: 0, returnedBytes: 0, successfulReads: 0 });
function fixture() {
  const database = new DatabaseSync(':memory:');
  const key = randomBytes(32).toString('base64');
  let store = createRecoverySqliteStore({ database, dataKey: key, now: () => 100 });
  const ledger = createContextEvidenceLedger({
    owner: 'owner',
    threadId: 'thread',
    now: () => 100,
  });
  const receipt = ledger.capture({
    callId: 'call',
    toolName: 'synthetic-source',
    arguments: {},
    completed: true,
    output: '原文\r\nélève🙂',
  });
  return {
    database,
    ledger,
    receipt,
    get store() {
      return store;
    },
    budget() {
      return store.execute({ operation: 'load', scope }).state.budget;
    },
    reopen() {
      store.close();
      store = createRecoverySqliteStore({ database, dataKey: key, now: () => 200 });
      return store;
    },
    close() {
      ledger.close();
      store.close();
      database.close();
    },
  };
}

test('async reserved reads share write-ahead budgets, block concurrent readers and consume each reservation once', async () => {
  const f = fixture();
  const budget = createContextEvidenceBudget();
  const first = createContextEvidenceTools(f.ledger, budget);
  const second = createContextEvidenceTools(f.ledger, budget);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const args = { sourceId: f.receipt.sourceId, digest: f.receipt.digest };
  try {
    const reservation = reserveContextEvidenceBudget(budget);
    const pending = readContextEvidenceReservationAsync(
      first,
      reservation,
      READ_EVIDENCE_TOOL,
      args,
      async (range, maximum) => {
        await gate;
        return f.ledger.read(range, maximum);
      }
    );
    assert.equal(second.reply(LIST_EVIDENCE_TOOL, {}).code, 'evidence_reader_busy');
    assert.throws(() => reserveContextEvidenceBudget(budget));
    await assert.rejects(
      readContextEvidenceReservationAsync(
        second,
        reservation,
        READ_EVIDENCE_TOOL,
        args,
        async () => ({})
      )
    );
    assert.equal(exportContextEvidenceBudget(budget).returnedBytes, 16384);
    release();
    assert.equal((await pending).ok, true);
    const actual = exportContextEvidenceReservation(reservation);
    assert.equal(actual.calls, 1);
    assert.equal(actual.successfulReads, 1);
    assert.ok(actual.returnedBytes < 16384);
    settleContextEvidenceReservation(reservation);
    assert.deepEqual(exportContextEvidenceBudget(budget), actual);
    assert.equal(second.reply(LIST_EVIDENCE_TOOL, {}).ok, true);
    assert.equal(exportContextEvidenceBudget(budget).calls, 2);
  } finally {
    release();
    f.close();
  }
});

test('async reserved attempts preserve invalid arguments, failure accounting and safe promise admission', async () => {
  const f = fixture();
  let invoked = 0;
  try {
    for (const failure of ['invalid', 'throw', 'reject', 'thenable', 'constructor', 'oversize']) {
      const budget = createContextEvidenceBudget();
      const tools = createContextEvidenceTools(f.ledger, budget);
      const reservation = reserveContextEvidenceBudget(budget);
      const args =
        failure === 'invalid' ? {} : { sourceId: f.receipt.sourceId, digest: f.receipt.digest };
      const result = await readContextEvidenceReservationAsync(
        tools,
        reservation,
        READ_EVIDENCE_TOOL,
        args,
        () => {
          if (failure === 'invalid') {
            invoked++;
            return {};
          }
          if (failure === 'throw') throw new Error('private');
          if (failure === 'reject') return Promise.reject(new Error('private'));
          if (failure === 'thenable')
            return {
              get then() {
                invoked++;
                return () => {};
              },
            };
          if (failure === 'oversize') return { ok: true, page: { text: 'x'.repeat(200000) } };
          const pending = Promise.resolve({});
          Object.defineProperty(pending, 'constructor', {
            get() {
              invoked++;
              return Promise;
            },
          });
          return pending;
        }
      );
      assert.equal(result.ok, false);
      assert.equal(
        result.code,
        failure === 'invalid'
          ? 'invalid_evidence_arguments'
          : failure === 'oversize'
            ? 'evidence_read_budget_exceeded'
            : 'context_evidence_unavailable'
      );
      assert.equal(exportContextEvidenceReservation(reservation).calls, 1);
      assert.equal(exportContextEvidenceReservation(reservation).successfulReads, 0);
      settleContextEvidenceReservation(reservation);
      await assert.rejects(
        readContextEvidenceReservationAsync(
          tools,
          reservation,
          READ_EVIDENCE_TOOL,
          args,
          async () => ({})
        )
      );
    }
    assert.equal(invoked, 0);
  } finally {
    f.close();
  }
});

test('reader budget export and restore preserve accounting without accepting forged capabilities', () => {
  const budget = createContextEvidenceBudget();
  const ledger = {
    list: () => ({ ok: false, error: 'context_evidence_unavailable' }),
    read: () => {
      throw new Error('synthetic');
    },
  };
  const tools = createContextEvidenceTools(ledger, budget);
  tools.reply(LIST_EVIDENCE_TOOL, {});
  tools.reply(LIST_EVIDENCE_TOOL, { limit: 'invalid' });
  tools.reply(READ_EVIDENCE_TOOL, { sourceId: 'hce_' + 'a'.repeat(32), digest: 'b'.repeat(64) });
  const snapshot = exportContextEvidenceBudget(budget);
  assert.equal(snapshot.calls, 3);
  assert.ok(snapshot.returnedBytes > 0);
  const restored = restoreContextEvidenceBudget(snapshot);
  const readers = createContextEvidenceTools(ledger, restored);
  assert.deepEqual(readers.inspect(), tools.inspect());
  snapshot.calls = 0;
  assert.equal(exportContextEvidenceBudget(restored).calls, 3);
  assert.throws(() => exportContextEvidenceBudget({}), { code: 'invalid_evidence_budget_state' });
  assert.throws(() =>
    createContextEvidenceTools(ledger, json(exportContextEvidenceBudget(restored)))
  );
  for (const state of [
    null,
    [],
    {},
    { ...empty(), calls: -1 },
    { ...empty(), calls: 65 },
    { ...empty(), returnedBytes: 1 },
    { ...empty(), calls: 1, successfulReads: 1 },
    { ...empty(), calls: 1, successfulReads: 2 },
    { ...empty(), calls: 1, returnedBytes: MAX_READER_BYTES + 1 },
    { ...empty(), calls: NaN },
    { ...empty(), version: 3 },
    { ...empty(), extra: 'secret' },
  ])
    assert.throws(() => restoreContextEvidenceBudget(state), {
      code: 'invalid_evidence_budget_state',
    });
  let invoked = 0;
  assert.throws(
    () =>
      restoreContextEvidenceBudget({
        ...empty(),
        get calls() {
          invoked++;
          return 0;
        },
      }),
    { code: 'invalid_evidence_budget_state' }
  );
  assert.equal(invoked, 0);
});

test('durable readers debit before ledger access, persist exact accounting and retain exhaustion after reopen', async () => {
  const f = fixture();
  let reader;
  try {
    reader = await createDurableEvidenceTools({
      ledger: f.ledger,
      storage: f.store,
      scope,
      expiresAt,
    });
    assert.equal(await reader.reply('external-tool', {}), null);
    assert.equal((await reader.reply(LIST_EVIDENCE_TOOL, {})).ok, true);
    assert.equal(
      (
        await reader.reply(READ_EVIDENCE_TOOL, {
          sourceId: f.receipt.sourceId,
          digest: f.receipt.digest,
        })
      ).ok,
      true
    );
    const used = json(f.budget());
    assert.equal(used.calls, 2);
    assert.equal(used.successfulReads, 1);
    assert.ok(used.returnedBytes > 0);
    reader.close();
    reader = await createDurableEvidenceTools({
      ledger: f.ledger,
      storage: f.reopen(),
      scope,
      expiresAt,
    });
    assert.deepEqual(json(f.budget()), used);
    for (let index = used.calls; index < MAX_READER_CALLS; index++)
      await reader.reply(LIST_EVIDENCE_TOOL, { limit: 'invalid' });
    assert.equal(f.budget().calls, MAX_READER_CALLS);
    reader.close();
    reader = await createDurableEvidenceTools({
      ledger: f.ledger,
      storage: f.reopen(),
      scope,
      expiresAt,
    });
    assert.equal(
      (await reader.reply(LIST_EVIDENCE_TOOL, {})).code,
      'evidence_read_budget_exceeded'
    );
    assert.equal(f.budget().calls, MAX_READER_CALLS);
  } finally {
    reader?.close();
    f.close();
  }
});

test('reservation and finalization failures cannot publish data or reset the durable debit', async () => {
  for (const mode of ['reserve', 'finalize']) {
    const f = fixture();
    let reader,
      reads = 0;
    try {
      const ledger = {
        list() {
          reads++;
          assert.equal(f.budget().calls, 1);
          assert.equal(f.budget().returnedBytes, MAX_READER_RESULT_BYTES);
          return { ok: true, sources: [], nextAfterSourceId: null };
        },
        read() {
          throw new Error('unused');
        },
      };
      const storage = {
        execute(request) {
          if (
            request.operation === 'save' &&
            request.expectedRevision === (mode === 'reserve' ? 1 : 2)
          )
            throw new Error('secret-value');
          return f.store.execute(request);
        },
      };
      reader = await createDurableEvidenceTools({ ledger, storage, scope, expiresAt });
      assert.deepEqual(await reader.reply(LIST_EVIDENCE_TOOL, {}), {
        ok: false,
        code: 'context_evidence_unavailable',
      });
      assert.equal(reads, mode === 'reserve' ? 0 : 1);
      assert.equal(f.budget().calls, mode === 'reserve' ? 0 : 1);
      assert.equal(f.budget().returnedBytes, mode === 'reserve' ? 0 : MAX_READER_RESULT_BYTES);
      reader.close();
      reader = await createDurableEvidenceTools({
        ledger: f.ledger,
        storage: f.reopen(),
        scope,
        expiresAt,
      });
      assert.equal(f.budget().calls, mode === 'reserve' ? 0 : 1);
    } finally {
      reader?.close();
      f.close();
    }
  }
});

test('revocation and invalid persisted state never return evidence or recreate a revoked budget', async () => {
  const f = fixture();
  let reader;
  try {
    reader = await createDurableEvidenceTools({
      ledger: f.ledger,
      storage: f.store,
      scope,
      expiresAt,
    });
    const prior = f.store.execute({ operation: 'load', scope });
    f.store.execute({ operation: 'revoke', scope, expectedRevision: prior.revision });
    assert.equal((await reader.reply(LIST_EVIDENCE_TOOL, {})).code, 'context_evidence_unavailable');
    await assert.rejects(
      createDurableEvidenceTools({ ledger: f.ledger, storage: f.store, scope, expiresAt }),
      { code: 'context_recovery_storage_unavailable' }
    );
    reader.close();
    assert.equal((await reader.reply(LIST_EVIDENCE_TOOL, {})).code, 'context_evidence_unavailable');
  } finally {
    reader?.close();
    f.close();
  }
  let writes = 0;
  await assert.rejects(
    createDurableEvidenceTools({
      ledger: { list() {}, read() {} },
      scope,
      expiresAt,
      storage: {
        execute(request) {
          if (request.operation === 'save') writes++;
          return {
            revision: 1,
            createdAt: 100,
            expiresAt,
            state: { version: 1, kind: 'foreign', budget: empty() },
          };
        },
      },
    }),
    { code: 'context_recovery_storage_unavailable' }
  );
  assert.equal(writes, 0);
});

test('standalone durable readers cannot adopt the larger session-task budget format', async () => {
  let writes = 0;
  await assert.rejects(
    createDurableEvidenceTools({
      ledger: { list() {}, read() {} },
      scope,
      expiresAt,
      storage: {
        execute(request) {
          if (request.operation !== 'load') writes++;
          return {
            revision: 1,
            createdAt: 100,
            expiresAt,
            state: { version: 1, kind: 'reader-budget', budget: { ...empty(), version: 2 } },
          };
        },
      },
    }),
    { code: 'context_recovery_storage_unavailable' }
  );
  assert.equal(writes, 0);
});

test('all durable save acknowledgments reject executable, extra and invalid revision data', async () => {
  let invoked = 0;
  const invalidReplies = [
    null,
    [],
    {},
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: 0 },
    { revision: '2' },
    { revision: 2, secret: 'not-allowed' },
    {
      get revision() {
        invoked++;
        return 2;
      },
    },
  ];
  for (const phase of [0, 1, 2]) {
    for (const reply of invalidReplies) {
      const f = fixture();
      let reader,
        accesses = 0;
      try {
        const storage = {
          execute(request) {
            const result = f.store.execute(request);
            return request.operation === 'save' && request.expectedRevision === phase
              ? reply
              : result;
          },
        };
        const options = {
          ledger: {
            list() {
              accesses++;
              return f.ledger.list();
            },
            read: (args, bytes) => f.ledger.read(args, bytes),
          },
          storage,
          scope,
          expiresAt,
        };
        if (phase === 0) {
          await assert.rejects(createDurableEvidenceTools(options), {
            code: 'context_recovery_storage_unavailable',
          });
        } else {
          reader = await createDurableEvidenceTools(options);
          assert.deepEqual(await reader.reply(LIST_EVIDENCE_TOOL, {}), {
            ok: false,
            code: 'context_evidence_unavailable',
          });
        }
        assert.equal(accesses, phase === 2 ? 1 : 0);
        assert.equal(f.budget().calls, phase === 0 ? 0 : 1);
        if (phase === 1) assert.equal(f.budget().returnedBytes, MAX_READER_RESULT_BYTES);
      } finally {
        reader?.close();
        f.close();
      }
    }
  }
  assert.equal(invoked, 0);
});

test('nearly exhausted byte allowance and ledger failures keep durable accounting bounded', async () => {
  for (const mode of ['one-byte', 'ledger-failure']) {
    const f = fixture();
    let reader;
    const prior = {
      ...empty(),
      calls: 1,
      returnedBytes: mode === 'one-byte' ? MAX_READER_BYTES - 1 : 100,
    };
    try {
      f.store.execute({
        operation: 'save',
        scope,
        expectedRevision: 0,
        expiresAt,
        state: { version: 1, kind: 'reader-budget', budget: prior },
      });
      reader = await createDurableEvidenceTools({
        ledger: {
          list() {
            throw new Error('secret-ledger-output');
          },
          read() {
            throw new Error('unused');
          },
        },
        storage: f.store,
        scope,
        expiresAt,
      });
      const result = await reader.reply(
        LIST_EVIDENCE_TOOL,
        mode === 'one-byte' ? { limit: 'invalid' } : {}
      );
      assert.deepEqual(result, {
        ok: false,
        code:
          mode === 'one-byte' ? 'evidence_read_budget_exceeded' : 'context_evidence_unavailable',
      });
      assert.deepEqual(json(f.budget()), { ...prior, calls: 2 });
    } finally {
      reader?.close();
      f.close();
    }
  }
});

test('concurrent instances reserve with CAS and only one can read from the same old budget revision', async () => {
  const f = fixture();
  let first, second;
  let accesses = 0;
  const ledger = {
    list() {
      accesses++;
      return f.ledger.list();
    },
    read: (args, bytes) => f.ledger.read(args, bytes),
  };
  try {
    first = await createDurableEvidenceTools({ ledger, storage: f.store, scope, expiresAt });
    second = await createDurableEvidenceTools({ ledger, storage: f.store, scope, expiresAt });
    const results = await Promise.all([
      first.reply(LIST_EVIDENCE_TOOL, {}),
      second.reply(LIST_EVIDENCE_TOOL, {}),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(accesses, 1);
    assert.equal(f.budget().calls, 1);
    assert.equal(
      results.filter((result) => result.code === 'context_evidence_unavailable').length,
      1
    );
  } finally {
    first?.close();
    second?.close();
    f.close();
  }
});

test('closure after a durable reservation suppresses ledger access and preserves the pre-debit', async () => {
  const f = fixture();
  let reader,
    release,
    accesses = 0;
  try {
    const storage = {
      execute(request) {
        const result = f.store.execute(request);
        if (request.operation === 'save' && request.expectedRevision === 1)
          return new Promise((resolve) => {
            release = () => resolve(result);
          });
        return result;
      },
    };
    reader = await createDurableEvidenceTools({
      ledger: {
        list() {
          accesses++;
        },
        read() {
          accesses++;
        },
      },
      storage,
      scope,
      expiresAt,
    });
    const pending = reader.reply(LIST_EVIDENCE_TOOL, {});
    await Promise.resolve();
    assert.equal(typeof release, 'function');
    assert.equal((await reader.reply(LIST_EVIDENCE_TOOL, {})).code, 'context_evidence_unavailable');
    reader.close();
    release();
    assert.equal((await pending).code, 'context_evidence_unavailable');
    assert.equal(accesses, 0);
    assert.equal(f.budget().calls, 1);
    assert.equal(f.budget().returnedBytes, MAX_READER_RESULT_BYTES);
  } finally {
    reader?.close();
    f.close();
  }
});

test('durable budget admission rejects malformed dependencies and exhausted byte budgets safely', async () => {
  let invoked = 0;
  for (const options of [
    null,
    [],
    {},
    {
      get ledger() {
        invoked++;
        return {};
      },
    },
    {
      ledger: {},
      scope,
      expiresAt,
      storage: {
        get execute() {
          invoked++;
          return () => {};
        },
      },
    },
    {
      ledger: {},
      scope,
      expiresAt,
      storage: {
        execute() {
          invoked++;
        },
      },
    },
  ])
    await assert.rejects(createDurableEvidenceTools(options), {
      code: 'context_recovery_storage_unavailable',
    });
  assert.equal(invoked, 0);
  const f = fixture();
  let reader;
  try {
    f.store.execute({
      operation: 'save',
      scope,
      expectedRevision: 0,
      expiresAt,
      state: {
        kind: 'reader-budget',
        version: 1,
        budget: { ...empty(), calls: 32, returnedBytes: MAX_READER_BYTES },
      },
    });
    reader = await createDurableEvidenceTools({
      ledger: f.ledger,
      storage: f.store,
      scope,
      expiresAt,
    });
    assert.equal(
      (await reader.reply(LIST_EVIDENCE_TOOL, {})).code,
      'evidence_read_budget_exceeded'
    );
    assert.equal(f.budget().returnedBytes, MAX_READER_BYTES);
  } finally {
    reader?.close();
    f.close();
  }
});

test(
  'real storage worker restart preserves exact reader debit without restoring ledger authority from disk',
  { timeout: 120000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-budget-reader-test-'));
    const ledger = createContextEvidenceLedger({
      owner: 'synthetic-owner',
      threadId: 'synthetic-thread',
    });
    const receipt = ledger.capture({
      callId: 'synthetic-call',
      toolName: 'synthetic-source',
      arguments: {},
      completed: true,
      output: '原文🙂',
    });
    let storage, reader;
    const expiration = Date.now() + 120000;
    try {
      if (process.platform !== 'win32') {
        await assert.rejects(
          openContextRecoveryStorage({ directory: path.join(directory, 'context') }),
          { code: 'context_recovery_storage_unavailable' }
        );
        return;
      }
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'context') });
      reader = await createDurableEvidenceTools({ ledger, storage, scope, expiresAt: expiration });
      assert.equal((await reader.reply(LIST_EVIDENCE_TOOL, {})).ok, true);
      assert.equal(
        (
          await reader.reply(READ_EVIDENCE_TOOL, {
            sourceId: receipt.sourceId,
            digest: receipt.digest,
          })
        ).ok,
        true
      );
      const used = json((await storage.execute({ operation: 'load', scope })).state.budget);
      assert.equal(used.calls, 2);
      assert.equal(used.successfulReads, 1);
      reader.close();
      await storage.close();
      storage = undefined;
      storage = await openContextRecoveryStorage({ directory: path.join(directory, 'context') });
      reader = await createDurableEvidenceTools({ ledger, storage, scope, expiresAt: expiration });
      assert.deepEqual(
        json((await storage.execute({ operation: 'load', scope })).state.budget),
        used
      );
      await reader.reply(LIST_EVIDENCE_TOOL, { limit: 'invalid' });
      assert.equal((await storage.execute({ operation: 'load', scope })).state.budget.calls, 3);
    } finally {
      reader?.close();
      ledger.close();
      try {
        await storage?.close();
      } finally {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('hpm-budget-reader-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
);
