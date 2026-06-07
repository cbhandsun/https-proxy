/**
 * 协议路由处理器(9 个 handleXxx)
 *
 * 每个 handler 处理"客户端→上游"的协议转换:
 *   - 输入:HTTP 请求 + 已解析的 prepared/target/apiKey
 *   - 输出:HTTP 响应(可能是流式 SSE)
 *
 * 所有依赖通过 ctx 单次注入(避免长参数列表),包括:
 *   - stdlib (https/http) + log + CORS_HEADERS
 *   - http-utils 工厂产物
 *   - code-assist / responses-state / request-validators 工厂产物
 *   - 协议转换函数与 SSE 工具(从 createProxyHandlers 的 deps 透传)
 */
'use strict';

function createRouteHandlers(ctx) {
  const {
    // stdlib / 模块级
    https, http, log, CORS_HEADERS, mcpHub,
    // 通用工具(deps 透传)
    sendJsonError, sendUpstreamError, logRequestEnd, logProxyEvent,
    fallbackId, stableCreated, sendGeminiRateLimit, writeClaudeSseEvent,
    // OpenAI / Claude 协议转换(deps 透传)
    processOpenAISseChunkToClaude, flushOpenAISseToClaude,
    processClaudeSseChunkToOpenAI, flushClaudeSseToOpenAI,
    processOpenAIResponsesSseChunkToChat, flushOpenAIResponsesSseToChat,
    processOpenAIChatSseChunkToResponses, flushOpenAIChatSseToResponses,
    processGeminiSseEvent, flushPendingGeminiToolCall,
    geminiClaudeStopReason = (state) => {
      const stopReason = state && state.stopReason ? state.stopReason : 'end_turn';
      return state && state.hasToolUse && stopReason === 'end_turn' ? 'tool_use' : stopReason;
    },
    sampleResponseChunk,
    claudeMessagesToOpenAIChat, openAIResponseToClaudeMessage,
    openAIChatToClaudeMessages, claudeResponseToOpenAIChat,
    openAIChatToResponsesRequest, openAIResponsesToChatResponse,
    openAIChatToResponses, openAIResponsesToChat,
    claudeMessagesToGemini, geminiGeneratePath,
    geminiResponseToClaude, parseGeminiError,
    getGeminiCooldown, setGeminiCooldown,
    // http-utils 工厂产物
    writeJsonResponse, parseProxyBody, upstreamRequestOptions,
    onProxyTimeout, onProxyError, parseJsonOrSseJson,
    // code-assist 工厂产物
    shouldUseCodeAssistUpstream, codeAssistUserAgent, codeAssistGenerateRequest,
    unwrapCodeAssistResponse, unwrapCodeAssistSseEvent,
    // responses-state 工厂产物
    collectBoundedResponse, createChatToResponsesBridge,
    responsesToChatWithHistory, rememberResponsesFromChatResponse, rememberResponsesFromBridge,
    // request-validators 工厂产物
    rejectUnsupportedResponsesConversion, rejectUnsupportedResponsesNonOpenAIConversion,
    rejectUnsupportedOpenAIChatNonOpenAIConversion,
  } = ctx;

  // MCP 拦截(仅被 handleClaudeMessagesToOpenAIChat 使用,放在本文件)
  async function handleMcpInterception(responseBody, protocol, clientRes, upstreamPath, startTime, method) {
    if (!mcpHub) return false;
    try {
      const parsed = parseJsonOrSseJson(responseBody);
      const toolCalls = mcpHub.extractToolCalls(parsed, protocol);
      if (toolCalls && toolCalls.length > 0) {
        const mcpResults = await mcpHub.interceptAndExecute(toolCalls, protocol);
        if (mcpResults) {
          log.info(`[MCP Hub] Intercepted and executed ${mcpResults.length} tool(s):`, mcpResults.map(r => r.toolCallId).join(', '));
          const finalResponse = {
            mcp_intercepted: true,
            results: mcpResults,
          };
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
          clientRes.end(JSON.stringify(finalResponse));
          logRequestEnd(method, upstreamPath, startTime, 200, { type: 'mcp_interception', tools: toolCalls.length });
          return true;
        }
      }
    } catch (e) {
      log.warn('[MCP Hub] Interception check failed:', e.message);
    }
    return false;
  }

  // ========== Claude 源 → 各类上游 ==========

  function handleClaudeMessagesToOpenAIChat(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    const openAIBody = claudeMessagesToOpenAIChat(parsed, targetModel);
    const requestBody = Buffer.from(JSON.stringify(openAIBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(upstreamRequestOptions(target, target.path + '/chat/completions', headers), (proxyRes) => {
      if (openAIBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS_HEADERS });
        const state = { buffer: '', textIndex: -1, textOpen: false, toolCalls: [], finishReason: 'stop', usage: { input_tokens: 0, output_tokens: 0 }, done: false };
        const messageId = fallbackId('msg_openai', { model: parsed.model || targetModel, messages: parsed.messages, route: targetModel });
        writeClaudeSseEvent(clientRes, 'message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: parsed.model || targetModel, content: [], stop_reason: null, stop_sequence: null, usage: state.usage } });
        proxyRes.on('data', (chunk) => processOpenAISseChunkToClaude(clientRes, chunk.toString('utf8'), state));
        proxyRes.on('end', () => {
          flushOpenAISseToClaude(clientRes, state);
          clientRes.end();
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'claude_to_openai_stream' });
        });
        return;
      }

      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'claude_to_openai', async (responseBody) => {
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          sendUpstreamError(clientRes, proxyRes.statusCode, proxyRes.headers, responseBody, 'openai');
          logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, { type: 'claude_to_openai_error' });
          return;
        }
        if (await handleMcpInterception(responseBody, 'openai', clientRes, upstreamPath, startTime, clientReq.method)) return;
        try {
          const claudeResponse = openAIResponseToClaudeMessage(parseJsonOrSseJson(responseBody), parsed.model || targetModel);
          writeJsonResponse(clientRes, 200, claudeResponse);
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'claude_to_openai' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'OpenAI response conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'OpenAI'));
    proxyReq.on('error', onProxyError(clientRes, 'OpenAI'));
    proxyReq.end(requestBody);
  }

  function handleClaudeMessagesToOpenAIResponses(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    const chatBody = claudeMessagesToOpenAIChat(parsed, targetModel);
    const responsesBody = openAIChatToResponsesRequest({ ...chatBody, model: targetModel });
    const requestBody = Buffer.from(JSON.stringify(responsesBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(upstreamRequestOptions(target, target.path + '/responses', headers), (proxyRes) => {
      const code = proxyRes.statusCode;
      if (parsed.stream && code >= 200 && code < 300) {
        clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS_HEADERS });

        const chatSeed = { model: parsed.model || targetModel, messages: parsed.messages, route: targetModel };
        const messageId = fallbackId('msg_openai_responses', chatSeed);
        const chatState = { id: fallbackId('chatcmpl', chatSeed), created: stableCreated(chatSeed), model: parsed.model || targetModel, buffer: '', started: false, toolCalls: [], usage: null, done: false };
        const claudeState = { buffer: '', textIndex: -1, textOpen: false, toolCalls: [], finishReason: 'stop', usage: { input_tokens: 0, output_tokens: 0 }, done: false };
        const chatRes = { write: (chunk) => processOpenAISseChunkToClaude(clientRes, String(chunk), claudeState) };
        writeClaudeSseEvent(clientRes, 'message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: parsed.model || targetModel, content: [], stop_reason: null, stop_sequence: null, usage: claudeState.usage } });

        proxyRes.on('data', (chunk) => processOpenAIResponsesSseChunkToChat(chatRes, chunk.toString('utf8'), chatState));
        proxyRes.on('end', () => {
          flushOpenAIResponsesSseToChat(chatRes, chatState);
          flushOpenAISseToClaude(clientRes, claudeState);
          clientRes.end();
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'claude_to_responses_stream', upstreamEndpoint: target.path + '/responses' });
        });
        return;
      }

      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'claude_to_responses', (responseBody) => {
        if (code < 200 || code >= 300) {
          sendUpstreamError(clientRes, code, proxyRes.headers, responseBody, 'openai');
          logRequestEnd(clientReq.method, upstreamPath, startTime, code, { type: 'claude_to_responses_error' });
          return;
        }
        try {
          const payload = parseJsonOrSseJson(responseBody);
          const chatResponse = (payload && Array.isArray(payload.choices) && !payload.output) ? payload : openAIResponsesToChatResponse(payload, parsed.model || targetModel);
          const claudeResponse = openAIResponseToClaudeMessage(chatResponse, parsed.model || targetModel);
          writeJsonResponse(clientRes, 200, claudeResponse);
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'claude_to_responses', upstreamEndpoint: target.path + '/responses' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'Claude from Responses conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'OpenAI'));
    proxyReq.on('error', onProxyError(clientRes, 'OpenAI'));
    proxyReq.end(requestBody);
  }

  // ========== OpenAI Chat 源 → 各类上游 ==========

  function handleOpenAIChatToClaudeMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : (parsed.model || 'claude-3-5-sonnet-latest');
    if (rejectUnsupportedOpenAIChatNonOpenAIConversion(clientRes, parsed, 'Claude')) return;
    const claudeBody = openAIChatToClaudeMessages(parsed, targetModel);
    const requestBody = Buffer.from(JSON.stringify(claudeBody));
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
      'anthropic-version': clientReq.headers['anthropic-version'] || '2023-06-01',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(upstreamRequestOptions(target, target.path + '/messages', headers), (proxyRes) => {
      if (claudeBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS_HEADERS });
        const streamSeed = { model: parsed.model || targetModel, messages: parsed.messages, route: targetModel };
        const state = { id: fallbackId('chatcmpl', streamSeed), created: stableCreated(streamSeed), model: parsed.model || targetModel, buffer: '', pendingToolCall: null, toolCallIndex: 0, hasToolCalls: false, stopReason: 'end_turn', done: false };
        proxyRes.on('data', (chunk) => processClaudeSseChunkToOpenAI(clientRes, chunk.toString('utf8'), state));
        proxyRes.on('end', () => {
          flushClaudeSseToOpenAI(clientRes, state);
          clientRes.end();
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'openai_to_claude_stream' });
        });
        return;
      }

      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'openai_to_claude', (responseBody) => {
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          sendUpstreamError(clientRes, proxyRes.statusCode, proxyRes.headers, responseBody, 'claude');
          logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, { type: 'openai_to_claude_error' });
          return;
        }
        try {
          const openAIResponse = claudeResponseToOpenAIChat(parseJsonOrSseJson(responseBody), parsed.model || targetModel);
          writeJsonResponse(clientRes, 200, openAIResponse);
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'openai_to_claude' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'Claude response conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Claude'));
    proxyReq.on('error', onProxyError(clientRes, 'Claude'));
    proxyReq.end(requestBody);
  }

  function handleOpenAIChatToOpenAIResponses(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    const responsesBody = openAIChatToResponsesRequest({ ...parsed, model: targetModel });
    const requestBody = Buffer.from(JSON.stringify(responsesBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(upstreamRequestOptions(target, target.path + '/responses', headers), (proxyRes) => {
      const code = proxyRes.statusCode;
      if (parsed.stream && code >= 200 && code < 300) {
        clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS_HEADERS });
        const streamSeed = { model: parsed.model || targetModel, messages: parsed.messages, route: targetModel };
        const state = { id: fallbackId('chatcmpl', streamSeed), created: stableCreated(streamSeed), model: parsed.model || targetModel, buffer: '', started: false, toolCalls: [], usage: null, done: false };
        proxyRes.on('data', (chunk) => processOpenAIResponsesSseChunkToChat(clientRes, chunk.toString('utf8'), state));
        proxyRes.on('end', () => {
          flushOpenAIResponsesSseToChat(clientRes, state);
          clientRes.end();
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'chat_to_responses_stream' });
        });
        return;
      }

      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'chat_to_responses', (responseBody) => {
        if (code < 200 || code >= 300) {
          sendUpstreamError(clientRes, code, proxyRes.headers, responseBody, 'openai');
          logRequestEnd(clientReq.method, upstreamPath, startTime, code, { type: 'chat_to_responses_error' });
          return;
        }
        try {
          const payload = parseJsonOrSseJson(responseBody);
          const response = (payload && Array.isArray(payload.choices) && !payload.output) ? payload : openAIResponsesToChatResponse(payload, parsed.model || targetModel);
          writeJsonResponse(clientRes, 200, response);
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'chat_to_responses' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'OpenAI Chat from Responses conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'OpenAI'));
    proxyReq.on('error', onProxyError(clientRes, 'OpenAI'));
    proxyReq.end(requestBody);
  }

  // ========== OpenAI Responses 源 → 各类上游 ==========

  function handleOpenAIResponsesToOpenAIChat(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    if (rejectUnsupportedResponsesConversion(clientRes, parsed)) return;
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;

    const requestBody = Buffer.from(JSON.stringify(chatBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(upstreamRequestOptions(target, target.path + '/chat/completions', headers), (proxyRes) => {
      if (chatBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS_HEADERS });
        const bridge = createChatToResponsesBridge(clientRes, parsed, targetModel);
        proxyRes.on('data', (chunk) => processOpenAIChatSseChunkToResponses(clientRes, chunk.toString('utf8'), bridge.responseState));
        proxyRes.on('end', () => {
          bridge.flush();
          rememberResponsesFromBridge(bridge, chatBody);
          clientRes.end();
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'responses_to_chat_stream' });
        });
        return;
      }
      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'responses_to_chat', (responseBody) => {
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          sendUpstreamError(clientRes, proxyRes.statusCode, proxyRes.headers, responseBody, 'openai');
          logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, { type: 'responses_to_chat_error' });
          return;
        }
        try {
          const chatPayload = parseJsonOrSseJson(responseBody);
          const response = openAIChatToResponses(chatPayload, parsed.model || targetModel);
          rememberResponsesFromChatResponse(response, chatBody, chatPayload);
          writeJsonResponse(clientRes, 200, response);
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'responses_to_chat' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'OpenAI Responses conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'OpenAI'));
    proxyReq.on('error', onProxyError(clientRes, 'OpenAI'));
    proxyReq.end(requestBody);
  }

  function handleOpenAIResponsesToClaudeMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : (parsed.model || 'claude-3-5-sonnet-latest');
    if (rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed)) return;
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;
    const claudeBody = openAIChatToClaudeMessages(chatBody, targetModel);
    const requestBody = Buffer.from(JSON.stringify(claudeBody));
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
      'anthropic-version': clientReq.headers['anthropic-version'] || '2023-06-01',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(upstreamRequestOptions(target, target.path + '/messages', headers), (proxyRes) => {
      if (claudeBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS_HEADERS });
        const bridge = createChatToResponsesBridge(clientRes, parsed, targetModel);
        const chatSeed = { model: parsed.model || targetModel, input: parsed.input, route: targetModel };
        const chatState = { id: fallbackId('chatcmpl', chatSeed), created: stableCreated(chatSeed), model: parsed.model || targetModel, buffer: '', pendingToolCall: null, toolCallIndex: 0, hasToolCalls: false, stopReason: 'end_turn', done: false };
        const chatRes = { write: (chunk) => processOpenAIChatSseChunkToResponses(clientRes, String(chunk), bridge.responseState) };
        proxyRes.on('data', (chunk) => processClaudeSseChunkToOpenAI(chatRes, chunk.toString('utf8'), chatState));
        proxyRes.on('end', () => {
          flushClaudeSseToOpenAI(chatRes, chatState);
          bridge.flush();
          rememberResponsesFromBridge(bridge, chatBody);
          clientRes.end();
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'responses_to_claude_stream' });
        });
        return;
      }
      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'responses_to_claude', (responseBody) => {
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          sendUpstreamError(clientRes, proxyRes.statusCode, proxyRes.headers, responseBody, 'claude');
          logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, { type: 'responses_to_claude_error' });
          return;
        }
        try {
          const chatResponse = claudeResponseToOpenAIChat(parseJsonOrSseJson(responseBody), parsed.model || targetModel);
          const response = openAIChatToResponses(chatResponse, parsed.model || targetModel);
          rememberResponsesFromChatResponse(response, chatBody, chatResponse);
          writeJsonResponse(clientRes, 200, response);
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'responses_to_claude' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'OpenAI Responses conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Claude'));
    proxyReq.on('error', onProxyError(clientRes, 'Claude'));
    proxyReq.end(requestBody);
  }

  function handleOpenAIResponsesToGeminiMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : (parsed.model || 'gemini-pro');
    if (rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed)) return;
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;
    const claudeBody = openAIChatToClaudeMessages(chatBody, targetModel);
    const geminiBody = claudeMessagesToGemini(claudeBody, targetModel);
    const requestBody = Buffer.from(JSON.stringify(geminiBody));
    const stream = chatBody.stream === true;
    const pathWithMethod = geminiGeneratePath(target.path, targetModel, stream) + (stream ? '?alt=sse' : '');
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) {
      if (String(apiKey).startsWith('ya29.')) {
        headers['authorization'] = 'Bearer ' + apiKey;
      } else {
        headers['x-goog-api-key'] = apiKey;
      }
    }

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(upstreamRequestOptions(target, pathWithMethod, headers), (proxyRes) => {
      if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS_HEADERS });
        clientRes.__diagnostics = { protocol: 'gemini', route: prepared.model, target: targetModel, upstreamPath, profile: prepared.profile && prepared.profile.id, entryProtocol: 'openai-responses' };
        const bridge = createChatToResponsesBridge(clientRes, parsed, targetModel);
        const chatSeed = { model: parsed.model || targetModel, input: parsed.input, route: targetModel };
        const chatState = { id: fallbackId('chatcmpl', chatSeed), created: stableCreated(chatSeed), model: parsed.model || targetModel, buffer: '', pendingToolCall: null, toolCallIndex: 0, hasToolCalls: false, stopReason: 'end_turn', done: false };
        const chatRes = { write: (chunk) => processOpenAIChatSseChunkToResponses(clientRes, String(chunk), bridge.responseState) };
        const claudeBridge = { write: (chunk) => processClaudeSseChunkToOpenAI(chatRes, String(chunk), chatState) };
        const geminiState = { textIndex: -1, textOpen: false, stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, buffer: '', tools: claudeBody.tools, pendingToolCall: null };
        const messageId = fallbackId('msg_gemini', { model: targetModel, messages: claudeBody.messages, route: targetModel });
        writeClaudeSseEvent(claudeBridge, 'message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: targetModel, content: [], stop_reason: null, stop_sequence: null, usage: geminiState.usage } });
        proxyRes.on('data', (chunk) => {
          const chunkText = chunk.toString('utf8');
          sampleResponseChunk('gemini-upstream', chunkText, { upstreamPath, targetModel, entryProtocol: 'openai-responses' });
          geminiState.buffer += chunkText;
          const events = geminiState.buffer.split(/\r?\n\r?\n/);
          geminiState.buffer = events.pop();
          for (const event of events) processGeminiSseEvent(claudeBridge, event, geminiState, targetModel);
        });
        proxyRes.on('end', () => {
          if (geminiState.buffer.trim()) processGeminiSseEvent(claudeBridge, geminiState.buffer, geminiState, targetModel);
          flushPendingGeminiToolCall(claudeBridge, geminiState, geminiState.tools);
          if (geminiState.textOpen) writeClaudeSseEvent(claudeBridge, 'content_block_stop', { type: 'content_block_stop', index: geminiState.textIndex });
          writeClaudeSseEvent(claudeBridge, 'message_delta', { type: 'message_delta', delta: { stop_reason: geminiClaudeStopReason(geminiState), stop_sequence: null }, usage: geminiState.usage });
          writeClaudeSseEvent(claudeBridge, 'message_stop', { type: 'message_stop' });
          flushClaudeSseToOpenAI(chatRes, chatState);
          bridge.flush();
          rememberResponsesFromBridge(bridge, chatBody);
          clientRes.end();
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'responses_to_gemini_stream', usage: geminiState.usage });
        });
        return;
      }
      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'responses_to_gemini', (responseBody) => {
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          sendUpstreamError(clientRes, proxyRes.statusCode, proxyRes.headers, responseBody, 'gemini');
          logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, { type: 'responses_to_gemini_error' });
          return;
        }
        try {
          const claudeResponse = geminiResponseToClaude(parseJsonOrSseJson(responseBody), targetModel, claudeBody.tools);
          const chatResponse = claudeResponseToOpenAIChat(claudeResponse, parsed.model || targetModel);
          const response = openAIChatToResponses(chatResponse, parsed.model || targetModel);
          rememberResponsesFromChatResponse(response, chatBody, chatResponse);
          writeJsonResponse(clientRes, 200, response);
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'responses_to_gemini' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'OpenAI Responses to Gemini conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Gemini'));
    proxyReq.on('error', onProxyError(clientRes, 'Gemini'));
    proxyReq.end(requestBody);
  }

  function handleOpenAIChatToGeminiMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const stream = parsed.stream === true;
    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : (parsed.model || 'gemini-pro');
    if (rejectUnsupportedOpenAIChatNonOpenAIConversion(clientRes, parsed, 'Gemini')) return;
    const cooldown = getGeminiCooldown(prepared.profile && prepared.profile.id, targetModel);
    if (cooldown) {
      const message = 'Gemini rate limit cooldown active. Please retry in ' + cooldown.retryAfterSeconds + 's.';
      log.warn('gemini rate limited ' + clientReq.method + ' ' + upstreamPath + ' -> 429 retry_after=' + cooldown.retryAfterSeconds + 's source=local_cooldown target=' + targetModel);
      sendGeminiRateLimit(clientReq, clientRes, upstreamPath, startTime, targetModel, cooldown.retryAfterSeconds, message, { source: 'local_cooldown' });
      return;
    }

    const claudeBody = openAIChatToClaudeMessages(parsed, targetModel);
    const geminiBody = claudeMessagesToGemini(claudeBody, targetModel);
    const useCodeAssist = shouldUseCodeAssistUpstream(prepared, apiKey);
    const codeAssist = useCodeAssist ? codeAssistGenerateRequest(prepared, geminiBody, targetModel, stream) : null;
    const requestBody = Buffer.from(JSON.stringify(useCodeAssist ? codeAssist.body : geminiBody));
    const pathWithMethod = useCodeAssist
      ? codeAssist.target.pathname + codeAssist.target.search
      : geminiGeneratePath(target.path, targetModel, stream) + (stream ? '?alt=sse' : '');
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
    };
    if (useCodeAssist) headers['user-agent'] = codeAssistUserAgent();
    if (apiKey) {
      if (String(apiKey).startsWith('ya29.')) {
        headers['authorization'] = 'Bearer ' + apiKey;
      } else {
        headers['x-goog-api-key'] = apiKey;
      }
    }

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request({
      hostname: useCodeAssist ? codeAssist.target.hostname : (process.env.TARGET || target.hostname),
      port: parseInt(useCodeAssist ? (codeAssist.target.port || 443) : (process.env.TARGET_PORT || target.port), 10),
      path: pathWithMethod,
      method: 'POST',
      headers,
      timeout: 600000,
    }, (proxyRes) => {
      if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS_HEADERS });
        clientRes.__diagnostics = { protocol: 'gemini', route: prepared.model, target: targetModel, upstreamPath, profile: prepared.profile && prepared.profile.id, entryProtocol: 'openai-chat' };
        const chatSeed = { model: parsed.model || targetModel, messages: parsed.messages, route: targetModel };
        const chatState = { id: fallbackId('chatcmpl', chatSeed), created: stableCreated(chatSeed), model: parsed.model || targetModel, buffer: '', pendingToolCall: null, toolCallIndex: 0, hasToolCalls: false, stopReason: 'end_turn', done: false };
        const bridge = { write: (chunk) => processClaudeSseChunkToOpenAI(clientRes, String(chunk), chatState) };
        const geminiState = { textIndex: -1, textOpen: false, stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, buffer: '', tools: claudeBody.tools, pendingToolCall: null };
        const messageId = fallbackId('msg_gemini', { model: targetModel, messages: claudeBody.messages, route: targetModel });
        writeClaudeSseEvent(bridge, 'message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: targetModel, content: [], stop_reason: null, stop_sequence: null, usage: geminiState.usage } });
        proxyRes.on('data', (chunk) => {
          const chunkText = chunk.toString('utf8');
          sampleResponseChunk('gemini-upstream', chunkText, { upstreamPath, targetModel, entryProtocol: 'openai-chat' });
          geminiState.buffer += chunkText;
          const events = geminiState.buffer.split(/\r?\n\r?\n/);
          geminiState.buffer = events.pop();
          for (const event of events) processGeminiSseEvent(bridge, useCodeAssist ? unwrapCodeAssistSseEvent(event) : event, geminiState, targetModel);
        });
        proxyRes.on('end', () => {
          if (geminiState.buffer.trim()) processGeminiSseEvent(bridge, useCodeAssist ? unwrapCodeAssistSseEvent(geminiState.buffer) : geminiState.buffer, geminiState, targetModel);
          flushPendingGeminiToolCall(bridge, geminiState, geminiState.tools);
          if (geminiState.textOpen) writeClaudeSseEvent(bridge, 'content_block_stop', { type: 'content_block_stop', index: geminiState.textIndex });
          writeClaudeSseEvent(bridge, 'message_delta', { type: 'message_delta', delta: { stop_reason: geminiClaudeStopReason(geminiState), stop_sequence: null }, usage: geminiState.usage });
          writeClaudeSseEvent(bridge, 'message_stop', { type: 'message_stop' });
          flushClaudeSseToOpenAI(clientRes, chatState);
          clientRes.end();
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'openai_to_gemini_stream', usage: geminiState.usage });
        });
        return;
      }

      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'openai_to_gemini', (responseBody) => {
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          const geminiError = parseGeminiError(proxyRes.statusCode, responseBody);
          const retryAfter = geminiError.retryAfterSeconds;
          const errHeaders = {};
          if (proxyRes.statusCode === 429 && retryAfter) errHeaders['retry-after'] = String(retryAfter);
          sendUpstreamError(clientRes, proxyRes.statusCode, { ...proxyRes.headers, ...errHeaders }, responseBody, 'gemini');
          if (proxyRes.statusCode === 429) {
            setGeminiCooldown(prepared.profile && prepared.profile.id, targetModel, retryAfter || 45);
          }
          logProxyEvent('upstream_error', { method: clientReq.method, path: upstreamPath, code: proxyRes.statusCode, type: 'gemini', errorType: geminiError.type, status: geminiError.status, retryAfterSeconds: retryAfter });
          logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, { type: 'openai_to_gemini_error', errorType: geminiError.type, retryAfterSeconds: retryAfter });
          return;
        }
        try {
          const claudeResponse = geminiResponseToClaude(unwrapCodeAssistResponse(parseJsonOrSseJson(responseBody)), targetModel, claudeBody.tools);
          const openAIResponse = claudeResponseToOpenAIChat(claudeResponse, parsed.model || targetModel);
          writeJsonResponse(clientRes, 200, openAIResponse);
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'openai_to_gemini', usage: claudeResponse.usage });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'Gemini response conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Gemini'));
    proxyReq.on('error', function(err) {
      log.error('gemini ' + clientReq.method + ' ' + clientReq.url + '  ' + (err.code || err.message));
      logProxyEvent('proxy_error', { method: clientReq.method, path: clientReq.url, error: err.message, code: err.code, type: 'gemini', entryProtocol: 'openai-chat' });
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, { error: { message: 'Gemini proxy error: ' + (err && err.message), type: 'proxy_error' } });
      }
    });
    proxyReq.end(requestBody);
  }

  // ========== Gemini 源 / 直接 ==========

  function handleGeminiMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) return;

    const stream = parsed.stream === true;
    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : (parsed.model || 'gemini-pro');
    const cooldown = getGeminiCooldown(prepared.profile && prepared.profile.id, targetModel);
    if (cooldown) {
      const message = 'Gemini rate limit cooldown active. Please retry in ' + cooldown.retryAfterSeconds + 's.';
      log.warn('gemini rate limited ' + clientReq.method + ' ' + upstreamPath + ' -> 429 retry_after=' + cooldown.retryAfterSeconds + 's source=local_cooldown target=' + targetModel);
      sendGeminiRateLimit(clientReq, clientRes, upstreamPath, startTime, targetModel, cooldown.retryAfterSeconds, message, { source: 'local_cooldown' });
      return;
    }
    parsed.__diagnosticsMeta = { protocol: 'gemini', route: prepared.model, target: targetModel, upstreamPath, profile: prepared.profile && prepared.profile.id };
    const geminiBody = claudeMessagesToGemini(parsed, targetModel);
    const useCodeAssist = shouldUseCodeAssistUpstream(prepared, apiKey);
    const codeAssist = useCodeAssist ? codeAssistGenerateRequest(prepared, geminiBody, targetModel, stream) : null;
    const requestBody = Buffer.from(JSON.stringify(useCodeAssist ? codeAssist.body : geminiBody));
    const pathWithMethod = useCodeAssist
      ? codeAssist.target.pathname + codeAssist.target.search
      : geminiGeneratePath(target.path, targetModel, stream) + (stream ? '?alt=sse' : '');
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
    };
    if (useCodeAssist) headers['user-agent'] = codeAssistUserAgent();
    if (apiKey) {
      if (String(apiKey).startsWith('ya29.')) {
        headers['authorization'] = 'Bearer ' + apiKey;
      } else {
        headers['x-goog-api-key'] = apiKey;
      }
    }

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request({
      hostname: useCodeAssist ? codeAssist.target.hostname : (process.env.TARGET || target.hostname),
      port: parseInt(useCodeAssist ? (codeAssist.target.port || 443) : (process.env.TARGET_PORT || target.port), 10),
      path: pathWithMethod,
      method: 'POST',
      headers,
      timeout: 600000,
    }, (proxyRes) => {
      log.info('gemini upstream response ' + clientReq.method + ' ' + upstreamPath + ' -> ' + proxyRes.statusCode + ' stream=' + stream);
      if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS_HEADERS });
        clientRes.__diagnostics = { protocol: 'gemini', route: prepared.model, target: targetModel, upstreamPath, profile: prepared.profile && prepared.profile.id };
        const state = { textIndex: -1, textOpen: false, stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, buffer: '', tools: parsed.tools, pendingToolCall: null };
        const messageId = fallbackId('msg_gemini', { model: targetModel, messages: parsed.messages, route: targetModel });
        writeClaudeSseEvent(clientRes, 'message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: targetModel, content: [], stop_reason: null, stop_sequence: null, usage: state.usage } });
        proxyRes.on('data', (chunk) => {
          const chunkText = chunk.toString('utf8');
          sampleResponseChunk('gemini-upstream', chunkText, { upstreamPath, targetModel });
          state.buffer += chunkText;
          const events = state.buffer.split(/\r?\n\r?\n/);
          state.buffer = events.pop();
          for (const event of events) processGeminiSseEvent(clientRes, useCodeAssist ? unwrapCodeAssistSseEvent(event) : event, state, targetModel);
        });
        proxyRes.on('end', () => {
          if (state.buffer.trim()) processGeminiSseEvent(clientRes, useCodeAssist ? unwrapCodeAssistSseEvent(state.buffer) : state.buffer, state, targetModel);
          flushPendingGeminiToolCall(clientRes, state, state.tools);
          if (state.textOpen) writeClaudeSseEvent(clientRes, 'content_block_stop', { type: 'content_block_stop', index: state.textIndex });
          writeClaudeSseEvent(clientRes, 'message_delta', { type: 'message_delta', delta: { stop_reason: geminiClaudeStopReason(state), stop_sequence: null }, usage: state.usage });
          writeClaudeSseEvent(clientRes, 'message_stop', { type: 'message_stop' });
          clientRes.end();
          log.info('ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (gemini streaming)');
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'gemini_stream', usage: state.usage });
        });
        return;
      }

      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'gemini', (responseBody) => {
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          const geminiError = parseGeminiError(proxyRes.statusCode, responseBody);
          const retryAfter = geminiError.retryAfterSeconds;
          const headers = {};
          if (proxyRes.statusCode === 429 && retryAfter) headers['retry-after'] = String(retryAfter);
          sendUpstreamError(clientRes, proxyRes.statusCode, { ...proxyRes.headers, ...headers }, responseBody, 'gemini');
          if (proxyRes.statusCode === 429) {
            setGeminiCooldown(prepared.profile && prepared.profile.id, targetModel, retryAfter || 45);
            log.warn('gemini rate limited ' + clientReq.method + ' ' + upstreamPath + ' -> 429 retry_after=' + (retryAfter || 45) + 's metric=' + (geminiError.quotaId || geminiError.quotaMetric || '-') + ' target=' + targetModel);
          } else {
            log.warn('gemini error ' + clientReq.method + ' ' + upstreamPath + ' -> ' + proxyRes.statusCode + ' message=' + String(geminiError.message || '').replace(/\s+/g, ' ').slice(0, 500));
          }
          logProxyEvent('upstream_error', { method: clientReq.method, path: upstreamPath, code: proxyRes.statusCode, type: 'gemini', errorType: geminiError.type, status: geminiError.status, retryAfterSeconds: retryAfter, quotaMetric: geminiError.quotaMetric, quotaId: geminiError.quotaId });
          logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, { type: 'gemini_error', errorType: geminiError.type, retryAfterSeconds: retryAfter });
          return;
        }
        try {
          const claudeResponse = geminiResponseToClaude(unwrapCodeAssistResponse(parseJsonOrSseJson(responseBody)), targetModel, parsed.tools);
          writeJsonResponse(clientRes, 200, claudeResponse);
          log.info('ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (gemini)');
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'gemini', usage: claudeResponse.usage });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'Gemini response conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', onProxyTimeout(proxyReq, 'Gemini'));
    proxyReq.on('error', function(err) {
      log.error('gemini ' + clientReq.method + ' ' + clientReq.url + '  ' + (err.code || err.message));
      logProxyEvent('proxy_error', { method: clientReq.method, path: clientReq.url, error: err.message, code: err.code, type: 'gemini' });
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, { error: { message: 'Gemini proxy error: ' + err.message, type: 'proxy_error' } });
      }
    });

    proxyReq.end(requestBody);
  }

  return {
    handleClaudeMessagesToOpenAIChat,
    handleClaudeMessagesToOpenAIResponses,
    handleOpenAIChatToClaudeMessages,
    handleOpenAIChatToOpenAIResponses,
    handleOpenAIResponsesToOpenAIChat,
    handleOpenAIResponsesToClaudeMessages,
    handleOpenAIResponsesToGeminiMessages,
    handleOpenAIChatToGeminiMessages,
    handleGeminiMessages,
  };
}

module.exports = { createRouteHandlers };
