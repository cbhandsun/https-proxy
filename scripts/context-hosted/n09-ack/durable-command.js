'use strict';

const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const {
  fields,
  fail,
  parseN09AckCommand,
  parseN09AckReceipt,
  isN09NativePromise,
  discardN09PromiseRejection,
} = require('./contract');
const clock = () => performance.now();
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

// One fixed 15s operation budget, matching the existing synthetic business
// request budget. It is never restarted between armed and final receipt.
async function performN09DurableCommand(input, supplied, timing = { now: clock, pause }) {
  try {
    const command = fields(input, ['pid', 'operation', 'rootId', 'expiresAt', 'minRevision']);
    const hooks = fields(supplied, ['client', 'startSave']);
    const methods = fields(hooks.client, ['submit', 'readArmed', 'readReceipt', 'close']);
    const time = fields(timing, ['now', 'pause']);
    for (const method of [...Object.values(methods), hooks.startSave, time.now, time.pause])
      if (typeof method !== 'function' || types.isProxy(method)) throw fail();
    if (
      !Number.isSafeInteger(command.pid) ||
      command.pid < 1 ||
      !['save', 'revoke'].includes(command.operation)
    )
      throw fail();
    parseN09AckCommand({
      version: 1,
      pid: command.pid,
      epoch: '0'.repeat(32),
      sequence: 1,
      operation: command.operation === 'save' ? 'arm-save' : 'revoke-bound-root',
      rootId: command.rootId,
      expiresAt: command.expiresAt,
      minRevision: command.minRevision,
    });
    if (
      types.isAsyncFunction(hooks.startSave) ||
      Object.values(methods).some((method) => types.isAsyncFunction(method))
    )
      throw fail();
    const started = time.now();
    if (typeof started !== 'number' || !Number.isFinite(started) || started < 0) throw fail();
    let last = started;
    async function wait() {
      const pending = time.pause();
      if (!isN09NativePromise(pending)) {
        discardN09PromiseRejection(pending);
        throw fail();
      }
      await pending;
    }
    function withinBudget() {
      const value = time.now();
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < last ||
        value - started >= 15000
      )
        throw fail();
      last = value;
    }
    function sync(name, args = []) {
      const value = Reflect.apply(methods[name], hooks.client, args);
      if (types.isPromise(value)) {
        discardN09PromiseRejection(value);
        throw fail();
      }
      return value;
    }
    const submitted = sync('submit', [
      {
        operation: command.operation === 'save' ? 'arm-save' : 'revoke-bound-root',
        rootId: command.rootId,
        expiresAt: command.expiresAt,
        minRevision: command.minRevision,
      },
    ]);
    if (submitted !== undefined) throw fail();
    if (command.operation === 'save') {
      for (;;) {
        withinBudget();
        const armed = sync('readArmed');
        if (armed === true) break;
        if (armed !== false) throw fail();
        await wait();
      }
      withinBudget();
      const startedSave = Reflect.apply(hooks.startSave, undefined, []);
      if (startedSave !== undefined) {
        discardN09PromiseRejection(startedSave);
        throw fail();
      }
    }
    for (;;) {
      withinBudget();
      const value = sync('readReceipt');
      if (value !== null) {
        const receipt = parseN09AckReceipt(value);
        if (
          receipt.pid !== command.pid ||
          receipt.rootId !== command.rootId ||
          receipt.expiresAt !== command.expiresAt ||
          receipt.kind !== 'host-' + command.operation + '-completed' ||
          (command.operation === 'save'
            ? receipt.revision <= command.minRevision
            : receipt.revision !== command.minRevision)
        )
          throw fail();
        withinBudget();
        return receipt;
      }
      await wait();
    }
  } catch {
    throw fail();
  }
}

module.exports = { performN09DurableCommand };
