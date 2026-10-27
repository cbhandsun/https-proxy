'use strict';
const { publicationModule } = require('./publication-runtime.cjs');

// Offline process fixture: synthetic key/data travel over private IPC only.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const http = require('node:http');
const { observePublicationOperations } = require('./publication-operation-progress.cjs');
const { observePublicationSql } = require('./publication-sql-progress.cjs');
const { createProxyShutdown } = publicationModule('server-shutdown');
const { createStoppingAdmission } = publicationModule('stopping-admission');
const { openContextRecoveryStorage } = publicationModule('context-recovery-storage');
const { createRecoverySqliteStore } = publicationModule('context-recovery-storage-sqlite');
const { createContextRecoverySessions, attachContextRecoveryStorage } = publicationModule(
  'context-recovery-sessions'
);
const {
  declareRecoverySourcePages,
  declareRecoveryReaderSettlement,
  declareRecoveryReferenceStates,
  declareRecoveryReferenceAdmission,
} = publicationModule('context-recovery-storage-contract');
const phases = ['prepared', 'sending', 'transport-finished', 'uncertain', 'withdrawn'];
let initialized = false;
let advance;
let release;
let stop;
const report = (phase, details = {}) => process.send({ phase, ...details });
async function initialize(input) {
  if (
    input?.operation !== 'initialize' ||
    typeof input.file !== 'string' ||
    (input.native === true
      ? Object.hasOwn(input, 'key')
      : typeof input.key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(input.key)) ||
    !phases.includes(input.transition) ||
    !['commit', 'ack'].includes(input.boundary)
  )
    throw new Error('invalid fixture');
  let armed = false;
  let committing = false;
  let scope;
  const native = input.native === true;
  const database = native ? null : new DatabaseSync(input.file, { allowExtension: false });
  if (native) report('native-opening');
  const engine = native
    ? await openContextRecoveryStorage({
        directory: path.dirname(input.file),
        onStartup(progress) {
          report('native-startup', { progress });
        },
        onExecutionProgress(progress) {
          report('native-execution', { progress });
        },
      })
    : createRecoverySqliteStore({
        database: observePublicationSql(
          {
            prepare: (sql) => database.prepare(sql),
            exec(sql) {
              if (committing && sql === 'COMMIT') report('commit-entering');
              return database.exec(sql);
            },
          },
          (progress) => report('sql-progress', { progress })
        ),
        dataKey: input.key,
        now: () => 100,
      });
  if (native) report('native-opened');
  // Observe the original execute Promise, including its durable native ACK.
  // No WorkerType/protector/clock override, extra storage operation or retry.
  const execute = observePublicationOperations(
    (request) => engine.execute(request),
    (progress) => report('storage-operation', { progress })
  );
  const storage = {
    async execute(request) {
      const target =
        request.operation === 'save-reference-state' &&
        armed &&
        request.reference.publications.some(
          (item) => item.snapshotId === targetId && item.state === input.transition
        );
      if (request.operation === 'save-reference-state') scope = request.scope;
      committing = target;
      let result;
      try {
        // The parent additionally witnesses SQLite's actual PENDING lock.
        // This message alone is never accepted as proof of COMMIT entry.
        if (native && target && input.boundary === 'commit') report('commit-entering');
        result = await execute(request);
      } catch {
        report('engine-failed');
        throw new Error('fixture storage failure');
      } finally {
        committing = false;
      }
      if (target && input.graceful === true && input.boundary === 'commit') {
        report('commit-durable', { record: await execute({ operation: 'load', scope }) });
      }
      if (target && input.boundary === 'ack') {
        const pending = new Promise((resolve) => {
          release = resolve;
        });
        report('commit-durable', { record: await execute({ operation: 'load', scope }) });
        await pending;
      }
      return result;
    },
  };
  declareRecoverySourcePages(storage.execute);
  declareRecoveryReaderSettlement(storage.execute);
  declareRecoveryReferenceStates(storage.execute);
  declareRecoveryReferenceAdmission(storage.execute);
  const runtime = createContextRecoverySessions({ now: native ? Date.now : () => 100 });
  runtime.configure(true);
  attachContextRecoveryStorage(runtime, storage);
  const binding = { principal: 'owner', protocol: 'chat', target: 'offline-fixture' };
  const question = { role: 'user', content: 'q' };
  const external = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'external', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ],
  };
  const root = runtime.begin({ ...binding, history: [question] });
  assert.deepEqual(
    await root.completeObservedAsync(
      [external],
      [{ callId: 'external', toolName: 'lookup', arguments: {}, output: '', completed: true }]
    ),
    { ok: true }
  );
  report('fixture-observed');
  const original = 'synthetic-publication\r\nélève🙂\u0000';
  const view = runtime.begin(
    {
      ...binding,
      history: [question, external, { role: 'tool', tool_call_id: 'external', content: original }],
    },
    [{ callId: 'external', output: original }]
  );
  const targetId = view.snapshotId;
  const output = [{ role: 'assistant', content: 'synthetic public answer' }];
  if (input.transition !== 'prepared')
    assert.deepEqual(await view.completePublicAsync(output), { ok: true });
  report('fixture-prepared');
  if (['transport-finished', 'uncertain'].includes(input.transition))
    assert.deepEqual(await view.startPublicationAsync(), { ok: true });
  report('fixture-sending');
  const before = await execute({ operation: 'load', scope });
  advance = async () => {
    if (armed) throw new Error('duplicate advance');
    armed = true;
    const result =
      input.transition === 'prepared'
        ? await view.completePublicAsync(output)
        : input.transition === 'sending'
          ? await view.startPublicationAsync()
          : input.transition === 'transport-finished'
            ? await view.finishPublicationAsync()
            : await view.withdrawAsync();
    if (input.graceful === true) return result;
    if (!result.ok) {
      report('publication-failed');
      throw new Error('fixture publication failure');
    }
    assert.deepEqual(result, { ok: true });
    report('acknowledged', { record: await execute({ operation: 'load', scope }) });
    await engine.close();
    database?.close();
    process.disconnect();
  };
  let server;
  if (input.graceful === true) {
    let stopping = false;
    const gate = createStoppingAdmission({
      isStopping: () => stopping,
      closeIdleConnections: () => server.closeIdleConnections(),
      async handleRequest(_req, res) {
        try {
          const result = await advance();
          assert.equal(result.ok, false);
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('stopped');
        } catch {
          res.destroy();
          fail();
        }
      },
    });
    server = http.createServer(gate.request);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const shutdown = createProxyShutdown({
      servers: [server],
      async shutdownRecovery() {
        const result = await runtime.shutdownAsync();
        await engine.close();
        database?.close();
        return result;
      },
      stopPid() {
        return true;
      },
      reportFailure() {
        report('shutdown-failed');
      },
    });
    stop = async () => {
      if (stopping) throw new Error('duplicate stop');
      stopping = true;
      const pending = shutdown();
      assert.equal(runtime.inspect().closed, true);
      report('stopping');
      assert.equal(await pending, true);
      report('stopped');
      process.disconnect();
    };
  }
  report('ready', {
    scope,
    targetId,
    record: before,
    ...(server ? { port: server.address().port } : {}),
  });
}
function fail() {
  report('failed');
  process.exitCode = 39;
  process.disconnect();
}
process.on('message', (input) => {
  if (!initialized) {
    initialized = true;
    void initialize(input).catch(fail);
  } else if (input?.operation === 'advance' && advance) {
    void advance().catch(fail);
  } else if (input?.operation === 'stop' && stop) {
    void stop().catch(fail);
  } else if (input?.operation === 'release' && release) {
    release();
    release = undefined;
  } else fail();
});
