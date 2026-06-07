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

function createTraeBridgeUtils({
  makeRequest,
  getTraeOfficialBridgeUrl,
  normalizeTraeBridgeText,
  bridgeTimeoutMs = Number(process.env.TRAE_BRIDGE_TIMEOUT_MS || 5 * 60 * 1000),
  liveHeartbeatMs = Number(process.env.TRAE_BRIDGE_LIVE_HEARTBEAT_MS || 2000),
}) {
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
      const res = await makeRequest(bridgeUrl, {
        method: 'POST',
        timeout: bridgeTimeoutMs,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
      }, body);
      let parsed;
      try {
        parsed = JSON.parse(res.body || '{}');
      } catch (err) {
        parsed = { ok: false, error: 'Trae bridge returned non-JSON response', body: res.body };
      }
      if (res.statusCode < 200 || res.statusCode >= 300 || parsed.ok === false) {
        const message = parsed && (parsed.error || parsed.message) || `Trae bridge failed with HTTP ${res.statusCode}`;
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
      let payload = {};
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
      return `[Trae ${type}${cwd}${command}]`;
    }
    if (type === 'AskUserQuestion') {
      const questions = Array.isArray(interaction.questions)
        ? interaction.questions.map((item) => item && (item.question || item.text || item.title)).filter(Boolean).join('; ')
        : '';
      return `[Trae ${type}${questions ? ': ' + questions : ''}]`;
    }
    if (type === 'NotifyUser') {
      const explanation = interaction.explanation ? `: ${interaction.explanation}` : '';
      return `[Trae ${type}${explanation}]`;
    }
    return `[Trae ${type}]`;
  }

  function getTraeBridgeErrorMessage(error) {
    return error && error.message ? String(error.message) : String(error || 'Trae bridge stream error');
  }

  function formatTraeBridgeStreamError(error) {
    const message = getTraeBridgeErrorMessage(error);
    const label = /not waiting input|busy|running/i.test(message) ? 'busy' : 'error';
    return `[Trae bridge ${label}: ${message}]`;
  }

  function startLiveHeartbeat(writeHeartbeat) {
    if (!writeHeartbeat || liveHeartbeatMs <= 0) return () => {};
    const startedAt = Date.now();
    const timer = setInterval(() => {
      writeHeartbeat({
        phase: 'running',
        elapsedMs: Date.now() - startedAt,
        source: 'proxy',
      });
    }, liveHeartbeatMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  async function streamTraeOfficialBridge(payload, handlers = {}) {
    return enqueueBridgeRequest(async () => {
      const body = JSON.stringify(payload);
      const bridgeUrl = getTraeOfficialBridgeUrl('/v1/chat/stream');
      let parsedUrl;
      try {
        parsedUrl = new URL(bridgeUrl);
      } catch (err) {
        throw new Error('Invalid Trae bridge stream URL: ' + bridgeUrl);
      }
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const finalState = { text: '', rawDone: null, bridgeUrl };
      await new Promise((resolve, reject) => {
        const req = lib.request({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          timeout: bridgeTimeoutMs,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res) => {
          const sseState = { buffer: '' };
          const errorChunks = [];
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.on('data', (chunk) => errorChunks.push(chunk));
            res.on('end', () => {
              const error = new Error(`Trae bridge stream failed with HTTP ${res.statusCode}: ${Buffer.concat(errorChunks).toString('utf8')}`);
              error.statusCode = res.statusCode;
              error.bridgeUrl = bridgeUrl;
              reject(error);
            });
            return;
          }
          res.on('data', (chunk) => {
            parseSseEvents(sseState, chunk.toString('utf8'), (eventName, eventPayload) => {
              if (eventName === 'text_delta') {
                const text = typeof eventPayload.text === 'string' ? eventPayload.text : '';
                finalState.text += text;
                if (text && handlers.onTextDelta) handlers.onTextDelta(text, eventPayload);
              } else if (eventName === 'interaction') {
                if (handlers.onInteraction) handlers.onInteraction(eventPayload.interaction, eventPayload);
              } else if (eventName === 'progress') {
                if (handlers.onProgress) handlers.onProgress(eventPayload);
              } else if (eventName === 'raw_event') {
                if (handlers.onRawEvent) handlers.onRawEvent(eventPayload);
              } else if (eventName === 'done') {
                finalState.rawDone = eventPayload;
                if (typeof eventPayload.text === 'string') finalState.text = eventPayload.text;
                if (handlers.onDone) handlers.onDone(eventPayload);
              } else if (eventName === 'error') {
                const error = new Error(eventPayload.error || 'Trae bridge stream error');
                error.bridgeUrl = bridgeUrl;
                reject(error);
              }
            });
          });
          res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Trae bridge stream timeout (' + Math.round(bridgeTimeoutMs / 1000) + 's)'));
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
