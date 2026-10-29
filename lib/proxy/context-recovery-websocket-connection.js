'use strict';

const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { recoveryHistoryRequestLimit } = require('./context-recovery-history-request');
const {
  parseRecoveryWebSocketMessage,
  recoveryWebSocketStreamError,
} = require('./context-recovery-websocket-wire');
const { runRecoveryWebSocketTurn } = require('./context-recovery-websocket-turn');
const {
  createRecoveryWebSocketContinuations,
} = require('./context-recovery-websocket-continuation');
const { createRecoveryWebSocketWarmups } = require('./context-recovery-websocket-warmup');

const unavailable = () => new Error('Recovery WebSocket connection unavailable');

function createRecoveryWebSocketConnection(options) {
  const {
    runtime,
    auth,
    prepared,
    authorized,
    sendClient,
    sendUpstream,
    close,
    timeoutMs = 60000,
  } = options;
  if (
    [authorized, sendClient, sendUpstream, close].some((value) => typeof value !== 'function') ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000
  )
    throw unavailable();
  const lanes = new Map();
  const continuations = createRecoveryWebSocketContinuations();
  const warmups = createRecoveryWebSocketWarmups();
  let admissionTail = Promise.resolve();
  // Admission alone is serialized per connection, within the existing 16
  // active-turn budget. Model responses on different lanes remain concurrent.
  function admit(operation) {
    const next = admissionTail.then(() => {
      if (!permitted()) throw unavailable();
      return operation();
    });
    admissionTail = next.then(
      () => {},
      () => {}
    );
    return next;
  }
  let closed = false,
    errorReplies = 0,
    active = 0,
    count = 0,
    queuedBytes = 0,
    smallQueuedBytes = 0;

  function stop() {
    if (closed) return;
    closed = true;
    continuations.close();
    warmups.close();
    for (const lane of lanes.values()) {
      count -= lane.queue.length;
      queuedBytes -= lane.queue.reduce((sum, job) => sum + job.bytes, 0);
      smallQueuedBytes -= lane.queue.reduce(
        (sum, job) => sum + (job.bytes <= MAX_WIRE_BYTES ? job.bytes : 0),
        0
      );
      lane.active?.controller.abort();
      lane.queue.length = 0;
    }
    close();
  }

  function permitted() {
    try {
      return !closed && authorized() === true;
    } catch {
      return false;
    }
  }

  function rejectStream(code, id) {
    if (!permitted() || errorReplies >= 32) {
      stop();
      return;
    }
    const event = recoveryWebSocketStreamError(code, id);
    errorReplies++;
    void Promise.resolve()
      .then(() => {
        if (!permitted()) throw unavailable();
        return sendClient(event);
      })
      .catch(stop)
      .finally(() => errorReplies--);
  }

  function dispatch(lane, job, body, { signal, onEvent }) {
    return new Promise((resolve, reject) => {
      if (
        !permitted() ||
        signal.aborted ||
        lane.waiter ||
        (onEvent !== undefined && typeof onEvent !== 'function')
      ) {
        reject(unavailable());
        return;
      }
      const cancel = () => finish(true);
      function settle(failed, response) {
        if (lane.waiter !== waiter) return;
        lane.waiter = null;
        signal.removeEventListener('abort', cancel);
        if (failed) reject(unavailable());
        else
          resolve({
            statusCode: 200,
            stream: false,
            wire: Buffer.from(JSON.stringify(response)),
            events: waiter.events,
            eventCount: waiter.count,
          });
      }
      function finish(failed, response) {
        if (failed) {
          settle(true);
          return;
        }
        waiter.terminal = true;
        void waiter.tail.then(
          () => settle(false, response),
          () => settle(true)
        );
      }
      const waiter = {
        events: [],
        bytes: 0,
        count: 0,
        responseId: null,
        sequence: -1,
        terminal: false,
        tail: Promise.resolve(),
        onEvent,
        finish,
      };
      lane.waiter = waiter;
      signal.addEventListener('abort', cancel, { once: true });
      const event = {
        ...body,
        type: 'response.create',
        ...(job.event.stream_id === undefined ? {} : { stream_id: job.event.stream_id }),
      };
      delete event.stream;
      delete event.background;
      Promise.resolve()
        .then(() => {
          if (!permitted() || signal.aborted) throw unavailable();
          return sendUpstream(event);
        })
        .catch(() => finish(true));
    });
  }

  function pump() {
    if (!permitted()) {
      stop();
      return;
    }
    for (const lane of lanes.values()) {
      if (active >= 16) break;
      if (
        lane.active ||
        !lane.queue.length ||
        continuations.blocked(lane.queue[0].event.previous_response_id)
      )
        continue;
      const job = lane.queue.shift();
      lane.active = job;
      active++;
      const timer = setTimeout(() => job.controller.abort(), timeoutMs);
      void runRecoveryWebSocketTurn({
        admit,
        event: job.event,
        runtime,
        auth,
        prepared,
        authorized: permitted,
        signal: job.controller.signal,
        continuations,
        warmups,
        dispatch: (body, context) => dispatch(lane, job, body, context),
        send: sendClient,
      })
        .then((result) => {
          if (!result.ok) stop();
        }, stop)
        .finally(() => {
          clearTimeout(timer);
          lane.active = null;
          count--;
          queuedBytes -= job.bytes;
          if (job.bytes <= MAX_WIRE_BYTES) smallQueuedBytes -= job.bytes;
          active--;
          pump();
        });
    }
  }

  function client(bytes, binary = false) {
    if (!permitted()) {
      stop();
      return;
    }
    try {
      if (binary) throw unavailable();
      const event = parseRecoveryWebSocketMessage(bytes, 3);
      if (event.type !== 'response.create') throw unavailable();
      let lane = lanes.get(event.stream_id);
      if (
        !lane &&
        event.stream_id !== undefined &&
        [...lanes.keys()].filter((key) => key !== undefined).length >= 32
      ) {
        rejectStream('websocket_stream_limit_reached', event.stream_id);
        return;
      }
      if (
        count >= 32 ||
        queuedBytes + bytes.length > recoveryHistoryRequestLimit(3) ||
        (bytes.length <= MAX_WIRE_BYTES && smallQueuedBytes + bytes.length > MAX_WIRE_BYTES)
      )
        throw unavailable();
      if (!lane) {
        lane = { queue: [], active: null, waiter: null };
        lanes.set(event.stream_id, lane);
      }
      count++;
      queuedBytes += bytes.length;
      if (bytes.length <= MAX_WIRE_BYTES) smallQueuedBytes += bytes.length;
      lane.queue.push({ event, bytes: bytes.length, controller: new globalThis.AbortController() });
      pump();
    } catch (error) {
      const code =
        error && typeof error === 'object'
          ? Object.getOwnPropertyDescriptor(error, 'code')?.value
          : undefined;
      if (code === 'invalid_stream_id') rejectStream(code);
      else stop();
    }
  }

  function upstream(bytes, binary = false) {
    if (!permitted()) {
      stop();
      return;
    }
    try {
      if (binary) throw unavailable();
      const event = parseRecoveryWebSocketMessage(bytes);
      const waiter = lanes.get(event.stream_id)?.waiter;
      if (
        !waiter ||
        waiter.terminal ||
        waiter.bytes + bytes.length > MAX_WIRE_BYTES ||
        waiter.count >= 4096
      )
        throw unavailable();
      // A terminal envelope and its nested response must refer to the same
      // upstream response. Neither field can mask an invalid or conflicting
      // identity before public progress or durable publication.
      for (const id of [event.response_id, event.response?.id]) {
        if (id === undefined) continue;
        if (
          typeof id !== 'string' ||
          !id.length ||
          id.length > 256 ||
          (waiter.responseId !== null && waiter.responseId !== id)
        )
          throw unavailable();
        waiter.responseId = id;
      }
      if (event.sequence_number !== undefined) {
        if (
          !Number.isSafeInteger(event.sequence_number) ||
          event.sequence_number < 0 ||
          event.sequence_number <= waiter.sequence
        )
          throw unavailable();
        waiter.sequence = event.sequence_number;
      }
      waiter.bytes += bytes.length;
      waiter.count++;
      const terminal = [
        'response.completed',
        'response.failed',
        'response.incomplete',
        'error',
      ].includes(event.type);
      if (!terminal && waiter.onEvent) {
        // Public progress is ordered by transport acknowledgement. Terminal
        // publication waits for this tail and its own durable acknowledgement.
        // Private recovery dispatches never receive this public capability.
        waiter.tail = waiter.tail.then(() => {
          if (!permitted() || lanes.get(event.stream_id)?.waiter !== waiter) throw unavailable();
          return waiter.onEvent(event);
        });
        void waiter.tail.catch(() => waiter.finish(true));
      } else waiter.events.push(event);
      if (terminal) {
        waiter.finish(false, event.response ?? { error: event.error });
      }
    } catch {
      stop();
    }
  }

  return {
    client,
    upstream,
    close: stop,
    inspect: () => ({ closed, active, queued: count - active, lanes: lanes.size, queuedBytes }),
  };
}

module.exports = { createRecoveryWebSocketConnection };
