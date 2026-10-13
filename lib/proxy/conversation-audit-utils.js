const { hasResponseBytes, markRequestTiming, snapshotRequestTiming } = require('./request-timing');
const { captureAuditErrorSummary } = require('./audit-error-summary');
const { stringifyWithoutInlineMedia } = require('./inline-media');
const { StringDecoder } = require('string_decoder');

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

function responseOutputItemAuditKeys(event, fallbackIndex) {
  const keys = [];
  const addKey = (prefix, value) => {
    if (value == null) return;
    const key = `${prefix}:${String(value)}`;
    if (!keys.includes(key)) keys.push(key);
  };
  addKey('item', event && event.item_id);
  const item = event && event.item;
  if (item && (item.call_id != null || item.id != null)) {
    addKey('item', item.call_id);
    addKey('item', item.id);
  }
  addKey('index', event && event.output_index);
  addKey('index', event && event.item_index);
  if (keys.length === 0) keys.push(`index:${String(fallbackIndex)}`);
  return keys;
}

function customToolAuditArgsString(input) {
  if (typeof input === 'string') return input ? JSON.stringify({ input }) : '';
  if (input && typeof input === 'object' && !Array.isArray(input)) return JSON.stringify(input);
  return JSON.stringify({ input: input == null ? '' : String(input) });
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
    contextDiagnostics: null,
    contextDiagnosticsMissingReason: '',
    response: { role: 'assistant', content: '', tool_calls: [] },
  };
  Object.defineProperty(auditData, '__captureContent', {
    value: captureContent === true,
    enumerable: false,
  });
  return auditData;
}

function captureAuditBody(auditData, buffer, encoding, captureRequestBody) {
  const empty = { body: '', truncated: false };
  if (
    !auditData ||
    auditData.__captureContent !== true ||
    !Buffer.isBuffer(buffer) ||
    typeof captureRequestBody !== 'function'
  ) {
    return empty;
  }
  try {
    const captured = captureRequestBody(buffer, encoding);
    if (!captured || typeof captured.body !== 'string') return empty;
    return {
      body: captured.body,
      truncated: captured.truncated === true,
      ...(Number.isSafeInteger(captured.originalLength) && captured.originalLength >= 0
        ? { originalLength: captured.originalLength }
        : {}),
    };
  } catch (_error) {
    // Audit capture must never expose content or interrupt a proxied request.
    return empty;
  }
}

