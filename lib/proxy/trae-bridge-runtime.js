function createTraeBridgeRuntime({
  makeRequest,
  getTraeOfficialBridgeUrl,
  normalizeTraeBridgeText,
  buildTraeBridgeOpenAIChatCompletion,
  openAIChatToResponses,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  writeClaudeSseEvent,
  fallbackId,
  stableCreated,
  bridgeTimeoutMs = Number(process.env.TRAE_BRIDGE_TIMEOUT_MS || 5 * 60 * 1000),
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
          'Content-Length': Buffer.byteLength(body)
        }
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

  function writeTraeBridgeOpenAIStream(clientRes, requestBody, text, model) {
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-trae-' + created;
    const responseModel = model || requestBody.model || 'trae-official';
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    const writeChunk = (delta, finishReason = null) => {
      clientRes.write('data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      }) + '\n\n');
    };
    writeChunk({ role: 'assistant' });
    if (text) writeChunk({ content: String(text) });
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
      'access-control-allow-origin': '*'
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
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      }) + '\n\n', state);
    };
    if (text) writeChatChunk({ content: String(text) });
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
        output_tokens: 0
      }
    };
  }

  function writeTraeBridgeClaudeStream(clientRes, requestBody, text, model) {
    const message = buildTraeBridgeClaudeMessageResponse(requestBody, '', model);
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'access-control-allow-origin': '*'
    });
    writeClaudeSseEvent(clientRes, 'message_start', { type: 'message_start', message });
    writeClaudeSseEvent(clientRes, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    if (text) writeClaudeSseEvent(clientRes, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(text) } });
    writeClaudeSseEvent(clientRes, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeClaudeSseEvent(clientRes, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: message.usage });
    writeClaudeSseEvent(clientRes, 'message_stop', { type: 'message_stop' });
    clientRes.end();
  }

  return {
    callTraeOfficialBridge,
    writeTraeBridgeOpenAIStream,
    buildTraeBridgeOpenAIResponsesResponse,
    writeTraeBridgeOpenAIResponsesStream,
    buildTraeBridgeClaudeMessageResponse,
    writeTraeBridgeClaudeStream,
  };
}

module.exports = {
  createTraeBridgeRuntime,
};
