'use strict';

const { types } = require('node:util');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { exact } = require('../shared/boundary');
const {
  startObservedContinuation,
  startCancellationObservedContinuation,
} = require('../n08/observed-client');
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
    releaseResponse,
    releaseAttempted = false,
    released = false,
    arrived = false,
    ended = false,
    closed = false,
    finished = false,
    closeFailed = false,
    published,
    observingPublished = false,
    publishedFailed = false,
    cancellationAttempted = false,
    cancellationFailed = false,
    cancelled = false;
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
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  async function readPublished(deadline) {
    if (
      closed ||
      !released ||
      finished ||
      publishedFailed ||
      cancellationAttempted ||
      cancellationFailed
    )
      throw fail();
    let timeout;
    let raw;
    try {
      raw =
        deadline === undefined
          ? await observer.result
          : await Promise.race([
              observer.result,
              new Promise((_, reject) => {
                timeout = setTimeout(
                  () => reject(fail()),
                  Math.max(1, deadline - performance.now())
                );
              }),
            ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const result = exact(raw, ['response']);
    if (
      closed ||
      finished ||
      publishedFailed ||
      (deadline !== undefined && performance.now() >= deadline)
    )
      throw fail();
    const response = exact(result.response, ['status', 'bytes']);
    if (
      response.status !== 200 ||
      types.isProxy(response.bytes) ||
      !Buffer.isBuffer(response.bytes) ||
      response.bytes.length < 1 ||
      response.bytes.length > 262144 ||
      observer.bytes() !== response.bytes.length ||
      observer.termination() !== 'response'
    )
      throw fail();
    const bytes = Buffer.from(response.bytes);
    if (published && (published.bytes !== bytes.length || published.digest !== digest(bytes))) {
      publishedFailed = true;
      throw fail();
    }
    if (
      closed ||
      finished ||
      publishedFailed ||
      (deadline !== undefined && performance.now() >= deadline)
    )
      throw fail();
    return Object.freeze({ response: Object.freeze({ status: response.status, bytes }) });
  }
  return Object.freeze({
    arrive(cancel, release) {
      try {
        if (
          closed ||
          arrived ||
          ended ||
          typeof cancel !== 'function' ||
          types.isProxy(cancel) ||
          types.isAsyncFunction(cancel) ||
          types.isGeneratorFunction(cancel) ||
          (release !== undefined &&
            (typeof release !== 'function' ||
              types.isProxy(release) ||
              types.isAsyncFunction(release) ||
              types.isGeneratorFunction(release)))
        )
          throw fail();
        zeroBytes();
        if (observer.termination() !== 'pending') throw fail();
        arrived = true;
        cancelResponse = cancel;
        releaseResponse = release;
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
    releaseUpstream() {
      try {
        if (closed || !arrived || ended || releaseAttempted || !releaseResponse) throw fail();
        zeroBytes();
        if (observer.termination() !== 'pending') throw fail();
        releaseAttempted = true;
        const result = releaseResponse();
        if (result !== true) {
          discardN09PromiseRejection(result);
          throw fail();
        }
        released = true;
        releaseResponse = undefined;
        zeroBytes();
        return Object.freeze({ upstreamReleased: true, publicBytes: 0 });
      } catch {
        throw fail();
      }
    },
    assertReleasedPending() {
      try {
        if (closed || !released || ended || finished || cancellationAttempted || cancellationFailed)
          throw fail();
        zeroBytes();
        if (observer.termination() !== 'pending') throw fail();
        return Object.freeze({ upstreamReleased: true, publicBytes: 0 });
      } catch {
        throw fail();
      }
    },
    async cancelReleased(timeoutMs = 750) {
      let timeout;
      try {
        if (
          closed ||
          !released ||
          ended ||
          finished ||
          published ||
          observingPublished ||
          publishedFailed ||
          cancellationAttempted ||
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs > 750
        )
          throw fail();
        zeroBytes();
        if (observer.termination() !== 'pending') throw fail();
        cancellationAttempted = true;
        const deadline = performance.now() + timeoutMs;
        const result = observer.cancel();
        discardN09PromiseRejection(result);
        if (result !== true) throw fail();
        if (!isN09NativePromise(observer.result)) {
          discardN09PromiseRejection(observer.result);
          throw fail();
        }
        const reply = exact(
          await Promise.race([
            observer.result,
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(fail()), Math.max(1, deadline - performance.now()));
            }),
          ]),
          ['failed']
        );
        if (
          closed ||
          cancellationFailed ||
          performance.now() >= deadline ||
          reply.failed !== true ||
          observer.termination() !== 'cancelled-transport'
        )
          throw fail();
        zeroBytes();
        cancelled = true;
        return Object.freeze({ cancelled: true, clientTransportClosed: true, publicBytes: 0 });
      } catch {
        cancellationFailed = true;
        throw fail();
      } finally {
        clearTimeout(timeout);
      }
    },
    assertCancelled() {
      try {
        if (
          closed ||
          !cancelled ||
          cancellationFailed ||
          observer.termination() !== 'cancelled-transport'
        )
          throw fail();
        zeroBytes();
        return Object.freeze({ cancelled: true, clientTransportClosed: true, publicBytes: 0 });
      } catch {
        cancellationFailed = true;
        throw fail();
      }
    },
    async observePublished(timeoutMs = 750) {
      try {
        if (
          published ||
          observingPublished ||
          publishedFailed ||
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs > 750
        )
          throw fail();
        observingPublished = true;
        const deadline = performance.now() + timeoutMs;
        const result = await readPublished(deadline);
        if (publishedFailed || closed || finished) throw fail();
        const observed = Object.freeze({
          bytes: result.response.bytes.length,
          digest: digest(result.response.bytes),
        });
        if (performance.now() >= deadline) throw fail();
        published = observed;
        return result;
      } catch {
        publishedFailed = true;
        throw fail();
      } finally {
        observingPublished = false;
      }
    },
    async afterPublishedKill() {
      try {
        if (!published || observingPublished || publishedFailed) throw fail();
        const result = await readPublished();
        finished = true;
        return Object.freeze({
          publicTransportCompleted: true,
          publicBytes: result.response.bytes.length,
        });
      } catch {
        publishedFailed = true;
        throw fail();
      }
    },
    async afterRelease() {
      try {
        if (observingPublished) {
          publishedFailed = true;
          throw fail();
        }
        const result = await readPublished();
        finished = true;
        return result;
      } catch {
        throw fail();
      }
    },
    async afterKill() {
      try {
        if (
          closed ||
          !arrived ||
          finished ||
          cancellationAttempted ||
          cancellationFailed ||
          (releaseAttempted && !released)
        )
          throw fail();
        const result = exact(await observer.result, ['failed']);
        if (closed || finished) throw fail();
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
      cancelResponse = releaseResponse = published = undefined;
      closeFailed = failed;
      if (failed) throw fail();
    },
  });
}

const createCancellationPublicResponseInterruption = (
  input,
  start = startCancellationObservedContinuation
) => createPublicResponseInterruption(input, start);
module.exports = { createPublicResponseInterruption, createCancellationPublicResponseInterruption };
