/**
 * 上游 SSE 终帧探测。
 *
 * 问题背景：官方 Codex/Responses 上游在发完 response.completed（并带上 usage）
 * 之后，经常不立刻关闭 TCP 连接。而代理只在 socket end/close 时才认为转发结束，
 * 于是这份已经完整的回答会一直挂到 profile.timeoutMs：客户端在 300s 后拿到
 * 502 + event: error，审计里却已有 provider usage，实际是一次成功的推理被超时判死。
 *
 * 生产证据（重启后真实流量，仅 openai-official）：
 * - 15 条 elapsed > 290s 的审计记录全部 statusCode=200、usage source=provider，
 *   同时段 proxy-events 里对应 reqId 全是 502 / upstream_timeout，时间差 1ms 内；
 * - 审计 timings 显示 upstreamHeadersMs/firstVisibleTextMs 都在数秒内，
 *   说明正文早已发完，等待的只是连接关闭。
 *
 * 这里在转发侧按行增量扫描 SSE，一旦看到终帧立即判定为逻辑完成，由调用方收尾
 * 客户端并写 200 终态记录。注意：SSE 帧会被 TCP 任意切分，必须缓存未结束的
 * 半行，否则会漏判。
 */
'use strict';

const { StringDecoder } = require('string_decoder');

// Responses 上游的终帧；[DONE] 是一些兼容上游的收尾哨兵。
const DEFAULT_TERMINAL_MARKERS = [
  '"type":"response.completed"',
  '"type": "response.completed"',
  '"type":"response.incomplete"',
  '"type": "response.incomplete"',
  '"type":"response.failed"',
  '"type": "response.failed"',
  '[DONE]',
  '"event":"message_stop"',
  '"event": "message_stop"',
  'event: message_stop',
];

// 防止异常流把缓冲撑爆：终帧一定在行首附近，保留一个有限窗口即可。
const MAX_PENDING_LINE_CHARS = 256 * 1024;

/**
 * @param {object} options
 * @param {(marker: string) => void} options.onTerminal 首次发现终帧时回调一次
 * @param {string[]} [options.markers] 自定义终帧标记
 */
function createUpstreamTerminalFrameWatcher(options = {}) {
  const onTerminal = options.onTerminal;
  const markers =
    Array.isArray(options.markers) && options.markers.length
      ? options.markers
      : DEFAULT_TERMINAL_MARKERS;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let settled = false;
  let matched = null;

  // Only SSE lines may match. A pretty-printed JSON body can contain the literal
  // "type": "response.completed" on its own line, and ending the response on that
  // would truncate a non-streaming answer.
  function isSseLine(line) {
    const trimmed = line.trim();
    return trimmed.startsWith('data:') || trimmed.startsWith('event:');
  }

  function scanLine(line) {
    if (!isSseLine(line)) return null;
    for (const marker of markers) {
      if (line.indexOf(marker) >= 0) return marker;
    }
    return null;
  }

  return {
    /** 探测到终帧时返回命中的标记，否则返回 null。最多回调一次。 */
    push(chunk) {
      if (settled || !chunk) return null;
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      // 逐行判定；最后一段可能仍是半行，留在 pending 里等下一个 chunk。
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        const hit = scanLine(line);
        if (hit) {
          settled = true;
          matched = hit;
          if (typeof onTerminal === 'function') onTerminal(hit);
          return hit;
        }
        newlineIndex = pending.indexOf('\n');
      }
      if (pending.length > MAX_PENDING_LINE_CHARS) {
        // 保留尾部，避免无换行的异常流无限增长。
        pending = pending.slice(-MAX_PENDING_LINE_CHARS);
      }
      return null;
    },
    isSettled: () => settled,
    matchedMarker: () => matched,
  };
}

module.exports = { createUpstreamTerminalFrameWatcher, DEFAULT_TERMINAL_MARKERS };
