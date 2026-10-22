'use strict';

const { permitsOrdinaryRecoveryControls } = require('./context-recovery-rejection');
const {
  createRecoveryCacheMissBoundary,
  recoveryCacheMissBody,
} = require('./context-recovery-cache-miss');

const { evidencePrincipal } = require('./context-api-evidence-runtime');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const { decodeContextRecoveryResponse } = require('./context-recovery-protocol');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { recoveryHistoryRequestLimit } = require('./context-recovery-history-request');
const { contextRecoveryDiagnostics } = require('./context-recovery-diagnostics');
const { invokeRecoveryPublication } = require('./context-recovery-publication');
const {
  recoveryOfficialCredentialsAllowed,
  recoveryWbipcCredentialsAllowed,
} = require('./context-recovery-auth');

function nativeRecoveryProviderAllowed({ kind, target, path, prepared, requestOptions }) {
  if (
    target.protocol !== 'https:' ||
    requestOptions.hostname !== target.hostname ||
    Number(requestOptions.port) !== 443
  )
    return false;
  if (prepared.authMode === 'official-login')
    return (
      kind === 'responses' &&
      target.hostname === 'chatgpt.com' &&
      path === '/backend-api/codex/responses' &&
      recoveryOfficialCredentialsAllowed(prepared)
    );
  if (kind === 'claude')
    return (
      (target.hostname === 'api.anthropic.com' &&
        ['/v1/messages', '/v1/messages?beta=true'].includes(path)) ||
      (target.hostname === 'api.deepseek.com' &&
        prepared.authMode === 'api-key' &&
        prepared.profile?.protocol === 'claude' &&
        ['/anthropic/v1/messages', '/anthropic/v1/messages?beta=true'].includes(path))
    );
  if (kind === 'gemini')
    return (
      target.hostname === 'generativelanguage.googleapis.com' &&
      /^\/v1beta\/models\/[A-Za-z0-9_.%~-]+:generateContent$/.test(path)
    );
  return (
    target.hostname === 'api.openai.com' &&
    ((kind === 'responses' && path === '/v1/responses') ||
      (kind === 'chat' && path === '/v1/chat/completions'))
  );
}

// readScope is a trusted composition capability. No caller-supplied selectors
// can change the route, owner or credentials while a private turn is in flight.
function createRecoveryHttpAuthorization(readScope, initialAuth, prepared) {
  const owner = evidencePrincipal(initialAuth);
  let baseline;
  function snapshot() {
    const current = readScope();
    if (!current.enabled || !current.allowed || evidencePrincipal(current.auth) !== owner || !owner)
      return null;
    const profile = current.profile;
    if (!profile) return null;
    if (prepared.authMode === 'official-login') {
      const allowed =
        prepared.authProvider === 'workbuddy'
          ? recoveryWbipcCredentialsAllowed(prepared, profile)
          : recoveryOfficialCredentialsAllowed(prepared, profile);
      if (!allowed) return null;
    } else if (
      ['id', 'protocol', 'targetUrl', 'apiKey'].some(
        (key) => profile[key] !== prepared.profile[key]
      )
    )
      return null;
    return fingerprintContextData({ profile, environment: current.environment });
  }
  try {
    baseline = snapshot();
  } catch {
    baseline = null;
  }
  return () => {
    try {
      return baseline !== null && snapshot() === baseline;
    } catch {
      return false;
    }
  };
}

