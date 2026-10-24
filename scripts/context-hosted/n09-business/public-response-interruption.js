'use strict';

const { types } = require('node:util');
const { exact } = require('../shared/boundary');
const { startObservedContinuation } = require('../n08/observed-client');
const { isN09NativePromise, discardN09PromiseRejection } = require('../n09-ack/contract');
const fail = () => new Error('n09_public_response_interruption_failed');

// start() has already acquired the request when validation of its returned
// observer fails. Release only plain own-data capabilities; never execute an
// accessor or Proxy while attempting cleanup of an invalid result.
function discardStartedObserver(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return;
  const result = Object.getOwnPropertyDescriptor(value, 'result');
  if (result && Object.hasOwn(result, 'value')) discardN09PromiseRejection(result.value);
  const cancel = Object.getOwnPropertyDescriptor(value, 'cancel');
  if (
    !cancel ||
    !Object.hasOwn(cancel, 'value') ||
    typeof cancel.value !== 'function' ||
    types.isProxy(cancel.value) ||
    types.isAsyncFunction(cancel.value) ||
    types.isGeneratorFunction(cancel.value)
  )
    return;
  try {
    discardN09PromiseRejection(Reflect.apply(cancel.value, undefined, []));
  } catch {
    // Construction is already rejected; cleanup errors cannot grant a handle.
  }
}

// A held upstream response is a precise pre-publication boundary, not proof of
// an interrupted SQLite COMMIT or a durable sending/finished transition.
function createPublicResponseInterruption(input, start = startObservedContinuation) {
  let observer,
    started,
    cancelResponse,
    arrived = false,
    ended = false,
    closed = false,
    finished = false,
    closeFailed = false;
  let resolveHeld, rejectHeld;
  const held = new Promise((resolve, reject) => {
    resolveHeld = resolve;
    rejectHeld = reject;
  });
  void held.catch(() => {});
  let timer;
  try {
    if (
      typeof start !== 'function' ||
      types.isProxy(start) ||
      types.isAsyncFunction(start) ||
      types.isGeneratorFunction(start)
    )
      throw fail();
    started = start(input);
    observer = exact(started, ['result', 'bytes', 'termination', 'cancel']);
    discardN09PromiseRejection(observer.result);
    if (
      !isN09NativePromise(observer.result) ||
      ['bytes', 'termination', 'cancel'].some(
        (name) =>
          typeof observer[name] !== 'function' ||
          types.isProxy(observer[name]) ||
          types.isAsyncFunction(observer[name]) ||
          types.isGeneratorFunction(observer[name])
      )
    )
      throw fail();
    // Install both handlers before any hold can arrive. The original observed
    // HTTP client retains its own 15s request deadline and actual byte counter.
    void observer.result.then(
      () => {
        ended = true;
        if (!arrived) rejectHeld(fail());
      },
      () => {
        ended = true;
        rejectHeld(fail());
      }
    );
    timer = setTimeout(() => rejectHeld(fail()), 15000);
  } catch {
    discardStartedObserver(started);
    rejectHeld(fail());
    throw fail();
  }
  function zeroBytes() {
    if (observer.bytes() !== 0) throw fail();
  }
  return Object.freeze({
    arrive(cancel) {
      try {
        if (
          closed ||
          arrived ||
          ended ||
          typeof cancel !== 'function' ||
          types.isProxy(cancel) ||
          types.isAsyncFunction(cancel) ||
          types.isGeneratorFunction(cancel)
        )
          throw fail();
        zeroBytes();
        if (observer.termination() !== 'pending') throw fail();
        arrived = true;
        cancelResponse = cancel;
        clearTimeout(timer);
        resolveHeld();
      } catch {
        throw fail();
      }
    },
    async waitHeld() {
      try {
        await held;
        if (closed || !arrived || ended) throw fail();
        zeroBytes();
        if (observer.termination() !== 'pending') throw fail();
        return Object.freeze({ publicResponseHeld: true, publicBytes: 0 });
      } catch {
        throw fail();
      }
    },
    async afterKill() {
      try {
        if (closed || !arrived || finished) throw fail();
        const result = exact(await observer.result, ['failed']);
        if (result.failed !== true || observer.termination() !== 'transport-error') throw fail();
        zeroBytes();
        finished = true;
        return Object.freeze({ interrupted: true, publicBytes: 0 });
      } catch {
        throw fail();
      }
    },
    close() {
      if (closed) {
        if (closeFailed) throw fail();
        return;
      }
      closed = true;
      clearTimeout(timer);
      rejectHeld(fail());
      let failed = false;
      for (const cancel of [cancelResponse, observer.cancel]) {
        if (!cancel) continue;
        try {
          if (cancel() !== true) throw fail();
        } catch {
          failed = true;
        }
      }
      cancelResponse = undefined;
      closeFailed = failed;
      if (failed) throw fail();
    },
  });
}

module.exports = { createPublicResponseInterruption };
