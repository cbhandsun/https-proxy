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

function createResponsesState(deps) {
  const {
    log,
    sendJsonError,
    logProxyEvent,
    fallbackId,
    stableCreated,
    processOpenAIChatSseChunkToResponses,
    flushOpenAIChatSseToResponses,
    openAIResponsesToChat,
    conversionResponseLimit,
    cacheFile,
    limit = 20,
  } = deps;

  const responsesHistory = new Map();
  let saveTimeout = null;

  // 启动时从磁盘加载历史(向后兼容旧版本)
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const entries = JSON.parse(raw);
      if (Array.isArray(entries)) {
        for (const [key, value] of entries) {
          responsesHistory.set(key, value);
        }
        log.info('[proxy] Loaded responses history from cache. Entries:', responsesHistory.size);
      }
    }
  } catch (err) {
    log.warn('[proxy] Failed to load responses history cache:', err.message);
  }

  function saveResponsesHistoryToDisk() {
    if (saveTimeout) return;
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      try {
        const serialized = JSON.stringify(Array.from(responsesHistory.entries()));
        fs.writeFile(cacheFile, serialized, 'utf8', (err) => {
          if (err) log.warn('[proxy] Failed to save responses history cache:', err.message);
        });
      } catch (err) {
        log.warn('[proxy] Failed to serialize responses history:', err.message);
      }
    }, 1000);
  }

  function collectBoundedResponse(proxyRes, clientRes, upstreamPath, type, onComplete) {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;

    proxyRes.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > conversionResponseLimit) {
        tooLarge = true;
        chunks.length = 0;
        proxyRes.destroy();
        sendJsonError(clientRes, 502, {
          error: {
            type: 'upstream_response_too_large',
            message: 'Upstream response for protocol conversion exceeds proxy limit of ' + conversionResponseLimit + ' bytes',
          },
        });
        logProxyEvent('upstream_response_too_large', { path: upstreamPath, type, bytes, limit: conversionResponseLimit });
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
      sendJsonError(clientRes, 502, { error: { type: 'proxy_error', message: 'Upstream response error: ' + err.message } });
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
      chatRes: { write: (chunk) => processOpenAIChatSseChunkToResponses(clientRes, String(chunk), responseState) },
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
          tool_calls: [{
            id: item.call_id || item.id,
            type: 'function',
            function: {
              name: item.name || 'tool',
              arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
            },
          }],
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
          message: 'previous_response_id "' + parsed.previous_response_id + '" is not available in this proxy process. Send full input history or retry without previous_response_id.',
        },
      });
      return null;
    }
    return { ...chatBody, messages: [...previousMessages, ...chatBody.messages] };
  }

  function rememberResponsesFromChatResponse(response, chatBody, chatPayload) {
    const choice = chatPayload && Array.isArray(chatPayload.choices) ? chatPayload.choices[0] : null;
    const message = choice && choice.message ? choice.message : null;
    rememberResponsesHistory(response && response.id, message ? [...chatBody.messages, message] : chatBody.messages);
  }

  function rememberResponsesFromBridge(bridge, chatBody) {
    const outputMessages = responseOutputItemsToChatMessages(bridge && bridge.responseState && bridge.responseState.completedOutputItems);
    rememberResponsesHistory(bridge && bridge.responseState && bridge.responseState.id, [...chatBody.messages, ...outputMessages]);
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
