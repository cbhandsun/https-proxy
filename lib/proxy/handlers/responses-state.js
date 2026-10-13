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
const { randomUUID } = require('node:crypto');
const { mergeResponsesChatHistory } = require('../responses-history-merge');
const { jsonObjectRequested } = require('../json-object-output-contract');
const {
  applyResponsesHistoryPolicy,
  shouldStoreResponsesHistory,
  preservesResponsesHistory,
} = require('../responses-history-policy');
const { createConversationSummary, summaryToChatMessages } = require('../context-summary');
const { parseBoundedInteger, writeTextFileAtomically } = require('../management-utils');
const { collectCustomToolNames } = require('../responses-custom-tools');
const { terminateClientAfterUpstreamFailure } = require('./failure-terminal');
const { clientAcceptsEventStream, safeErrorCode } = require('./upstream-stream-guard');
const {
  isSemanticEntry,
  sanitizeSemanticHistory,
  semanticHistoryToChat,
} = require('../responses-semantic-history');
const { createResponsesSemanticState } = require('./responses-semantic-state');

const DEFAULT_HISTORY_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const MIN_HISTORY_CACHE_MAX_BYTES = 1024;
const MAX_HISTORY_CACHE_MAX_BYTES = 16 * 1024 * 1024;

function isEmptyAssistantHistoryMessage(message) {
  if (!message || typeof message !== 'object' || message.role !== 'assistant') return false;
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (hasToolCalls) return false;
  if (typeof message.function_call?.name === 'string' && message.function_call.name.trim())
    return false;
  const content = message.content;
  if (content == null) return true;
  if (typeof content === 'string') return content.trim() === '';
  if (Array.isArray(content)) {
    return !content.some((part) => {
      if (!part || typeof part !== 'object') return false;
      if (part.type === 'text' || part.type === 'output_text') {
        return typeof part.text === 'string' && part.text.trim() !== '';
      }
      return true;
    });
  }
  return false;
}

