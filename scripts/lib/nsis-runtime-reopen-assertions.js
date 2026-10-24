'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { safePath } = require('./nsis-encrypted-contract');
const { createRuntimeReopenProgress } = require('./nsis-runtime-reopen-progress');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../../lib/proxy/context-evidence-tools');

const fail = () => new Error('runtime_reopen_assertion_failed');
const check = (value) => {
  if (!value) throw fail();
};
const original = 'synthetic-runtime-reopen\r\nélève🙂';
const settings = {
  appSettings: { contextRecoveryEnabled: true, contextRecoveryPersistenceEnabled: true },
};
const binding = { principal: 'n09-owner', protocol: 'chat', target: 'n09-target' };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

function record(input) {
  check(
    input !== null &&
      typeof input === 'object' &&
      !types.isProxy(input) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(input))
  );
  return input;
}

function own(input, key) {
  const slot = Object.getOwnPropertyDescriptor(record(input), key);
  check(slot && slot.enumerable && Object.hasOwn(slot, 'value'));
  return slot.value;
}

function capability(input, key) {
  record(input);
  check(Reflect.ownKeys(input).length === 1);
  const method = own(input, key);
  check(typeof method === 'function' && !types.isProxy(method));
  return (...args) => Reflect.apply(method, input, args);
}

function parseInput(input) {
  const keys = Reflect.ownKeys(record(input));
  const explicit = keys.length === 3;
  check(
    (keys.length === 1 && keys[0] === 'caseRoot') ||
      (explicit && keys.every((key) => ['caseRoot', 'runtimeApi', 'storageApi'].includes(key)))
  );
  const value = own(input, 'caseRoot');
  check(typeof value === 'string' && value.length <= 4096);
  const root = safePath(value, true);
  check(root !== path.parse(root).root);
  // Only a trusted composition root may supply already verified installed API
  // capabilities. No module path is accepted, and explicit mode never falls back.
  const createRuntime = explicit
    ? capability(own(input, 'runtimeApi'), 'createContextRecoveryRuntime')
    : require('../../lib/proxy/context-recovery-runtime').createContextRecoveryRuntime;
  const openStorage = explicit
    ? capability(own(input, 'storageApi'), 'openContextRecoveryStorage')
    : require('../../lib/proxy/context-recovery-storage').openContextRecoveryStorage;
  return { root, createRuntime, openStorage };
}

function ack(value) {
  check(value && Object.keys(value).join(',') === 'ok' && value.ok === true);
}

async function seed(owner, run) {
  const history = [{ role: 'user', content: 'synthetic runtime revoke and clear' }];
  const tool = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'n09-call', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ],
  };
  const first = await run('seed-first-begin', () =>
    owner.sessions.beginAsync({ ...binding, history }, [], () => true)
  );
  check(first.ok === true);
  ack(
    await run('seed-first-complete', () =>
      first.completeObservedAsync(
        [tool],
        [{ callId: 'n09-call', toolName: 'lookup', arguments: {}, completed: true, output: '' }]
      )
    )
  );
  const capturedHistory = [
    ...history,
    tool,
    { role: 'tool', tool_call_id: 'n09-call', content: original },
  ];
  const second = await run('seed-capture-begin', () =>
    owner.sessions.beginAsync(
      { ...binding, history: capturedHistory },
      [{ callId: 'n09-call', output: original }],
      () => true
    )
  );
  check(second.ok === true);
  const answer = [{ role: 'assistant', content: 'done' }];
  ack(
    await run('seed-capture-complete', () => second.completeObservedAsync(answer, [], 'n09-final'))
  );
  const view = await run('seed-view-begin', () =>
    owner.sessions.beginAsync(
      { ...binding, history: [...capturedHistory, ...answer] },
      [],
      () => true
    )
  );
  check(view.ok === true);
  const listed = await run('seed-list', () => view.replyAsync(LIST, {}));
  check(listed.ok === true);
  const sources = JSON.parse(listed.text).sources;
  check(Array.isArray(sources) && sources.length === 1);
  const receipt = { sourceId: sources[0].sourceId, digest: sources[0].digest };
  const read = await run('seed-read', () => view.replyAsync(READ, receipt));
  check(read.ok === true && JSON.parse(read.text).page.text === original);
  check(typeof first.snapshotId === 'string');
  const scope = createHash('sha256')
    .update('hpm/recovery-root/v1\0' + first.snapshotId)
    .digest('hex');
  return { view, receipt, scope };
}

