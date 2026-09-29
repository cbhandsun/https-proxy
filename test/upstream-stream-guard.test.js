'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createUpstreamStreamGuard,
  clientAcceptsEventStream,
  collectUpstreamRequestFailureDiagnostics,
} = require('../lib/proxy/handlers/upstream-stream-guard');

function createClientRes(contentType = 'text/event-stream; charset=utf-8') {
  return {
    writes: [],
    ended: false,
    writableEnded: false,
    getHeader() {
      return contentType;
    },
    write(chunk) {
      this.writes.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.writes.push(String(chunk));
      this.ended = true;
      this.writableEnded = true;
    },
  };
}

// 1. aborted 后必须补 SSE error 事件、结束响应并落 request_end
{
  const proxyRes = new EventEmitter();
  const clientRes = createClientRes();
  const events = [];
  const ends = [];
  const guard = createUpstreamStreamGuard({
    logProxyEvent: (kind, payload) => events.push({ kind, payload }),
    logRequestEnd: (...args) => ends.push(args),
  })(proxyRes, {
    clientRes,
    label: 'Gemini',
    logType: 'gemini_stream_aborted',
    method: 'POST',
    upstreamPath: '/v1/messages',
    startTime: Date.now(),
  });

  assert.equal(guard.hasFailed(), false);
  proxyRes.emit('aborted');
  assert.equal(guard.hasFailed(), true);
  assert.equal(clientRes.ended, true);
  assert.match(clientRes.writes[0], /^event: error\ndata: /);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'upstream_stream_aborted');
  assert.equal(events[0].payload.reason, 'aborted');
  assert.match(events[0].payload.error, /Gemini stream was aborted/);
  assert.equal(ends.length, 1);
  assert.equal(ends[0][3], 502);
  assert.equal(ends[0][4].type, 'gemini_stream_aborted');
  assert.equal(ends[0][4].errorType, 'upstream_stream_aborted');
  assert.equal(ends[0][4].failureOrigin, 'upstream_response');
}

// 2. 正常 end 之后 close 不应被当作失败
{
  const proxyRes = new EventEmitter();
  proxyRes.complete = true;
  const clientRes = createClientRes();
  const events = [];
  const ends = [];
  const guard = createUpstreamStreamGuard({
    logProxyEvent: (kind, payload) => events.push({ kind, payload }),
    logRequestEnd: (...args) => ends.push(args),
  })(proxyRes, { clientRes, method: 'POST', upstreamPath: '/v1/messages', startTime: Date.now() });

  proxyRes.emit('end');
  guard.markComplete();
  proxyRes.emit('close');
  assert.equal(guard.hasFailed(), false);
  assert.equal(clientRes.ended, false);
  assert.deepEqual(events, []);
  assert.deepEqual(ends, []);
}

// 3. 未完成的 close（没有 end）必须判为失败
{
  const proxyRes = new EventEmitter();
  proxyRes.complete = false;
  const clientRes = createClientRes();
  const events = [];
  const ends = [];
  const guard = createUpstreamStreamGuard({
    logProxyEvent: (kind, payload) => events.push({ kind, payload }),
    logRequestEnd: (...args) => ends.push(args),
  })(proxyRes, { clientRes, method: 'POST', upstreamPath: '/v1/messages', startTime: Date.now() });

  proxyRes.emit('close');
  assert.equal(guard.hasFailed(), true);
  assert.equal(events[0].payload.reason, 'incomplete_close');
  assert.equal(clientRes.ended, true);
}

