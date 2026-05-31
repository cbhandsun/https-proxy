const fs = require('fs');
const path = require('path');
const { DATA_DIR, DEFAULT_CONFIG } = require('./config');

const GEMINI_SAMPLE_FILE = path.join(DATA_DIR, 'gemini-tool-samples.jsonl');
const TOOL_AUDIT_FILE = path.join(DATA_DIR, 'tool-call-audit.jsonl');
const RESPONSE_SAMPLE_FILE = path.join(DATA_DIR, 'response-samples.jsonl');
const DIAGNOSTICS_OUTBOUND_SSE_FILE = path.join(DATA_DIR, 'diagnostics-outbound-sse.jsonl');
const DIAGNOSTICS_REQUEST_TOOLS_FILE = path.join(DATA_DIR, 'diagnostics-request-tools.jsonl');
const PROXY_EVENTS_FILE = path.join(DATA_DIR, 'proxy-events.jsonl');

function createDiagnostics(deps) {
  const configSource = deps.config || {};
  const normalizeClaudeContent = deps.normalizeClaudeContent;
  const sanitizeGeminiToolCall = deps.sanitizeGeminiToolCall;

  function getDiagnosticsConfig() {
    const user = configSource.diagnostics || {};
    const defaults = DEFAULT_CONFIG.diagnostics;
    return {
      enabled: user.enabled === true,
      captureGemini: user.captureGemini !== false,
      captureOpenAI: user.captureOpenAI === true,
      captureOutboundSse: user.captureOutboundSse !== false,
      captureRequestToolResults: user.captureRequestToolResults !== false,
      maxFileBytes: Number(user.maxFileBytes || defaults.maxFileBytes),
      maxTextBytes: Number(user.maxTextBytes || defaults.maxTextBytes),
    };
  }

  function shouldCaptureDiagnostics(meta) {
    const config = getDiagnosticsConfig();
    if (!config.enabled) return false;
    const protocol = meta && meta.protocol;
    if (protocol === 'gemini') return config.captureGemini;
    if (protocol === 'openai') return config.captureOpenAI;
    return true;
  }

  function redactDiagnosticsValue(value) {
    if (Array.isArray(value)) return value.map(redactDiagnosticsValue);
    if (!value || typeof value !== 'object') return value;
    const redacted = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(apiKey|authorization|x-api-key|api-key|x-goog-api-key)$/i.test(key)) {
        redacted[key] = '[redacted]';
      } else {
        redacted[key] = redactDiagnosticsValue(item);
      }
    }
    return redacted;
  }

  function truncateDiagnosticsText(value, maxTextBytes) {
    if (typeof value !== 'string') return value;
    const max = Math.max(100, Number(maxTextBytes || 12000));
    if (Buffer.byteLength(value, 'utf8') <= max) return value;
    return value.slice(0, max) + '...[truncated]';
  }

  function compactDiagnosticsValue(value, maxTextBytes) {
    if (Array.isArray(value)) return value.map((item) => compactDiagnosticsValue(item, maxTextBytes));
    if (!value || typeof value !== 'object') return truncateDiagnosticsText(value, maxTextBytes);
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = compactDiagnosticsValue(item, maxTextBytes);
    return result;
  }

  function writeJsonlBounded(filePath, entry, maxFileBytes) {
    const limit = Math.max(1024, Number(maxFileBytes || DEFAULT_CONFIG.diagnostics.maxFileBytes));
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > limit) {
        const rotated = filePath + '.1';
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        try {
          fs.renameSync(filePath, rotated);
        } catch (err) {
          fs.copyFileSync(filePath, rotated);
          fs.writeFileSync(filePath, '');
        }
      }
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
      return true;
    } catch (err) {
      console.warn('!! failed to write diagnostics ' + path.basename(filePath) + ': ' + err.message);
      return false;
    }
  }

  function diagnosticsMetaFromResponse(clientRes) {
    return clientRes && clientRes.__diagnostics ? clientRes.__diagnostics : {};
  }

  function sampleDiagnostics(filePath, kind, payload, meta) {
    const config = getDiagnosticsConfig();
    const mergedMeta = meta || {};
    if (!config.enabled || !shouldCaptureDiagnostics(mergedMeta)) return false;
    const entry = {
      time: new Date().toISOString(),
      kind,
      meta: redactDiagnosticsValue(compactDiagnosticsValue(mergedMeta, config.maxTextBytes)),
      payload: redactDiagnosticsValue(compactDiagnosticsValue(payload || {}, config.maxTextBytes)),
    };
    return writeJsonlBounded(filePath, entry, config.maxFileBytes);
  }

  function extractDiagnosticsSsePayload(event, data) {
    if (!data || typeof data !== 'object') return null;
    if (event === 'content_block_delta') {
      const delta = data.delta || {};
      if (delta.type !== 'input_json_delta' && !delta.input_json_delta) return null;
      const partial = delta.partial_json != null ? delta.partial_json : (delta.input_json_delta && delta.input_json_delta.partial_json);
      return { event, index: data.index, deltaType: delta.type || 'input_json_delta', partial_json: partial || '', partialBytes: Buffer.byteLength(String(partial || ''), 'utf8') };
    }
    if (!['message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop'].includes(event)) return null;
    const block = data.content_block || {};
    return {
      event,
      index: data.index,
      messageId: data.message && data.message.id,
      model: data.message && data.message.model,
      blockType: block.type,
      toolUseId: block.type === 'tool_use' ? block.id : undefined,
      toolName: block.type === 'tool_use' ? block.name : undefined,
      stopReason: data.delta && data.delta.stop_reason,
    };
  }

  function sampleOutboundSse(clientRes, event, data) {
    const config = getDiagnosticsConfig();
    if (!config.captureOutboundSse) return;
    const payload = extractDiagnosticsSsePayload(event, data);
    if (!payload) return;
    sampleDiagnostics(DIAGNOSTICS_OUTBOUND_SSE_FILE, 'outbound_sse', payload, diagnosticsMetaFromResponse(clientRes));
  }

  function inputKeys(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  }

  function contentLengthForDiagnostics(content) {
    if (typeof content === 'string') return content.length;
    try { return JSON.stringify(content || '').length; } catch (err) { return 0; }
  }

  function summarizeClaudeToolHistory(body) {
    const toolUses = [];
    const toolResults = [];
    const ids = new Set();
    const duplicateToolUseIds = [];
    for (const message of Array.isArray(body && body.messages) ? body.messages : []) {
      for (const block of normalizeClaudeContent(message.content)) {
        if (block && block.type === 'tool_use') {
          if (ids.has(block.id)) duplicateToolUseIds.push(block.id);
          ids.add(block.id);
          toolUses.push({ id: block.id, name: block.name, inputKeys: inputKeys(block.input) });
        }
        if (block && block.type === 'tool_result') {
          toolResults.push({ toolUseId: block.tool_use_id, contentLength: contentLengthForDiagnostics(block.content), isError: block.is_error === true, hasMatchingToolUse: ids.has(block.tool_use_id) });
        }
      }
    }
    return { messageCount: Array.isArray(body && body.messages) ? body.messages.length : 0, toolUses, toolResults, duplicateToolUseIds };
  }

  function sampleRequestToolResults(prepared, protocol, upstreamPath) {
    const config = getDiagnosticsConfig();
    if (!config.captureRequestToolResults) return;
    const meta = { protocol, route: prepared.model, target: prepared.rewriteTo, upstreamPath, profile: prepared.profile && prepared.profile.id };
    if (!shouldCaptureDiagnostics(meta)) return;
    try {
      const parsed = JSON.parse(prepared.buffer.toString('utf8'));
      const summary = summarizeClaudeToolHistory(parsed);
      if (summary.toolUses.length === 0 && summary.toolResults.length === 0) return;
      sampleDiagnostics(DIAGNOSTICS_REQUEST_TOOLS_FILE, 'request_tool_history', { model: parsed.model, ...summary }, meta);
    } catch (err) {}
  }

  function sampleGeminiToolEvent(reason, payload) {
    try {
      fs.appendFileSync(GEMINI_SAMPLE_FILE, JSON.stringify({ time: new Date().toISOString(), reason, payload }) + '\n');
    } catch (err) {
      console.warn('!! failed to write gemini tool sample: ' + err.message);
    }
  }

  function logProxyEvent(kind, payload) {
    const entry = {
      time: new Date().toISOString(),
      kind,
      ...(payload || {}),
    };
    writeJsonlBounded(PROXY_EVENTS_FILE, entry, 5 * 1024 * 1024);
  }

  function logRequestEnd(method, path, startTime, statusCode, extra) {
    const elapsed = Date.now() - startTime;
    logProxyEvent('request_end', {
      method,
      path,
      elapsed,
      statusCode,
      ...(extra || {})
    });
  }

  function auditToolCall(source, toolName, input, meta) {
    const sanitized = sanitizeGeminiToolCall({ name: toolName, args: input || {} }, []);
    if (!sanitized.error) return;
    const entry = {
      time: new Date().toISOString(),
      source,
      toolName,
      input: input || {},
      error: sanitized.error,
      meta: meta || {},
    };
    try {
      fs.appendFileSync(TOOL_AUDIT_FILE, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.warn('!! failed to write tool call audit: ' + err.message);
    }
    console.warn('!! invalid tool_use audit source=' + source + ' tool=' + toolName + ' error=' + sanitized.error);
  }

  function auditClaudeSseToolCalls(chunkText, meta) {
    const matches = String(chunkText || '').match(/data:\s*(\{[^\n]*"type"\s*:\s*"content_block_start"[^\n]*\})/g) || [];
    for (const match of matches) {
      const jsonText = match.replace(/^data:\s*/, '');
      try {
        const data = JSON.parse(jsonText);
        const block = data && data.content_block;
        if (block && block.type === 'tool_use') auditToolCall('openai-sse', block.name, block.input, meta);
      } catch (err) {}
    }
  }

  function sampleResponseChunk(source, chunkText, meta) {
    const text = String(chunkText || '');
    if (text.indexOf('tool_use') < 0 && text.indexOf('functionCall') < 0 && text.indexOf('input_json') < 0) return;
    const entry = {
      time: new Date().toISOString(),
      source,
      meta: meta || {},
      text: text.slice(0, 12000),
    };
    try {
      fs.appendFileSync(RESPONSE_SAMPLE_FILE, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.warn('!! failed to write response sample: ' + err.message);
    }
  }

  return {
    getDiagnosticsConfig,
    shouldCaptureDiagnostics,
    redactDiagnosticsValue,
    truncateDiagnosticsText,
    compactDiagnosticsValue,
    writeJsonlBounded,
    diagnosticsMetaFromResponse,
    sampleDiagnostics,
    extractDiagnosticsSsePayload,
    sampleOutboundSse,
    inputKeys,
    contentLengthForDiagnostics,
    summarizeClaudeToolHistory,
    sampleRequestToolResults,
    sampleGeminiToolEvent,
    logProxyEvent,
    logRequestEnd,
    auditToolCall,
    auditClaudeSseToolCalls,
    sampleResponseChunk,
  };
}

module.exports = {
  createDiagnostics,
  GEMINI_SAMPLE_FILE,
  TOOL_AUDIT_FILE,
  RESPONSE_SAMPLE_FILE,
  DIAGNOSTICS_OUTBOUND_SSE_FILE,
  DIAGNOSTICS_REQUEST_TOOLS_FILE,
  PROXY_EVENTS_FILE,
};
