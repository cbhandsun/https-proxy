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

const { terminateClientAfterUpstreamFailure } = require('./failure-terminal');

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

    function fail(reason, error) {
      if (failed || completed) return false;
      failed = true;
      const detail = error && (error.message || error.code);
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
          code: error && error.code,
          logType,
          errorType: 'upstream_stream_aborted',
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
          code: error && error.code,
        });
      }
      if (reported) return true;
      if (typeof logRequestEnd === 'function') {
        logRequestEnd(method, upstreamPath, startTime, 502, {
          type: logType,
          errorType: 'upstream_stream_aborted',
          error: message,
          reason,
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

module.exports = { createUpstreamStreamGuard, clientAcceptsEventStream };
