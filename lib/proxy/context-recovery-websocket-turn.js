'use strict';

const { blocksRecoveryAdmission } = require('./context-recovery-rejection');
const {
  createRecoveryCacheMissBoundary,
  recoveryCacheMissEvent,
} = require('./context-recovery-cache-miss');

const {
  beginContextRecoveryRequestAsync,
  decodeContextRecoveryResponse,
} = require('./context-recovery-protocol');
const { runContextRecovery } = require('./context-recovery-runner');
const { invokeRecoveryPublication } = require('./context-recovery-publication');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { createRecoveryWebSocketDispatch } = require('./context-recovery-websocket-dispatch');
const {
  recoveryWebSocketBody,
  recoveryWebSocketEvents,
} = require('./context-recovery-websocket-wire');

// Transport capabilities are pinned by composition. The model can only request
// existing read-only evidence tools; there is no external tool executor here.
async function runRecoveryWebSocketTurn({
  event,
  runtime,
  auth,
  prepared,
  authorized,
  dispatch,
  send,
  signal,
  continuations,
  warmups,
  admit = (operation) => operation(),
}) {
  let session;
  let continuation;
  let committed = false;
  let cacheMiss;
  let publicHistoryUnavailable = false;
  const check = () => {
    if (signal.aborted || authorized() !== true)
      throw new Error('Recovery WebSocket turn unavailable');
  };
  function publish(event) {
    return new Promise((resolve, reject) => {
      const cancel = () => done(new Error('Recovery WebSocket publication unavailable'));
      let settled = false;
      function done(error) {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        if (error) reject(new Error('Recovery WebSocket publication unavailable'));
        else resolve();
      }
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return;
      }
      Promise.resolve()
        .then(() => {
          check();
          return send(event);
        })
        .then(
          () => done(),
          () => done(true)
        );
    });
  }
  try {
    check();
    const body = recoveryWebSocketBody(event);
    cacheMiss = createRecoveryCacheMissBoundary(dispatch, 'websocket', event.stream_id);
    if (body.generate !== false) {
      session = await admit(() => {
        check();
        return beginContextRecoveryRequestAsync(
          runtime,
          {
            auth,
            kind: 'responses',
            prepared,
            buffer: Buffer.from(
              JSON.stringify(warmups ? warmups.admission(body, event.stream_id) : body)
            ),
          },
          () => !signal.aborted && authorized() === true
        );
      });
      check();
      if (blocksRecoveryAdmission(session))
        throw new Error('Recovery WebSocket admission unavailable');
    }
    let events, response;
    const localDeferred =
      continuations?.read(body.previous_response_id, session?.ok === true) ?? [];
    const reader = session?.ok
      ? Object.getOwnPropertyDescriptor(session, 'readPendingResults')
      : undefined;
    if (reader && typeof reader.value !== 'function')
      throw new Error('Recovery WebSocket continuation unavailable');
    const deferred = reader ? reader.value.call(session) : localDeferred;
    if (localDeferred.length && JSON.stringify(localDeferred) !== JSON.stringify(deferred))
      throw new Error('Recovery WebSocket continuation unavailable');
    // Large ingress is only staging. A successful owner binding must explicitly
    // grant the format before any ordinary or private dispatch can use it.
    const historyFormat = session?.ok === true ? (session.historyFormat ?? 2) : 2;
    normalizeRecoveryRequestBody('responses', body, historyFormat);
    const upstreamDispatch = createRecoveryWebSocketDispatch(
      cacheMiss.dispatch,
      deferred,
      historyFormat
    );
    let coordinator;
    if (session?.ok && (session.inspect().visibleSources > 0 || session.inspect().localSummary)) {
      coordinator = session.recovery(body, { publicGeneration: 'isolated' });
      publicHistoryUnavailable = coordinator.code === 'context_recovery_public_history_unavailable';
      if (
        !coordinator.ok &&
        ![
          'context_recovery_controls_unsupported',
          'context_recovery_tools_unsupported',
          'context_recovery_tool_collision',
        ].includes(coordinator.code)
      )
        throw new Error('Recovery WebSocket turn unavailable');
    }
    if (coordinator?.ok) {
      const result = await runContextRecovery({
        kind: 'responses',
        body,
        session: { recovery: () => coordinator },
        dispatch: reader
          ? createRecoveryWebSocketDispatch(cacheMiss.dispatch, [], historyFormat)
          : upstreamDispatch,
        signal,
      });
      check();
      if (!result.ok) throw new Error('Recovery WebSocket turn unavailable');
      const encoded = recoveryWebSocketEvents(result.response, result.usage, event.stream_id);
      events = encoded.events;
      response = encoded.response;
      if (result.deferredInput) {
        if (!continuations) throw new Error('Recovery WebSocket continuation unavailable');
        continuation = continuations.reserve(
          response.id,
          result.deferredInput,
          session.inspect().expiresAt,
          () => session.inspect().active === true
        );
      }
    } else {
      // Only an ordinary dispatch has no injected private tools/results. Its
      // validated progress can cross the wire while generation is running;
      // terminal events remain behind prepare/sending/finished below.
      const result = await (deferred.length ? upstreamDispatch : cacheMiss.dispatch)(body, {
        signal,
        ...(deferred.length ? {} : { onEvent: publish }),
      });
      check();
      if (cacheMiss.matched()) throw new Error('Recovery WebSocket cache miss');
      events = result.events;
      response = JSON.parse(result.wire.toString('utf8'));
      // Ordinary provider failures are client-visible protocol outcomes, not
      // completed evidence. Revoke this uncommitted branch before forwarding
      // them, and leave the lane available for a new client-selected request.
      // Once private results were injected, a provider error can mention those
      // exchanges and must stay behind the recovery boundary instead.
      if (
        deferred.length === 0 &&
        ['error', 'response.failed', 'response.incomplete'].includes(events.at(-1)?.type)
      ) {
        if (session?.ok) {
          await invokeRecoveryPublication(session, 'abort');
          session = undefined;
          check();
        }
        for (const output of events) {
          check();
          await publish(output);
        }
        check();
        return { ok: true };
      }
    }
    check();
    if (session?.ok) {
      const decoded = decodeContextRecoveryResponse(
        'responses',
        Buffer.from(JSON.stringify(response)),
        false
      );
      await invokeRecoveryPublication(
        session,
        coordinator?.ok || deferred.length ? 'prepare' : 'public',
        [decoded.output, decoded.calls, decoded.responseId]
      );
      committed = true;
      check();
      await invokeRecoveryPublication(session, 'sending');
      check();
    }
    for (const output of events) {
      check();
      await publish(output);
    }
    check();
    if (session?.ok) {
      await invokeRecoveryPublication(session, 'finished');
      check();
    }
    if (continuation) continuations.commit(continuation);
    if (body.generate === false) warmups?.remember(body, response, event.stream_id);
    return { ok: true };
  } catch {
    if (continuation) continuations.discard(continuation);
    if (session?.ok) {
      try {
        await invokeRecoveryPublication(session, committed ? 'withdraw' : 'abort');
      } catch {
        return { ok: false, code: 'context_recovery_websocket_cleanup_failed' };
      }
    }
    if (!committed && (cacheMiss?.matched() || publicHistoryUnavailable)) {
      try {
        check();
        await publish(recoveryCacheMissEvent(event.stream_id));
        check();
        return { ok: true };
      } catch {
        return { ok: false, code: 'context_recovery_websocket_unavailable' };
      }
    }
    return { ok: false, code: 'context_recovery_websocket_unavailable' };
  }
}

module.exports = { runRecoveryWebSocketTurn };
