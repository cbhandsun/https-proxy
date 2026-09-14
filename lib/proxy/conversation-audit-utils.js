const { hasResponseBytes, markRequestTiming, snapshotRequestTiming } = require('./request-timing');
const { stringifyWithoutInlineMedia } = require('./inline-media');

function bufferFromResponseChunk(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

function sendRequestTooLarge(clientReq, clientRes, limit) {
  if (clientRes.headersSent) return;
  const body = JSON.stringify({
    error: {
      type: 'request_too_large',
      message: 'Request body exceeds proxy limit of ' + limit + ' bytes',
    },
  });
  clientRes.writeHead(413, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  clientRes.end(body);
}

function appendAuditText(current, addition, maxChars) {
  const text = String(addition || '');
  if (!text) return { value: current || '', truncated: false };
  const base = current || '';
  if (base.length >= maxChars) return { value: base, truncated: true };
  const remaining = maxChars - base.length;
  if (text.length > remaining) return { value: base + text.slice(0, remaining), truncated: true };
  return { value: base + text, truncated: false };
}

function hasVisibleTextSsePayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (
    data.type === 'content_block_delta' &&
    data.delta &&
    typeof data.delta.text === 'string' &&
    data.delta.text.length > 0
  ) {
    return true;
  }
  if (
    data.type === 'response.output_text.delta' &&
    typeof data.delta === 'string' &&
    data.delta.length > 0
  ) {
    return true;
  }
  const delta = Array.isArray(data.choices) && data.choices[0] && data.choices[0].delta;
  return !!(delta && typeof delta.content === 'string' && delta.content.length > 0);
}

function createConversationAuditData(options) {
  const {
    id,
    startTime,
    method,
    path,
    clientIp,
    entryPort,
    entryProtocol,
    requestHeaders,
    redactHeaders,
    captureContent,
  } = options || {};
  const safeRedactHeaders =
    typeof redactHeaders === 'function' ? redactHeaders : (headers) => ({ ...(headers || {}) });

  const auditData = {
    id,
    startTime,
    method,
    path,
    clientIp,
    entryPort,
    entryProtocol,
    originalModel: '',
    rewriteModel: '',
    profileId: '',
    profileName: '',
    protocol: '',
    system: '',
    messages: [],
    request: {
      headers: safeRedactHeaders(requestHeaders || {}),
      body: '',
      truncated: false,
    },
    upstream: {},
    responseHeaders: {},
    usage: null,
    cost: null,
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  Object.defineProperty(auditData, '__captureContent', {
    value: captureContent === true,
    enumerable: false,
  });
  return auditData;
}

function profileProtocol(prepared, isGeminiProfile, isClaudeProfile) {
  const profile = (prepared && prepared.profile) || {};
  return isGeminiProfile(profile) ? 'gemini' : isClaudeProfile(profile) ? 'claude' : 'openai';
}

function populateAuditDataFromPrepared(
  clientRes,
  prepared,
  requestBuffer,
  { isGeminiProfile, isClaudeProfile }
) {
  const auditData = clientRes && clientRes.__auditData;
  if (!auditData || !prepared) return;
  const profile = prepared.profile || {};
  const requestProtocol = profileProtocol(prepared, isGeminiProfile, isClaudeProfile);
  auditData.originalModel = prepared.model || '';
  auditData.rewriteModel = prepared.rewriteTo || '';
  auditData.profileId = profile.id || '';
  auditData.profileName = profile.name || profile.id || '';
  auditData.protocol = requestProtocol;
  if (!auditData.request || typeof auditData.request !== 'object') {
    auditData.request = { headers: {}, body: '', truncated: false };
  }
  auditData.request.bodyBytes = Buffer.byteLength(
    prepared.buffer || requestBuffer || Buffer.alloc(0)
  );

  if (auditData.__captureContent === false) return;

  try {
    const sourceBuffer = prepared.buffer || requestBuffer || Buffer.alloc(0);
    const extracted = extractPromptFromBuffer(sourceBuffer, requestProtocol);
    auditData.system = extracted.system;
    auditData.messages = extracted.messages;
  } catch (err) {
    auditData.system = auditData.system || '';
    auditData.messages = auditData.messages || [];
  }
}

function installConversationAuditResponseCapture(clientRes, options) {
  const {
    maxCaptureBytes,
    maxTextChars,
    redactHeaders,
    mergeUsage,
    usageFromSsePayload,
    extractUsageFromJsonPayload,
    estimateUsageForRecord,
    logUsage,
    estimateCost,
    appendAuditRecord,
    config,
    log,
    captureContent = true,
  } = options;
  const responseBuffer = [];
  let responseBytes = 0;
  let responseTruncated = false;
  let sseContent = '';
  let auditTextTruncated = false;
  let auditProviderUsage = null;
  const sseToolCallsMap = new Map();
  let isStream = false;

  const appendText = (current, addition) => appendAuditText(current, addition, maxTextChars);
  const originalWrite = clientRes.write;
  const originalEnd = clientRes.end;
  const originalWriteHead = clientRes.writeHead;

  clientRes.writeHead = function (statusCode, reasonPhrase, headers) {
    const headerObj =
      headers || (reasonPhrase && typeof reasonPhrase === 'object' ? reasonPhrase : {});
    if (headerObj) {
      const contentType = headerObj['content-type'] || headerObj['Content-Type'] || '';
      if (contentType.indexOf('text/event-stream') >= 0) {
        isStream = true;
      }
      if (clientRes.__auditData) {
        clientRes.__auditData.responseHeaders = redactHeaders(headerObj);
      }
    }
    return originalWriteHead.apply(this, arguments);
  };

  const captureAuditResponseChunk = function (chunk, encoding) {
    if (!chunk) return;
    if (!isStream) {
      const chunkBuffer = bufferFromResponseChunk(chunk, encoding);
      let capturedLength = 0;
      if (responseBytes < maxCaptureBytes) {
        const remaining = maxCaptureBytes - responseBytes;
        const captured =
          chunkBuffer.length > remaining ? chunkBuffer.subarray(0, remaining) : chunkBuffer;
        responseBuffer.push(captured);
        responseBytes += captured.length;
        capturedLength = captured.length;
      }
      if (chunkBuffer.length > capturedLength) responseTruncated = true;
      return;
    }

    const text = chunk.toString('utf8');
    const lines = text.split('\n');
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const dataStr = trimmed.substring(5).trim();
      if (dataStr === '[DONE]') return;
      try {
        const needsFirstVisibleText =
          clientRes.__requestTiming && clientRes.__requestTiming.firstVisibleTextAt == null;
        const mayContainUsage = dataStr.includes('"usage"');
        const mayContainText = /"(?:text|content|delta)"/.test(dataStr);
        if (!captureContent && !mayContainUsage && !(needsFirstVisibleText && mayContainText)) {
          return;
        }
        const data = JSON.parse(dataStr);
        if (hasVisibleTextSsePayload(data)) {
          markRequestTiming(clientRes.__requestTiming, 'firstVisibleText');
        }
        auditProviderUsage = mergeUsage(auditProviderUsage, usageFromSsePayload(data));

        if (data.type === 'content_block_delta' && data.delta) {
          if (captureContent && data.delta.text) {
            const appended = appendText(sseContent, data.delta.text);
            sseContent = appended.value;
            if (appended.truncated) auditTextTruncated = true;
          }
          if (captureContent && data.delta.partial_json) {
            const index = data.index;
            const existing = sseToolCallsMap.get(index) || { args: '' };
            const appended = appendText(existing.args, data.delta.partial_json);
            existing.args = appended.value;
            if (appended.truncated) {
              existing.truncated = true;
              auditTextTruncated = true;
            }
            sseToolCallsMap.set(index, existing);
          }
        } else if (data.type === 'content_block_start' && data.content_block) {
          const block = data.content_block;
          if (captureContent && block.type === 'tool_use') {
            const index = data.index;
            sseToolCallsMap.set(index, {
              id: block.id,
              name: block.name,
              args: '',
            });
          }
        } else if (data.type === 'response.output_text.delta' && typeof data.delta === 'string') {
          if (captureContent && data.delta) {
            const appended = appendText(sseContent, data.delta);
            sseContent = appended.value;
            if (appended.truncated) auditTextTruncated = true;
          }
        } else if (data.type === 'response.output_text.done' && typeof data.text === 'string') {
          if (captureContent && !sseContent) {
            const appended = appendText(sseContent, data.text);
            sseContent = appended.value;
            if (appended.truncated) auditTextTruncated = true;
          }
        } else if (data.type === 'response.output_item.added' && data.item) {
          const item = data.item;
          if (captureContent && (item.type === 'function_call' || item.type === 'tool_call')) {
            const index =
              data.output_index != null
                ? data.output_index
                : data.item_index != null
                  ? data.item_index
                  : sseToolCallsMap.size;
            sseToolCallsMap.set(index, {
              id: item.call_id || item.id || `call_${index}`,
              name: item.name || '',
              args: typeof item.arguments === 'string' ? item.arguments : '',
            });
          }
        } else if (data.type === 'response.function_call_arguments.delta' && data.delta) {
          if (captureContent) {
            const index =
              data.output_index != null
                ? data.output_index
                : data.item_index != null
                  ? data.item_index
                  : 0;
            const existing = sseToolCallsMap.get(index) || { args: '' };
            const appended = appendText(existing.args, data.delta);
            existing.args = appended.value;
            if (appended.truncated) {
              existing.truncated = true;
              auditTextTruncated = true;
            }
            sseToolCallsMap.set(index, existing);
          }
        }

        if (Array.isArray(data.choices) && data.choices[0] && data.choices[0].delta) {
          const delta = data.choices[0].delta;
          if (captureContent && delta.content) {
            const appended = appendText(sseContent, delta.content);
            sseContent = appended.value;
            if (appended.truncated) auditTextTruncated = true;
          }
          if (captureContent && Array.isArray(delta.tool_calls)) {
            delta.tool_calls.forEach((tc) => {
              const idx = tc.index;
              const existing = sseToolCallsMap.get(idx) || { args: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function && tc.function.name) existing.name = tc.function.name;
              if (tc.function && tc.function.arguments) {
                const appended = appendText(existing.args, tc.function.arguments);
                existing.args = appended.value;
                if (appended.truncated) {
                  existing.truncated = true;
                  auditTextTruncated = true;
                }
              }
              sseToolCallsMap.set(idx, existing);
            });
          }
        }
      } catch (e) {}
    });
  };

  clientRes.write = function (chunk, encoding, _callback) {
    captureAuditResponseChunk(chunk, encoding);
    return originalWrite.apply(this, arguments);
  };

  clientRes.end = function (chunk, encoding, _callback) {
    if (chunk) {
      captureAuditResponseChunk(chunk, encoding);
    }
    if (hasResponseBytes(chunk)) {
      markRequestTiming(clientRes.__requestTiming, 'firstClientByte');
    }
    const result = originalEnd.apply(this, arguments);

    try {
      const auditData = clientRes.__auditData;
      if (auditData) {
        auditData.elapsed = Date.now() - auditData.startTime;
        auditData.statusCode = clientRes.statusCode || 200;
        auditData.timings = snapshotRequestTiming(clientRes.__requestTiming);

        if (isStream && captureContent) {
          auditData.response.content = sseContent;
          auditData.response.truncated = auditTextTruncated;
          const toolCalls = [];
          for (const [idx, tc] of sseToolCallsMap.entries()) {
            let parsedArgs = tc.args;
            try {
              parsedArgs = JSON.parse(tc.args);
            } catch (e) {}
            toolCalls.push({
              id: tc.id || `tc-${idx}`,
              name: tc.name || '',
              args: parsedArgs,
              truncated: tc.truncated === true,
            });
          }
          auditData.response.tool_calls = toolCalls;
        } else {
          auditData.response.truncated = responseTruncated;
          try {
            const resBodyStr = Buffer.concat(responseBuffer).toString('utf8');
            if (captureContent) {
              auditData.response.body = resBodyStr;
              auditData.response.bodyTruncated = responseTruncated;
            }
            const resJson = JSON.parse(resBodyStr);
            auditProviderUsage = mergeUsage(
              auditProviderUsage,
              extractUsageFromJsonPayload(resJson)
            );

            if (
              captureContent &&
              resJson.choices &&
              resJson.choices[0] &&
              resJson.choices[0].message
            ) {
              const msg = resJson.choices[0].message;
              const appended = appendText('', msg.content || '');
              auditData.response.content = appended.value;
              if (appended.truncated) auditData.response.truncated = true;
              if (Array.isArray(msg.tool_calls)) {
                auditData.response.tool_calls = msg.tool_calls.map((tc) => {
                  let args = tc.function && tc.function.arguments;
                  try {
                    if (typeof args === 'string') args = JSON.parse(args);
                  } catch (e) {}
                  return { id: tc.id, name: tc.function && tc.function.name, args };
                });
              }
            } else if (captureContent && Array.isArray(resJson.content)) {
              resJson.content.forEach((block) => {
                if (block.type === 'text') {
                  const appended = appendText(auditData.response.content, block.text || '');
                  auditData.response.content = appended.value;
                  if (appended.truncated) auditData.response.truncated = true;
                } else if (block.type === 'tool_use') {
                  auditData.response.tool_calls.push({
                    id: block.id,
                    name: block.name,
                    args: block.input,
                  });
                }
              });
            }
          } catch (e) {}
        }

        auditData.usage = auditProviderUsage || estimateUsageForRecord(auditData);
        logUsage({
          profileId: auditData.profileId,
          model: auditData.rewriteModel || auditData.originalModel,
          inputTokens: auditData.usage.input_tokens || 0,
          outputTokens: auditData.usage.output_tokens || 0,
        });
        const costModel = auditData.rewriteModel || auditData.originalModel || '';
        auditData.cost = estimateCost(auditData.usage, costModel, config);
        appendAuditRecord(auditData);
      }
    } catch (e) {
      log.error('!! failed to write conversation audit logs:', e);
    }

    return result;
  };
}

