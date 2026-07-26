/**
 * Trae Bridge 工具层: SSE 解析、请求队列、错误格式化、心跳
 *
 * 拆分自 trae-bridge-runtime.js,负责"如何与 Trae 上游通信"和
 * "如何把 SSE 流解析为可消费的回调",不关心协议转换和写回 clientRes。
 *
 * 公开 API (createTraeBridgeUtils(deps)):
 *   - enqueueBridgeRequest(fn)        串行化跨请求的 bridge 调用
 *   - parseSseEvents(state, chunk, cb) 增量 SSE 解析 (state.buffer 保留跨 chunk 状态)
 *   - formatTraeInteraction(i)       人类可读一行标记
 *   - getTraeBridgeErrorMessage(err) 归一化错误 message
 *   - formatTraeBridgeStreamError(err) 同上,加 [Trae bridge error: ...] 前缀
 *   - startLiveHeartbeat(writeFn)    返回 stop() 的间隔心跳
 *   - callTraeOfficialBridge(payload) 非流式一次性 POST
 *   - streamTraeOfficialBridge(p, handlers) 流式 POST,回调驱动 (textDelta/interaction/progress/raw_event/done/error)
 */

const http = require('http');
const https = require('https');
const {
  parseBoundedInteger,
  parsePortOrDefault,
  readTextBodyFromResponse,
} = require('./management-utils');

const DEFAULT_BRIDGE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_LIVE_HEARTBEAT_MS = 2000;
const DEFAULT_FINAL_TEXT_MAX_CHARS = 1024 * 1024;
const MAX_FINAL_TEXT_MAX_CHARS = 4 * 1024 * 1024;
const DEFAULT_SSE_BUFFER_MAX_CHARS = 1024 * 1024;
const MAX_SSE_BUFFER_MAX_CHARS = 4 * 1024 * 1024;