// 4. 失败只收尾一次；error 之后 close 不重复结束
{
  const proxyRes = new EventEmitter();
  const clientRes = createClientRes();
  const events = [];
  const ends = [];
  const guard = createUpstreamStreamGuard({
    logProxyEvent: (kind, payload) => events.push({ kind, payload }),
    logRequestEnd: (...args) => ends.push(args),
  })(proxyRes, { clientRes, method: 'POST', upstreamPath: '/v1/messages', startTime: Date.now() });

  const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  proxyRes.emit('error', err);
  proxyRes.emit('aborted');
  proxyRes.emit('close');
  assert.equal(guard.hasFailed(), true);
  assert.equal(events.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(events[0].payload.code, 'ECONNRESET');
  assert.match(events[0].payload.error, /ECONNRESET|socket hang up/);
}

// 5. respondOnFailure=false 时只回调，不替调用方写响应
{
  const proxyRes = new EventEmitter();
  const clientRes = createClientRes();
  const failures = [];
  const guard = createUpstreamStreamGuard({})(proxyRes, {
    clientRes,
    respondOnFailure: false,
    onFailure: (reason) => failures.push(reason),
  });
  proxyRes.emit('aborted');
  assert.equal(clientRes.ended, false);
  assert.deepEqual(failures, ['aborted']);
  assert.equal(guard.hasFailed(), true);
}

// 6. 缺失/异常上游流不应抛错
{
  const nullGuard = createUpstreamStreamGuard({})(null, {});
  assert.equal(nullGuard.hasFailed(), false);
  assert.equal(nullGuard.isSettled(), true);
  nullGuard.markComplete();
}

// 7. 非 SSE 响应结束时不写 SSE 事件
{
  const proxyRes = new EventEmitter();
  const clientRes = createClientRes('application/json');
  clientRes.getHeader = () => undefined;
  const guard = createUpstreamStreamGuard({})(proxyRes, {
    clientRes,
    method: 'POST',
    upstreamPath: '/v1/chat/completions',
    startTime: Date.now(),
  });
  proxyRes.emit('aborted');
  assert.equal(clientRes.ended, true);
  assert.deepEqual(clientRes.writes, []);
  assert.equal(guard.hasFailed(), true);
}

// 8. 别人已经结束过响应时不要重复落 request_end
{
  const proxyRes = new EventEmitter();
  const clientRes = createClientRes();
  const events = [];
  const ends = [];
  const guard = createUpstreamStreamGuard({
    logProxyEvent: (kind, payload) => events.push({ kind, payload }),
    logRequestEnd: (...args) => ends.push(args),
  })(proxyRes, {
    clientRes,
    method: 'POST',
    upstreamPath: '/v1/messages',
    startTime: Date.now(),
  });
  clientRes.end(); // 模拟 proxyReq.on('error') 已经收尾
  proxyRes.emit('aborted');
  assert.equal(guard.hasFailed(), true);
  assert.deepEqual(events, []);
  assert.deepEqual(ends, []);
}

assert.equal(
  clientAcceptsEventStream({ getHeader: () => 'text/event-stream; charset=utf-8' }),
  true
);
assert.equal(clientAcceptsEventStream({ getHeader: () => 'application/json' }), false);
assert.equal(clientAcceptsEventStream(null), false);
assert.equal(
  clientAcceptsEventStream({
    getHeader() {
      throw new Error('boom');
    },
  }),
  false
);

// 9. 上游中断诊断只记录安全的 socket 元数据，并主动淘汰未完成连接。
{
  const proxyRes = new EventEmitter();
  const socket = new EventEmitter();
  Object.assign(socket, {
    bytesRead: 1000,
    remoteAddress: '104.18.32.47',
    remotePort: 443,
    readyState: 'open',
    encrypted: true,
    authorized: true,
    secureConnecting: false,
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  });
  Object.assign(proxyRes, {
    socket,
    statusCode: 200,
    complete: false,
    aborted: true,
    destroyed: true,
    errored: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    req: { reusedSocket: true },
  });
  const clientRes = createClientRes();
  clientRes.headersSent = true;
  const events = [];
  const reported = [];
  createUpstreamStreamGuard({
    logProxyEvent: (kind, payload) => events.push({ kind, payload }),
  })(proxyRes, {
    clientRes,
    method: 'POST',
    upstreamPath: '/backend-api/codex/responses',
    startTime: Date.now(),
    reportFailure: (detail) => reported.push(detail),
  });

  socket.bytesRead = 1450;
  proxyRes.emit('aborted');

  assert.equal(socket.destroyed, true);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].code, 'ECONNRESET');
  assert.deepEqual(reported[0].diagnostics, {
    failureOrigin: 'upstream_response',
    upstreamFailureReason: 'aborted',
    upstreamResponseAborted: true,
    upstreamResponseComplete: false,
    upstreamResponseDestroyed: true,
    upstreamSocketDestroyed: false,
    upstreamSocketReused: true,
    downstreamHeadersSent: true,
    downstreamWritableEndedBeforeFailure: false,
    upstreamResponseStatusCode: 200,
    upstreamErrorCode: 'ECONNRESET',
    upstreamSocketBytesReadDelta: 450,
    upstreamRemoteAddress: '104.18.32.47',
    upstreamRemotePort: 443,
    upstreamSocketReadyState: 'open',
    upstreamTlsAuthorized: true,
    upstreamTlsHandshakeComplete: true,
    upstreamSocketDiscarded: true,
  });
  assert.equal(events[0].payload.downstreamFailureNoticeWritten, true);
  assert.equal(events[0].payload.downstreamTerminated, true);
  assert.equal(events[0].payload.downstreamTerminationReason, 'ended');
  assert.doesNotMatch(
    JSON.stringify(events[0]),
    /"(?:headers|authorization|cookie|body|content)"\s*:/i
  );
}

