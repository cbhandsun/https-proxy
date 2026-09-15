'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createUpstreamStreamGuard,
  clientAcceptsEventStream,
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

// 9. reportFailure 必须先于结束客户端响应触发：会话审计记录是在 clientRes.end()
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

// 10. reportFailure 生效时不得再落第二条 request_end（终态由调用方单点拥有）。
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

console.log('[upstream-stream-guard.test] ok');