function tryHandleContextRecoveryHttp(options) {
  const {
    kind,
    session,
    observer,
    clientReq,
    clientRes,
    prepared,
    transport,
    requestOptions,
    authorized,
    stream,
    onOutcome,
    setActive,
  } = options;
  if (
    !session?.ok ||
    !observer ||
    (session.inspect().visibleSources === 0 && !session.inspect().localSummary) ||
    !Buffer.isBuffer(prepared.buffer) ||
    prepared.buffer.length >
      (session.historyFormat === 3 ? recoveryHistoryRequestLimit(3) : MAX_WIRE_BYTES) ||
    ![undefined, 'identity'].includes(requestOptions.headers['content-encoding']) ||
    typeof stream !== 'boolean'
  )
    return false;
  let run;
  let dispatch;
  let cacheMiss;
  let preparationFailed = false;
  let publicHistoryUnavailable = false;
  let body;
  try {
    const text = prepared.buffer.toString('utf8');
    if (!Buffer.from(text).equals(prepared.buffer)) return false;
    body = JSON.parse(text);
  } catch {
    return false;
  }
  try {
    run = session.recovery(body, { publicGeneration: 'isolated' });
    if (!run.ok) {
      if (permitsOrdinaryRecoveryControls(run)) return false;
      publicHistoryUnavailable = run.code === 'context_recovery_public_history_unavailable';
      preparationFailed = true;
    }
    if (options.dispatch !== undefined && typeof options.dispatch !== 'function')
      throw new TypeError('Invalid recovery dispatch capability');
    const nativeDispatch =
      options.dispatch ||
      require('./context-recovery-http-dispatch').createContextRecoveryHttpDispatch(
        transport,
        requestOptions,
        authorized,
        {
          kind: options.conversion?.upstreamKind || kind,
          historyFormat: session.historyFormat ?? 2,
        }
      );
    dispatch = options.conversion
      ? options.conversion.createDispatch(nativeDispatch)
      : nativeDispatch;
    if (
      kind === 'responses' &&
      (!options.conversion || options.conversion.upstreamKind === 'responses')
    ) {
      cacheMiss = createRecoveryCacheMissBoundary(dispatch, 'http');
      dispatch = cacheMiss.dispatch;
    }
  } catch {
    preparationFailed = true;
  }
  if (!observer.detach()) {
    preparationFailed = true;
  }
  const controller = new globalThis.AbortController();
  const cancel = () => controller.abort();
  let transportFinished = false;
  const close = () => {
    if (!transportFinished) cancel();
  };
  // Reporting is outside the publication transaction. A synchronous throw or
  // rejected callback promise is observable as a content-free counter, but may
  // neither revoke delivered history nor prevent failure response/cleanup.
  function reportOutcome(outcome) {
    const failed = () => contextRecoveryDiagnostics.record(kind, 'reportingFailed');
    try {
      Promise.resolve(onOutcome(outcome)).catch(failed);
    } catch {
      failed();
    }
  }
  clientReq.once('aborted', cancel);
  clientRes.once('close', close);
  clientRes.once('error', cancel);
  setActive({ destroy: cancel });
  if (clientReq.aborted || clientRes.destroyed) cancel();
  function publish(encoded) {
    return new Promise((resolve, reject) => {
      const finish = () => {
        transportFinished = true;
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('Recovery publication failed'));
      };
      const cleanup = () => {
        clientRes.removeListener('finish', finish);
        clientRes.removeListener('close', fail);
        clientRes.removeListener('error', fail);
        controller.signal.removeEventListener('abort', fail);
      };
      clientRes.once('finish', finish);
      clientRes.once('close', fail);
      clientRes.once('error', fail);
      controller.signal.addEventListener('abort', fail, { once: true });
      try {
        if (controller.signal.aborted) {
          fail();
          return;
        }
        clientRes.writeHead(200, {
          'content-type': encoded.contentType,
          'content-length': String(encoded.wire.length),
          'cache-control': 'no-store',
        });
        clientRes.end(encoded.wire);
      } catch {
        fail();
      }
    });
  }
  async function execute() {
    let result;
    let committed = false;
    try {
      if (preparationFailed) throw new Error('Recovery preparation unavailable');
      // Execution is cold until this boundary owns a qualified private turn.
      // Keep imports inside the same failure transaction as execution so a
      // missing module cannot fall back to ordinary forwarding or leak details.
      const { runContextRecovery } = require('./context-recovery-runner');
      result = await runContextRecovery({
        kind,
        body: null,
        session: { recovery: () => run },
        dispatch,
        signal: controller.signal,
      });
      if (!result.ok || !authorized() || controller.signal.aborted)
        throw new Error('recovery failed');
      const { encodeContextRecoveryClientWire } = require('./context-recovery-client-wire');
      const encoded = encodeContextRecoveryClientWire(kind, result.response, result.usage, stream);
      const decoded = decodeContextRecoveryResponse(kind, encoded.wire, stream);
      if (!authorized()) throw new Error('recovery commit failed');
      await invokeRecoveryPublication(session, 'prepare', [
        decoded.output,
        decoded.calls,
        decoded.responseId,
      ]);
      committed = true;
      if (!authorized() || controller.signal.aborted || clientRes.destroyed)
        throw new Error('recovery cancelled');
      await invokeRecoveryPublication(session, 'sending');
      if (!authorized() || controller.signal.aborted || clientRes.destroyed)
        throw new Error('recovery cancelled');
      await publish(encoded);
      if (!authorized() || controller.signal.aborted) throw new Error('recovery cancelled');
      await invokeRecoveryPublication(session, 'finished');
      if (!authorized() || controller.signal.aborted) throw new Error('recovery cancelled');
      reportOutcome({
        ok: true,
        statusCode: 200,
        rounds: result.rounds,
        calls: result.calls,
        usage: result.usage,
      });
    } catch {
      let cleaned = false;
      try {
        await invokeRecoveryPublication(session, committed ? 'withdraw' : 'abort');
        cleaned = true;
      } catch {
        contextRecoveryDiagnostics.record(kind, 'publicationCleanupFailed');
      }
      let recoverable = false;
      try {
        recoverable =
          !committed &&
          cleaned &&
          (cacheMiss?.matched() === true || publicHistoryUnavailable) &&
          !controller.signal.aborted &&
          authorized() === true;
      } catch {
        /* Authorization exceptions cannot authorize a client retry. */
      }
      const failureStatus = controller.signal.aborted ? 499 : recoverable ? 400 : 502;
      // Register failure before destroying a response, which itself emits close.
      reportOutcome({
        ok: false,
        statusCode: failureStatus,
        rounds: result?.rounds ?? 0,
        calls: result?.calls ?? 0,
        usage: result?.usage ?? [],
      });
      if (!controller.signal.aborted && !clientRes.destroyed && !clientRes.writableEnded) {
        try {
          if (clientRes.headersSent) clientRes.destroy();
          else {
            clientRes.writeHead(failureStatus, {
              'content-type': 'application/json',
              ...(recoverable ? { 'cache-control': 'no-store' } : {}),
            });
            clientRes.end(
              JSON.stringify(
                recoverable
                  ? recoveryCacheMissBody()
                  : {
                      error: {
                        type: 'upstream_error',
                        code: 'context_recovery_failed',
                        message: 'Context recovery could not complete safely.',
                      },
                    }
              )
            );
          }
        } catch {
          clientRes.destroy();
        }
      }
    } finally {
      clientReq.removeListener('aborted', cancel);
      clientRes.removeListener('close', close);
      clientRes.removeListener('error', cancel);
    }
  }
  void execute();
  return true;
}

module.exports = {
  nativeRecoveryProviderAllowed,
  createRecoveryHttpAuthorization,
  tryHandleContextRecoveryHttp,
};
