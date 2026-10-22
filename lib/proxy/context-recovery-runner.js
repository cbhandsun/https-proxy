'use strict';

const { decodeContextRecoveryEnvelope } = require('./context-recovery-protocol');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { parseRecoveryProgress } = require('./context-recovery-progress');

// The composition layer supplies an authenticated, pinned dispatch operation.
// No retry, fallback profile, external tool executor or client write exists here.
// The caller commits the session and encodes the final protocol response only
// after this bounded run succeeds. Every private phase remains observable in usage.
async function runContextRecovery({ kind, body, session, dispatch, signal, timeoutMs = 60000 }) {
  if (
    typeof dispatch !== 'function' ||
    (signal !== undefined && !(signal instanceof globalThis.AbortSignal)) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000
  )
    throw new TypeError('Invalid recovery runner capability');
  const run = session.recovery(body);
  if (!run.ok) return run;
  const controller = new globalThis.AbortController();
  let expired = false;
  let abortListener;
  let usage = [];
  let rounds = 0;
  let calls = 0;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => {
    expired = true;
    cancel();
  }, timeoutMs);
  const interrupted = new Promise((resolve) => {
    abortListener = () => resolve(null);
    controller.signal.addEventListener('abort', abortListener, { once: true });
    if (controller.signal.aborted) resolve(null);
  });
  function failure(code) {
    // A completed upstream response can already be charged while its durable
    // reader is still awaiting reservation/settlement. Preserve that progress
    // on timeout/cancel instead of reporting a free zero-round failure.
    const inspect = Object.getOwnPropertyDescriptor(run, 'inspectProgress');
    if (typeof inspect?.value === 'function') {
      try {
        const progress = parseRecoveryProgress(inspect.value.call(run));
        usage = progress.usage;
        rounds = progress.rounds;
        calls = progress.calls;
      } catch {
        code = 'context_recovery_invalid_progress';
      }
    }
    run.cancel();
    return { ok: false, code, usage, rounds, calls };
  }
  try {
    let request = run.initialRequest;
    for (;;) {
      if (controller.signal.aborted)
        return failure(expired ? 'context_recovery_timeout' : 'context_recovery_cancelled');
      const result = await Promise.race([
        Promise.resolve().then(() =>
          controller.signal.aborted ? null : dispatch(request, { signal: controller.signal })
        ),
        interrupted,
      ]);
      if (controller.signal.aborted)
        return failure(expired ? 'context_recovery_timeout' : 'context_recovery_cancelled');
      const fields = result && Object.getOwnPropertyDescriptors(result);
      if (
        !fields ||
        ['statusCode', 'wire', 'stream'].some(
          (key) => !fields[key] || !Object.hasOwn(fields[key], 'value')
        )
      )
        return failure('context_recovery_invalid_response');
      const { statusCode, wire, stream } = {
        statusCode: fields.statusCode.value,
        wire: fields.wire.value,
        stream: fields.stream.value,
      };
      if (
        statusCode !== 200 ||
        !Buffer.isBuffer(wire) ||
        wire.length > MAX_WIRE_BYTES ||
        typeof stream !== 'boolean' ||
        (fields.encoding &&
          (!Object.hasOwn(fields.encoding, 'value') ||
            ![undefined, 'identity'].includes(fields.encoding.value)))
      )
        return failure('context_recovery_invalid_response');
      const decoded = decodeContextRecoveryEnvelope(kind, wire, stream);
      const next = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) return null;
          const method =
            Object.getOwnPropertyDescriptor(run, 'acceptAsync') ??
            Object.getOwnPropertyDescriptor(run, 'accept');
          if (typeof method?.value !== 'function') throw new TypeError('Invalid recovery turn');
          return method.value.call(run, decoded);
        }),
        interrupted,
      ]);
      if (controller.signal.aborted)
        return failure(expired ? 'context_recovery_timeout' : 'context_recovery_cancelled');
      if (next.usage) usage = next.usage;
      rounds = next.rounds ?? rounds;
      calls = next.calls ?? calls;
      if (!next.ok) return failure(next.code);
      if (next.mode === 'release') return next;
      if (next.mode !== 'continue') return failure('context_recovery_invalid_response');
      request = next.request;
    }
  } catch {
    return failure('context_recovery_dispatch_failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', abortListener);
  }
}

module.exports = { runContextRecovery };
