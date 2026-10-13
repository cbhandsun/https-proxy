/**
 * 上游流式中断守卫。
 *
 * 上游在响应头之后断开（aborted / error / 未完成的 close）时，Node 不会替我们把
 * 下游响应结束掉：SSE 转换分支只监听 'end'，直通分支只 pipe 源流。两者都会让
 * 客户端一直等待一个永远不会到来的终止事件（实测客户端 6s 后仍在等待）。
 *
 * 守卫监听上游流的 aborted/error/不完整 close，一旦失败就补 SSE error 事件、结束
 * 下游响应并落 request_end；hasFailed() 让 data 分支停止继续写入，避免 write after end。
 */
'use strict';

const net = require('node:net');
const { terminateClientAfterUpstreamFailure } = require('./failure-terminal');

const SAFE_SOCKET_STATES = new Set(['opening', 'open', 'readOnly', 'writeOnly', 'closed']);
const SAFE_TERMINATION_REASONS = new Set(['no_response', 'already_ended', 'end_threw', 'ended']);
const SAFE_ERROR_CODES = new Set([
  'GEMINI_NO_IMAGE',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
]);

function safeNonNegativeInteger(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function safeContentLength(value) {
  if (typeof value === 'number') return safeNonNegativeInteger(value);
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  return safeNonNegativeInteger(Number(value));
}

function safeErrorCode(error) {
  const value = error && typeof error === 'object' ? error.code : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return SAFE_ERROR_CODES.has(normalized) ? normalized : null;
}

function safeRemoteAddress(socket) {
  const value = socket && typeof socket.remoteAddress === 'string' ? socket.remoteAddress : '';
  return net.isIP(value) ? value : null;
}

function resolveStreamError(proxyRes, socket, error) {
  const candidates = [error, proxyRes && proxyRes.errored, socket && socket.errored];
  return candidates.find((candidate) => candidate && typeof candidate === 'object') || null;
}

/**
 * Produce a bounded, content-free snapshot for structured failure logs.
 * Never copy headers, request bodies, response chunks, or raw error messages here.
 */
function collectUpstreamFailureDiagnostics({
  proxyRes,
  clientRes,
  socket,
  socketBytesReadAtStart,
  reason,
  error,
}) {
  const resolvedError = resolveStreamError(proxyRes, socket, error);
  const bytesRead = safeNonNegativeInteger(socket && socket.bytesRead);
  const startBytes = safeNonNegativeInteger(socketBytesReadAtStart);
  const bytesReadDelta =
    bytesRead != null && startBytes != null && bytesRead >= startBytes
      ? bytesRead - startBytes
      : null;
  const remoteAddress = safeRemoteAddress(socket);
  const remotePort = safeNonNegativeInteger(socket && socket.remotePort);
  const readyState =
    socket && SAFE_SOCKET_STATES.has(socket.readyState) ? socket.readyState : undefined;
  const responseStatusCode = safeNonNegativeInteger(proxyRes && proxyRes.statusCode);
  const errorCode = safeErrorCode(resolvedError);

  return {
    failureOrigin: 'upstream_response',
    upstreamFailureReason: reason,
    upstreamResponseAborted: proxyRes && proxyRes.aborted === true,
    upstreamResponseComplete: proxyRes && proxyRes.complete === true,
    upstreamResponseDestroyed: proxyRes && proxyRes.destroyed === true,
    upstreamSocketDestroyed: socket && socket.destroyed === true,
    upstreamSocketReused: proxyRes && proxyRes.req && proxyRes.req.reusedSocket === true,
    downstreamHeadersSent: clientRes && clientRes.headersSent === true,
    downstreamWritableEndedBeforeFailure: clientRes && clientRes.writableEnded === true,
    ...(responseStatusCode != null ? { upstreamResponseStatusCode: responseStatusCode } : {}),
    ...(errorCode ? { upstreamErrorCode: errorCode } : {}),
    ...(bytesReadDelta != null ? { upstreamSocketBytesReadDelta: bytesReadDelta } : {}),
    ...(remoteAddress ? { upstreamRemoteAddress: remoteAddress } : {}),
    ...(remotePort != null && remotePort >= 1 && remotePort <= 65535
      ? { upstreamRemotePort: remotePort }
      : {}),
    ...(readyState ? { upstreamSocketReadyState: readyState } : {}),
    ...(socket && socket.encrypted === true && typeof socket.authorized === 'boolean'
      ? { upstreamTlsAuthorized: socket.authorized }
      : {}),
    ...(socket && socket.encrypted === true && typeof socket.secureConnecting === 'boolean'
      ? { upstreamTlsHandshakeComplete: socket.secureConnecting === false }
      : {}),
  };
}

/** Classify request errors without copying URLs, headers, bodies, or error text. */
function collectUpstreamRequestFailureDiagnostics({
  proxyReq,
  clientRes,
  upstreamResponseSeen = false,
  upstreamResponseStatusCode,
  connectionSnapshot,
  error,
  requestBodyByteLength,
  contentLength,
}) {
  const socket = proxyReq && proxyReq.socket;
  const observedConnection =
    connectionSnapshot && connectionSnapshot.socketAssigned === true ? connectionSnapshot : null;
  const responseSeen = upstreamResponseSeen === true;
  const tcpConnectPending = observedConnection && observedConnection.tcpConnectPending === true;
  const tlsHandshakePending = observedConnection && observedConnection.tlsHandshakePending === true;
  const phase = responseSeen
    ? clientRes && clientRes.headersSent === true
      ? 'streaming'
      : 'upstream_response'
    : (tcpConnectPending && observedConnection.tcpConnectSeen !== true) ||
        (!observedConnection && socket && socket.connecting === true)
      ? 'tcp_connect'
      : (tlsHandshakePending && observedConnection.tlsSecureConnectSeen !== true) ||
          (!observedConnection && socket && socket.secureConnecting === true)
        ? 'tls_handshake'
        : socket || observedConnection
          ? 'awaiting_response'
          : 'socket_unassigned';
  const bytesRead = safeNonNegativeInteger(socket && socket.bytesRead);
  const bytesWritten = safeNonNegativeInteger(socket && socket.bytesWritten);
  const remoteAddress =
    safeRemoteAddress(socket) ||
    safeRemoteAddress({ remoteAddress: observedConnection && observedConnection.remoteAddress });
  const remotePort =
    safeNonNegativeInteger(socket && socket.remotePort) ??
    safeNonNegativeInteger(observedConnection && observedConnection.remotePort);
  const localPort =
    safeNonNegativeInteger(socket && socket.localPort) ??
    safeNonNegativeInteger(observedConnection && observedConnection.localPort);
  const dnsAddress = safeRemoteAddress({
    remoteAddress: observedConnection && observedConnection.dnsAddress,
  });
  const statusCode = safeNonNegativeInteger(upstreamResponseStatusCode);
  const errorCode = safeErrorCode(error);
  const bodyBytes = safeNonNegativeInteger(requestBodyByteLength);
  const headerBytes = safeContentLength(contentLength);
  return {
    failureOrigin: 'upstream_request',
    upstreamFailurePhase: phase,
    upstreamResponseSeen: responseSeen,
    upstreamRequestReusedSocket: proxyReq && proxyReq.reusedSocket === true,
    downstreamHeadersSent: clientRes && clientRes.headersSent === true,
    ...(errorCode ? { upstreamErrorCode: errorCode } : {}),
    ...(bodyBytes != null ? { upstreamRequestBodyBytes: bodyBytes } : {}),
    ...(bodyBytes != null && headerBytes != null
      ? { upstreamContentLengthMatches: bodyBytes === headerBytes }
      : {}),
    ...(observedConnection
      ? {
          upstreamDnsLookupObserved: observedConnection.dnsLookupSeen === true,
          upstreamTcpConnectObserved: observedConnection.tcpConnectSeen === true,
          upstreamTlsSecureConnectObserved: observedConnection.tlsSecureConnectSeen === true,
          upstreamRequestFinished: observedConnection.requestFinished === true,
        }
      : {}),
    ...(dnsAddress ? { upstreamDnsAddress: dnsAddress } : {}),
    ...(responseSeen && statusCode != null && statusCode >= 100 && statusCode <= 599
      ? { upstreamResponseStatusCode: statusCode }
      : {}),
    ...(bytesRead != null ? { upstreamSocketBytesRead: bytesRead } : {}),
    ...(bytesWritten != null ? { upstreamSocketBytesWritten: bytesWritten } : {}),
    ...(remoteAddress ? { upstreamRemoteAddress: remoteAddress } : {}),
    ...(remotePort != null && remotePort >= 1 && remotePort <= 65535
      ? { upstreamRemotePort: remotePort }
      : {}),
    ...(localPort != null && localPort >= 1 && localPort <= 65535
      ? { upstreamLocalPort: localPort }
      : {}),
    ...(socket && SAFE_SOCKET_STATES.has(socket.readyState)
      ? { upstreamSocketReadyState: socket.readyState }
      : {}),
    ...(socket && socket.encrypted === true && typeof socket.secureConnecting === 'boolean'
      ? { upstreamTlsHandshakeComplete: socket.secureConnecting === false }
      : {}),
  };
}

function discardIncompleteUpstreamSocket(proxyRes, socket) {
  if (!proxyRes || proxyRes.complete === true || !socket || socket.destroyed === true) return false;
  if (typeof socket.destroy !== 'function') return false;
  try {
    socket.destroy();
    return true;
  } catch (_error) {
    return false;
  }
}

function clientAcceptsEventStream(clientRes) {
  try {
    if (!clientRes || typeof clientRes.getHeader !== 'function') return false;
    const contentType = clientRes.getHeader('content-type');
    return typeof contentType === 'string' && contentType.indexOf('text/event-stream') >= 0;
  } catch (err) {
    return false;
  }
}

function createUpstreamStreamGuard(deps = {}) {
  const { logProxyEvent, logRequestEnd } = deps;

  return function guardUpstreamStream(proxyRes, options = {}) {
    const {
      clientRes,
      label = 'Upstream',
      logType = 'upstream_stream_aborted',
      method,
      upstreamPath,
      startTime,
      stream = clientAcceptsEventStream(clientRes),
      // Callers that own the error response (for example a collapsed stream that must
      // emit JSON 502 before headers are sent) pass false and respond themselves.
      respondOnFailure = true,
      onFailure,
      // Callers that own the single terminal record for the whole forward attempt
      // (see upstream-terminal-state) pass a reporter here so a stream abort does not
      // write a second, competing request_end for the same reqId.
      reportFailure,
    } = options;

    if (!proxyRes || typeof proxyRes.once !== 'function') {
      return { hasFailed: () => false, isSettled: () => true, markComplete() {} };
    }

    let failed = false;
    let completed = false;
    const socket = proxyRes.socket || proxyRes.connection || null;
    const socketBytesReadAtStart = safeNonNegativeInteger(socket && socket.bytesRead);

    function fail(reason, error) {
      if (failed || completed) return false;
      // Closing the downstream deliberately destroys the upstream socket. That is a
      // client cancellation, not a new upstream failure.
      if (clientRes && clientRes.destroyed === true && clientRes.writableEnded !== true) {
        completed = true;
        return false;
      }
      failed = true;
      const resolvedError = resolveStreamError(proxyRes, socket, error);
      // Socket error messages may contain URLs, headers, or provider text. Only the
      // bounded machine code is safe for structured logs and client-facing failures.
      const detail = safeErrorCode(resolvedError);
      const diagnostics = collectUpstreamFailureDiagnostics({
        proxyRes,
        clientRes,
        socket,
        socketBytesReadAtStart,
        reason,
        error: resolvedError,
      });
      diagnostics.upstreamSocketDiscarded = discardIncompleteUpstreamSocket(proxyRes, socket);
      const message =
        label +
        ' stream ' +
        (reason === 'aborted' ? 'was aborted' : 'failed') +
        (detail ? ': ' + detail : '');
      if (typeof onFailure === 'function') {
        try {
          onFailure(reason, error, message);
        } catch (err) {}
      }
      // Report before terminating: terminateClientAfterUpstreamFailure() calls
      // clientRes.end(), which is where the conversation-audit record is written. The
      // failure has to be on the audit data before that happens, or the audit log
      // records the client-visible 200 while the events log records the 502.
      let reported = false;
      if (typeof reportFailure === 'function') {
        reported = true;
        reportFailure({
          message,
          reason,
          code: safeErrorCode(resolvedError),
          logType,
          errorType: 'upstream_stream_aborted',
          diagnostics,
        });
      }
      let terminated = null;
      if (clientRes && respondOnFailure) {
        terminated = terminateClientAfterUpstreamFailure(clientRes, {
          stream,
          payload: { type: 'error', error: { type: 'proxy_error', message } },
        });
      }
      // proxyReq.on('error') already terminates the client and logs request_end for
      // the same failure; re-logging here would double-count the request.
      if (terminated && terminated.terminated === false && terminated.reason === 'already_ended') {
        return true;
      }
      if (typeof logProxyEvent === 'function') {
        logProxyEvent('upstream_stream_aborted', {
          method,
          path: upstreamPath,
          error: message,
          reason,
          code: safeErrorCode(resolvedError),
          ...diagnostics,
          ...(terminated
            ? {
                downstreamFailureNoticeWritten: terminated.wroteNotice === true,
                downstreamTerminated: terminated.terminated === true,
                ...(SAFE_TERMINATION_REASONS.has(terminated.reason)
                  ? { downstreamTerminationReason: terminated.reason }
                  : {}),
              }
            : {}),
        });
      }
      if (reported) return true;
      if (typeof logRequestEnd === 'function') {
        logRequestEnd(method, upstreamPath, startTime, 502, {
          type: logType,
          errorType: 'upstream_stream_aborted',
          error: message,
          reason,
          code: safeErrorCode(resolvedError),
          ...diagnostics,
        });
      }
      return true;
    }

    proxyRes.once('aborted', () => fail('aborted', null));
    proxyRes.once('error', (error) => fail('error', error || null));
    proxyRes.once('close', () => {
      if (proxyRes.complete === true) return;
      fail('incomplete_close', null);
    });

    return {
      hasFailed: () => failed,
      isSettled: () => failed || completed,
      markComplete() {
        completed = true;
      },
    };
  };
}

module.exports = {
  createUpstreamStreamGuard,
  clientAcceptsEventStream,
  collectUpstreamRequestFailureDiagnostics,
  safeErrorCode,
};
