'use strict';

const { types } = require('node:util');
const {
  createContextRecoverySessions,
  initializeContextRecoveryStorage,
} = require('../../lib/proxy/context-recovery-sessions');
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');
const { createCapacityWorkload, parseProfile } = require('./context-recovery-capacity-workload');

const { declareCapacityFailure } = require('./context-recovery-capacity-failure');
const { createCapacityFailureObserver } = require('./context-recovery-capacity-failure-observer');

const fail = () => new Error('persistent_capacity_execution_failed');

function capabilities(input, names) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw fail();
  const result = Object.create(null);
  for (const name of names) {
    const slot = Object.getOwnPropertyDescriptor(input, name);
    if (
      !slot?.enumerable ||
      !Object.hasOwn(slot, 'value') ||
      typeof slot.value !== 'function' ||
      types.isProxy(slot.value) ||
      types.isGeneratorFunction(slot.value)
    )
      throw fail();
    result[name] = slot.value;
  }
  return result;
}

// The factory supplies actual storage, including its own close acknowledgement.
// No JSON checkpoint export/restore, source transformation, retry or in-memory
// fallback can stand in for reopening that storage. The returned qualification
// covers the workload only; a caller must separately prove native/time identity.
async function exercisePersistentCapacityProfile(input, options, onFirstFailure) {
  const observer = createCapacityFailureObserver(onFirstFailure);
  const profile = parseProfile(input);
  const host = capabilities(options, ['openStorage', 'now', 'advance']);
  if (types.isAsyncFunction(host.now)) throw fail();
  let runtime;
  let storage;
  let operation = 'open',
    stage = 'storage-open',
    commandIndex = 0,
    scheduledMs = 0;
  let primary, cleanup;
  let observedInCommand;
  function note() {
    observedInCommand = true;
    const current = { operation, stage, commandIndex, scheduledMs };
    if (!primary) {
      primary = current;
      observer.notify(primary);
    } else if (
      !cleanup &&
      ['runtime-shutdown', 'storage-close'].includes(stage) &&
      (primary.commandIndex !== commandIndex || primary.stage !== stage)
    )
      cleanup = current;
  }
  async function close() {
    const previousRuntime = runtime;
    const previousStorage = storage;
    runtime = storage = undefined;
    let failed = false;
    try {
      if (previousRuntime) {
        stage = 'runtime-shutdown';
        const result = await previousRuntime.shutdownAsync();
        if (result?.ok !== true) throw fail();
      }
    } catch {
      note();
      failed = true;
    }
    try {
      if (previousStorage) {
        stage = 'storage-close';
        const pending = previousStorage.close();
        const result = nativeReaderPromise(pending) ? await pending : pending;
        if (result !== undefined) throw fail();
      }
    } catch {
      note();
      failed = true;
    }
    if (failed) throw fail();
  }
  async function open() {
    if (runtime || storage) throw fail();
    stage = 'storage-open';
    const pending = host.openStorage();
    const opened = nativeReaderPromise(pending) ? await pending : pending;
    // Retain a plain owned close capability even if another field is malformed,
    // so failed admission cannot strand an already opened worker or database.
    if (
      opened &&
      typeof opened === 'object' &&
      !types.isProxy(opened) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(opened))
    ) {
      const slot = Object.getOwnPropertyDescriptor(opened, 'close');
      if (
        slot?.enumerable &&
        Object.hasOwn(slot, 'value') &&
        typeof slot.value === 'function' &&
        !types.isProxy(slot.value) &&
        !types.isGeneratorFunction(slot.value)
      )
        storage = { close: slot.value.bind(opened) };
    }
    stage = 'storage-admission';
    capabilities(opened, ['execute', 'close']);
    storage = opened;
    runtime = createContextRecoverySessions({ now: host.now });
    stage = 'storage-initialize';
    if ((await initializeContextRecoveryStorage(runtime, storage)).ok !== true) throw fail();
    stage = 'storage-configure';
    if ((await runtime.configureAsync(true)).ok !== true) throw fail();
  }
  async function execute(command) {
    switch (command.operation) {
      case 'open':
        return open();
      case 'advance': {
        const pending = host.advance(command.offsetMs);
        const result = nativeReaderPromise(pending) ? await pending : pending;
        if (result !== undefined) throw fail();
        return;
      }
      case 'begin':
        return runtime.beginAsync(command.binding, command.results, () => true);
      case 'reply':
        return command.session.replyAsync(command.name, command.args);
      case 'complete':
        return command.session.completeObservedAsync(
          command.output,
          command.calls,
          command.responseId
        );
      case 'abort': {
        const result = await command.session.abortAsync();
        if (result?.ok !== true) throw fail();
        return;
      }
      case 'reopen':
        await close();
        return open();
      case 'close':
        return close();
      default:
        throw fail();
    }
  }
  const workload = createCapacityWorkload(profile);
  let reply;
  let failed = false;
  try {
    for (;;) {
      const step = failed ? workload.throw(reply) : workload.next(reply);
      if (step.done) return declareCapacityFailure(step.value, primary, cleanup);
      operation = step.value.operation;
      observedInCommand = false;
      commandIndex++;
      stage = operation;
      if (operation === 'advance') scheduledMs = step.value.offsetMs;
      try {
        reply = await execute(step.value);
        if (
          ['begin', 'reply', 'complete'].includes(operation) &&
          reply &&
          typeof reply === 'object' &&
          !types.isProxy(reply) &&
          Object.getOwnPropertyDescriptor(reply, 'ok')?.value === false
        )
          note();
        failed = false;
      } catch {
        if (!observedInCommand) note();
        reply = fail();
        failed = true;
      }
      if (observer.failed()) {
        reply = fail();
        failed = true;
      }
    }
  } catch {
    throw declareCapacityFailure(fail(), primary, cleanup);
  }
}

module.exports = { exercisePersistentCapacityProfile };
