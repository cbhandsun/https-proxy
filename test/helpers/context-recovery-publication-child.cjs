'use strict';

// Offline process fixture: synthetic key/data travel over private IPC only.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../../lib/proxy/context-recovery-storage-sqlite');
const {
  createContextRecoverySessions,
  attachContextRecoveryStorage,
} = require('../../lib/proxy/context-recovery-sessions');
const {
  declareRecoverySourcePages,
  declareRecoveryReaderSettlement,
  declareRecoveryReferenceStates,
  declareRecoveryReferenceAdmission,
} = require('../../lib/proxy/context-recovery-storage-contract');
const phases = ['prepared', 'sending', 'transport-finished', 'uncertain', 'withdrawn'];
let initialized = false;
let advance;
let release;
const report = (phase, details = {}) => process.send({ phase, ...details });
async function initialize(input) {
  if (
    input?.operation !== 'initialize' ||
    typeof input.file !== 'string' ||
    typeof input.key !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(input.key) ||
    !phases.includes(input.transition) ||
    !['commit', 'ack'].includes(input.boundary)
  )
    throw new Error('invalid fixture');
  let armed = false;
  let committing = false;
  let scope;
  const database = new DatabaseSync(input.file, { allowExtension: false });
  const engine = createRecoverySqliteStore({
    database: {
      prepare: (sql) => database.prepare(sql),
      exec(sql) {
        if (committing && sql === 'COMMIT') report('commit-entering');
        return database.exec(sql);
      },
    },
    dataKey: input.key,
    now: () => 100,
  });
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
        result = engine.execute(request);
      } catch {
        report('engine-failed');
        throw new Error('fixture storage failure');
      } finally {
        committing = false;
      }
      if (target && input.boundary === 'ack') {
        const pending = new Promise((resolve) => {
          release = resolve;
        });
        report('commit-durable', { record: engine.execute({ operation: 'load', scope }) });
        await pending;
      }
      return result;
    },
  };
  declareRecoverySourcePages(storage.execute);
  declareRecoveryReaderSettlement(storage.execute);
  declareRecoveryReferenceStates(storage.execute);
  declareRecoveryReferenceAdmission(storage.execute);
  const runtime = createContextRecoverySessions({ now: () => 100 });
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
  if (['transport-finished', 'uncertain'].includes(input.transition))
    assert.deepEqual(await view.startPublicationAsync(), { ok: true });
  const before = engine.execute({ operation: 'load', scope });
  report('ready', { scope, targetId, record: before });
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
    if (!result.ok) {
      report('publication-failed');
      throw new Error('fixture publication failure');
    }
    assert.deepEqual(result, { ok: true });
    report('acknowledged', { record: engine.execute({ operation: 'load', scope }) });
    engine.close();
    database.close();
    process.disconnect();
  };
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
  } else if (input?.operation === 'release' && release) {
    release();
    release = undefined;
  } else fail();
});
