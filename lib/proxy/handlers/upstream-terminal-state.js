/**
 * 单次上游转发的终态登记（terminal state）。
 *
 * 问题背景：一次转发的结束可能由多条互相竞争的路径同时观察到——上游 `end`、
 * `proxyReq` 超时、socket `error`、以及流式守卫看到的 `aborted`/不完整 `close`。
 * 旧实现各写各的日志，于是同一 reqId 会同时出现 `proxy_error: Gateway Timeout`
 * 和一条 `statusCode: 200` 的成功记录；更常见的情况是超时/错误路径完全没有
 * `request_end`，监控只能看到孤立的 `request_start`。
 *
 * 这里把"这次转发到底以什么结局收场"收敛成唯一一个登记项：谁先登记谁负责写日志，
 * 后来的观察者只拿到 false。这样既能保证每条请求恰好一条终态记录，也能保证失败
 * 不会被迟到的成功回调覆盖。
 */
'use strict';

function createUpstreamTerminalState(deps = {}) {
  const logRequestEnd = deps.logRequestEnd;
  // Optional hook so the conversation-audit record can agree with the events log.
  // The audit writer only sees clientRes.statusCode at clientRes.end(); when the
  // upstream already sent 200 headers and then timed out, that value stays 200 and
  // the audit record contradicted the request_end 502 for the same request.
  const recordFailure = typeof deps.recordFailure === 'function' ? deps.recordFailure : null;
  let settled = false;
  let settledReason = null;

  function settle(nextReason) {
    if (settled) return false;
    settled = true;
    settledReason = nextReason || 'settled';
    return true;
  }

  return {
    isSettled: () => settled,
    reason: () => settledReason,
    /** 上游正常走完响应体时调用；之后到达的失败观察应被忽略。 */
    markComplete: () => settle('complete'),
    /**
     * 登记一次失败并写出唯一的 request_end。
     * 返回 true 表示本次调用是第一个登记终态的观察者（日志已写出）。
     */
    fail(detail = {}) {
      if (!settle(detail.reason || detail.type || 'upstream_failure')) return false;
      if (recordFailure) {
        try {
          recordFailure(detail);
        } catch (err) {
          // Auditing must never break the terminal-record path.
        }
      }
      if (typeof logRequestEnd !== 'function') return true;
      if (!detail.method || detail.startTime == null) return true;
      logRequestEnd(detail.method, detail.path, detail.startTime, detail.statusCode || 502, {
        type: detail.type || 'proxy_error',
        errorType: detail.errorType || 'proxy_error',
        ...(detail.failureKind ? { failureKind: detail.failureKind } : {}),
        ...(detail.error ? { error: String(detail.error) } : {}),
        ...(detail.extra || {}),
      });
      return true;
    },
  };
}

module.exports = { createUpstreamTerminalState };