// 10. 非法/敏感形态的端点与错误码不会进入结构化事件。
{
  const proxyRes = new EventEmitter();
  const socket = {
    bytesRead: 5,
    remoteAddress: 'Bearer secret-token',
    remotePort: 70000,
    readyState: 'malicious-state',
    destroyed: true,
    errored: { code: 'ECONNRESET\r\nAuthorization: Bearer secret-token' },
  };
  Object.assign(proxyRes, {
    socket,
    complete: false,
    aborted: true,
    errored: socket.errored,
  });
  const events = [];
  createUpstreamStreamGuard({
    logProxyEvent: (kind, payload) => events.push({ kind, payload }),
  })(proxyRes, { clientRes: createClientRes(), method: 'POST', upstreamPath: '/v1/responses' });
  proxyRes.emit('aborted');

  const serialized = JSON.stringify(events[0]);
  assert.doesNotMatch(serialized, /secret-token|authorization|Bearer/i);
  assert.equal(events[0].payload.upstreamRemoteAddress, undefined);
  assert.equal(events[0].payload.upstreamRemotePort, undefined);
  assert.equal(events[0].payload.upstreamSocketReadyState, undefined);
  assert.equal(events[0].payload.upstreamErrorCode, undefined);
}

// 11. reportFailure 必须先于结束客户端响应触发：会话审计记录是在 clientRes.end()
// 内部写的，若先 end 再上报，审计日志会保留客户端可见的 200，与 events 日志的 502 矛盾。
{
  const proxyRes = new EventEmitter();
  const order = [];
  const clientRes = createClientRes();
  const originalEnd = clientRes.end.bind(clientRes);
  clientRes.end = function (chunk) {
    order.push('client.end');
    return originalEnd(chunk);
  };
  const guard = createUpstreamStreamGuard({
    logProxyEvent: () => order.push('logProxyEvent'),
  })(proxyRes, {
    clientRes,
    method: 'POST',
    upstreamPath: '/v1/responses',
    startTime: Date.now(),
    reportFailure: () => order.push('reportFailure'),
  });

  proxyRes.emit('aborted');
  assert.equal(guard.hasFailed(), true);
  assert.equal(order[0], 'reportFailure', 'failure must be reported before the response ends');
  assert.ok(order.includes('client.end'), 'the client response is still terminated');
}

// 12. reportFailure 生效时不得再落第二条 request_end（终态由调用方单点拥有）。
{
  const proxyRes = new EventEmitter();
  const clientRes = createClientRes();
  const ends = [];
  const reported = [];
  const guard = createUpstreamStreamGuard({
    logRequestEnd: (...args) => ends.push(args),
  })(proxyRes, {
    clientRes,
    method: 'POST',
    upstreamPath: '/v1/responses',
    startTime: Date.now(),
    reportFailure: (detail) => reported.push(detail),
  });

  proxyRes.emit('aborted');
  assert.equal(guard.hasFailed(), true);
  assert.equal(reported.length, 1);
  assert.deepEqual(ends, [], 'the caller owns the single terminal record');
}