function extractPromptFromBuffer(buffer, protocol) {
  let system = '';
  const messages = [];
  try {
    const raw = JSON.parse(buffer.toString('utf8'));

    if (protocol === 'gemini') {
      if (raw.systemInstruction && Array.isArray(raw.systemInstruction.parts)) {
        system = raw.systemInstruction.parts.map((p) => p.text || '').join('\n');
      }
      if (Array.isArray(raw.contents)) {
        raw.contents.forEach((item) => {
          const role = item.role === 'model' ? 'assistant' : 'user';
          let content = '';
          const toolUses = [];
          const toolResults = [];
          if (Array.isArray(item.parts)) {
            item.parts.forEach((p) => {
              if (p.text) content += p.text;
              if (p.functionCall) {
                toolUses.push({
                  id: p.functionCall.name,
                  name: p.functionCall.name,
                  args: p.functionCall.args,
                });
              }
              if (p.functionResponse) {
                toolResults.push({
                  name: p.functionResponse.name,
                  content: p.functionResponse.response,
                });
              }
            });
          }
          messages.push({ role, content, toolUses, toolResults });
        });
      }
    } else {
      if (raw.system) {
        if (typeof raw.system === 'string') system = raw.system;
        else if (Array.isArray(raw.system)) {
          system = raw.system.map((x) => x.text || stringifyWithoutInlineMedia(x)).join('\n');
        }
      }

      const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
      rawMessages.forEach((msg) => {
        const role = msg.role;
        let content = '';
        const toolUses = [];
        const toolResults = [];

        if (role === 'system') {
          system =
            typeof msg.content === 'string'
              ? msg.content
              : stringifyWithoutInlineMedia(msg.content);
          return;
        }

        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          msg.content.forEach((block) => {
            if (block.type === 'text') {
              content += block.text || '';
            } else if (block.type === 'image_url') {
              content += '[图片]';
            } else if (block.type === 'tool_use' || block.type === 'tool_call') {
              const id = block.id || (block.function && block.function.name);
              const name = block.name || (block.function && block.function.name);
              const args = block.input || (block.function && block.function.arguments);
              toolUses.push({ id, name, args });
            } else if (block.type === 'tool_result') {
              toolResults.push({
                id: block.tool_use_id,
                content: block.content,
              });
            }
          });
        }

        if (Array.isArray(msg.tool_calls)) {
          msg.tool_calls.forEach((tc) => {
            const id = tc.id;
            const name = tc.function && tc.function.name;
            let args = tc.function && tc.function.arguments;
            try {
              if (typeof args === 'string') args = JSON.parse(args);
            } catch (e) {}
            toolUses.push({ id, name, args });
          });
        }

        if (role === 'tool') {
          toolResults.push({
            id: msg.tool_call_id,
            content: msg.content,
          });
        }

        messages.push({ role, content, toolUses, toolResults });
      });
    }
  } catch (err) {}

  return { system, messages };
}

module.exports = {
  bufferFromResponseChunk,
  sendRequestTooLarge,
  appendAuditText,
  hasVisibleTextSsePayload,
  createConversationAuditData,
  installConversationAuditResponseCapture,
  populateAuditDataFromPrepared,
  extractPromptFromBuffer,
};