function sanitizeContextDiagnostics(value) {
  if (!value || typeof value !== 'object') return null;
  const contextBudget =
    value.contextBudget && typeof value.contextBudget === 'object' ? value.contextBudget : null;
  const providerContext =
    value.providerContext && typeof value.providerContext === 'object'
      ? value.providerContext
      : null;
  if (!contextBudget && !providerContext) return null;
  const safeEnum = (input) => {
    const normalized = String(input || '')
      .trim()
      .toLowerCase();
    return /^[a-z][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : 'unknown';
  };
  const cache =
    contextBudget && contextBudget.contextCache && typeof contextBudget.contextCache === 'object'
      ? contextBudget.contextCache
      : null;
  const providerCache =
    value.providerCache && typeof value.providerCache === 'object' ? value.providerCache : null;
  return {
    contextBudget: contextBudget
      ? {
          enabled: contextBudget.enabled === true,
          policy: String(contextBudget.policy || ''),
          source: String(contextBudget.source || ''),
          inputBudgetTokens: Number(contextBudget.inputBudgetTokens || 0),
          estimatedBeforeTokens: Number(contextBudget.estimatedBeforeTokens || 0),
          estimatedInputTokens: Number(contextBudget.estimatedInputTokens || 0),
          fixedInputTokens: Number(contextBudget.fixedInputTokens || 0),
          overBudgetTokens: Number(contextBudget.overBudgetTokens || 0),
          optimizedCount: Number(contextBudget.optimizedCount || 0),
          droppedCount: Number(contextBudget.droppedCount || 0),
          savedChars: Number(contextBudget.savedChars || 0),
          compactionTriggered: contextBudget.compactionTriggered === true,
          compactionApplied: contextBudget.compactionApplied === true,
          compactionTargetTokens: Number(contextBudget.compactionTargetTokens || 0),
          compactionTargetRatio: Number(contextBudget.compactionTargetRatio || 0),
          minimumSavingsTokens: Number(contextBudget.minimumSavingsTokens || 0),
          batchSavingsTokens: Number(contextBudget.batchSavingsTokens || 0),
          stablePrefixPreserved: contextBudget.stablePrefixPreserved !== false,
          contextCache: cache
            ? {
                candidate: cache.candidate === true,
                candidateMinTokens: Number(cache.candidateMinTokens || 0),
                stablePrefixHash: String(cache.stablePrefixHash || ''),
                stablePrefixMessageCount: Number(cache.stablePrefixMessageCount || 0),
                stablePrefixTokens: Number(cache.stablePrefixTokens || 0),
                fixedPrefixTokens: Number(cache.fixedPrefixTokens || 0),
                dynamicTokens: Number(cache.dynamicTokens || 0),
              }
            : null,
        }
      : null,
    providerContext: providerContext
      ? {
          provider: safeEnum(providerContext.provider),
          applied: providerContext.applied === true,
          explicit: providerContext.explicit === true,
          reason: safeEnum(providerContext.reason),
        }
      : null,
    providerCache: providerCache
      ? {
          enabled: providerCache.enabled === true,
          policy: String(providerCache.policy || ''),
          provider: String(providerCache.provider || ''),
          strategy: String(providerCache.strategy || ''),
          candidate: providerCache.candidate === true,
          applied: providerCache.applied === true,
          reason: String(providerCache.reason || ''),
          stablePrefixHash: String(providerCache.stablePrefixHash || ''),
          stablePrefixTokens: Number(providerCache.stablePrefixTokens || 0),
        }
      : null,
    repairedOrphanToolResults: Number(value.repairedOrphanToolResults || 0),
  };
}

function contextDiagnosticsUsageSummary(value) {
  const diagnostics = sanitizeContextDiagnostics(value);
  if (!diagnostics) {
    return {
      contextDiagnostics: false,
      contextDroppedCount: 0,
      contextOptimizedCount: 0,
      contextOverBudgetTokens: 0,
      contextStablePrefixCandidate: false,
      providerCacheCandidate: false,
      providerCacheApplied: false,
      providerContextApplied: false,
      providerContextExplicit: false,
    };
  }
  const contextBudget = diagnostics.contextBudget || {};
  const contextCache = contextBudget.contextCache || {};
  const providerCache = diagnostics.providerCache || {};
  const providerContext = diagnostics.providerContext || {};
  return {
    contextDiagnostics: true,
    contextDroppedCount: Number(contextBudget.droppedCount || 0),
    contextOptimizedCount: Number(contextBudget.optimizedCount || 0),
    contextOverBudgetTokens: Number(contextBudget.overBudgetTokens || 0),
    contextStablePrefixCandidate: contextCache.candidate === true,
    providerCacheCandidate: providerCache.candidate === true,
    providerCacheApplied: providerCache.applied === true,
    providerContextApplied: providerContext.applied === true,
    providerContextExplicit: providerContext.explicit === true,
  };
}

function sanitizeDiagnosticsMissingReason(value) {
  const reason = String(value || '').trim();
  if (!reason) return '';
  return /^[a-z][a-z0-9_-]{0,63}$/.test(reason) ? reason : 'unknown';
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

const SSE_FIELD_MARKERS = ['data:', 'event:', 'id:', 'retry:', ':'];
const MAX_STREAM_PROBE_BYTES = 64;

// A response whose body is SSE but which never declared text/event-stream (chunked
// Responses upstreams) starts with an event:/data: line or a leading ':' comment
// heartbeat. One TCP chunk can end mid-marker, so 'pending' means the accumulated
// prefix could still become a marker and the probe must continue.
function classifyUndeclaredBodyPrefix(buffer) {
  const head = buffer
    .subarray(0, MAX_STREAM_PROBE_BYTES)
    .toString('utf8')
    .replace(/^[\r\n\t ]+/, '');
  if (!head) return 'pending';
  if (SSE_FIELD_MARKERS.some((marker) => head.startsWith(marker))) return 'sse';
  if (SSE_FIELD_MARKERS.some((marker) => marker.startsWith(head))) return 'pending';
  return 'other';
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
    // The client asked for a stream. Official Codex/Responses upstreams answer with
    // transfer-encoding: chunked and no content-type at all, so a content-type-only
    // check classified the response as non-stream and never parsed the SSE usage
    // frame. Callers pass the client's own accept intent; the first chunk still has
    // to look like SSE for the mode to stick.
    expectStream = false,
  } = options;
  const responseBuffer = [];
  let responseBytes = 0;
  let responseTruncated = false;
  let sseContent = '';
  let auditTextTruncated = false;
  let auditProviderUsage = null;
  const sseToolCallsMap = new Map();
  const sseToolCallAliases = new Map();
  let isStream = false;
  // SSE frames are not guaranteed to arrive whole: the proxy forwards arbitrary TCP
  // chunks, so a single data: line carrying response.completed is routinely split
  // mid-JSON. Parsing each chunk in isolation threw and silently dropped provider
  // usage, which is why official Responses requests kept falling back to estimates.
  // Hold the trailing partial line until its newline arrives.
  let sseLineBuffer = '';
  const sseLineDecoder = new StringDecoder('utf8');
  const MAX_SSE_LINE_BUFFER_CHARS = Math.max(maxCaptureBytes, 4096);
  let streamModeResolved = false;
  let streamProbeBuffer = Buffer.alloc(0);

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
      if (!streamModeResolved) {
        // Undeclared stream: a chunked upstream that omitted content-type. Accumulate
        // just enough of the head to classify it, then choose SSE vs JSON once.
        streamProbeBuffer = Buffer.concat([streamProbeBuffer, chunkBuffer]);
        const classification = classifyUndeclaredBodyPrefix(streamProbeBuffer);
        if (classification === 'pending' && streamProbeBuffer.length < MAX_STREAM_PROBE_BYTES) {
          return;
        }
        streamModeResolved = true;
        const probed = streamProbeBuffer;
        streamProbeBuffer = Buffer.alloc(0);
        if (expectStream && classification === 'sse') {
          isStream = true;
          sseLineBuffer += sseLineDecoder.write(probed);
          processCompleteAuditSseLines();
          return;
        }
        return bufferAuditNonStreamBody(probed);
      }
      return bufferAuditNonStreamBody(chunkBuffer);
    }

    // Decode incrementally (a multi-byte UTF-8 sequence can also straddle chunks) and
    // only process lines that are terminated; the trailing partial line waits here.
    sseLineBuffer += sseLineDecoder.write(bufferFromResponseChunk(chunk, encoding));
    processCompleteAuditSseLines();
  };

  function bufferAuditNonStreamBody(chunkBuffer) {
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
  }

  function processCompleteAuditSseLines() {
    if (sseLineBuffer.length > MAX_SSE_LINE_BUFFER_CHARS) {
      sseLineBuffer = sseLineBuffer.slice(-MAX_SSE_LINE_BUFFER_CHARS);
    }
    const lastNewline = sseLineBuffer.lastIndexOf('\n');
    if (lastNewline < 0) return;
    const completeLines = sseLineBuffer.slice(0, lastNewline);
    sseLineBuffer = sseLineBuffer.slice(lastNewline + 1);
    processAuditSseLines(completeLines);
  }

  function auditToolCallKey(event, fallbackIndex) {
    const keys = responseOutputItemAuditKeys(event, fallbackIndex);
    for (const key of keys) {
      const canonical = sseToolCallAliases.get(key) || key;
      if (sseToolCallsMap.has(canonical)) return canonical;
    }
    const canonical = keys[0];
    for (const key of keys) sseToolCallAliases.set(key, canonical);
    return canonical;
  }

  const processAuditSseLines = function (completeLines) {
    completeLines.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const dataStr = trimmed.substring(5).trim();
      if (dataStr === '[DONE]') return;
      try {
        const needsFirstVisibleText =
          clientRes.__requestTiming && clientRes.__requestTiming.firstVisibleTextAt == null;
        const mayContainUsage = dataStr.includes('"usage"');
        const mayContainError = dataStr.includes('"error"');
        const mayContainText = /"(?:text|content|delta)"/.test(dataStr);
        if (
          !captureContent &&
          !mayContainUsage &&
          !mayContainError &&
          !(needsFirstVisibleText && mayContainText)
        ) {
          return;
        }
        const data = JSON.parse(dataStr);
        captureAuditErrorSummary(clientRes.__auditData, data);
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
        } else if (
          (data.type === 'response.output_item.added' ||
            data.type === 'response.output_item.done') &&
          data.item
        ) {
          const item = data.item;
          if (
            captureContent &&
            (item.type === 'function_call' ||
              item.type === 'tool_call' ||
              item.type === 'custom_tool_call')
          ) {
            const key = auditToolCallKey(data, sseToolCallsMap.size);
            const existing = sseToolCallsMap.get(key) || { args: '' };
            existing.id = item.call_id || item.id || existing.id || `call_${sseToolCallsMap.size}`;
            existing.name = item.name || existing.name || '';
            const itemArgs =
              item.type === 'custom_tool_call'
                ? customToolAuditArgsString(item.input)
                : typeof item.arguments === 'string'
                  ? item.arguments
                  : item.arguments && typeof item.arguments === 'object'
                    ? JSON.stringify(item.arguments)
                    : '';
            if (itemArgs && !existing.args) existing.args = itemArgs;
            sseToolCallsMap.set(key, existing);
            for (const alias of responseOutputItemAuditKeys(data, sseToolCallsMap.size)) {
              sseToolCallAliases.set(alias, key);
            }
          }
        } else if (data.type === 'response.function_call_arguments.delta' && data.delta) {
          if (captureContent) {
            const key = auditToolCallKey(data, 0);
            const existing = sseToolCallsMap.get(key) || { args: '' };
            const appended = appendText(existing.args, data.delta);
            existing.args = appended.value;
            if (appended.truncated) {
              existing.truncated = true;
              auditTextTruncated = true;
            }
            sseToolCallsMap.set(key, existing);
          }
        } else if (
          data.type === 'response.custom_tool_call_input.delta' &&
          typeof data.delta === 'string'
        ) {
          if (captureContent) {
            const key = auditToolCallKey(data, 0);
            const existing = sseToolCallsMap.get(key) || { args: '' };
            const appended = appendText(existing.args, data.delta);
            existing.args = appended.value;
            if (appended.truncated) {
              existing.truncated = true;
              auditTextTruncated = true;
            }
            sseToolCallsMap.set(key, existing);
          }
        } else if (
          data.type === 'response.custom_tool_call_input.done' &&
          typeof data.input === 'string'
        ) {
          if (captureContent) {
            const key = auditToolCallKey(data, 0);
            const existing = sseToolCallsMap.get(key) || { args: '' };
            if (!existing.args) existing.args = data.input;
            sseToolCallsMap.set(key, existing);
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
    // Flush any final line the upstream sent without a trailing newline, plus a
    // multi-byte character split across the last chunks, before the audit record is
    // built below.
    if (isStream) {
      sseLineBuffer += sseLineDecoder.end();
      if (sseLineBuffer) {
        const pending = sseLineBuffer;
        sseLineBuffer = '';
        processAuditSseLines(pending);
      }
    } else if (streamProbeBuffer.length) {
      // Body was shorter than the probe window and never resolved; treat it as JSON.
      const pendingProbe = streamProbeBuffer;
      streamProbeBuffer = Buffer.alloc(0);
      streamModeResolved = true;
      if (expectStream && classifyUndeclaredBodyPrefix(pendingProbe) === 'sse') {
        isStream = true;
        processAuditSseLines(sseLineDecoder.write(pendingProbe));
      } else {
        bufferAuditNonStreamBody(pendingProbe);
      }
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
        // A proxy-side upstream failure owns the outcome: the client may have already
        // received 200 headers before the body timed out, so statusCode alone would
        // record a success that contradicts request_end in proxy-events.jsonl.
        applyAuditUpstreamFailure(auditData);
        auditData.timings = snapshotRequestTiming(clientRes.__requestTiming);
        auditData.contextDiagnostics = sanitizeContextDiagnostics(
          clientRes.__diagnostics && clientRes.__diagnostics.hpmDiagnostics
        );
        auditData.contextDiagnosticsMissingReason = auditData.contextDiagnostics
          ? ''
          : sanitizeDiagnosticsMissingReason(
              clientRes.__diagnostics && clientRes.__diagnostics.contextDiagnosticsMissingReason
            );

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
            captureAuditErrorSummary(auditData, resJson);
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
            } else if (captureContent && Array.isArray(resJson.output)) {
              resJson.output.forEach((item, index) => {
                if (!item || typeof item !== 'object') return;
                if (item.type === 'message' && Array.isArray(item.content)) {
                  item.content.forEach((part) => {
                    if (
                      part &&
                      typeof part === 'object' &&
                      (part.type === 'output_text' || part.type === 'text') &&
                      typeof part.text === 'string'
                    ) {
                      const appended = appendText(auditData.response.content, part.text);
                      auditData.response.content = appended.value;
                      if (appended.truncated) auditData.response.truncated = true;
                    }
                  });
                  return;
                }
                if (
                  item.type !== 'function_call' &&
                  item.type !== 'tool_call' &&
                  item.type !== 'custom_tool_call'
                ) {
                  return;
                }
                const id = item.call_id || item.id || `call_${index}`;
                const name = item.name || '';
                let args =
                  item.type === 'custom_tool_call'
                    ? customToolAuditArgsString(item.input)
                    : typeof item.arguments === 'string'
                      ? item.arguments
                      : item.arguments && typeof item.arguments === 'object'
                        ? JSON.stringify(item.arguments)
                        : '';
                try {
                  if (typeof args === 'string') args = JSON.parse(args);
                } catch (e) {}
                auditData.response.tool_calls.push({ id, name, args });
              });
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
        const usageLogRecord = {
          profileId: auditData.profileId,
          model: auditData.rewriteModel || auditData.originalModel,
          // auditData.usage is the camelCase shape produced by normalizeUsage()/
          // estimateUsageForRecord(); reading snake_case here always yielded 0.
          inputTokens: auditData.usage.inputTokens || 0,
          outputTokens: auditData.usage.outputTokens || 0,
          cachedInputTokens: auditData.usage.cachedInputTokens || 0,
        };
        if (auditData.contextDiagnostics || auditData.contextDiagnosticsMissingReason) {
          usageLogRecord.context = contextDiagnosticsUsageSummary(auditData.contextDiagnostics);
          usageLogRecord.contextDiagnosticsMissingReason =
            auditData.contextDiagnosticsMissingReason;
        }
        logUsage(usageLogRecord);
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

/**
 * Record a proxy-side upstream failure on the audit data attached to the response.
 *
 * The audit writer only samples clientRes.statusCode inside clientRes.end(). When the
 * upstream already sent 200 headers and the body then timed out, that value stays 200,
 * so the audit record claimed success while the same request produced a request_end
 * 502 in proxy-events.jsonl. One request therefore had two contradictory outcomes
 * depending on which log an operator read.
 *
 * The first failure wins; a later failure or a success must not overwrite it. Returns
 * true only when this call recorded the failure.
 */
function recordAuditUpstreamFailure(clientRes, detail = {}) {
  const auditData = clientRes && clientRes.__auditData;
  if (!auditData) return false;
  if (auditData.__upstreamFailure) return false;
  const statusCode = Number(detail.statusCode);
  const failure = {
    statusCode: Number.isFinite(statusCode) && statusCode > 0 ? statusCode : 502,
    failureKind: detail.failureKind || 'upstream_error',
    errorType: detail.errorType || 'proxy_error',
    type: detail.type || 'proxy_error',
    message: detail.error ? String(detail.error) : 'Upstream request failed',
  };
  Object.defineProperty(auditData, '__upstreamFailure', {
    value: failure,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return true;
}

/**
 * Apply a recorded upstream failure to a finished audit record. Called immediately
 * before the record is written so the audit log agrees with the events log for the
 * same request. Returns true when a failure was applied.
 */
function applyAuditUpstreamFailure(auditData) {
  if (!auditData || !auditData.__upstreamFailure) return false;
  const failure = auditData.__upstreamFailure;
  auditData.statusCode = failure.statusCode;
  auditData.failureKind = failure.failureKind;
  auditData.errorType = failure.errorType;
  auditData.error = failure.message;
  return true;
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
  captureAuditBody,
  installConversationAuditResponseCapture,
  recordAuditUpstreamFailure,
  applyAuditUpstreamFailure,
  sanitizeContextDiagnostics,
  contextDiagnosticsUsageSummary,
  sanitizeDiagnosticsMissingReason,
  populateAuditDataFromPrepared,
  extractPromptFromBuffer,
};
