/**
 * Trae OpenAI Bridge Extension - 桥接层
 *
 * 拆分自 extension.js (536 行),包含两种 dispatch:
 *   - dispatchChat()      同步:执行 waitCommand,返回最终结果
 *   - dispatchChatStream() 流式:订阅 rawStream,emit text_delta/interaction/progress/done
 *
 * 通过 factory 注入 vscode 命令入口 + 日志函数,便于测试。
 *
 * 依赖 extension-utils.js 的常量与 HTTP 工具。
 */

const {
  WAIT_COMMAND_CANDIDATES,
  STREAMING_COMMAND_CANDIDATES,
  RAW_STREAM_COMMAND,
  BUSY_RETRY_ATTEMPTS,
  BUSY_RETRY_DELAY_MS,
  delay,
  isBusyTraeError,
  normalizeResult,
  pickTraeCommand: pickTraeCommandPure,
  listTraeBridgeCommands: listTraeBridgeCommandsPure,
  sendSseEvent,
} = require('./extension-utils');

function createBridge({
  executeCommand,           // async (command, ...args) => result
  getAllCommands,           // async () => [string]
  log = () => {},           // optional logger
}) {
  async function pickTraeCommand() {
    const commands = await getAllCommands();
    return pickTraeCommandPure(commands);
  }

  async function listTraeBridgeCommands() {
    const commands = await getAllCommands();
    return listTraeBridgeCommandsPure(commands);
  }

  async function dispatchChat(payload, onProgress) {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    if (!prompt.trim()) throw new Error('prompt is required');
    const images = Array.isArray(payload.images) ? payload.images : undefined;
    let lastError = null;

    for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt += 1) {
      const command = await pickTraeCommand();
      if (!command) {
        throw new Error(`Trae bridge command not found: ${WAIT_COMMAND_CANDIDATES.join(', ')}`);
      }
      try {
        log(`execute ${command}, prompt_chars=${prompt.length}, images=${images ? images.length : 0}`);
        const result = await executeCommand(command, prompt, images);
        return { ok: true, command, ...normalizeResult(result) };
      } catch (err) {
        lastError = err;
        const message = err && err.message ? err.message : String(err);
        log(`command failed: ${message}`);
        const isBusy = isBusyTraeError(message);
        if (!isBusy || attempt === BUSY_RETRY_ATTEMPTS - 1) break;
        if (onProgress) {
          onProgress({
            phase: 'busy',
            attempt: attempt + 1,
            maxAttempts: BUSY_RETRY_ATTEMPTS,
            retryInMs: BUSY_RETRY_DELAY_MS,
            message
          });
        }
        await delay(BUSY_RETRY_DELAY_MS);
      }
    }

    throw lastError || new Error('Trae bridge command failed');
  }

  async function dispatchChatStream(payload, res, context = {}) {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    if (!prompt.trim()) throw new Error('prompt is required');
    const images = Array.isArray(payload.images) ? payload.images : undefined;
    const commands = await listTraeBridgeCommands();
    const command = commands.streamCommand;
    if (!command) {
      throw new Error(`Trae streaming bridge command not found: ${STREAMING_COMMAND_CANDIDATES.join(', ')}`);
    }
    const { sanitizeRawStreamEvent, makeRawEventKey } = context;

    let fullText = '';
    let closed = false;
    const progressStarted = Date.now();
    let progressTimer = null;
    let rawPollTimer = null;
    let rawStreamSubscription = null;
    const rawStreamStartedAt = Date.now();
    const seenRawEvents = new Set();
    const cleanupRawStream = () => {
      if (rawPollTimer) {
        clearInterval(rawPollTimer);
        rawPollTimer = null;
      }
      if (rawStreamSubscription && typeof rawStreamSubscription.dispose === 'function') {
        try {
          rawStreamSubscription.dispose();
        } catch (err) {
          log(`raw stream unsubscribe failed: ${err && err.message ? err.message : String(err)}`);
        }
      }
      rawStreamSubscription = null;
    };
    res.on('close', () => {
      closed = true;
      if (progressTimer) clearInterval(progressTimer);
      cleanupRawStream();
    });
    progressTimer = setInterval(() => {
      if (closed) return;
      sendSseEvent(res, 'progress', {
        phase: 'running',
        elapsedMs: Date.now() - progressStarted
      });
    }, 2000);

    const emitText = (nextText) => {
      if (closed || typeof nextText !== 'string') return;
      const delta = nextText.startsWith(fullText) ? nextText.slice(fullText.length) : nextText;
      fullText = nextText;
      if (delta) sendSseEvent(res, 'text_delta', { text: delta, fullText });
    };
    const emitInteraction = (interaction) => {
      if (!closed) sendSseEvent(res, 'interaction', { interaction });
    };
    const emitRawEvent = (event) => {
      if (!closed) sendSseEvent(res, 'raw_event', sanitizeRawStreamEvent ? sanitizeRawStreamEvent(event) : event);
    };
    const emitRawSnapshot = async () => {
      if (closed || !commands.rawStreamCommand) return;
      try {
        const events = await executeCommand(commands.rawStreamCommand);
        if (!Array.isArray(events)) return;
        for (const event of events) {
          if (!event || typeof event !== 'object') continue;
          if (typeof event.ts === 'number' && event.ts < rawStreamStartedAt - 1000) continue;
          if (event.service && (event.service !== 'chat' || event.method !== 'chat')) continue;
          const key = makeRawEventKey ? makeRawEventKey(event) : JSON.stringify(event);
          if (seenRawEvents.has(key)) continue;
          seenRawEvents.add(key);
          emitRawEvent(event);
        }
      } catch (err) {
        log(`raw stream poll failed: ${err && err.message ? err.message : String(err)}`);
      }
    };

    if (commands.rawStreamCommand) {
      try {
        rawStreamSubscription = await executeCommand(commands.rawStreamCommand, emitRawEvent);
        rawPollTimer = setInterval(() => {
          emitRawSnapshot();
        }, 250);
        sendSseEvent(res, 'progress', {
          phase: 'raw_stream_subscribed',
          elapsedMs: Date.now() - progressStarted
        });
      } catch (err) {
        log(`raw stream subscribe failed: ${err && err.message ? err.message : String(err)}`);
        sendSseEvent(res, 'progress', {
          phase: 'raw_stream_unavailable',
          elapsedMs: Date.now() - progressStarted,
          message: err && err.message ? err.message : String(err)
        });
      }
    } else {
      sendSseEvent(res, 'progress', {
        phase: 'raw_stream_unavailable',
        elapsedMs: Date.now() - progressStarted,
        message: `${RAW_STREAM_COMMAND} is not registered`
      });
    }

    log(`execute ${command}, prompt_chars=${prompt.length}, images=${images ? images.length : 0}`);
    let result = null;
    let lastError = null;
    for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        result = await executeCommand(command, prompt, images, emitText, emitInteraction);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        const message = err && err.message ? err.message : String(err);
        log(`stream command failed: ${message}`);
        const isBusy = isBusyTraeError(message);
        if (!isBusy || attempt === BUSY_RETRY_ATTEMPTS - 1) break;
        sendSseEvent(res, 'progress', {
          phase: 'busy',
          attempt: attempt + 1,
          maxAttempts: BUSY_RETRY_ATTEMPTS,
          retryInMs: BUSY_RETRY_DELAY_MS,
          elapsedMs: Date.now() - progressStarted,
          message
        });
        await delay(BUSY_RETRY_DELAY_MS);
      }
    }
    await emitRawSnapshot();
    if (lastError) {
      log(`fallback wait command, prompt_chars=${prompt.length}, images=${images ? images.length : 0}`);
      result = await dispatchChat(payload, (progress) => {
        if (!closed) {
          sendSseEvent(res, 'progress', {
            ...progress,
            phase: progress.phase || 'busy',
            fallback: true,
            elapsedMs: Date.now() - progressStarted
          });
        }
      });
    }
    const normalized = normalizeResult(result);
    if (typeof normalized.text === 'string' && normalized.text && normalized.text !== fullText) {
      emitText(normalized.text);
    }
    await emitRawSnapshot();
    if (!closed) {
      sendSseEvent(res, 'done', { ok: true, command, text: fullText || normalized.text || '', files: normalized.files });
      res.end();
    }
    cleanupRawStream();
    if (progressTimer) clearInterval(progressTimer);
  }

  return {
    pickTraeCommand,
    listTraeBridgeCommands,
    dispatchChat,
    dispatchChatStream,
  };
}

module.exports = {
  createBridge,
};
