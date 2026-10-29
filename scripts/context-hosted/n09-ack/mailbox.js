'use strict';

const { types } = require('node:util');
const {
  createN09AckContract,
  fields,
  fail,
  isN09NativePromise,
  discardN09PromiseRejection,
  n09AckFailureStage,
  wrapN09AckFailure,
} = require('./contract');
const { createN09MailboxControl } = require('./mailbox-control');
const { createN09MailboxFiles } = require('./mailbox-files');

function components(input) {
  const config = fields(input, ['directory', 'pid', 'epoch', 'signingKey']);
  const identity = { pid: config.pid, epoch: config.epoch, signingKey: config.signingKey };
  const files = createN09MailboxFiles({ directory: config.directory, pid: config.pid });
  let contract, control;
  try {
    contract = createN09AckContract(identity);
    control = createN09MailboxControl(identity);
  } catch {
    files.close();
    contract?.close();
    throw fail();
  }
  return { pid: config.pid, epoch: config.epoch, files, contract, control };
}
function methods(input) {
  const result = fields(input, ['armSave', 'revokeBoundRoot', 'close']);
  for (const value of Object.values(result))
    if (typeof value !== 'function' || types.isProxy(value)) throw fail();
  if (types.isAsyncFunction(result.close)) throw fail();
  return result;
}
function closeAll(values) {
  let failed = false;
  for (const value of values) {
    try {
      const result = value.close();
      if (result !== undefined) {
        discardN09PromiseRejection(result);
        throw fail();
      }
    } catch {
      failed = true;
    }
  }
  if (failed) throw fail();
}

// Passive construction. start() is for the verified disposable host only;
// step() exercises the same state machine in filesystem-only regression tests.
function createN09MailboxHost(input, suppliedHooks) {
  let context;
  try {
    const hooks = methods(suppliedHooks);
    context = components(input);
    const { pid, epoch, files, contract, control } = context;
    let closed = false,
      closeFailed = false,
      failed = false,
      sequence = 0,
      active,
      timer;
    function failure(at, error, stage) {
      if (closed || failed) return;
      failed = true;
      try {
        files.write(
          'failure',
          at,
          control.sign({
            version: 1,
            pid,
            epoch,
            sequence: at,
            state: 'failed',
            stage: n09AckFailureStage(error) ?? stage,
          })
        );
      } catch {
        /* A compromised mailbox can never yield a success receipt. */
      }
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }
    function step() {
      if (closed || failed) throw fail();
      if (active) return 'pending';
      if (sequence === 16) return 'exhausted';
      const at = sequence + 1;
      let stage = 140;
      try {
        const envelope = files.read('command', at);
        if (envelope === null) return 'idle';
        stage = 141;
        const command = contract.verifyCommand(envelope);
        if (command.sequence !== at) throw fail();
        stage = 156;
        const pending =
          command.operation === 'arm-save'
            ? hooks.armSave(command)
            : hooks.revokeBoundRoot(command);
        if (!isN09NativePromise(pending)) {
          discardN09PromiseRejection(pending);
          throw fail();
        }
        active = command;
        sequence = at;
        // Install both observers before publishing armed; reject is always consumed.
        Reflect.apply(Promise.prototype.then, pending, [
          (value) => {
            if (closed || failed) return;
            let receiptStage = 148;
            try {
              const envelope = contract.signReceipt(value);
              const receipt = envelope.payload;
              if (
                receipt.sequence !== command.sequence ||
                receipt.rootId !== command.rootId ||
                receipt.expiresAt !== command.expiresAt ||
                receipt.kind !==
                  (command.operation === 'arm-save'
                    ? 'host-save-completed'
                    : 'host-revoke-completed') ||
                (command.operation === 'arm-save'
                  ? receipt.revision <= command.minRevision
                  : receipt.revision !== command.minRevision)
              )
                throw fail();
              receiptStage = 149;
              files.write('receipt', at, envelope);
              active = undefined;
            } catch (error) {
              failure(at, error, receiptStage);
            }
          },
          (error) => {
            failure(at, error, 157);
          },
        ]);
        if (command.operation === 'arm-save')
          files.write(
            'control',
            at,
            control.sign({ version: 1, pid, epoch, sequence: at, state: 'armed' })
          );
        return command.operation === 'arm-save' ? 'armed' : 'revoking';
      } catch (error) {
        failure(at, error, stage);
        throw wrapN09AckFailure(error, stage);
      }
    }
    return Object.freeze({
      step,
      start() {
        if (closed || failed || timer) throw fail();
        timer = setInterval(() => {
          try {
            step();
          } catch {
            /* Signed failure state only. */
          }
        }, 10);
        timer.unref();
      },
      close() {
        if (closed) {
          if (closeFailed) throw fail();
          return;
        }
        closed = true;
        if (timer) clearInterval(timer);
        active = undefined;
        try {
          closeAll([hooks, files, contract, control]);
        } catch {
          closeFailed = true;
          throw fail();
        }
      },
    });
  } catch {
    if (context) {
      try {
        closeAll([context.files, context.contract, context.control]);
      } catch {
        /* Fixed error below. */
      }
    }
    throw fail();
  }
}

function createN09MailboxClient(input) {
  let context;
  try {
    context = components(input);
    const { files, contract, control } = context;
    let closed = false,
      sequence = 0,
      current;
    function available() {
      if (closed || !current) throw fail();
      const failure = files.read('failure', current.sequence);
      if (failure !== null) {
        const signal = control.verify(failure);
        if (signal.sequence !== current.sequence || signal.state !== 'failed') throw fail();
        throw fail(signal.stage ?? 157);
      }
    }
    return Object.freeze({
      submit(input) {
        try {
          if (closed || current || sequence === 16) throw fail();
          const envelope = contract.signCommand(input);
          if (envelope.payload.sequence !== sequence + 1) throw fail();
          files.write('command', envelope.payload.sequence, envelope);
          current = envelope.payload;
          sequence++;
        } catch (error) {
          throw wrapN09AckFailure(error, 150);
        }
      },
      readArmed() {
        try {
          available();
          if (current.operation !== 'arm-save') throw fail();
          const envelope = files.read('control', sequence);
          if (envelope === null) return false;
          const signal = control.verify(envelope);
          if (signal.sequence !== sequence || signal.state !== 'armed') throw fail();
          return true;
        } catch (error) {
          throw wrapN09AckFailure(error, 151);
        }
      },
      readReceipt() {
        try {
          available();
          const envelope = files.read('receipt', sequence);
          if (envelope === null) return null;
          const receipt = contract.verifyReceipt(envelope);
          if (
            receipt.sequence !== sequence ||
            receipt.rootId !== current.rootId ||
            receipt.expiresAt !== current.expiresAt ||
            receipt.kind !==
              (current.operation === 'arm-save'
                ? 'host-save-completed'
                : 'host-revoke-completed') ||
            (current.operation === 'arm-save'
              ? receipt.revision <= current.minRevision
              : receipt.revision !== current.minRevision)
          )
            throw fail();
          current = undefined;
          return receipt;
        } catch (error) {
          throw wrapN09AckFailure(error, 152);
        }
      },
      close() {
        closed = true;
        current = undefined;
        closeAll([files, contract, control]);
      },
    });
  } catch {
    if (context) {
      try {
        closeAll([context.files, context.contract, context.control]);
      } catch {
        /* Fixed error below. */
      }
    }
    throw fail();
  }
}

module.exports = { createN09MailboxHost, createN09MailboxClient };
