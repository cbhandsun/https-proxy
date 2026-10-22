'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { safePath } = require('./nsis-encrypted-contract');
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

async function seed(owner) {
  const history = [{ role: 'user', content: 'synthetic runtime revoke and clear' }];
  const tool = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'n09-call', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ],
  };
  const first = await owner.sessions.beginAsync({ ...binding, history }, [], () => true);
  check(first.ok === true);
  ack(
    await first.completeObservedAsync(
      [tool],
      [{ callId: 'n09-call', toolName: 'lookup', arguments: {}, completed: true, output: '' }]
    )
  );
  const capturedHistory = [
    ...history,
    tool,
    { role: 'tool', tool_call_id: 'n09-call', content: original },
  ];
  const second = await owner.sessions.beginAsync(
    { ...binding, history: capturedHistory },
    [{ callId: 'n09-call', output: original }],
    () => true
  );
  check(second.ok === true);
  const answer = [{ role: 'assistant', content: 'done' }];
  ack(await second.completeObservedAsync(answer, [], 'n09-final'));
  const view = await owner.sessions.beginAsync(
    { ...binding, history: [...capturedHistory, ...answer] },
    [],
    () => true
  );
  check(view.ok === true);
  const listed = await view.replyAsync(LIST, {});
  check(listed.ok === true);
  const sources = JSON.parse(listed.text).sources;
  check(Array.isArray(sources) && sources.length === 1);
  const receipt = { sourceId: sources[0].sourceId, digest: sources[0].digest };
  const read = await view.replyAsync(READ, receipt);
  check(read.ok === true && JSON.parse(read.text).page.text === original);
  check(typeof first.snapshotId === 'string');
  const scope = createHash('sha256')
    .update('hpm/recovery-root/v1\0' + first.snapshotId)
    .digest('hex');
  return { view, receipt, scope };
}

async function exerciseCase(dataDirectory, action, api) {
  let owner, storage;
  async function closeOwner() {
    const current = owner;
    owner = undefined;
    if (current) ack(await current.shutdownAsync());
  }
  async function closeStorage() {
    const current = storage;
    storage = undefined;
    if (current) check((await current.close()) === undefined);
  }
  function createOwner() {
    owner = api.createRuntime({ dataDirectory });
    owner.configureSettings(settings);
  }
  async function ready() {
    ack(await owner.ready());
    const state = owner.inspect();
    check(
      state.storage === 'persistent' &&
        state.appliedEnabled === true &&
        state.appliedPersistence === true &&
        state.restartRetention === false
    );
  }
  try {
    createOwner();
    await ready();
    const retained = await seed(owner);
    ack(
      await (action === 'revoke'
        ? owner.sessions.revokeAsync(binding.principal)
        : owner.clearAsync())
    );
    check((await retained.view.replyAsync(READ, retained.receipt)).ok === false);
    await closeOwner();
    storage = await api.openStorage({
      directory: path.join(dataDirectory, 'context-recovery-v1'),
    });
    check((await storage.execute({ operation: 'inspect' })).records === 0);
    check((await storage.execute({ operation: 'load', scope: retained.scope })) === null);
    await closeStorage();
    createOwner();
    await ready();
    const reopened = await owner.sessions.beginAsync(
      {
        ...binding,
        history: [{ role: 'user', content: 'deny the old synthetic receipt' }],
        previousResponseId: 'n09-final',
      },
      [],
      () => true
    );
    check(
      reopened.ok === false ||
        (reopened.ok === true && (await reopened.replyAsync(READ, retained.receipt)).ok === false)
    );
    await closeOwner();
  } finally {
    // Cleanup failures remain failures; no success is constructed before ACKs.
    const results = await Promise.allSettled([closeOwner(), closeStorage()]);
    check(results.every((result) => result.status === 'fulfilled'));
  }
}

// Fixed synthetic assertions only. The caller owns installed identity, the case
// root, retained artifacts and the outer deadline. No configuration is loaded,
// arbitrary existing store cleared, artifact deleted or installed pass granted.
async function exerciseRuntimeReopenRevocation(input) {
  try {
    const api = parseInput(input);
    const { root } = api;
    const before = fs.lstatSync(root);
    const work = fs.mkdtempSync(path.join(root, 'runtime-reopen-'));
    safePath(work, true);
    safePath(root, true);
    check(same(before, fs.lstatSync(root)));
    await exerciseCase(path.join(work, 'revoke'), 'revoke', api);
    await exerciseCase(path.join(work, 'clear'), 'clear', api);
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
