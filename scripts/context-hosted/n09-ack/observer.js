'use strict';

const { types } = require('node:util');
const { parseReferenceState } = require('../../../lib/proxy/context-recovery-reference-state');
const { fields, fail, parseN09AckCommand, parseN09AckReceipt } = require('./contract');

// No transport, filesystem, timer, model or execution capability is provided.
// Installation must bind the actual runtime sessions instance before any ACK.
function createN09HostAckObserver(input) {
  try {
    const config = fields(input, ['pid', 'epoch', 'createRecoveryDurableAck']);
    const original = config.createRecoveryDurableAck;
    if (
      !Number.isSafeInteger(config.pid) ||
      config.pid < 1 ||
      typeof config.epoch !== 'string' ||
      config.epoch.length !== 32 ||
      !/^[a-f0-9]{32}$/.test(config.epoch) ||
      typeof original !== 'function' ||
      types.isProxy(original) ||
      types.isAsyncFunction(original)
    )
      throw fail();
    let sessions, revoke, observed, pending, cancelRevoke;
    let closed = false,
      failed = false,
      revoked = false,
      revoking = false,
      sequence = 0;
    function available() {
      if (closed || failed) throw fail();
    }
    function rejectPending() {
      if (cancelRevoke) {
        const cancel = cancelRevoke;
        cancelRevoke = undefined;
        cancel(fail());
      }
      if (pending) {
        const previous = pending;
        pending = undefined;
        previous.reject(fail());
      }
    }
    function abort() {
      failed = true;
      observed = undefined;
      rejectPending();
    }
    function command(input, operation) {
      available();
      const value = parseN09AckCommand(input);
      if (
        !sessions ||
        !observed ||
        revoked ||
        revoking ||
        pending ||
        value.operation !== operation ||
        value.pid !== config.pid ||
        value.epoch !== config.epoch ||
        value.sequence !== sequence + 1 ||
        value.rootId !== observed.rootId ||
        value.expiresAt !== observed.expiresAt ||
        value.minRevision !== observed.revision
      )
        throw fail();
      sequence = value.sequence;
      return value;
    }
    function receipt(value, kind, state) {
      return parseN09AckReceipt({
        version: 1,
        kind,
        durableBoundary:
          kind === 'host-save-completed' ? 'await-reference-save' : 'await-revokeAsync',
        pid: config.pid,
        epoch: config.epoch,
        sequence: value.sequence,
        rootId: state.rootId,
        expiresAt: state.expiresAt,
        revision: state.revision,
        calls: state.calls,
        returnedBytes: state.returnedBytes,
        // For revoke this is the last validated SAVE revision, never an invented tombstone revision.
        revisionSource: 'validated-reference-save',
        evidenceLevel: 'observer-boundary-only',
        liveDaemonProved: false,
      });
    }
    return Object.freeze({
      bindSessions(input) {
        try {
          available();
          if (
            sessions ||
            !input ||
            typeof input !== 'object' ||
            types.isProxy(input) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(input))
          )
            throw fail();
          const slot = Object.getOwnPropertyDescriptor(input, 'revokeAsync');
          if (
            !slot?.enumerable ||
            !Object.hasOwn(slot, 'value') ||
            typeof slot.value !== 'function' ||
            types.isProxy(slot.value)
          )
            throw fail();
          sessions = input;
          revoke = slot.value;
        } catch {
          throw fail();
        }
      },
      createRecoveryDurableAck(input, revision) {
        try {
          available();
          if (!sessions || revoked || revoking || !Number.isSafeInteger(revision) || revision < 1)
            throw fail();
          const reference = parseReferenceState(input);
          const metadata = reference.metadata;
          const state = Object.freeze({
            rootId: metadata.rootId,
            principal: metadata.principal,
            expiresAt: metadata.expiresAt,
            revision,
            calls: metadata.budget.calls,
            returnedBytes: metadata.budget.returnedBytes,
          });
          if (
            observed &&
            (state.rootId !== observed.rootId ||
              state.principal !== observed.principal ||
              state.expiresAt !== observed.expiresAt ||
              revision <= observed.revision ||
              state.calls < observed.calls ||
              state.returnedBytes < observed.returnedBytes)
          )
            throw fail();
          // The exact trusted producer runs first. No observation is published on failure.
          const token = Reflect.apply(original, undefined, [reference, revision]);
          fields(token, []);
          if (!Object.isFrozen(token)) throw fail();
          available();
          observed = state;
          if (pending && revision > pending.command.minRevision) {
            const completed = pending;
            const result = receipt(completed.command, 'host-save-completed', state);
            pending = undefined;
            completed.resolve(result);
          }
          return token;
        } catch {
          abort();
          throw fail();
        }
      },
      armSave(input) {
        try {
          const value = command(input, 'arm-save');
          return new Promise((resolve, reject) => {
            pending = { command: value, resolve, reject };
          });
        } catch {
          throw fail();
        }
      },
      async revokeBoundRoot(input) {
        let started = false;
        try {
          const value = command(input, 'revoke-bound-root');
          const state = observed;
          revoking = true;
          started = true;
          const result = Reflect.apply(revoke, sessions, [state.principal]);
          // Await only a native promise; never evaluate a then getter from an unknown result.
          if (!types.isPromise(result) || types.isProxy(result)) throw fail();
          available();
          const completed = new Promise((resolve, reject) => {
            Reflect.apply(Promise.prototype.then, result, [
              (value) => {
                try {
                  resolve(fields(value, ['ok']));
                } catch {
                  reject(fail());
                }
              },
              () => reject(fail()),
            ]);
          });
          const cancelled = new Promise((resolve, reject) => {
            cancelRevoke = reject;
          });
          const acknowledgement = await Promise.race([completed, cancelled]);
          available();
          if (acknowledgement.ok !== true) throw fail();
          revoked = true;
          return receipt(value, 'host-revoke-completed', state);
        } catch {
          if (started) abort();
          throw fail();
        } finally {
          if (started) {
            cancelRevoke = undefined;
            revoking = false;
          }
        }
      },
      close() {
        closed = true;
        rejectPending();
        observed = sessions = revoke = undefined;
      },
    });
  } catch {
    throw fail();
  }
}

module.exports = { createN09HostAckObserver };
