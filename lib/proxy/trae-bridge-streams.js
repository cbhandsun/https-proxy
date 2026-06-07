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
  formatTraeLogVisibleText,
  writeRawProgress,
  isLogProgressVisibleEnabled,
}) {
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
      clientRes.write('data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }) + '\n\n');
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
      clientRes.write('data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }) + '\n\n');
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
    }
    writeChunk({}, 'stop');
    clientRes.write('data: [DONE]\n\n');
    clientRes.end();
  }

  function buildTraeBridgeOpenAIResponsesResponse(requestBody, text, model) {
    const chatCompletion = buildTraeBridgeOpenAIChatCompletion({ model: requestBody.model || model }, text, model);
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
      processOpenAIChatSseChunkToResponses(clientRes, 'data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }) + '\n\n', state);
    };
    if (text) writeChatChunk({ content: String(text) });
    writeChatChunk({}, 'stop');
    flushOpenAIChatSseToResponses(clientRes, state);
    clientRes.end();
  }

  async function writeTraeBridgeOpenAIResponsesLiveStream(clientRes, requestBody, bridgePayload, model) {
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
      processOpenAIChatSseChunkToResponses(clientRes, 'data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }) + '\n\n', state);
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
    try {
      await streamTraeOfficialBridge(bridgePayload, {
        onTextDelta: (text) => writeChatChunk({ content: String(text) }),
        onProgress: writeProgress,
        onRawEvent: (rawEvent) => writeRawProgress(clientRes, rawEvent, (text) => {
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
    writeClaudeSseEvent(clientRes, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    if (text) writeClaudeSseEvent(clientRes, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(text) } });
    writeClaudeSseEvent(clientRes, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeClaudeSseEvent(clientRes, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: message.usage });
    writeClaudeSseEvent(clientRes, 'message_stop', { type: 'message_stop' });
    clientRes.end();
  }

  async function writeTraeBridgeClaudeLiveStream(clientRes, requestBody, bridgePayload, model) {
    const message = buildTraeBridgeClaudeMessageResponse(requestBody, '', model);
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    let textOpen = false;
    writeClaudeSseEvent(clientRes, 'message_start', { type: 'message_start', message });
    const openText = () => {
      if (textOpen) return;
      textOpen = true;
      writeClaudeSseEvent(clientRes, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    };
    const writePing = () => writeClaudeSseEvent(clientRes, 'ping', { type: 'ping' });
    const writeVisibleProgressText = (text) => {
      if (!text) return;
      openText();
      writeClaudeSseEvent(clientRes, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `\n${text}\n` } });
    };
    const writeProgress = (progress) => {
      writePing();
      if (isLogProgressVisibleEnabled()) writeVisibleProgressText(formatTraeLogVisibleText(progress));
    };
    const stopHeartbeat = startLiveHeartbeat(writePing);
    const stopLogProgress = startTraeLogProgress(writeProgress);
    try {
      await streamTraeOfficialBridge(bridgePayload, {
        onTextDelta: (text) => {
          openText();
          writeClaudeSseEvent(clientRes, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(text) } });
        },
        onProgress: writeProgress,
        onRawEvent: (rawEvent) => writeRawProgress(clientRes, rawEvent, writeVisibleProgressText),
        onInteraction: (interaction) => {
          const marker = formatTraeInteraction(interaction);
          if (!marker) return;
          openText();
          writeClaudeSseEvent(clientRes, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `\n${marker}\n` } });
        },
      });
    } catch (err) {
      writePing();
      openText();
      const errText = '\n' + formatTraeBridgeStreamError(err) + '\n';
      writeClaudeSseEvent(clientRes, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: errText } });
    } finally {
      stopHeartbeat();
      stopLogProgress();
    }
    if (textOpen) writeClaudeSseEvent(clientRes, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeClaudeSseEvent(clientRes, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: message.usage });
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
