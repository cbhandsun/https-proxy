/**
 * 上游失败后的客户端收尾。
 *
 * 当响应头已经发出时无法再改状态码，但必须结束连接，否则客户端会一直等待
 * 一个永远不会到达的结束事件。SSE 场景下先补一条错误注释再结束，普通响应
 * 直接结束，两种情况下都要落一条 request_end，保证监控能按 reqId 聚合。
 */
'use strict';

function writeSseFailureComment(clientRes, payload) {
  try {
    clientRes.write('event: error\ndata: ' + JSON.stringify(payload) + '\n\n');
  } catch (err) {
    return false;
  }
  return true;
}

function terminateClientAfterUpstreamFailure(clientRes, options = {}) {
  if (!clientRes) return { terminated: false, reason: 'no_response' };
  if (clientRes.writableEnded === true) return { terminated: false, reason: 'already_ended' };

  const payload = options.payload || {
    error: { type: 'proxy_error', message: options.message || 'Upstream request failed' },
  };
  let wroteNotice = false;
  if (options.stream === true) {
    wroteNotice = writeSseFailureComment(clientRes, payload);
  }
  try {
    clientRes.end();
  } catch (err) {
    return { terminated: false, reason: 'end_threw', wroteNotice };
  }
  return { terminated: true, reason: 'ended', wroteNotice };
}

module.exports = { terminateClientAfterUpstreamFailure, writeSseFailureComment };
