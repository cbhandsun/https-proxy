/**
 * Trae Bridge 流式输出层: OpenAI Chat / OpenAI Responses / Claude Messages
 *
 * 拆分自 trae-bridge-runtime.js,职责:
 *   - 拿到 bridge 文本(或实时流),按目标协议写回 clientRes
 *   - 三种协议的同步版和实时版共 6 个函数
 *
 * 公开 API (createTraeBridgeStreams(deps)):
 *   - writeTraeBridgeOpenAIStream
 *   - writeTraeBridgeOpenAILiveStream
 *   - buildTraeBridgeOpenAIResponsesResponse
 *   - writeTraeBridgeOpenAIResponsesStream
 *   - writeTraeBridgeOpenAIResponsesLiveStream
 *   - buildTraeBridgeClaudeMessageResponse
 *   - writeTraeBridgeClaudeStream
 *   - writeTraeBridgeClaudeLiveStream
 */

function createTraeBridgeStreams({
  buildTraeBridgeOpenAIChatCompletion,
  openAIChatToResponses,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  writeClaudeSseEvent,
  fallbackId,
  stableCreated,
  // streaming utilities from utils module
  streamTraeOfficialBridge,
  startLiveHeartbeat,
  getTraeBridgeErrorMessage,
  formatTraeBridgeStreamError,
  formatTraeInteraction,
  // progress utilities from progress module
  startTraeLogProgress,
  startNativeDeepProgress,
  formatTraeLogVisibleText,
  formatTraeRawVisibleText,
  summarizeTraeRawEvent,
  createTraeRawProgressDeduper,
  writeRawProgress,
  isRawProgressVisibleEnabled,
  isLogProgressVisibleEnabled,
  isClaudeProcessProgressEnabled,
  claudeProcessProgressStyle,
}) {
  function isAnyVisibleProgressEnabled() {
    return Boolean(
      (typeof isRawProgressVisibleEnabled === 'function' && isRawProgressVisibleEnabled()) ||
      (typeof isLogProgressVisibleEnabled === 'function' && isLogProgressVisibleEnabled()) ||
      (typeof isClaudeProcessProgressEnabled === 'function' && isClaudeProcessProgressEnabled())
    );
  }

  function startVisibleNativeDeepProgress(writeVisibleText) {
    if (!isAnyVisibleProgressEnabled()) return () => {};
    return startNativeDeepProgress ? startNativeDeepProgress(writeVisibleText) : () => {};
  }

  function writeTraeBridgeOpenAIStream(clientRes, requestBody, text, model) {
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-trae-' + created;
    const responseModel = model || requestBody.model || 'trae-official';
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    const writeChunk = (delta, finishReason = null) => {
      clientRes.write(
        'data: ' +
          JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: responseModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          }) +
          '\n\n'
      );
    };
    writeChunk({ role: 'assistant' });
    if (text) writeChunk({ content: String(text) });
    writeChunk({}, 'stop');
    clientRes.write('data: [DONE]\n\n');
    clientRes.end();
  }

  async function writeTraeBridgeOpenAILiveStream(clientRes, requestBody, bridgePayload, model) {
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-trae-' + created;
    const responseModel = model || requestBody.model || 'trae-official';
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    const writeChunk = (delta, finishReason = null) => {
      clientRes.write(
        'data: ' +
          JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: responseModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          }) +
          '\n\n'
      );
    };
    writeChunk({ role: 'assistant' });
    const writeVisibleProgressText = (text) => {
      if (text) writeChunk({ content: `\n${text}\n` });
    };
    const writeProgress = (progress) => {
      clientRes.write(': trae-progress ' + JSON.stringify(progress || {}) + '\n\n');
      if (isLogProgressVisibleEnabled()) {
        writeVisibleProgressText(formatTraeLogVisibleText(progress));
      }
    };
    const stopHeartbeat = startLiveHeartbeat(writeProgress);
    const stopLogProgress = startTraeLogProgress(writeProgress);
    const stopNativeDeepProgress = startVisibleNativeDeepProgress(writeVisibleProgressText);
    try {
      await streamTraeOfficialBridge(bridgePayload, {
        onTextDelta: (text) => writeChunk({ content: String(text) }),
        onProgress: writeProgress,
        onRawEvent: (rawEvent) => writeRawProgress(clientRes, rawEvent, writeVisibleProgressText),
        onInteraction: (interaction) => {
          const marker = formatTraeInteraction(interaction);
          if (marker) writeChunk({ content: `\n${marker}\n` });
        },
      });
    } catch (err) {
      writeProgress({ phase: 'error', source: 'proxy', message: getTraeBridgeErrorMessage(err) });
      writeChunk({ content: '\n' + formatTraeBridgeStreamError(err) + '\n' });
    } finally {
      stopHeartbeat();
      stopLogProgress();
      stopNativeDeepProgress();
    }
    writeChunk({}, 'stop');
    clientRes.write('data: [DONE]\n\n');
    clientRes.end();
  }

  function buildTraeBridgeOpenAIResponsesResponse(requestBody, text, model) {
    const chatCompletion = buildTraeBridgeOpenAIChatCompletion(
      { model: requestBody.model || model },
      text,
      model
    );
    return openAIChatToResponses(chatCompletion, model || requestBody.model || 'trae-official');
  }

  function writeTraeBridgeOpenAIResponsesStream(clientRes, requestBody, text, model) {
    const seed = { model: requestBody.model || model, input: requestBody.input, route: model };
    const state = {
      id: fallbackId('resp', seed),
      created_at: stableCreated(seed),
      model: requestBody.model || model || 'trae-official',
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
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-trae-' + created;
    const responseModel = model || requestBody.model || 'trae-official';
    const writeChatChunk = (delta, finishReason = null) => {
      processOpenAIChatSseChunkToResponses(
        clientRes,
        'data: ' +
          JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: responseModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          }) +
          '\n\n',
        state
      );
    };
    if (text) writeChatChunk({ content: String(text) });
    writeChatChunk({}, 'stop');
    flushOpenAIChatSseToResponses(clientRes, state);
    clientRes.end();
  }

  async function writeTraeBridgeOpenAIResponsesLiveStream(
    clientRes,
    requestBody,
    bridgePayload,
    model
  ) {
    const seed = { model: requestBody.model || model, input: requestBody.input, route: model };
    const state = {
      id: fallbackId('resp', seed),
      created_at: stableCreated(seed),
      model: requestBody.model || model || 'trae-official',
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
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-trae-' + created;
    const responseModel = model || requestBody.model || 'trae-official';
    const writeChatChunk = (delta, finishReason = null) => {
      processOpenAIChatSseChunkToResponses(
        clientRes,
        'data: ' +
          JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: responseModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          }) +
          '\n\n',
        state
      );
    };
    const writeProgress = (progress) => {
      clientRes.write(': trae-progress ' + JSON.stringify(progress || {}) + '\n\n');
      if (isLogProgressVisibleEnabled()) {
        const marker = formatTraeLogVisibleText(progress);
        if (marker) writeChatChunk({ content: `\n${marker}\n` });
      }
    };
    const stopHeartbeat = startLiveHeartbeat(writeProgress);
    const stopLogProgress = startTraeLogProgress(writeProgress);
    const stopNativeDeepProgress = startVisibleNativeDeepProgress((text) => {
      if (text) writeChatChunk({ content: `\n${text}\n` });
    });
    try {
      await streamTraeOfficialBridge(bridgePayload, {
        onTextDelta: (text) => writeChatChunk({ content: String(text) }),
        onProgress: writeProgress,
        onRawEvent: (rawEvent) =>
          writeRawProgress(clientRes, rawEvent, (text) => {
            if (text) writeChatChunk({ content: `\n${text}\n` });
          }),
        onInteraction: (interaction) => {
          const marker = formatTraeInteraction(interaction);
          if (marker) writeChatChunk({ content: `\n${marker}\n` });
        },
      });
    } catch (err) {
      writeProgress({ phase: 'error', source: 'proxy', message: getTraeBridgeErrorMessage(err) });
      writeChatChunk({ content: '\n' + formatTraeBridgeStreamError(err) + '\n' });
    } finally {
      stopHeartbeat();
      stopLogProgress();
      stopNativeDeepProgress();
    }
    writeChatChunk({}, 'stop');
    flushOpenAIChatSseToResponses(clientRes, state);
    clientRes.end();
  }

  function buildTraeBridgeClaudeMessageResponse(requestBody, text, model) {
    const seed = { model: requestBody.model || model, text };
    return {
      id: fallbackId('msg_trae', seed),
      type: 'message',
      role: 'assistant',
      model: model || requestBody.model || 'trae-official',
      content: [{ type: 'text', text: String(text || '') }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    };
  }

  function writeTraeBridgeClaudeStream(clientRes, requestBody, text, model) {
    const message = buildTraeBridgeClaudeMessageResponse(requestBody, '', model);
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    writeClaudeSseEvent(clientRes, 'message_start', { type: 'message_start', message });
    writeClaudeSseEvent(clientRes, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    if (text)
      writeClaudeSseEvent(clientRes, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: String(text) },
      });
    writeClaudeSseEvent(clientRes, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeClaudeSseEvent(clientRes, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: message.usage,
    });
    writeClaudeSseEvent(clientRes, 'message_stop', { type: 'message_stop' });
    clientRes.end();
  }

  function formatTraeRawLiveText(summary) {
    if (!summary || !summary.event) return '';
    if (summary.event === 'metadata') {
      const parts = [
        summary.agentName ? `Agent ${summary.agentName}` : '',
        summary.modelName ? `模型 ${summary.modelName}` : '',
        summary.requestClient ? `客户端 ${summary.requestClient}` : '',
        summary.status ? `状态 ${summary.status}` : '',
      ].filter(Boolean);
      return parts.length ? `Trae 已连接: ${parts.join(' · ')}` : 'Trae 已连接';
    }
    if (summary.event === 'plan_item') {
      const label = summary.toolName || '计划项';
      const status = summary.toolStatus || summary.agentStatus || '';
      const run = summary.runMode ? ` · ${summary.runMode}` : '';
      return `Trae ${label}${status ? `: ${status}` : ''}${run}`;
    }
    if (summary.event === 'model_config') {
      return summary.modelName ? `Trae 使用模型: ${summary.modelName}` : 'Trae 已选择模型';
    }
    if (summary.event === 'token_usage') {
      const total = summary.totalTokens == null ? '' : ` · total=${summary.totalTokens}`;
      const reasoning =
        summary.reasoningTokens == null ? '' : ` · reasoning=${summary.reasoningTokens}`;
      return `Trae Token 用量${total}${reasoning}`;
    }
    if (summary.event === 'timing_events') {
      const first = summary.firstSseMs == null ? '' : `首包 ${summary.firstSseMs}ms`;
      const server = summary.serverMs == null ? '' : `服务 ${summary.serverMs}ms`;
      const parts = [first, server].filter(Boolean);
      return parts.length ? `Trae 时延: ${parts.join(' · ')}` : 'Trae 时延已记录';
    }
    if (summary.event === 'done') {
      const duration = summary.durationMs == null ? '' : ` · ${summary.durationMs}ms`;
      return `Trae 完成${summary.status ? `: ${summary.status}` : ''}${duration}`;
    }
    return `Trae ${summary.event}${summary.status ? `: ${summary.status}` : ''}`;
  }

  async function writeTraeBridgeClaudeLiveStream(
    clientRes,
    requestBody,
    bridgePayload,
    model,
    options = {}
  ) {
    const message = buildTraeBridgeClaudeMessageResponse(requestBody, '', model);
    message.content = [];
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    let nextBlockIndex = 0;
    let textOpen = false;
    let textIndex = -1;
    let processOpen = false;
    let processIndex = -1;
    let processStyle = '';
    writeClaudeSseEvent(clientRes, 'message_start', { type: 'message_start', message });
    const closeText = () => {
      if (!textOpen) return;
      writeClaudeSseEvent(clientRes, 'content_block_stop', {
        type: 'content_block_stop',
        index: textIndex,
      });
      textOpen = false;
    };
    const closeProcess = () => {
      if (!processOpen) return;
      if (processStyle === 'thinking') {
        writeClaudeSseEvent(clientRes, 'content_block_delta', {
          type: 'content_block_delta',
          index: processIndex,
          delta: { type: 'signature_delta', signature: 'trae-process' },
        });
      }
      writeClaudeSseEvent(clientRes, 'content_block_stop', {
        type: 'content_block_stop',
        index: processIndex,
      });
      processOpen = false;
      processStyle = '';
    };
    const openText = () => {
      if (textOpen) return;
      closeProcess();
      textOpen = true;
      textIndex = nextBlockIndex;
      nextBlockIndex += 1;
      writeClaudeSseEvent(clientRes, 'content_block_start', {
        type: 'content_block_start',
        index: textIndex,
        content_block: { type: 'text', text: '' },
      });
    };
    const writePing = () => writeClaudeSseEvent(clientRes, 'ping', { type: 'ping' });
    const requestedProcessStyle = String(options.claudeProcessStyle || '').toLowerCase();
    const shouldEmitRawProcess =
      typeof createTraeRawProgressDeduper === 'function'
        ? createTraeRawProgressDeduper()
        : () => true;
    const currentClaudeProcessStyle = () => {
      if (requestedProcessStyle === 'text' || requestedProcessStyle === 'thinking') {
        return requestedProcessStyle;
      }
      if (typeof claudeProcessProgressStyle !== 'function') {
        return isClaudeProcessProgressEnabled() ? 'thinking' : '';
      }
      return claudeProcessProgressStyle() || '';
    };
    const isEffectiveClaudeProcessProgressEnabled = () => Boolean(currentClaudeProcessStyle());
    const writeClaudeProcessText = (text) => {
      if (!text) return;
      const style = currentClaudeProcessStyle();
      if (!style) {
        writeVisibleProgressText(text);
        return;
      }
      closeText();
      if (processOpen && processStyle !== style) closeProcess();
      if (!processOpen) {
        processOpen = true;
        processStyle = style;
        processIndex = nextBlockIndex;
        nextBlockIndex += 1;
        const contentBlock =
          style === 'text'
            ? { type: 'text', text: '' }
            : { type: 'thinking', thinking: '', signature: 'trae-process' };
        writeClaudeSseEvent(clientRes, 'content_block_start', {
          type: 'content_block_start',
          index: processIndex,
          content_block: contentBlock,
        });
      }
      const delta =
        style === 'text'
          ? { type: 'text_delta', text: `${text}\n` }
          : { type: 'thinking_delta', thinking: `${text}\n` };
      writeClaudeSseEvent(clientRes, 'content_block_delta', {
        type: 'content_block_delta',
        index: processIndex,
        delta,
      });
    };
    const writeProgressMarker = (marker) => {
      if (!marker) return;
      if (isEffectiveClaudeProcessProgressEnabled()) {
        writeClaudeProcessText(marker);
      } else {
        writeVisibleProgressText(marker);
      }
    };
    const writeVisibleProgressText = (text) => {
      if (!text) return;
      openText();
      writeClaudeSseEvent(clientRes, 'content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: `\n${text}\n` },
      });
    };
    const writeProgress = (progress) => {
      writePing();
      if (isEffectiveClaudeProcessProgressEnabled()) {
        writeProgressMarker(formatTraeLogVisibleText(progress));
      } else if (isLogProgressVisibleEnabled()) {
        writeVisibleProgressText(formatTraeLogVisibleText(progress));
      }
    };
    const stopHeartbeat = startLiveHeartbeat(writePing);
    const stopLogProgress = startTraeLogProgress(writeProgress);
    const stopNativeDeepProgress = startVisibleNativeDeepProgress(
      isEffectiveClaudeProcessProgressEnabled() ? writeClaudeProcessText : writeVisibleProgressText
    );
    try {
      await streamTraeOfficialBridge(bridgePayload, {
        onTextDelta: (text) => {
          openText();
          writeClaudeSseEvent(clientRes, 'content_block_delta', {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text_delta', text: String(text) },
          });
        },
        onProgress: writeProgress,
        onRawEvent: (rawEvent) => {
          if (isEffectiveClaudeProcessProgressEnabled()) {
            const summary =
              typeof summarizeTraeRawEvent === 'function' ? summarizeTraeRawEvent(rawEvent) : null;
            if (!shouldEmitRawProcess(summary)) {
              writeRawProgress(clientRes, rawEvent, writeVisibleProgressText);
              return;
            }
            const marker =
              currentClaudeProcessStyle() === 'text'
                ? formatTraeRawLiveText(summary)
                : typeof formatTraeRawVisibleText === 'function'
                  ? formatTraeRawVisibleText(summary)
                  : '';
            writeProgressMarker(marker);
          }
          writeRawProgress(clientRes, rawEvent, writeVisibleProgressText);
        },
        onInteraction: (interaction) => {
          const marker = formatTraeInteraction(interaction);
          if (!marker) return;
          writeProgressMarker(marker);
        },
      });
    } catch (err) {
      writePing();
      openText();
      const errText = '\n' + formatTraeBridgeStreamError(err) + '\n';
      writeClaudeSseEvent(clientRes, 'content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: errText },
      });
    } finally {
      stopHeartbeat();
      stopLogProgress();
      stopNativeDeepProgress();
    }
    closeText();
    closeProcess();
    writeClaudeSseEvent(clientRes, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: message.usage,
    });
    writeClaudeSseEvent(clientRes, 'message_stop', { type: 'message_stop' });
    clientRes.end();
  }

  return {
    writeTraeBridgeOpenAIStream,
    writeTraeBridgeOpenAILiveStream,
    buildTraeBridgeOpenAIResponsesResponse,
    writeTraeBridgeOpenAIResponsesStream,
    writeTraeBridgeOpenAIResponsesLiveStream,
    buildTraeBridgeClaudeMessageResponse,
    writeTraeBridgeClaudeStream,
    writeTraeBridgeClaudeLiveStream,
  };
}

module.exports = {
  createTraeBridgeStreams,
};