function sanitizeResponsesHistoryMessages(messages) {
  if (!Array.isArray(messages)) return { messages, removedCount: 0 };
  const sanitized = [];
  let removedCount = 0;
  for (const message of messages) {
    if (isEmptyAssistantHistoryMessage(message)) {
      removedCount += 1;
      continue;
    }
    sanitized.push(message);
  }
  return {
    messages: removedCount > 0 ? sanitized : messages,
    removedCount,
  };
}

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
  const responsesSummaries = new Map();
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
            if (typeof key !== 'string' || !key) continue;
            const semantic = value?.semanticHistory;
            let nativeHistory = null;
            if (isSemanticEntry(semantic)) {
              try {
                nativeHistory = sanitizeSemanticHistory(semantic.history);
              } catch {
                log.warn('[proxy] Invalid semantic responses history cache entry; skipping');
                continue;
              }
            }
            const rawMessages =
              nativeHistory ||
              (Array.isArray(value)
                ? value
                : value && typeof value === 'object' && Array.isArray(value.messages)
                  ? value.messages
                  : null);
            if (!rawMessages) continue;
            const sanitized = nativeHistory
              ? { messages: nativeHistory, removedCount: 0 }
              : sanitizeResponsesHistoryMessages(rawMessages);
            if (sanitized.removedCount > 0) {
              log.warn(
                '[proxy] Dropped empty assistant messages from responses history cache entry:',
                key,
                sanitized.removedCount
              );
            }
            responsesHistory.set(
              key,
              nativeHistory ? { version: 2, history: nativeHistory } : sanitized.messages
            );
            const summary =
              value && typeof value === 'object' && !Array.isArray(value) && value.summary
                ? value.summary
                : createConversationSummary(sanitized.messages);
            responsesSummaries.set(key, summary);
            while (responsesHistory.size > limit) {
              const firstKey = responsesHistory.keys().next().value;
              responsesHistory.delete(firstKey);
              responsesSummaries.delete(firstKey);
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
    // Serialize each entry once and accumulate its byte cost so trimming to the
    // budget never re-stringifies the whole history. Repeated JSON.stringify over
    // the shrinking array was O(n^2) and blocked the event loop for seconds once a
    // few dozen large contexts were cached.
    const parts = entries.map(([key, messages]) =>
      JSON.stringify([
        key,
        {
          ...(isSemanticEntry(messages) ? { semanticHistory: messages } : { messages }),
          summary: responsesSummaries.get(key) || null,
        },
      ])
    );
    const costs = parts.map((value) => Buffer.byteLength(value, 'utf8') + 1);
    let total = costs.reduce((sum, cost) => sum + cost, 0) + 1;
    let keepFrom = 0;
    while (total > maxCacheBytes && keepFrom < entries.length) {
      total -= costs[keepFrom];
      keepFrom += 1;
    }
    let serialized =
      keepFrom >= entries.length ? '[]' : '[' + parts.slice(keepFrom).join(',') + ']';
    if (Buffer.byteLength(serialized, 'utf8') > maxCacheBytes) {
      serialized = '[]';
      keepFrom = entries.length;
    }
    const dropped = keepFrom;
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
    let settled = false;

    function finishWithError(statusCode, meta) {
      if (typeof logRequestEnd !== 'function' || !context.method || context.startTime == null) {
        return;
      }
      logRequestEnd(context.method, upstreamPath, context.startTime, statusCode, meta);
    }

    proxyRes.on('data', (chunk) => {
      if (tooLarge || settled) return;
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
      if (tooLarge || settled) return;
      settled = true;
      const body = Buffer.concat(chunks, bytes).toString('utf8');
      chunks.length = 0;
      onComplete(body);
    });

    // A bounded conversion can also be streaming upstream (forced-stream collapse or
    // a JSON body whose framing was already switched to SSE). If the upstream dies
    // after our headers went out, only the downstream end signal is missing, so we
    // must finish it explicitly.
    const terminateIncomplete = (reason, error) => {
      if (tooLarge || settled) return;
      settled = true;
      chunks.length = 0;
      const message =
        reason === 'aborted' ? 'Upstream response was aborted' : 'Upstream response failed';
      if (clientRes.headersSent) {
        terminateClientAfterUpstreamFailure(clientRes, {
          stream: clientAcceptsEventStream(clientRes),
          payload: { type: 'error', error: { type: 'proxy_error', message } },
        });
      } else {
        sendJsonError(clientRes, 502, {
          error: { type: 'proxy_error', message: 'Upstream response error: ' + message },
        });
      }
      logProxyEvent('upstream_response_error', {
        path: upstreamPath,
        type,
        error: message,
        reason,
        code: safeErrorCode(error),
      });
      finishWithError(502, {
        type: context.errorLogType || type + '_response_error',
        errorType: 'proxy_error',
        error: message,
        reason,
      });
    };

    proxyRes.on('aborted', () => terminateIncomplete('aborted', null));
    proxyRes.on('close', () => {
      if (proxyRes.complete === true) return;
      terminateIncomplete('incomplete_close', null);
    });

    proxyRes.on('error', (err) => {
      if (tooLarge || settled) return;
      if (clientRes.headersSent) {
        terminateIncomplete('error', err);
        return;
      }
      settled = true;
      chunks.length = 0;
      const message = 'Upstream response failed';
      sendJsonError(clientRes, 502, {
        error: { type: 'proxy_error', message: 'Upstream response error: ' + message },
      });
      logProxyEvent('upstream_response_error', {
        path: upstreamPath,
        type,
        error: message,
        code: safeErrorCode(err),
      });
      finishWithError(502, {
        type: context.errorLogType || type + '_response_error',
        errorType: 'proxy_error',
        error: message,
        code: safeErrorCode(err),
      });
    });
  }

  function createResponsesStreamState(parsed, targetModel) {
    // Separate responses must not alias stored history for identical inputs.
    // Keep this identity fixed for the lifetime of one stream; tool IDs remain unchanged.
    const seed = {
      model: parsed.model || targetModel,
      input: parsed.input,
      route: targetModel,
      requestNonce: randomUUID(),
    };
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
      customToolNames: collectCustomToolNames(parsed),
      jsonObjectOutput: jsonObjectRequested(parsed),
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
    if (!responseId || (!Array.isArray(messages) && !isSemanticEntry(messages))) return;
    const nativeHistory = isSemanticEntry(messages)
      ? sanitizeSemanticHistory(messages.history)
      : null;
    const sanitized = nativeHistory
      ? { messages: nativeHistory, removedCount: 0 }
      : sanitizeResponsesHistoryMessages(messages);
    if (sanitized.removedCount > 0) {
      log.warn(
        '[proxy] Dropped empty assistant messages before saving responses history:',
        sanitized.removedCount
      );
    }
    responsesHistory.set(
      responseId,
      nativeHistory ? { version: 2, history: nativeHistory } : sanitized.messages
    );
    responsesSummaries.set(responseId, createConversationSummary(sanitized.messages));
    while (responsesHistory.size > limit) {
      const firstKey = responsesHistory.keys().next().value;
      responsesHistory.delete(firstKey);
      responsesSummaries.delete(firstKey);
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
      } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const isCustomToolCall = item.type === 'custom_tool_call';
        const input =
          typeof item.input === 'string'
            ? { input: item.input }
            : item.input && typeof item.input === 'object'
              ? item.input
              : {};
        const argumentsText = isCustomToolCall
          ? JSON.stringify(input)
          : typeof item.arguments === 'string'
            ? item.arguments
            : JSON.stringify(item.arguments || {});
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: item.call_id || item.id || fallbackId('call', item),
              type: 'function',
              function: {
                name: item.name || 'tool',
                arguments: argumentsText,
              },
            },
          ],
        });
      }
    }
    return messages;
  }

  function responsesToChatWithHistory(clientRes, parsed, targetModel, options) {
    const chatBody = applyResponsesHistoryPolicy(
      openAIResponsesToChat({ ...parsed, model: targetModel }, options),
      parsed
    );
    if (!parsed || !parsed.previous_response_id) return chatBody;
    const previousMessages = responsesHistory.get(parsed.previous_response_id);
    if (!previousMessages) {
      const summaryMessages = summaryToChatMessages(
        responsesSummaries.get(parsed.previous_response_id)
      );
      if (summaryMessages.length > 0 && !preservesResponsesHistory(chatBody)) {
        const combinedMessages = mergeResponsesChatHistory(summaryMessages, chatBody.messages);
        const messages =
          typeof mergeAdjacentAssistantMessages === 'function'
            ? mergeAdjacentAssistantMessages(combinedMessages)
            : combinedMessages;
        return { ...chatBody, messages };
      }
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message:
            'previous_response_id is not available in this proxy process. Send full input history or retry without previous_response_id.',
        },
      });
      return null;
    }
    const sanitizedPrevious = sanitizeResponsesHistoryMessages(
      isSemanticEntry(previousMessages)
        ? semanticHistoryToChat(previousMessages.history)
        : previousMessages
    );
    const combinedMessages = mergeResponsesChatHistory(
      sanitizedPrevious.messages,
      chatBody.messages
    );
    const messages =
      typeof mergeAdjacentAssistantMessages === 'function'
        ? mergeAdjacentAssistantMessages(combinedMessages)
        : combinedMessages;
    return { ...chatBody, messages };
  }

  function rememberResponsesFromChatResponse(response, chatBody, chatPayload) {
    if (!shouldStoreResponsesHistory(chatBody)) return;
    if (response?.status === 'failed') return;
    const choice =
      chatPayload && Array.isArray(chatPayload.choices) ? chatPayload.choices[0] : null;
    let message = choice && choice.message ? choice.message : null;
    if (message?.function_call) {
      const toolCalls = responseOutputItemsToChatMessages(response?.output).flatMap(
        (item) => item.tool_calls || []
      );
      if (!toolCalls.length) return;
      message = { ...message, tool_calls: toolCalls };
      delete message.function_call;
    }
    rememberResponsesHistory(
      response && response.id,
      message ? [...chatBody.messages, message] : chatBody.messages
    );
  }

  function rememberResponsesFromBridge(bridge, chatBody) {
    if (!shouldStoreResponsesHistory(chatBody)) return;
    if (Array.isArray(chatBody?.history))
      return semanticState.rememberSemanticBridge(bridge, chatBody);
    if (bridge && bridge.responseState && bridge.responseState.failed) return;
    const outputMessages = responseOutputItemsToChatMessages(
      bridge && bridge.responseState && bridge.responseState.completedOutputItems
    );
    const inputMessages = chatBody && Array.isArray(chatBody.messages) ? chatBody.messages : [];
    rememberResponsesHistory(bridge && bridge.responseState && bridge.responseState.id, [
      ...inputMessages,
      ...outputMessages,
    ]);
  }

  const semanticState = createResponsesSemanticState({
    responsesHistory,
    responsesSummaries,
    rememberResponsesHistory,
    fallbackId,
    sendJsonError,
  });
  return {
    resolveResponsesHistory: semanticState.resolveResponsesHistory,
    responsesHistory,
    responsesSummaries,
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

module.exports = {
  createResponsesState,
  isEmptyAssistantHistoryMessage,
  sanitizeResponsesHistoryMessages,
};
