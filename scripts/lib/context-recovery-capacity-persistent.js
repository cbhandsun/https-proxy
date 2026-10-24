'use strict';

const { types } = require('node:util');
const {
  createContextRecoverySessions,
  initializeContextRecoveryStorage,
} = require('../../lib/proxy/context-recovery-sessions');
const { nativeReaderPromise } = require('../../lib/proxy/context-recovery-reader-result');
const { createCapacityWorkload, parseProfile } = require('./context-recovery-capacity-workload');

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
async function exercisePersistentCapacityProfile(input, options) {
  const profile = parseProfile(input);
  const host = capabilities(options, ['openStorage', 'now', 'advance']);
  if (types.isAsyncFunction(host.now)) throw fail();
  let runtime;
  let storage;
  async function close() {
    const previousRuntime = runtime;
    const previousStorage = storage;
    runtime = storage = undefined;
    let failed = false;
    try {
      if (previousRuntime) {
        const result = await previousRuntime.shutdownAsync();
        if (result?.ok !== true) throw fail();
      }
    } catch {
      failed = true;
    }
    try {
      if (previousStorage) {
        const pending = previousStorage.close();
        const result = nativeReaderPromise(pending) ? await pending : pending;
        if (result !== undefined) throw fail();
      }
    } catch {
      failed = true;
    }
    if (failed) throw fail();
  }
  async function open() {
    if (runtime || storage) throw fail();
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
    capabilities(opened, ['execute', 'close']);
    storage = opened;
    runtime = createContextRecoverySessions({ now: host.now });
    if ((await initializeContextRecoveryStorage(runtime, storage)).ok !== true) throw fail();
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
      if (step.done) return step.value;
      try {
        reply = await execute(step.value);
        failed = false;
      } catch {
        reply = fail();
        failed = true;
      }
    }
  } catch {
    throw fail();
  }
}

module.exports = { exercisePersistentCapacityProfile };
