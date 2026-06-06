function writeJsonResponse(clientRes, payload) {
  const body = JSON.stringify(payload);
  clientRes.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'access-control-allow-origin': '*'
  });
  clientRes.end(body);
}

function createTraeOfficialHandlers({
  sendJsonError,
  logRequestEnd,
  normalizeTraeOfficialModelName,
  buildTraeBridgePromptFromOpenAIChat,
  openAIResponsesToChat,
  claudeMessagesToOpenAIChat,
  getTraeOfficialBridgeUrl,
  callTraeOfficialBridge,
  writeTraeBridgeOpenAIStream,
  buildTraeBridgeOpenAIChatCompletion,
  buildTraeBridgeOpenAIResponsesResponse,
  writeTraeBridgeOpenAIResponsesStream,
  buildTraeBridgeClaudeMessageResponse,
  writeTraeBridgeClaudeStream,
}) {
  function parseTraeOfficialJsonBody(clientReq, clientRes, requestBuffer, startTime, urlPath, logType) {
    if (clientReq.headers['content-encoding']) {
      sendJsonError(clientRes, 400, { error: { type: 'invalid_request_error', message: 'Trae official bridge does not support compressed request bodies' } });
      logRequestEnd(clientReq.method, urlPath, startTime, 400, { type: logType + '_compressed' });
      return null;
    }

    try {
      return JSON.parse(requestBuffer.toString('utf8') || '{}');
    } catch (err) {
      sendJsonError(clientRes, 400, { error: { type: 'invalid_request_error', message: 'Invalid JSON request body: ' + err.message } });
      logRequestEnd(clientReq.method, urlPath, startTime, 400, { type: logType + '_bad_json' });
      return null;
    }
  }

  async function getTraeOfficialBridgeResult(clientReq, clientRes, requestBody, chatBody, currentPrepared, startTime, urlPath, logType) {
    const model = normalizeTraeOfficialModelName(currentPrepared.rewriteTo || currentPrepared.model || requestBody.model || '');
    const { prompt, images } = buildTraeBridgePromptFromOpenAIChat(chatBody);
    if (!prompt) {
      sendJsonError(clientRes, 400, { error: { type: 'invalid_request_error', message: 'Trae official bridge requires at least one text message' } });
      logRequestEnd(clientReq.method, urlPath, startTime, 400, { type: logType + '_empty_prompt' });
      return null;
    }

    try {
      const bridge = await callTraeOfficialBridge({
        prompt,
        images,
        model,
        stream: Boolean(chatBody.stream || requestBody.stream),
        metadata: {
          source: 'https-proxy-manager',
          profileId: currentPrepared.profile && currentPrepared.profile.id,
          requestedModel: requestBody.model || '',
          routedModel: currentPrepared.rewriteTo || currentPrepared.model || ''
        }
      });
      clientRes.__diagnostics = { protocol: 'trae', route: currentPrepared.model, target: currentPrepared.rewriteTo, bridgeUrl: bridge.bridgeUrl };
      return { bridge, model };
    } catch (err) {
      const isConnectionError = err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || /timeout|connect ECONNREFUSED/i.test(err.message || ''));
      const statusCode = isConnectionError ? 503 : (err.statusCode && err.statusCode >= 400 ? err.statusCode : 502);
      const bridgeUrl = err.bridgeUrl || getTraeOfficialBridgeUrl('/v1/chat');
      const message = isConnectionError
        ? 'Trae bridge extension is not reachable. Install/reload https-proxy-manager-trae-bridge in Trae, then retry.'
        : 'Trae bridge request failed: ' + (err.message || err);
      sendJsonError(clientRes, statusCode, {
        error: {
          type: isConnectionError ? 'service_unavailable' : 'api_error',
          message,
          bridge_url: bridgeUrl
        }
      });
      logRequestEnd(clientReq.method, urlPath, startTime, statusCode, { type: logType + '_error', bridgeUrl });
      return null;
    }
  }

  async function handleTraeOfficialChatCompletion(clientReq, clientRes, requestBuffer, currentPrepared, startTime, urlPath) {
    const requestBody = parseTraeOfficialJsonBody(clientReq, clientRes, requestBuffer, startTime, urlPath, 'trae_official_bridge');
    if (!requestBody) return;
    const result = await getTraeOfficialBridgeResult(clientReq, clientRes, requestBody, requestBody, currentPrepared, startTime, urlPath, 'trae_official_bridge');
    if (!result) return;
    if (requestBody.stream) {
      writeTraeBridgeOpenAIStream(clientRes, requestBody, result.bridge.text, result.model);
      logRequestEnd(clientReq.method, urlPath, startTime, 200, { type: 'trae_official_bridge_stream' });
      return;
    }
    writeJsonResponse(clientRes, buildTraeBridgeOpenAIChatCompletion(requestBody, result.bridge.text, result.model));
    logRequestEnd(clientReq.method, urlPath, startTime, 200, { type: 'trae_official_bridge' });
  }

  async function handleTraeOfficialResponses(clientReq, clientRes, requestBuffer, currentPrepared, startTime, urlPath) {
    const requestBody = parseTraeOfficialJsonBody(clientReq, clientRes, requestBuffer, startTime, urlPath, 'trae_official_responses_bridge');
    if (!requestBody) return;
    const model = normalizeTraeOfficialModelName(currentPrepared.rewriteTo || currentPrepared.model || requestBody.model || '');
    const chatBody = openAIResponsesToChat({ ...requestBody, model: model || requestBody.model });
    const result = await getTraeOfficialBridgeResult(clientReq, clientRes, requestBody, chatBody, currentPrepared, startTime, urlPath, 'trae_official_responses_bridge');
    if (!result) return;
    if (requestBody.stream) {
      writeTraeBridgeOpenAIResponsesStream(clientRes, requestBody, result.bridge.text, result.model);
      logRequestEnd(clientReq.method, urlPath, startTime, 200, { type: 'trae_official_responses_bridge_stream' });
      return;
    }
    writeJsonResponse(clientRes, buildTraeBridgeOpenAIResponsesResponse(requestBody, result.bridge.text, result.model));
    logRequestEnd(clientReq.method, urlPath, startTime, 200, { type: 'trae_official_responses_bridge' });
  }

  async function handleTraeOfficialClaudeMessages(clientReq, clientRes, requestBuffer, currentPrepared, startTime, urlPath) {
    const requestBody = parseTraeOfficialJsonBody(clientReq, clientRes, requestBuffer, startTime, urlPath, 'trae_official_claude_bridge');
    if (!requestBody) return;
    const model = normalizeTraeOfficialModelName(currentPrepared.rewriteTo || currentPrepared.model || requestBody.model || '');
    const chatBody = claudeMessagesToOpenAIChat(requestBody, model || requestBody.model || currentPrepared.model || 'trae-official');
    const result = await getTraeOfficialBridgeResult(clientReq, clientRes, requestBody, chatBody, currentPrepared, startTime, urlPath, 'trae_official_claude_bridge');
    if (!result) return;
    if (requestBody.stream) {
      writeTraeBridgeClaudeStream(clientRes, requestBody, result.bridge.text, result.model);
      logRequestEnd(clientReq.method, urlPath, startTime, 200, { type: 'trae_official_claude_bridge_stream' });
      return;
    }
    writeJsonResponse(clientRes, buildTraeBridgeClaudeMessageResponse(requestBody, result.bridge.text, result.model));
    logRequestEnd(clientReq.method, urlPath, startTime, 200, { type: 'trae_official_claude_bridge' });
  }

  return {
    parseTraeOfficialJsonBody,
    getTraeOfficialBridgeResult,
    handleTraeOfficialChatCompletion,
    handleTraeOfficialResponses,
    handleTraeOfficialClaudeMessages,
  };
}

module.exports = {
  createTraeOfficialHandlers,
};