// Request errors must reveal the failing phase without copying sensitive socket data.
{
  const empty = collectUpstreamRequestFailureDiagnostics({});
  assert.equal(empty.upstreamFailurePhase, 'socket_unassigned');
  assert.equal(empty.upstreamResponseSeen, false);
  assert.equal(empty.upstreamSocketBytesRead, undefined);
  assert.equal(empty.upstreamResponseStatusCode, undefined);

  const connecting = collectUpstreamRequestFailureDiagnostics({
    proxyReq: { socket: { connecting: true, bytesRead: 0, bytesWritten: 0 } },
    clientRes: { headersSent: false },
  });
  assert.equal(connecting.upstreamFailurePhase, 'tcp_connect');
  assert.equal(connecting.upstreamSocketBytesRead, 0);

  const handshake = collectUpstreamRequestFailureDiagnostics({
    proxyReq: {
      reusedSocket: false,
      socket: { encrypted: true, secureConnecting: true, readyState: 'opening' },
    },
  });
  assert.equal(handshake.upstreamFailurePhase, 'tls_handshake');
  assert.equal(handshake.upstreamTlsHandshakeComplete, false);

  const awaiting = collectUpstreamRequestFailureDiagnostics({
    proxyReq: { reusedSocket: true, socket: { encrypted: true, secureConnecting: false } },
  });
  assert.equal(awaiting.upstreamFailurePhase, 'awaiting_response');
  assert.equal(awaiting.upstreamRequestReusedSocket, true);

  const streaming = collectUpstreamRequestFailureDiagnostics({
    proxyReq: {
      socket: {
        encrypted: true,
        secureConnecting: false,
        bytesRead: 1234,
        bytesWritten: 5678,
        remoteAddress: '104.18.32.47',
        remotePort: 443,
        readyState: 'open',
        headers: { authorization: 'Bearer secret-token' },
      },
    },
    clientRes: { headersSent: true },
    upstreamResponseSeen: true,
    upstreamResponseStatusCode: 200,
  });
  assert.equal(streaming.upstreamFailurePhase, 'streaming');
  assert.equal(streaming.upstreamResponseStatusCode, 200);
  assert.equal(streaming.upstreamSocketBytesRead, 1234);
  assert.equal(streaming.upstreamSocketBytesWritten, 5678);
  assert.equal(streaming.upstreamRemoteAddress, '104.18.32.47');
  assert.equal(streaming.upstreamRemotePort, 443);
  assert.equal(streaming.upstreamTlsHandshakeComplete, true);
  assert.doesNotMatch(JSON.stringify(streaming), /secret-token|authorization|"headers"\s*:/i);

  const malformed = collectUpstreamRequestFailureDiagnostics({
    proxyReq: {
      socket: {
        bytesRead: Number.MAX_SAFE_INTEGER + 1,
        bytesWritten: -2,
        remoteAddress: 'Bearer secret-token',
        remotePort: 70000,
        readyState: 'Bearer secret-token',
      },
    },
    upstreamResponseSeen: 'yes',
    upstreamResponseStatusCode: 70000,
  });
  assert.equal(malformed.upstreamResponseSeen, false);
  assert.equal(malformed.upstreamResponseStatusCode, undefined);
  assert.equal(malformed.upstreamSocketBytesRead, undefined);
  assert.equal(malformed.upstreamSocketBytesWritten, undefined);
  assert.equal(malformed.upstreamRemoteAddress, undefined);
  assert.equal(malformed.upstreamRemotePort, undefined);
  assert.equal(malformed.upstreamSocketReadyState, undefined);
  assert.doesNotMatch(JSON.stringify(malformed), /secret-token|Bearer/i);
}

// Deliberately cancelling the upstream after the downstream disappears is not an upstream failure.
{
  const proxyRes = new EventEmitter();
  proxyRes.complete = false;
  const clientRes = createClientRes();
  clientRes.destroyed = true;
  clientRes.writableEnded = false;
  const events = [];
  const guard = createUpstreamStreamGuard({
    logProxyEvent: (kind, payload) => events.push({ kind, payload }),
  })(proxyRes, { clientRes, method: 'POST', upstreamPath: '/v1/responses' });
  proxyRes.emit('aborted');
  assert.equal(guard.isSettled(), true);
  assert.deepEqual(events, []);
}

console.log('[upstream-stream-guard.test] ok');
