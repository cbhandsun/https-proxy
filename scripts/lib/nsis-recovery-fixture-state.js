'use strict';
const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { fail } = require('./nsis-encrypted-contract');
const original = 'synthetic-installer-evidence-élève🙂';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const request = () => ({
  principal: 'installer-owner',
  protocol: 'chat',
  target: 'installer-target',
  history: [{ role: 'user', content: 'synthetic lifecycle' }],
});
function* recoverySteps(api, operation) {
  if (!['seed', 'read', 'resave'].includes(operation)) throw fail();
  const { sessions, createRootCheckpoint, parseRecoveryStorageRecord, LIST, READ } = api;
  let runtime;
  try {
    let state, scope;
    if (operation === 'seed') {
      runtime = sessions.createContextRecoverySessions();
      runtime.configure(true);
      const first = runtime.begin(request());
      const tool = {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'installer-call', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      };
      if (
        !first.ok ||
        !first.complete(
          [tool],
          [
            {
              callId: 'installer-call',
              toolName: 'lookup',
              arguments: {},
              completed: true,
              output: '',
            },
          ],
          'installer-first'
        ).ok
      )
        throw fail();
      const next = runtime.begin(
        {
          ...request(),
          history: [
            ...request().history,
            tool,
            { role: 'tool', tool_call_id: 'installer-call', content: original },
          ],
        },
        [{ callId: 'installer-call', output: original }]
      );
      if (
        !next.ok ||
        !next.complete([{ role: 'assistant', content: 'done' }], [], 'installer-second').ok
      )
        throw fail();
      state = createRootCheckpoint(
        sessions.exportContextRecoveryRoot(runtime, first.snapshotId),
        []
      );
      scope = hash('hpm/recovery-root/v1\0' + state.root.rootId);
      yield {
        operation: 'save',
        scope,
        expectedRevision: 0,
        expiresAt: state.root.expiresAt,
        state,
      };
    }
    const catalog = yield { operation: 'catalog' };
    if (catalog.length !== 1) throw fail();
    scope = catalog[0].scope;
    const record = parseRecoveryStorageRecord(yield { operation: 'load', scope }, catalog[0]);
    state = record.state;
    runtime?.close();
    runtime = sessions.restoreContextRecoverySessions({}, [
      { binding: request(), state: state.root },
    ]);
    const view = runtime.begin({
      ...request(),
      history: [{ role: 'user', content: 'read synthetic evidence' }],
      previousResponseId: 'installer-second',
    });
    if (!view.ok) throw fail();
    const listing = JSON.parse(view.reply(LIST, {}).text);
    if (listing.sources.length !== 1) throw fail();
    const source = listing.sources[0];
    const page = JSON.parse(
      view.reply(READ, { sourceId: source.sourceId, digest: source.digest }).text
    );
    if (
      page.page.text !== original ||
      state.root.expiresAt !== record.expiresAt ||
      record.expiresAt <= Date.now()
    )
      throw fail();
    view.abort();
    if (operation === 'resave')
      yield {
        operation: 'save',
        scope,
        expectedRevision: record.revision,
        expiresAt: record.expiresAt,
        state,
      };
    return {
      budgetSha256: hash(JSON.stringify(state.root.budget)),
      callCount: state.root.callCount,
      expiresAt: state.root.expiresAt,
      originalSha256: hash(original),
      rootId: state.root.rootId,
      sourceId: source.sourceId,
    };
  } finally {
    runtime?.close();
  }
}
function ordinaryPromise(value) {
  if (!types.isPromise(value) || Object.getPrototypeOf(value) !== Promise.prototype) return false;
  const constructor = Object.getOwnPropertyDescriptor(value, 'constructor');
  return !constructor || (Object.hasOwn(constructor, 'value') && constructor.value === Promise);
}

function exerciseRecovery(api, storage, operation) {
  const steps = recoverySteps(api, operation);
  try {
    let next = steps.next();
    while (!next.done) {
      const result = storage.execute(next.value);
      if (types.isPromise(result)) {
        if (ordinaryPromise(result))
          Promise.prototype.then.call(
            result,
            () => {},
            () => {}
          );
        throw fail();
      }
      next = steps.next(result);
    }
    return next.value;
  } finally {
    steps.return();
  }
}

async function exerciseRecoveryAsync(api, storage, operation) {
  const steps = recoverySteps(api, operation);
  try {
    let next = steps.next();
    while (!next.done) {
      const pending = storage.execute(next.value);
      if (!ordinaryPromise(pending)) throw fail();
      next = steps.next(await pending);
    }
    return next.value;
  } finally {
    steps.return();
  }
}

module.exports = { exerciseRecovery, exerciseRecoveryAsync };