async function exerciseCase(dataDirectory, action, api, progress) {
  const run = (phase, operation) => progress.run(action, phase, operation);
  let owner, storage;
  async function closeOwner(phase = 'owner-shutdown') {
    const current = owner;
    owner = undefined;
    if (current) ack(await run(phase, () => current.shutdownAsync()));
  }
  async function closeStorage(phase = 'direct-close') {
    const current = storage;
    storage = undefined;
    if (current) check((await run(phase, () => current.close())) === undefined);
  }
  function createOwner() {
    owner = api.createRuntime({ dataDirectory });
    owner.configureSettings(settings);
  }
  async function ready(phase) {
    ack(await run(phase, () => owner.ready()));
    const state = owner.inspect();
    check(
      state.storage === 'persistent' &&
        state.appliedEnabled === true &&
        state.appliedPersistence === true &&
        state.restartRetention === false
    );
  }
  try {
    await run('initial-create', createOwner);
    await ready('initial-ready');
    const retained = await seed(owner, run);
    ack(
      await run('invalidate', () =>
        action === 'revoke' ? owner.sessions.revokeAsync(binding.principal) : owner.clearAsync()
      )
    );
    check(
      (await run('denied-read', () => retained.view.replyAsync(READ, retained.receipt))).ok ===
        false
    );
    await closeOwner();
    await run('direct-open', async () => {
      storage = await api.openStorage({
        directory: path.join(dataDirectory, 'context-recovery-v1'),
      });
    });
    check(
      (await run('direct-inspect', () => storage.execute({ operation: 'inspect' }))).records === 0
    );
    check(
      (await run('direct-load', () =>
        storage.execute({ operation: 'load', scope: retained.scope })
      )) === null
    );
    await closeStorage();
    await run('reopen-create', createOwner);
    await ready('reopen-ready');
    const reopened = await run('reopen-begin', () =>
      owner.sessions.beginAsync(
        {
          ...binding,
          history: [{ role: 'user', content: 'deny the old synthetic receipt' }],
          previousResponseId: 'n09-final',
        },
        [],
        () => true
      )
    );
    check(
      reopened.ok === false ||
        (reopened.ok === true &&
          (await run('reopen-denied-read', () => reopened.replyAsync(READ, retained.receipt)))
            .ok === false)
    );
    await closeOwner('reopen-shutdown');
  } finally {
    // Cleanup failures remain failures; no success is constructed before ACKs.
    const results = await Promise.allSettled([
      closeOwner('cleanup-owner'),
      closeStorage('cleanup-storage'),
    ]);
    check(results.every((result) => result.status === 'fulfilled'));
  }
}

// Fixed synthetic assertions only. The caller owns installed identity, the case
// root, retained artifacts and the outer deadline. No configuration is loaded,
// arbitrary existing store cleared, artifact deleted or installed pass granted.
async function exerciseRuntimeReopenRevocation(input, options) {
  try {
    const progress = createRuntimeReopenProgress(options);
    const api = parseInput(input);
    const { root } = api;
    const before = fs.lstatSync(root);
    const work = fs.mkdtempSync(path.join(root, 'runtime-reopen-'));
    safePath(work, true);
    safePath(root, true);
    check(same(before, fs.lstatSync(root)));
    await exerciseCase(path.join(work, 'revoke'), 'revoke', api, progress);
    await exerciseCase(path.join(work, 'clear'), 'clear', api, progress);
    return {
      schemaVersion: 1,
      checks: {
        persistentRuntimeRead: true,
        principalRevokeAcknowledged: true,
        principalReopenDenied: true,
        clearAcknowledged: true,
        clearReopenDenied: true,
        allOwnersClosed: true,
      },
      installationQualified: false,
      restartRetention: false,
    };
  } catch {
    throw fail();
  }
}

module.exports = { exerciseRuntimeReopenRevocation };
