'use strict';

const { types } = require('node:util');
const { fields, isN09NativePromise, discardN09PromiseRejection } = require('../n09-ack/contract');
const { snapshotOwnData } = require('../shared/boundary');
const { publicationAckCapability } = require('./publication-ack-capability');
const { publicationTransitionRoute } = require('./publication-transition-route');
const fail = () => new Error('n09_prepared_ack_probe_failed');
const signalKeys = [
  'version',
  'pid',
  'epoch',
  'challenge',
  'kind',
  'generation',
  'callOrdinal',
  'rootId',
  'expiresAt',
  'expectedRevision',
  'transition',
  'holdChallenge',
  'revision',
];
const hex = (value) =>
  typeof value === 'string' && value.length === 32 && /^[a-f0-9]{32}$/.test(value);

// Binds the authenticated control channel to one real business checkpoint.
// Signal authentication alone cannot qualify a publication or host-save ACK.
function createPreparedAckProbe(input, observed, control, transition = 'prepared') {
  try {
    const { delta, cancellation: terminal } = publicationTransitionRoute(transition);
    const config = fields(input, ['pid', 'rootId', 'expiresAt', 'revision']);
    const baseline = snapshotOwnData(observed);
    const { methods, cancellation } = publicationAckCapability(control);
    if (terminal && !cancellation) throw fail();
    if (
      !Number.isSafeInteger(config.pid) ||
      config.pid < 1 ||
      typeof config.rootId !== 'string' ||
      config.rootId.length !== 36 ||
      !/^hbs_[a-f0-9]{32}$/.test(config.rootId) ||
      !Number.isSafeInteger(config.expiresAt) ||
      config.expiresAt < 1 ||
      !Number.isSafeInteger(config.revision) ||
      config.revision < 1 ||
      config.revision > Number.MAX_SAFE_INTEGER - delta ||
      baseline.activeCount !== 0 ||
      !['idle', 'completed'].includes(baseline.status) ||
      !Number.isSafeInteger(baseline.generation) ||
      baseline.generation < 1 ||
      baseline.generation > 16 ||
      !Number.isSafeInteger(baseline.callOrdinal) ||
      baseline.callOrdinal < 1 ||
      baseline.callOrdinal + delta > 1024 ||
      Object.values(methods).some(
        (fn) => typeof fn !== 'function' || types.isProxy(fn) || types.isGeneratorFunction(fn)
      ) ||
      ['release', 'close'].some((name) => types.isAsyncFunction(methods[name]))
    )
      throw fail();
    const target = Object.freeze({
      generation: baseline.generation,
      callOrdinal: baseline.callOrdinal,
      rootId: config.rootId,
      expiresAt: config.expiresAt,
      expectedRevision: config.revision + delta - 1,
      transition,
    });
    let state = 'new',
      armed,
      held,
      trigger,
      closeFailed = false;
    function invoke(name, ...args) {
      const result = Reflect.apply(methods[name], control, args);
      if (!isN09NativePromise(result)) {
        discardN09PromiseRejection(result);
        throw fail();
      }
      return new Promise((resolve, reject) =>
        Reflect.apply(Promise.prototype.then, result, [
          (value) => resolve(Object.freeze(Object.assign(Object.create(null), { value }))),
          () => reject(fail()),
        ])
      );
    }
    function signal(value, kind) {
      const result = fields(value, signalKeys);
      if (
        result.version !== 1 ||
        result.kind !== kind ||
        result.pid !== config.pid ||
        !hex(result.epoch) ||
        !hex(result.challenge) ||
        ['generation', 'rootId', 'expiresAt', 'expectedRevision', 'transition'].some(
          (key) => result[key] !== target[key]
        )
      )
        throw fail();
      if (kind === 'armed' || kind === 'armed-cancel') {
        if (
          result.callOrdinal !== target.callOrdinal ||
          result.holdChallenge !== '' ||
          result.revision !== target.expectedRevision
        )
          throw fail();
      } else {
        if (
          result.epoch !== armed.epoch ||
          result.challenge !== armed.challenge ||
          !hex(result.holdChallenge) ||
          !Number.isSafeInteger(result.callOrdinal) ||
          result.callOrdinal < target.callOrdinal + delta - (kind === 'trigger-held' ? 1 : 0) ||
          result.callOrdinal > 1024 ||
          result.revision !== config.revision + delta - (kind === 'trigger-held' ? 1 : 0)
        )
          throw fail();
        if (
          terminal &&
          kind === 'held' &&
          (!trigger ||
            result.callOrdinal <= trigger.callOrdinal ||
            result.holdChallenge === trigger.holdChallenge)
        )
          throw fail();
        if (
          kind === 'released' &&
          ['holdChallenge', 'callOrdinal', 'revision'].some((key) => result[key] !== held[key])
        )
          throw fail();
      }
      return Object.freeze(result);
    }
    async function step(expected, next, run) {
      try {
        if (state !== expected) throw fail();
        state = 'pending';
        const result = await run();
        if (state !== 'pending') throw fail();
        state = next;
        return result;
      } catch {
        if (state !== 'closed') state = 'failed';
        throw fail();
      }
    }
    return Object.freeze({
      arm: () =>
        step('new', 'armed', async () => {
          armed = signal(
            (await invoke(terminal ? 'armCancellation' : 'arm', target)).value,
            terminal ? 'armed-cancel' : 'armed'
          );
        }),
      ...(terminal
        ? {
            waitTriggerHeld: () =>
              step('armed', 'trigger-held', async () => {
                trigger = signal((await invoke('waitTriggerHeld')).value, 'trigger-held');
                return Object.freeze({
                  boundary:
                    (transition === 'withdrawn' ? 'prepared' : 'sending') + '-before-client-cancel',
                  pid: config.pid,
                  expectedRevision: target.expectedRevision,
                  revision: trigger.revision,
                  terminalDurableAck: false,
                });
              }),
            releaseTrigger: (input) =>
              step('trigger-held', 'trigger-released', async () => {
                const witness = fields(input, [
                  'cancelled',
                  'clientTransportClosed',
                  'publicBytes',
                ]);
                if (
                  witness.cancelled !== true ||
                  witness.clientTransportClosed !== true ||
                  witness.publicBytes !== 0
                )
                  throw fail();
                const result = Reflect.apply(methods.releaseTrigger, control, []);
                discardN09PromiseRejection(result);
                if (result !== undefined) throw fail();
                return Object.freeze({ triggerReleaseRequested: true, hostAckDelivered: false });
              }),
          }
        : {}),
      waitHeld: () =>
        step(terminal ? 'trigger-released' : 'armed', 'held', async () => {
          held = signal((await invoke('waitHeld')).value, 'held');
          return Object.freeze({
            boundary: transition + '-durable-store-before-host-ack',
            pid: config.pid,
            expectedRevision: target.expectedRevision,
            revision: held.revision,
            hostAckDelivered: false,
          });
        }),
      release: () =>
        step('held', 'released', async () => {
          const result = Reflect.apply(methods.release, control, []);
          discardN09PromiseRejection(result);
          if (result !== undefined) throw fail();
          signal((await invoke('waitReleased')).value, 'released');
          return Object.freeze({ released: true, hostAckDelivered: false });
        }),
      close() {
        if (state === 'closed') {
          if (closeFailed) throw fail();
          return;
        }
        state = 'closed';
        try {
          const result = Reflect.apply(methods.close, control, []);
          discardN09PromiseRejection(result);
          if (result !== undefined) throw fail();
        } catch {
          closeFailed = true;
          throw fail();
        }
      },
    });
  } catch {
    throw fail();
  }
}

module.exports = { createPreparedAckProbe };
