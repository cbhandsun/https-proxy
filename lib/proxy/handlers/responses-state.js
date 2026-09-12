/**
 * OpenAI Responses API 状态/历史/桥接
 *
 * 维护 Responses API 的多轮会话历史(进程内 Map + 磁盘 debounce 持久化),
 * 以及在 OpenAI Chat Completions 与 Responses 之间互转的桥接/历史转换。
 *
 * 提取自 handlers.js,封装为工厂函数;`responsesHistory` 状态对外暴露
 * (供测试和外部观察)。
 */
'use strict';

const fs = require('fs');
const { parseBoundedInteger, writeTextFileAtomically } = require('../management-utils');

const DEFAULT_HISTORY_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const MIN_HISTORY_CACHE_MAX_BYTES = 1024;
const MAX_HISTORY_CACHE_MAX_BYTES = 16 * 1024 * 1024;

function createResponsesState(deps) {
  const {
    log,
    sendJsonError,
    logProxyEvent,
    logRequestEnd,
    fallbackId,
    stableCreated,
    processOpenAIChatSseChunkToResponses,
    flushOpenAIChatSseToResponses,
    openAIResponsesToChat,
    mergeAdjacentAssistantMessages,
    conversionResponseLimit,
    cacheFile,
    cacheFileMaxBytes,
    cacheSaveDelayMs = 1000,
    writeHistoryCacheFile = writeTextFileAtomically,
    limit = 20,
  } = deps;

  const responsesHistory = new Map();
  const maxCacheBytes = parseBoundedInteger(
    cacheFileMaxBytes,
    DEFAULT_HISTORY_CACHE_MAX_BYTES,
    MIN_HISTORY_CACHE_MAX_BYTES,
    MAX_HISTORY_CACHE_MAX_BYTES
  );
  let saveTimeout = null;

  // 启动时从磁盘加载历史(向后兼容旧版本)
  try {
    if (cacheFile && fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile);
      if (stat.size > maxCacheBytes) {
        log.warn(
          '[proxy] Responses history cache is too large; skipping load:',
          stat.size,
          '>',
          maxCacheBytes
        );
      } else {
        const raw = fs.readFileSync(cacheFile, 'utf8');
        const entries = JSON.parse(raw);
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length < 2) continue;
            const [key, value] = entry;
            if (typeof key !== 'string' || !key || !Array.isArray(value)) continue;
            responsesHistory.set(key, value);
            while (responsesHistory.size > limit) {
              const firstKey = responsesHistory.keys().next().value;
              responsesHistory.delete(firstKey);
            }
          }
          log.info('[proxy] Loaded responses history from cache. Entries:', responsesHistory.size);
        }
      }
    }
  } catch (err) {
    log.warn('[proxy] Failed to load responses history cache:', err.message);
  }

  function serializeResponsesHistoryForDisk() {
    const entries = Array.from(responsesHistory.entries());
    let serialized = JSON.stringify(entries);
    while (Buffer.byteLength(serialized, 'utf8') > maxCacheBytes && entries.length > 0) {
      entries.shift();
      serialized = JSON.stringify(entries);
    }
    const dropped = responsesHistory.size - entries.length;
    if (dropped > 0) {
      log.warn('[proxy] Dropped old responses history entries before cache save:', dropped);
    }
    return serialized;
  }

  function saveResponsesHistoryToDisk() {
    if (!cacheFile) return;
    if (saveTimeout) return;
    const delayMs = parseBoundedInteger(cacheSaveDelayMs, 1000, 0, 60 * 1000);
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      try {
        const serialized = serializeResponsesHistoryForDisk();
        writeHistoryCacheFile(cacheFile, serialized, 'utf8');
      } catch (err) {
        log.warn('[proxy] Failed to save responses history cache:', err.message);
      }
    }, delayMs);
  }

  function collectBoundedResponse(
    proxyRes,
    clientRes,
    upstreamPath,
    type,
    onComplete,
    context = {}
  ) {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;

    function finishWithError(statusCode, meta) {
      if (typeof logRequestEnd !== 'function' || !context.method || context.startTime == null) {
        return;
      }
      logRequestEnd(context.method, upstreamPath, context.startTime, statusCode, meta);
    }

    proxyRes.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > conversionResponseLimit) {
        tooLarge = true;
        chunks.length = 0;
        proxyRes.destroy();
        if (!clientRes.headersSent) {
          sendJsonError(clientRes, 502, {
            error: {
              type: 'upstream_response_too_large',
              message:
                'Upstream response for protocol conversion exceeds proxy limit of ' +
                conversionResponseLimit +
                ' bytes',
            },
          });
        }
        logProxyEvent('upstream_response_too_large', {
          path: upstreamPath,
          type,
          bytes,
          limit: conversionResponseLimit,
        });
        finishWithError(502, {
          type: context.tooLargeLogType || type + '_response_too_large',
          errorType: 'upstream_response_too_large',
          bytes,
          limit: conversionResponseLimit,
        });
        return;
      }
      chunks.push(chunk);
    });

    proxyRes.on('end', () => {
      if (tooLarge) return;
      onComplete(Buffer.concat(chunks, bytes).toString('utf8'));
    });

    proxyRes.on('error', (err) => {
      if (tooLarge || clientRes.headersSent) return;
      const message = err && err.message ? err.message : String(err);
      sendJsonError(clientRes, 502, {
        error: { type: 'proxy_error', message: 'Upstream response error: ' + message },
      });
      logProxyEvent('upstream_response_error', {
        path: upstreamPath,
        type,
        error: message,
        code: err && err.code,
      });
      finishWithError(502, {
        type: context.errorLogType || type + '_response_error',
        errorType: 'proxy_error',
        error: message,
        code: err && err.code,
      });
    });
  }

  function createResponsesStreamState(parsed, targetModel) {
    const seed = { model: parsed.model || targetModel, input: parsed.input, route: targetModel };
    return {
      id: fallbackId('resp', seed),
      created_at: stableCreated(seed),
      model: parsed.model || targetModel,
      buffer: '',
      started: false,
      outputIndex: 0,
      messageId: null,
      textItemStarted: false,
      textItemDone: false,
      text: '',
      pendingToolCalls: [],
      toolCalls: [],
      completedOutputItems: [],
      usage: undefined,
      done: false,
    };
  }

  function createChatToResponsesBridge(clientRes, parsed, targetModel) {
    const responseState = createResponsesStreamState(parsed, targetModel);
    return {
      responseState,
      chatRes: {
        write: (chunk) =>
          processOpenAIChatSseChunkToResponses(clientRes, String(chunk), responseState),
      },
      flush: () => flushOpenAIChatSseToResponses(clientRes, responseState),
    };
  }

  function rememberResponsesHistory(responseId, messages) {
    if (!responseId || !Array.isArray(messages)) return;
    responsesHistory.set(responseId, messages);
    while (responsesHistory.size > limit) {
      const firstKey = responsesHistory.keys().next().value;
      responsesHistory.delete(firstKey);
    }
    saveResponsesHistoryToDisk();
  }

  function responseOutputItemsToChatMessages(outputItems) {
    const messages = [];
    for (const item of Array.isArray(outputItems) ? outputItems : []) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'message') {
        const text = (Array.isArray(item.content) ? item.content : [])
          .filter((part) => part && (part.type === 'output_text' || part.type === 'text'))
          .map((part) => part.text || '')
          .join('');
        messages.push({ role: item.role || 'assistant', content: text });
      } else if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: item.call_id || item.id,
              type: 'function',
              function: {
                name: item.name || 'tool',
                arguments:
                  typeof item.arguments === 'string'
                    ? item.arguments
                    : JSON.stringify(item.arguments || {}),
              },
            },
          ],
        });
      }
    }
    return messages;
  }

  function responsesToChatWithHistory(clientRes, parsed, targetModel) {
    const chatBody = openAIResponsesToChat({ ...parsed, model: targetModel });
    if (!parsed || !parsed.previous_response_id) return chatBody;
    const previousMessages = responsesHistory.get(parsed.previous_response_id);
    if (!previousMessages) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message:
            'previous_response_id "' +
            parsed.previous_response_id +
            '" is not available in this proxy process. Send full input history or retry without previous_response_id.',
        },
      });
      return null;
    }
    const combinedMessages = [...previousMessages, ...chatBody.messages];
    const messages =
      typeof mergeAdjacentAssistantMessages === 'function'
        ? mergeAdjacentAssistantMessages(combinedMessages)
        : combinedMessages;
    return { ...chatBody, messages };
  }

  function rememberResponsesFromChatResponse(response, chatBody, chatPayload) {
    const choice =
      chatPayload && Array.isArray(chatPayload.choices) ? chatPayload.choices[0] : null;
    const message = choice && choice.message ? choice.message : null;
    rememberResponsesHistory(
      response && response.id,
      message ? [...chatBody.messages, message] : chatBody.messages
    );
  }

  function rememberResponsesFromBridge(bridge, chatBody) {
    const outputMessages = responseOutputItemsToChatMessages(
      bridge && bridge.responseState && bridge.responseState.completedOutputItems
    );
    rememberResponsesHistory(bridge && bridge.responseState && bridge.responseState.id, [
      ...chatBody.messages,
      ...outputMessages,
    ]);
  }

  return {
    responsesHistory,
    saveResponsesHistoryToDisk,
    collectBoundedResponse,
    createResponsesStreamState,
    createChatToResponsesBridge,
    rememberResponsesHistory,
    responseOutputItemsToChatMessages,
    responsesToChatWithHistory,
    rememberResponsesFromChatResponse,
    rememberResponsesFromBridge,
  };
}

module.exports = { createResponsesState };