function createTraeBridgeUtils({
  makeRequest,
  getTraeOfficialBridgeUrl,
  normalizeTraeBridgeText,
  bridgeTimeoutMs = process.env.TRAE_BRIDGE_TIMEOUT_MS,
  liveHeartbeatMs = process.env.TRAE_BRIDGE_LIVE_HEARTBEAT_MS,
  maxFinalTextChars = process.env.TRAE_BRIDGE_MAX_FINAL_TEXT_CHARS,
  maxSseBufferChars = process.env.TRAE_BRIDGE_MAX_SSE_BUFFER_CHARS,
}) {
  const safeBridgeTimeoutMs = parseBoundedInteger(
    bridgeTimeoutMs,
    DEFAULT_BRIDGE_TIMEOUT_MS,
    1000,
    10 * 60 * 1000
  );
  const safeLiveHeartbeatMs = parseBoundedInteger(
    liveHeartbeatMs,
    DEFAULT_LIVE_HEARTBEAT_MS,
    0,
    60 * 1000
  );
  const safeMaxFinalTextChars = parseBoundedInteger(
    maxFinalTextChars,
    DEFAULT_FINAL_TEXT_MAX_CHARS,
    0,
    MAX_FINAL_TEXT_MAX_CHARS
  );
  const safeMaxSseBufferChars = parseBoundedInteger(
    maxSseBufferChars,
    DEFAULT_SSE_BUFFER_MAX_CHARS,
    1024,
    MAX_SSE_BUFFER_MAX_CHARS
  );
  let bridgeQueue = Promise.resolve();

  function enqueueBridgeRequest(fn) {
    const run = bridgeQueue.then(fn, fn);
    bridgeQueue = run.catch(() => {});
    return run;
  }

  async function callTraeOfficialBridge(payload) {
    return enqueueBridgeRequest(async () => {
      const body = JSON.stringify(payload);
      const bridgeUrl = getTraeOfficialBridgeUrl('/v1/chat');
      const res = await makeRequest(
        bridgeUrl,
        {
          method: 'POST',
          timeout: safeBridgeTimeoutMs,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        body
      );
      let parsed;
      try {
        parsed = JSON.parse(res.body || '{}');
      } catch (err) {
        parsed = { ok: false, error: 'Trae bridge returned non-JSON response', body: res.body };
      }
      if (res.statusCode < 200 || res.statusCode >= 300 || parsed.ok === false) {
        const message =
          (parsed && (parsed.error || parsed.message)) ||
          `Trae bridge failed with HTTP ${res.statusCode}`;
        const error = new Error(String(message));
        error.statusCode = res.statusCode;
        error.bridgeUrl = bridgeUrl;
        throw error;
      }
      return { text: normalizeTraeBridgeText(parsed), raw: parsed, bridgeUrl };
    });
  }

  function parseSseEvents(state, chunkText, onEvent) {
    state.buffer += chunkText;
    if (state.buffer.length > safeMaxSseBufferChars) {
      state.buffer = '';
      throw new Error('Trae bridge SSE event too large; max ' + safeMaxSseBufferChars + ' chars');
    }
    const events = state.buffer.split(/\r?\n\r?\n/);
    state.buffer = events.pop();
    for (const eventText of events) {
      const lines = eventText.split(/\r?\n/);
      let eventName = 'message';
      const dataLines = [];
      for (const line of lines) {
        if (line.indexOf('event:') === 0) eventName = line.slice(6).trim() || 'message';
        if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      let payload;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch (err) {
        payload = { raw: dataLines.join('\n') };
      }
      onEvent(eventName, payload);
    }
  }

  function formatTraeInteraction(interaction) {
    if (!interaction || typeof interaction !== 'object') return '';
    const type = interaction.type || interaction.toolName || 'interaction';
    if (type === 'RunCommand') {
      const cwd = interaction.cwd ? ` cwd=${interaction.cwd}` : '';
      const command = interaction.command ? ` command=${interaction.command}` : '';
      return `Trae 请求执行命令${cwd}${command}`;
    }
    if (type === 'AskUserQuestion') {
      const questions = Array.isArray(interaction.questions)
        ? interaction.questions
            .map((item) => item && (item.question || item.text || item.title))
            .filter(Boolean)
            .join('; ')
        : '';
      return `Trae 请求用户确认${questions ? ': ' + questions : ''}`;
    }
    if (type === 'NotifyUser') {
      const explanation = interaction.explanation ? `: ${interaction.explanation}` : '';
      return `Trae 通知${explanation}`;
    }
    return `Trae ${type}`;
  }

  function getTraeBridgeErrorMessage(error) {
    return error && error.message
      ? String(error.message)
      : String(error || 'Trae bridge stream error');
  }

  function formatTraeBridgeStreamError(error) {
    const message = getTraeBridgeErrorMessage(error);
    const label = /not waiting input|busy|running/i.test(message) ? 'busy' : 'error';
    return `[Trae bridge ${label}: ${message}]`;
  }

  function startLiveHeartbeat(writeHeartbeat) {
    if (!writeHeartbeat || safeLiveHeartbeatMs <= 0) return () => {};
    const startedAt = Date.now();
    const timer = setInterval(() => {
      writeHeartbeat({
        phase: 'running',
        elapsedMs: Date.now() - startedAt,
        source: 'proxy',
      });
    }, safeLiveHeartbeatMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  function appendFinalTextSnapshot(finalState, text) {
    if (!text) return;
    if (safeMaxFinalTextChars <= 0) {
      finalState.textTruncated = true;
      return;
    }
    const remaining = safeMaxFinalTextChars - finalState.text.length;
    if (remaining <= 0) {
      finalState.textTruncated = true;
      return;
    }
    if (text.length > remaining) {
      finalState.text += text.slice(0, remaining);
      finalState.textTruncated = true;
      return;
    }
    finalState.text += text;
  }

  function boundedFinalTextSnapshot(text) {
    if (!text || safeMaxFinalTextChars <= 0) {
      return { text: '', truncated: Boolean(text) };
    }
    if (text.length <= safeMaxFinalTextChars) {
      return { text, truncated: false };
    }
    return { text: text.slice(0, safeMaxFinalTextChars), truncated: true };
  }

  async function streamTraeOfficialBridge(payload, handlers = {}) {
    return enqueueBridgeRequest(async () => {
      const body = JSON.stringify(payload);
      const bridgeUrl = getTraeOfficialBridgeUrl('/v1/chat/stream');
      let parsedUrl;
      try {
        parsedUrl = new URL(bridgeUrl);
      } catch (err) {
        throw new Error('Invalid Trae bridge stream URL', { cause: err });
      }
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const finalState = { text: '', textTruncated: false, rawDone: null, bridgeUrl };
      await new Promise((resolve, reject) => {
        const req = lib.request(
          {
            hostname: parsedUrl.hostname,
            port: parsePortOrDefault(parsedUrl.port, parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            timeout: safeBridgeTimeoutMs,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            const sseState = { buffer: '' };
            if (res.statusCode < 200 || res.statusCode >= 300) {
              readTextBodyFromResponse(
                res,
                (bodyErr, text) => {
                  const detail = bodyErr ? bodyErr.message : text;
                  const error = new Error(
                    `Trae bridge stream failed with HTTP ${res.statusCode}: ${detail}`
                  );
                  error.statusCode = res.statusCode;
                  error.bridgeUrl = bridgeUrl;
                  reject(error);
                },
                { maxBytes: 512 * 1024 }
              );
              return;
            }
            res.on('data', (chunk) => {
              try {
                parseSseEvents(sseState, chunk.toString('utf8'), (eventName, eventPayload) => {
                  if (eventName === 'text_delta') {
                    const text = typeof eventPayload.text === 'string' ? eventPayload.text : '';
                    appendFinalTextSnapshot(finalState, text);
                    if (text && handlers.onTextDelta) handlers.onTextDelta(text, eventPayload);
                  } else if (eventName === 'interaction') {
                    if (handlers.onInteraction)
                      handlers.onInteraction(eventPayload.interaction, eventPayload);
                  } else if (eventName === 'progress') {
                    if (handlers.onProgress) handlers.onProgress(eventPayload);
                  } else if (eventName === 'raw_event') {
                    if (handlers.onRawEvent) handlers.onRawEvent(eventPayload);
                  } else if (eventName === 'done') {
                    if (typeof eventPayload.text === 'string') {
                      const snapshot = boundedFinalTextSnapshot(eventPayload.text);
                      finalState.text = snapshot.text;
                      finalState.textTruncated = finalState.textTruncated || snapshot.truncated;
                      finalState.rawDone = {
                        ...eventPayload,
                        text: snapshot.text,
                        textTruncated: snapshot.truncated,
                      };
                    } else {
                      finalState.rawDone = eventPayload;
                    }
                    if (handlers.onDone) handlers.onDone(eventPayload);
                  } else if (eventName === 'error') {
                    const error = new Error(eventPayload.error || 'Trae bridge stream error');
                    error.bridgeUrl = bridgeUrl;
                    reject(error);
                  }
                });
              } catch (err) {
                err.bridgeUrl = bridgeUrl;
                res.destroy();
                reject(err);
              }
            });
            res.on('end', () => resolve());
          }
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(
            new Error(
              'Trae bridge stream timeout (' + Math.round(safeBridgeTimeoutMs / 1000) + 's)'
            )
          );
        });
        req.end(body);
      });
      return finalState;
    });
  }

  return {
    enqueueBridgeRequest,
    parseSseEvents,
    formatTraeInteraction,
    getTraeBridgeErrorMessage,
    formatTraeBridgeStreamError,
    startLiveHeartbeat,
    callTraeOfficialBridge,
    streamTraeOfficialBridge,
  };
}

module.exports = {
  createTraeBridgeUtils,
};
