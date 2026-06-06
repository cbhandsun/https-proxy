const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

function createProxyHandlers(deps) {
  const {
    claudeMessagesToOpenAIChat,
    openAIResponseToClaudeMessage,
    openAIChatToClaudeMessages,
    claudeResponseToOpenAIChat,
    openAIResponsesToChat,
    openAIChatToResponses,
    processOpenAIChatSseChunkToResponses,
    flushOpenAIChatSseToResponses,
    openAIChatToResponsesRequest,
    openAIResponsesToChatResponse,
    processOpenAIResponsesSseChunkToChat,
    flushOpenAIResponsesSseToChat,
    claudeMessagesToGemini,
    geminiGeneratePath,
    geminiResponseToClaude,
    parseGeminiError,
    getGeminiCooldown,
    setGeminiCooldown,
    sendGeminiRateLimit,
    sendUpstreamError,
    sendJsonError,
    writeClaudeSseEvent,
    processOpenAISseChunkToClaude,
    flushOpenAISseToClaude,
    processClaudeSseChunkToOpenAI,
    flushClaudeSseToOpenAI,
    processGeminiSseEvent,
    flushPendingGeminiToolCall,
    sampleResponseChunk,
    logProxyEvent,
    logRequestEnd,
    fallbackId,
    stableCreated,
    extractSseDataPayloads,
    maxConversionResponseBytes,
  } = deps;
  const responsesHistory = new Map();
  const responsesHistoryLimit = 20;
  const CACHE_FILE = path.join(DATA_DIR, '.responses_history.cache.json');
  const conversionResponseLimit = Math.max(1024 * 1024, Number(maxConversionResponseBytes || 16 * 1024 * 1024));

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const entries = JSON.parse(raw);
      if (Array.isArray(entries)) {
        for (const [key, value] of entries) {
          responsesHistory.set(key, value);
        }
        console.log('[proxy] Loaded responses history from cache. Entries:', responsesHistory.size);
      }
    }
  } catch (err) {
    console.warn('[proxy] Failed to load responses history cache:', err.message);
  }

  let saveTimeout = null;
  function saveResponsesHistoryToDisk() {
    if (saveTimeout) return;
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      try {
        const serialized = JSON.stringify(Array.from(responsesHistory.entries()));
        fs.writeFile(CACHE_FILE, serialized, 'utf8', (err) => {
          if (err) console.warn('[proxy] Failed to save responses history cache:', err.message);
        });
      } catch (err) {
        console.warn('[proxy] Failed to serialize responses history:', err.message);
      }
    }, 1000);
  }

  function parseJsonOrSseJson(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (extractSseDataPayloads) {
      const payloads = extractSseDataPayloads(trimmed);
      const parsedPayloads = [];
      for (const payload of payloads) {
        try { parsedPayloads.push(JSON.parse(payload)); } catch (err) {}
      }

      const chatText = parsedPayloads.map((item) => {
        const choice = item && Array.isArray(item.choices) ? item.choices[0] : null;
        if (!choice) return '';
        if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
        if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
        return '';
      }).join('');
      if (chatText) {
        const source = parsedPayloads.find((item) => item && item.id) || {};
        const usageSource = parsedPayloads.find((item) => item && item.usage) || {};
        return {
          id: source.id,
          choices: [{ index: 0, message: { role: 'assistant', content: chatText }, finish_reason: 'stop' }],
          usage: usageSource.usage,
        };
      }

      const responseText = parsedPayloads
        .filter((item) => item && item.type === 'response.output_text.done' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('');
      if (responseText) {
        const completed = parsedPayloads.find((item) => item && item.type === 'response.completed' && item.response) || null;
        const usage = completed && completed.response && completed.response.usage ? completed.response.usage : null;
        return {
          id: completed && completed.response && completed.response.id,
          choices: [{ index: 0, message: { role: 'assistant', content: responseText }, finish_reason: 'stop' }],
          usage: usage ? {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: usage.total_tokens || 0,
          } : undefined,
        };
      }
      for (let i = parsedPayloads.length - 1; i >= 0; i -= 1) return parsedPayloads[i];
    }
    return JSON.parse(trimmed);
  }

  function shouldUseCodeAssistUpstream(prepared, apiKey) {
    const protocol = prepared && prepared.profile && prepared.profile.protocol
      ? String(prepared.profile.protocol).toLowerCase()
      : '';
    return prepared
      && prepared.authMode === 'official-login'
      && prepared.authProvider === 'google'
      && protocol === 'gemini'
      && typeof apiKey === 'string'
      && apiKey.startsWith('ya29.');
  }

  function codeAssistUrl(method, stream) {
    const base = (process.env.CODE_ASSIST_ENDPOINT || 'https://daily-cloudcode-pa.googleapis.com').replace(/\/$/, '');
    const version = process.env.CODE_ASSIST_API_VERSION || 'v1internal';
    return new URL('/' + version + ':' + method + (stream ? '?alt=sse' : ''), base);
  }

  function codeAssistUserAgent() {
    return process.env.CODE_ASSIST_USER_AGENT || 'antigravity-cli/diagnostic';
  }

  function codeAssistModelSelection(model) {
    const normalized = String(model || '').replace(/^google\//, '').trim();
    const key = normalized.toLowerCase();
    const aliases = {
      'gemini 3.5 flash (medium)': 'gemini-3.5-flash-low',
      'gemini 3.5 flash medium': 'gemini-3.5-flash-low',
      'gemini-3.5-flash-medium': 'gemini-3.5-flash-low',
      'gemini-3.5-flash': 'gemini-3.5-flash-low',
      'gemini 3.5 flash (high)': 'gemini-3-flash-agent',
      'gemini 3.5 flash high': 'gemini-3-flash-agent',
      'gemini-3.5-flash-high': 'gemini-3-flash-agent',
      'gemini 3.5 flash (low)': 'gemini-3.5-flash-extra-low',
      'gemini 3.5 flash low': 'gemini-3.5-flash-extra-low',
      'gemini-3.5-flash-extra-low': 'gemini-3.5-flash-extra-low',
      'gemini 3.1 pro (low)': 'gemini-3.1-pro-low',
      'gemini-3.1-pro-low': 'gemini-3.1-pro-low',
      'gemini 3.1 pro (high)': 'gemini-pro-agent',
      'gemini-3.1-pro-high': 'gemini-pro-agent',
      gemini: 'gemini-3.5-flash-low',
      'gemini-3.1': 'gemini-3.1-flash-lite',
      'gemini-3.1-pro': 'gemini-pro-agent',
      'gemini-3.1-flash-preview': 'gemini-3.1-flash-lite',
      'gemini-3-flash-preview': 'gemini-3-flash',
      'claude sonnet 4.6 (thinking)': 'claude-sonnet-4-6',
      'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
      'claude opus 4.6 (thinking)': 'claude-opus-4-6-thinking',
      'claude-opus-4-6': 'claude-opus-4-6-thinking',
      'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
      'gpt-oss 120b (medium)': 'gpt-oss-120b-medium',
      'gpt-oss-120b': 'gpt-oss-120b-medium',
      'gpt-oss-120b-medium': 'gpt-oss-120b-medium'
    };
    return { model: aliases[key] || normalized };
  }

  function codeAssistGenerateRequest(prepared, geminiBody, targetModel, stream) {
    const selection = codeAssistModelSelection(targetModel);
    const backendModel = selection.model;
    const project = prepared.googleOfficialProjectId
      || (prepared.profile && prepared.profile.googleOfficialProjectId)
      || process.env.GOOGLE_CLOUD_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT_ID
      || undefined;
    const request = {
      contents: geminiBody.contents,
      systemInstruction: geminiBody.systemInstruction,
      tools: geminiBody.tools,
      toolConfig: geminiBody.toolConfig,
      generationConfig: geminiBody.generationConfig,
    };
    for (const key of Object.keys(request)) {
      if (request[key] == null) delete request[key];
    }
    return {
      target: codeAssistUrl(stream ? 'streamGenerateContent' : 'generateContent', stream),
      body: {
        model: backendModel,
        project,
        user_prompt_id: fallbackId('proxy_prompt', {
          model: backendModel,
          project,
          route: prepared.model,
          request
        }),
        request
      }
    };
  }

  function unwrapCodeAssistResponse(payload) {
    return payload && payload.response ? payload.response : payload;
  }

  function unwrapCodeAssistSseEvent(event) {
    return String(event || '').split(/\r?\n/).map((line) => {
      if (!line.startsWith('data:')) return line;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return line;
      try {
        return 'data: ' + JSON.stringify(unwrapCodeAssistResponse(JSON.parse(data)));
      } catch (err) {
        return line;
      }
    }).join('\n');
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
            message: 'Upstream response for protocol conversion exceeds proxy limit of ' + conversionResponseLimit + ' bytes'
          }
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
    while (responsesHistory.size > responsesHistoryLimit) {
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

  function rejectUnsupportedResponsesTools(clientRes, parsed) {
    if (!parsed || !Array.isArray(parsed.tools)) return false;
    const unsupported = parsed.tools.find((tool) => tool && tool.type && tool.type !== 'function');
    if (!unsupported) return false;
    sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Responses tool type "' + unsupported.type + '" cannot be converted to Chat, Claude, or Gemini upstreams. Only function tools are supported on converted routes.',
      },
    });
    return true;
  }

  function rejectUnsupportedResponsesInput(clientRes, parsed) {
    const input = parsed && parsed.input;
    const items = Array.isArray(input) ? input : [];
    const supportedItemTypes = new Set(['message', 'function_call', 'function_call_output']);
    const supportedContentTypes = new Set(['input_text', 'output_text', 'text', 'input_image']);
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item === 'string') continue;
      if (item.type && !supportedItemTypes.has(item.type)) {
        sendJsonError(clientRes, 400, {
          error: {
            type: 'invalid_request_error',
            message: 'Responses input item type "' + item.type + '" cannot be converted to Chat, Claude, or Gemini upstreams.',
          },
        });
        return true;
      }
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (part && typeof part === 'object' && part.type && !supportedContentTypes.has(part.type)) {
          sendJsonError(clientRes, 400, {
            error: {
              type: 'invalid_request_error',
              message: 'Responses content part type "' + part.type + '" cannot be converted to Chat, Claude, or Gemini upstreams.',
            },
          });
          return true;
        }
        if (part && typeof part === 'object' && part.type === 'input_image' && !(part.image_url || part.url)) {
          sendJsonError(clientRes, 400, {
            error: {
              type: 'invalid_request_error',
              message: 'Responses input_image parts without image_url cannot be converted to Chat, Claude, or Gemini upstreams.',
            },
          });
          return true;
        }
      }
    }
    return false;
  }

  function rejectUnsupportedResponsesStructuredOutput(clientRes, parsed) {
    const format = parsed && ((parsed.text && parsed.text.format) || parsed.response_format);
    if (!format) return false;
    const type = typeof format === 'object' ? format.type : '';
    if (!type || type === 'text') return false;
    sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Structured Responses output format "' + type + '" cannot be converted to Claude or Gemini upstreams.',
      },
    });
    return true;
  }

  function rejectUnsupportedResponsesReasoning(clientRes, parsed) {
    if (!parsed || !parsed.reasoning) return false;
    sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Responses reasoning options cannot be converted to Claude or Gemini upstreams.',
      },
    });
    return true;
  }

  function rejectUnsupportedResponsesConversion(clientRes, parsed) {
    return rejectUnsupportedResponsesTools(clientRes, parsed)
      || rejectUnsupportedResponsesInput(clientRes, parsed);
  }

  function rejectUnsupportedResponsesNonOpenAIConversion(clientRes, parsed) {
    return rejectUnsupportedResponsesConversion(clientRes, parsed)
      || rejectUnsupportedResponsesStructuredOutput(clientRes, parsed)
      || rejectUnsupportedResponsesReasoning(clientRes, parsed);
  }

  function rejectUnsupportedOpenAIChatNonOpenAIConversion(clientRes, parsed, targetProtocol) {
    const unsupportedTool = parsed && Array.isArray(parsed.tools)
      ? parsed.tools.find((tool) => tool && tool.type && tool.type !== 'function')
      : null;
    if (unsupportedTool) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'OpenAI Chat tool type "' + unsupportedTool.type + '" cannot be converted to ' + targetProtocol + ' upstreams. Only function tools are supported on converted routes.',
        },
      });
      return true;
    }

    const responseFormat = parsed && parsed.response_format;
    const responseFormatType = responseFormat && typeof responseFormat === 'object' ? responseFormat.type : '';
    if (responseFormatType && responseFormatType !== 'text') {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'OpenAI Chat response_format "' + responseFormatType + '" cannot be converted to ' + targetProtocol + ' upstreams.',
        },
      });
      return true;
    }

    if (parsed && (parsed.reasoning || parsed.reasoning_effort)) {
      sendJsonError(clientRes, 400, {
        error: {
          type: 'invalid_request_error',
          message: 'OpenAI Chat reasoning options cannot be converted to ' + targetProtocol + ' upstreams.',
        },
      });
      return true;
    }

    return false;
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

  function handleClaudeMessagesToOpenAIChat(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    let parsed;
    try {
      parsed = JSON.parse(prepared.buffer.toString('utf8'));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' } }));
      return;
    }

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    const openAIBody = claudeMessagesToOpenAIChat(parsed, targetModel);
    const requestBody = Buffer.from(JSON.stringify(openAIBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request({
      hostname: process.env.TARGET || target.hostname,
      port: parseInt(process.env.TARGET_PORT || target.port, 10),
      path: target.path + '/chat/completions',
      method: 'POST',
      headers,
      timeout: 600000,
    }, (proxyRes) => {
      if (openAIBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': '*' });
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

      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'claude_to_openai', (responseBody) => {
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          sendUpstreamError(clientRes, proxyRes.statusCode, proxyRes.headers, responseBody, 'openai');
          logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, { type: 'claude_to_openai_error' });
          return;
        }
        try {
          const claudeResponse = openAIResponseToClaudeMessage(parseJsonOrSseJson(responseBody), parsed.model || targetModel);
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': '*' });
          clientRes.end(JSON.stringify(claudeResponse));
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'claude_to_openai' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'OpenAI response conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', function() { proxyReq.destroy(new Error('OpenAI upstream request timeout')); });
    proxyReq.on('error', function(err) {
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, { error: { message: 'OpenAI proxy error: ' + err.message, type: 'proxy_error' } });
      }
    });
    proxyReq.end(requestBody);
  }

  function handleClaudeMessagesToOpenAIResponses(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    let parsed;
    try {
      parsed = JSON.parse(prepared.buffer.toString('utf8'));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' } }));
      return;
    }

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    const chatBody = claudeMessagesToOpenAIChat(parsed, targetModel);
    const responsesBody = openAIChatToResponsesRequest({ ...chatBody, model: targetModel });
    const requestBody = Buffer.from(JSON.stringify(responsesBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request({
      hostname: process.env.TARGET || target.hostname,
      port: parseInt(process.env.TARGET_PORT || target.port, 10),
      path: target.path + '/responses',
      method: 'POST',
      headers,
      timeout: 600000,
    }, (proxyRes) => {
      const code = proxyRes.statusCode;
      if (parsed.stream && code >= 200 && code < 300) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        });

        const chatSeed = { model: parsed.model || targetModel, messages: parsed.messages, route: targetModel };
        const messageId = fallbackId('msg_openai_responses', chatSeed);
        const chatState = {
          id: fallbackId('chatcmpl', chatSeed),
          created: stableCreated(chatSeed),
          model: parsed.model || targetModel,
          buffer: '',
          started: false,
          toolCalls: [],
          usage: null,
          done: false
        };
        const claudeState = { buffer: '', textIndex: -1, textOpen: false, toolCalls: [], finishReason: 'stop', usage: { input_tokens: 0, output_tokens: 0 }, done: false };
        const chatRes = { write: (chunk) => processOpenAISseChunkToClaude(clientRes, String(chunk), claudeState) };
        writeClaudeSseEvent(clientRes, 'message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: parsed.model || targetModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: claudeState.usage
          }
        });

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
          const chatResponse = (payload && Array.isArray(payload.choices) && !payload.output)
            ? payload
            : openAIResponsesToChatResponse(payload, parsed.model || targetModel);
          const claudeResponse = openAIResponseToClaudeMessage(chatResponse, parsed.model || targetModel);
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': '*' });
          clientRes.end(JSON.stringify(claudeResponse));
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'claude_to_responses', upstreamEndpoint: target.path + '/responses' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'Claude from Responses conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', function() { proxyReq.destroy(new Error('OpenAI upstream request timeout')); });
    proxyReq.on('error', function(err) {
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, { error: { message: 'OpenAI proxy error: ' + err.message, type: 'proxy_error' } });
      }
    });
    proxyReq.end(requestBody);
  }

  function handleOpenAIChatToClaudeMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    let parsed;
    try {
      parsed = JSON.parse(prepared.buffer.toString('utf8'));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' } }));
      return;
    }

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
    const proxyReq = transport.request({
      hostname: process.env.TARGET || target.hostname,
      port: parseInt(process.env.TARGET_PORT || target.port, 10),
      path: target.path + '/messages',
      method: 'POST',
      headers,
      timeout: 600000,
    }, (proxyRes) => {
      if (claudeBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        });
        const streamSeed = { model: parsed.model || targetModel, messages: parsed.messages, route: targetModel };
        const state = { id: fallbackId('chatcmpl', streamSeed), created: stableCreated(streamSeed), model: parsed.model || targetModel, buffer: '', pendingToolCall: null, toolCallIndex: 0, hasToolCalls: false, stopReason: 'end_turn', done: false };
        proxyRes.on('data', (chunk) => processClaudeSseChunkToOpenAI(clientRes, chunk.toString('utf8'), state));
        proxyRes.on('end', () => {
          flushClaudeSseToOpenAI(clientRes, state);
          clientRes.end();
          console.log('ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (openai->claude streaming)');
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
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': '*' });
          clientRes.end(JSON.stringify(openAIResponse));
          console.log('ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (openai->claude)');
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'openai_to_claude' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'Claude response conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', function() {
      proxyReq.destroy(new Error('Claude upstream request timeout'));
    });

    proxyReq.on('error', function(err) {
      console.error('xx claude ' + clientReq.method + ' ' + clientReq.url + '  ' + (err.code || err.message));
      logProxyEvent('proxy_error', { method: clientReq.method, path: clientReq.url, error: err.message, code: err.code, type: 'claude' });
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, { error: { message: 'Claude proxy error: ' + err.message, type: 'proxy_error' } });
      }
    });

    proxyReq.end(requestBody);
  }

  function handleOpenAIChatToOpenAIResponses(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    let parsed;
    try {
      parsed = JSON.parse(prepared.buffer.toString('utf8'));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' } }));
      return;
    }

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    const responsesBody = openAIChatToResponsesRequest({ ...parsed, model: targetModel });
    const requestBody = Buffer.from(JSON.stringify(responsesBody));
    
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request({
      hostname: process.env.TARGET || target.hostname,
      port: parseInt(process.env.TARGET_PORT || target.port, 10),
      path: target.path + '/responses',
      method: 'POST',
      headers,
      timeout: 600000,
    }, (proxyRes) => {
      const code = proxyRes.statusCode;
      if (parsed.stream && code >= 200 && code < 300) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        });
        
        const streamSeed = { model: parsed.model || targetModel, messages: parsed.messages, route: targetModel };
        const state = {
          id: fallbackId('chatcmpl', streamSeed),
          created: stableCreated(streamSeed),
          model: parsed.model || targetModel,
          buffer: '',
          started: false,
          toolCalls: [],
          usage: null,
          done: false
        };
        
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
          // 如果上游因为强制流式返回了 EventStream，并被 parseJsonOrSseJson 拼装成了 Chat 格式，则无需进行二次转换
          const response = (payload && Array.isArray(payload.choices) && !payload.output)
            ? payload
            : openAIResponsesToChatResponse(payload, parsed.model || targetModel);
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': '*' });
          clientRes.end(JSON.stringify(response));
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'chat_to_responses' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'OpenAI Chat from Responses conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', function() { proxyReq.destroy(new Error('OpenAI upstream request timeout')); });
    proxyReq.on('error', function(err) {
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, { error: { message: 'OpenAI proxy error: ' + err.message, type: 'proxy_error' } });
      }
    });
    proxyReq.end(requestBody);
  }

  function handleOpenAIResponsesToOpenAIChat(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    let parsed;
    try {
      parsed = JSON.parse(prepared.buffer.toString('utf8'));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' } }));
      return;
    }

    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model;
    if (rejectUnsupportedResponsesConversion(clientRes, parsed)) return;
    const chatBody = responsesToChatWithHistory(clientRes, parsed, targetModel);
    if (!chatBody) return;

    const requestBody = Buffer.from(JSON.stringify(chatBody));
    const headers = { 'content-type': 'application/json', 'content-length': requestBody.length };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request({
      hostname: process.env.TARGET || target.hostname,
      port: parseInt(process.env.TARGET_PORT || target.port, 10),
      path: target.path + '/chat/completions',
      method: 'POST',
      headers,
      timeout: 600000,
    }, (proxyRes) => {
      if (chatBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        });
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
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': '*' });
          clientRes.end(JSON.stringify(response));
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'responses_to_chat' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'OpenAI Responses conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', function() { proxyReq.destroy(new Error('OpenAI upstream request timeout')); });
    proxyReq.on('error', function(err) {
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, { error: { message: 'OpenAI proxy error: ' + err.message, type: 'proxy_error' } });
      }
    });
    proxyReq.end(requestBody);
  }

  function handleOpenAIResponsesToClaudeMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    let parsed;
    try {
      parsed = JSON.parse(prepared.buffer.toString('utf8'));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' } }));
      return;
    }

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
    const proxyReq = transport.request({
      hostname: process.env.TARGET || target.hostname,
      port: parseInt(process.env.TARGET_PORT || target.port, 10),
      path: target.path + '/messages',
      method: 'POST',
      headers,
      timeout: 600000,
    }, (proxyRes) => {
      if (claudeBody.stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        });
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
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': '*' });
          clientRes.end(JSON.stringify(response));
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'responses_to_claude' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'OpenAI Responses conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', function() { proxyReq.destroy(new Error('Claude upstream request timeout')); });
    proxyReq.on('error', function(err) {
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, { error: { message: 'Claude proxy error: ' + err.message, type: 'proxy_error' } });
      }
    });
    proxyReq.end(requestBody);
  }

  function handleOpenAIResponsesToGeminiMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    let parsed;
    try {
      parsed = JSON.parse(prepared.buffer.toString('utf8'));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' } }));
      return;
    }

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
    const proxyReq = transport.request({
      hostname: process.env.TARGET || target.hostname,
      port: parseInt(process.env.TARGET_PORT || target.port, 10),
      path: pathWithMethod,
      method: 'POST',
      headers,
      timeout: 600000,
    }, (proxyRes) => {
      if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        });
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
          writeClaudeSseEvent(claudeBridge, 'message_delta', { type: 'message_delta', delta: { stop_reason: geminiState.stopReason, stop_sequence: null }, usage: geminiState.usage });
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
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': '*' });
          clientRes.end(JSON.stringify(response));
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'responses_to_gemini' });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'OpenAI Responses to Gemini conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', function() { proxyReq.destroy(new Error('Gemini upstream request timeout')); });
    proxyReq.on('error', function(err) {
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, { error: { message: 'Gemini proxy error: ' + err.message, type: 'proxy_error' } });
      }
    });
    proxyReq.end(requestBody);
  }

  function handleOpenAIChatToGeminiMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    let parsed;
    try {
      parsed = JSON.parse(prepared.buffer.toString('utf8'));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' } }));
      return;
    }

    const stream = parsed.stream === true;
    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : (parsed.model || 'gemini-pro');
    if (rejectUnsupportedOpenAIChatNonOpenAIConversion(clientRes, parsed, 'Gemini')) return;
    const cooldown = getGeminiCooldown(prepared.profile && prepared.profile.id, targetModel);
    if (cooldown) {
      const message = 'Gemini rate limit cooldown active. Please retry in ' + cooldown.retryAfterSeconds + 's.';
      console.warn('!! gemini rate limited ' + clientReq.method + ' ' + upstreamPath + ' -> 429 retry_after=' + cooldown.retryAfterSeconds + 's source=local_cooldown target=' + targetModel);
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
      console.log('gemini upstream response ' + clientReq.method + ' ' + upstreamPath + ' -> ' + proxyRes.statusCode + ' stream=' + stream + ' entry=openai-chat');
      if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        });
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
          writeClaudeSseEvent(bridge, 'message_delta', { type: 'message_delta', delta: { stop_reason: geminiState.stopReason, stop_sequence: null }, usage: geminiState.usage });
          writeClaudeSseEvent(bridge, 'message_stop', { type: 'message_stop' });
          flushClaudeSseToOpenAI(clientRes, chatState);
          clientRes.end();
          console.log('ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (openai->gemini streaming)');
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'openai_to_gemini_stream', usage: geminiState.usage });
        });
        return;
      }

      collectBoundedResponse(proxyRes, clientRes, upstreamPath, 'openai_to_gemini', (responseBody) => {
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          const geminiError = parseGeminiError(proxyRes.statusCode, responseBody);
          const retryAfter = geminiError.retryAfterSeconds;
          const headers = {};
          if (proxyRes.statusCode === 429 && retryAfter) headers['retry-after'] = String(retryAfter);
          sendUpstreamError(clientRes, proxyRes.statusCode, { ...proxyRes.headers, ...headers }, responseBody, 'gemini');
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
          clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': '*' });
          clientRes.end(JSON.stringify(openAIResponse));
          console.log('ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (openai->gemini)');
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'openai_to_gemini', usage: claudeResponse.usage });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'Gemini response conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', function() { proxyReq.destroy(new Error('Gemini upstream request timeout')); });
    proxyReq.on('error', function(err) {
      console.error('xx gemini ' + clientReq.method + ' ' + clientReq.url + '  ' + (err.code || err.message));
      logProxyEvent('proxy_error', { method: clientReq.method, path: clientReq.url, error: err.message, code: err.code, type: 'gemini', entryProtocol: 'openai-chat' });
      if (!clientRes.headersSent) {
        sendJsonError(clientRes, 502, { error: { message: 'Gemini proxy error: ' + err.message, type: 'proxy_error' } });
      }
    });

    proxyReq.end(requestBody);
  }

  function handleGeminiMessages(clientReq, clientRes, prepared, target, apiKey, upstreamPath, startTime) {
    let parsed;
    try {
      parsed = JSON.parse(prepared.buffer.toString('utf8'));
    } catch (err) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' } }));
      return;
    }

    const stream = parsed.stream === true;
    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : (parsed.model || 'gemini-pro');
    const cooldown = getGeminiCooldown(prepared.profile && prepared.profile.id, targetModel);
    if (cooldown) {
      const message = 'Gemini rate limit cooldown active. Please retry in ' + cooldown.retryAfterSeconds + 's.';
      console.warn('!! gemini rate limited ' + clientReq.method + ' ' + upstreamPath + ' -> 429 retry_after=' + cooldown.retryAfterSeconds + 's source=local_cooldown target=' + targetModel);
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
      console.log('gemini upstream response ' + clientReq.method + ' ' + upstreamPath + ' -> ' + proxyRes.statusCode + ' stream=' + stream);
      if (stream && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        });
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
          writeClaudeSseEvent(clientRes, 'message_delta', { type: 'message_delta', delta: { stop_reason: state.stopReason, stop_sequence: null }, usage: state.usage });
          writeClaudeSseEvent(clientRes, 'message_stop', { type: 'message_stop' });
          clientRes.end();
          console.log('ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (gemini streaming)');
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
            console.warn('!! gemini rate limited ' + clientReq.method + ' ' + upstreamPath + ' -> 429 retry_after=' + (retryAfter || 45) + 's metric=' + (geminiError.quotaId || geminiError.quotaMetric || '-') + ' target=' + targetModel);
          } else {
            console.warn('!! gemini error ' + clientReq.method + ' ' + upstreamPath + ' -> ' + proxyRes.statusCode + ' message=' + String(geminiError.message || '').replace(/\s+/g, ' ').slice(0, 500));
          }
          logProxyEvent('upstream_error', { method: clientReq.method, path: upstreamPath, code: proxyRes.statusCode, type: 'gemini', errorType: geminiError.type, status: geminiError.status, retryAfterSeconds: retryAfter, quotaMetric: geminiError.quotaMetric, quotaId: geminiError.quotaId });
          logRequestEnd(clientReq.method, upstreamPath, startTime, proxyRes.statusCode, { type: 'gemini_error', errorType: geminiError.type, retryAfterSeconds: retryAfter });
          return;
        }
        try {
          const claudeResponse = geminiResponseToClaude(unwrapCodeAssistResponse(parseJsonOrSseJson(responseBody)), targetModel, parsed.tools);
          clientRes.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'access-control-allow-headers': '*',
          });
          clientRes.end(JSON.stringify(claudeResponse));
          console.log('ok ' + clientReq.method + ' ' + clientReq.url + '  -> 200 (gemini)');
          logRequestEnd(clientReq.method, upstreamPath, startTime, 200, { type: 'gemini', usage: claudeResponse.usage });
        } catch (err) {
          sendJsonError(clientRes, 502, { error: { type: 'api_error', message: 'Gemini response conversion failed: ' + err.message } });
        }
      });
    });

    proxyReq.on('timeout', function() {
      proxyReq.destroy(new Error('Gemini upstream request timeout'));
    });

    proxyReq.on('error', function(err) {
      console.error('xx gemini ' + clientReq.method + ' ' + clientReq.url + '  ' + (err.code || err.message));
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
    _responsesHistory: responsesHistory,
    _rememberResponsesHistory: rememberResponsesHistory,
    _saveResponsesHistoryToDisk: saveResponsesHistoryToDisk,
  };
}

module.exports = { createProxyHandlers };
