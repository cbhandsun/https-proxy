'use strict';

const TERMINAL_FAILED = new Set(['FAILED', 'CANCELED']);

function writeResponsesSseEvent(clientRes, event, payload) {
  const nextPayload = { ...payload };
  if (
    nextPayload &&
    typeof nextPayload.type === 'string' &&
    nextPayload.type.startsWith('response.') &&
    nextPayload.sequence_number == null
  ) {
    const current =
      typeof clientRes.__tianxiResponsesSequenceNumber === 'number'
        ? clientRes.__tianxiResponsesSequenceNumber
        : 0;
    nextPayload.sequence_number = current;
    clientRes.__tianxiResponsesSequenceNumber = current + 1;
  }
  clientRes.write('event: ' + event + '\n');
  clientRes.write('data: ' + JSON.stringify(nextPayload) + '\n\n');
}

function safeJsonParse(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  if (text[0] !== '{' && text[0] !== '[') return value;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return value;
  }
}

function compactText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function safeJsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch (_err) {
    return 0;
  }
}

function firstOwnValue(sources, fields, fallback) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of fields) {
      if (Object.hasOwn(source, field)) return source[field];
    }
  }
  return fallback;
}

function firstOwnField(source, fields) {
  if (!source || typeof source !== 'object') return null;
  for (const field of fields) {
    if (Object.hasOwn(source, field)) return { field, value: source[field] };
  }
  return null;
}

function collectStructuredText(value, depth = 0) {
  if (value == null || depth > 5) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => collectStructuredText(item, depth + 1))
      .filter(Boolean)
      .join('');
  }
  if (typeof value !== 'object') return compactText(value);
  if (isResponsesToolHistoryItem(value)) return '';
  const direct = firstOwnField(value, [
    'content',
    'delta',
    'text',
    'message',
    'output',
    'answer',
    'result',
    'final',
    'display_text',
    'displayText',
    'plain_text',
    'markdown',
  ]);
  if (direct) return collectStructuredText(direct.value, depth + 1);
  for (const field of ['parts', 'segments', 'items', 'blocks', 'children']) {
    if (Array.isArray(value[field])) return collectStructuredText(value[field], depth + 1);
  }
  return compactText(value);
}

function isResponsesToolHistoryItem(value) {
  const type = typeof value?.type === 'string' ? value.type : '';
  return (
    type === 'function_call' ||
    type === 'function_call_output' ||
    type === 'custom_tool_call' ||
    type === 'custom_tool_call_output' ||
    type === 'tool_call' ||
    type === 'tool_call_output' ||
    type === 'call'
  );
}

function isTianxiReasoningMarker(data) {
  const markers = [
    data && data.content_type,
    data && data.content_stage,
    data && data.content_schema,
    data && data.stage,
    data && data.schema,
  ]
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
  return markers.some((value) =>
    ['reasoning', 'thought', 'thinking', 'analysis', 'summary'].includes(value)
  );
}

function isTianxiTextMarker(data) {
  const markers = [
    data && data.content_type,
    data && data.content_stage,
    data && data.content_schema,
    data && data.stage,
    data && data.schema,
  ]
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
  return markers.some((value) =>
    [
      'text',
      'plain_text',
      'markdown',
      'md',
      'message',
      'answer',
      'assistant',
      'output',
      'final',
      'result',
    ].includes(value)
  );
}

function hasTianxiOutputMarker(data) {
  return [
    data && data.content_type,
    data && data.content_stage,
    data && data.content_schema,
    data && data.stage,
    data && data.schema,
  ].some((value) => String(value || '').trim());
}

function extractTianxiText(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  if (isTianxiReasoningMarker(data)) return '';
  const markerlessFinal = !hasTianxiOutputMarker(data)
    ? firstOwnField(data, ['message', 'answer', 'result', 'final', 'display_text', 'displayText'])
    : null;
  if (!isTianxiTextMarker(data) && !markerlessFinal) return '';
  const field = firstOwnField(data, [
    'content',
    'delta',
    'text',
    'message',
    'output',
    'answer',
    'result',
    'final',
    'display_text',
    'displayText',
  ]);
  return field ? collectStructuredText(field.value) : '';
}

function isAmbiguousTianxiText(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  if (isTianxiReasoningMarker(data)) return false;
  const markers = [
    data.content_type,
    data.content_stage,
    data.content_schema,
    data.stage,
    data.schema,
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().toLowerCase());
  return (
    markers.length > 0 &&
    markers.every((value) => ['text', 'plain_text', 'markdown', 'md'].includes(value))
  );
}

function extractTianxiProgress(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  if (isTianxiReasoningMarker(data) || hasTianxiOutputMarker(data)) return '';
  const field = firstOwnField(data, ['content', 'delta', 'text']);
  return field ? collectStructuredText(field.value) : '';
}

function extractTianxiReasoning(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  const explicit = firstOwnValue(
    [data],
    [
      'reasoning_content',
      'reasoning_text',
      'reasoning',
      'thought_content',
      'thought_text',
      'thinking_content',
      'thinking_text',
      'analysis_content',
      'analysis_text',
      'thought',
      'thinking',
      'analysis',
    ],
    undefined
  );
  if (explicit !== undefined) return collectStructuredText(explicit);
  if (!isTianxiReasoningMarker(data)) return '';
  const field = firstOwnField(data, ['content', 'delta', 'text']);
  return field ? collectStructuredText(field.value) : '';
}

function tianxiOutputShape(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  const marker = [
    data.content_type,
    data.content_stage,
    data.content_schema,
    data.stage,
    data.schema,
  ].find((value) => typeof value === 'string' && value.trim());
  const normalized = String(marker || '')
    .trim()
    .toLowerCase();
  const knownMarkers = new Set([
    'text',
    'plain_text',
    'markdown',
    'md',
    'message',
    'answer',
    'assistant',
    'output',
    'final',
    'result',
    'reasoning',
    'thought',
    'thinking',
    'analysis',
    'summary',
  ]);
  const markerKind = normalized ? (knownMarkers.has(normalized) ? normalized : 'other') : 'none';
  const fields = [
    'content',
    'delta',
    'text',
    'message',
    'answer',
    'result',
    'final',
    'reasoning_content',
    'reasoning_text',
    'reasoning',
    'thought',
    'thinking',
    'analysis',
  ].filter((field) => Object.hasOwn(data, field));
  return { markerKind, fields: fields.length ? fields : ['none'] };
}

function normalizeToolArgs(value) {
  const parsed = safeJsonParse(value);
  if (parsed == null || parsed === '') return '{}';
  if (typeof parsed === 'string') return parsed;
  try {
    return JSON.stringify(parsed);
  } catch (_err) {
    return String(value || '{}');
  }
}

function tianxiActionFromFrame(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  const action = Array.isArray(data.actions) ? data.actions[0] || {} : data.action || data;
  const rawName =
    String(
      action.name || data.action_name || data.tool_name || data.name || data.type || ''
    ).trim() || 'tianxi_tool';
  const parameters =
    action.parameters ||
    action.args ||
    action.arguments ||
    data.parameters ||
    data.args ||
    data.tool_input ||
    data.toolInput ||
    {};
  return {
    id:
      String(action.id || data.action_id || data.actionId || data.id || frame.id || '').trim() ||
      'tianxi_action',
    name: safeTianxiToolName(rawName),
    arguments: normalizeToolArgs(action.jsonl || parameters),
  };
}

function tianxiToolOutputFromFrame(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  const action = Array.isArray(data.actions) ? data.actions[0] || {} : data.action || data;
  const raw = firstOwnValue([data, action], ['result', 'output', 'response'], data);
  return {
    call_id:
      String(action.id || data.action_id || data.actionId || data.id || frame.id || '').trim() ||
      'tianxi_action',
    output: compactText(raw),
  };
}

function safeTianxiToolName(value) {
  const name = String(value || '').trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) && !/^(sat|sk|sess|bearer)[_-]/i.test(name)
    ? name
    : 'tool';
}

function isInternalTianxiToolFrame(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  return (
    frame && frame.type === 'act_exec' && Object.prototype.hasOwnProperty.call(data, 'exec_mode')
  );
}

function isProviderNativeTianxiToolFrame(frame) {
  return isInternalTianxiToolFrame(frame) || (frame && frame.type === 'risk_exec');
}

function appendReasoningSummary(state, text) {
  if (!text) return;
  state.reasoning += text;
  let item = state.output.find((candidate) => candidate.type === 'reasoning');
  if (!item) {
    item = { id: 'rsn_' + state.id, type: 'reasoning', summary: [] };
    state.output.push(item);
  }
  item.summary = [{ type: 'summary_text', text: state.reasoning }];
}

function flushPendingTianxiText(state, asReasoning) {
  const text = state.pendingText || '';
  state.pendingText = '';
  if (!text) return;
  if (asReasoning) {
    appendReasoningSummary(state, text);
    return;
  }
  state.text += text;
  addMessageOutput(state).content[0].text = state.text;
}

function statusFromFrame(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  return String(data.status || frame.status || '').toUpperCase();
}

function nativeToolProgressText(state, name, phase = 'started') {
  const safeName = safeTianxiToolName(name);
  const count = (state.nativeToolCounts.get(safeName) || 0) + 1;
  state.nativeToolCounts.set(safeName, count);
  return `\n- Tianxi native tool ${safeName} (${count} ${count === 1 ? 'call' : 'calls'}) ${phase}.\n`;
}

function nativeActionFrames(frame) {
  const data = frame?.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.actions)) return [frame];
  return data.actions
    .slice(0, 128)
    .filter((action) => action && typeof action === 'object' && !Array.isArray(action))
    .map((action) => ({ ...frame, data: { ...data, actions: [action] } }));
}

function startNativeToolProgress(state, frame) {
  let text = '';
  for (const actionFrame of nativeActionFrames(frame)) {
    const action = tianxiActionFromFrame(actionFrame);
    if (state.nativeToolSeenIds.has(action.id)) continue;
    state.nativeToolSeenIds.add(action.id);
    text += nativeToolProgressText(state, action.name);
    state.internalToolCalls.set(action.id, {
      name: action.name,
      count: state.nativeToolCounts.get(action.name),
    });
  }
  return text;
}

function finishNativeToolProgress(state, frame) {
  let text = '';
  for (const actionFrame of nativeActionFrames(frame)) {
    const output = tianxiToolOutputFromFrame(actionFrame);
    const call = state.internalToolCalls.get(output.call_id);
    if (!call) continue;
    state.internalToolCalls.delete(output.call_id);
    const data = actionFrame.data || {};
    const action = Array.isArray(data.actions) ? data.actions[0] : data.action || data;
    const status = String(action.status || data.status || '').toUpperCase();
    const failed =
      ['FAILED', 'ERROR', 'CANCELED'].includes(status) ||
      action.success === false ||
      data.success === false;
    const phase = status === 'CANCELED' ? 'canceled' : failed ? 'failed' : 'returned';
    text += `\n- Tianxi native tool ${call.name} (${call.count} ${call.count === 1 ? 'call' : 'calls'}) ${phase}.\n`;
  }
  return text;
}

function tianxiStatusProgressText(frame) {
  return statusFromFrame(frame) === 'WORKING' ? 'Tianxi native task is working.\n' : '';
}

function tianxiToolCallItem(callId, name, args, status = 'in_progress') {
  return {
    id: 'fc_' + callId,
    type: 'function_call',
    call_id: callId,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
    status,
  };
}

function tianxiToolOutputItem(output) {
  return {
    id: 'fco_' + output.call_id,
    type: 'function_call_output',
    call_id: output.call_id,
    output: output.output,
    status: 'completed',
  };
}

function appendDedupedStatusProgress(state, text) {
  if (!text || state.lastStatusProgress === text) return;
  state.lastStatusProgress = text;
  appendReasoningSummary(state, text);
}

function writeDedupedStatusProgress(clientRes, state, text) {
  if (!text || state.lastStatusProgress === text) return;
  state.lastStatusProgress = text;
  writeTianxiReasoningDelta(clientRes, state, text);
}

function sanitizeTianxiErrorText(value) {
  return compactText(value)
    .replace(/sat-[A-Za-z0-9._-]+/g, 'sat-<redacted>')
    .replace(
      /\b(authorization|cookie|set-cookie|token|access_token|refresh_token)\b\s*[:=]\s*[^,\s}]+/gi,
      '$1=<redacted>'
    )
    .replace(/[A-Za-z0-9_+/=-]{120,}/g, '<redacted-long>');
}

function normalizeTianxiErrorMessage(value, details = {}) {
  const message = sanitizeTianxiErrorText(value);
  if (/Service Account token has expired|service_account_token_expired/i.test(message)) {
    const registryCredentialState =
      details &&
      details.registry_credential_state &&
      typeof details.registry_credential_state === 'object'
        ? details.registry_credential_state
        : {};
    if (registryCredentialState.refreshPossibleWithLogin === true) {
      return 'Tianxi qoder service account token has expired. The Tianxi registry login cache is still valid, but the native AgentCore plugin has not issued a fresh qoder_token yet; refresh or re-open Tianxi super mode in the native app, then retry.';
    }
    const credentialState =
      details && details.credential_state && typeof details.credential_state === 'object'
        ? details.credential_state
        : {};
    if (credentialState.txExpired === true) {
      return 'Tianxi qoder service account token has expired and the Tianxi login token observed by the local AgentCore log is also expired. The current tac-server route needs the native Tianxi app to refresh login credentials and issue a fresh qoder_token before chat or super mode can run.';
    }
    return 'Tianxi qoder service account token has expired. The local Tianxi login token may still be valid, but the current tac-server route needs a fresh qoder_token from the native Tianxi host before chat or super mode can run.';
  }
  if (/catalog not ready after authentication/i.test(message)) {
    const refreshState =
      details && details.refresh_state && typeof details.refresh_state === 'object'
        ? details.refresh_state
        : {};
    const qoderRuntimeState =
      details && details.qoder_runtime_state && typeof details.qoder_runtime_state === 'object'
        ? details.qoder_runtime_state
        : {};
    if (qoderRuntimeState.latestClassification === 'service_account_expired') {
      return 'Tianxi qoder authentication succeeded, but the Qoder model catalog is not ready. The latest local xlagent run still failed before catalog initialization because the service-account token was expired; refresh Tianxi super mode in the native app until qoder_runtime.ready reports catalog_ready=true, then retry.';
    }
    if (refreshState.status === 'no_native_refresh') {
      return 'Tianxi qoder authentication succeeded, but the Qoder model catalog is not ready. The direct tac-server route cannot refresh the plugin-managed service-account/catalog context; open or refresh Tianxi super mode in the native app so XLAgentCorePlugin can start and initialize the session, then retry.';
    }
    return 'Tianxi qoder authentication succeeded, but the Qoder model catalog is not ready. Refresh Tianxi super mode in the native app, then retry.';
  }
  return message;
}

function isSensitiveDiagnosticKey(key) {
  return /token|secret|credential|authorization|cookie|key/i.test(String(key || ''));
}

function isSafeBooleanDiagnosticKey(key, value) {
  return (
    ['hasQoderToken', 'hasPlaintextQoderToken'].includes(String(key || '')) &&
    typeof value === 'boolean'
  );
}

function sanitizeDiagnosticValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticValue);
  if (!value || typeof value !== 'object') return value;
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSafeBooleanDiagnosticKey(key, item)) {
      sanitized[key] = item;
      continue;
    }
    if (isSensitiveDiagnosticKey(key)) {
      if (
        [
          'credential_state',
          'registry_credential_state',
          'log_credential_state',
          'credentialState',
          'registryCredentialState',
          'logCredentialState',
          'qoder_runtime_state',
          'qoderRuntimeState',
        ].includes(key)
      ) {
        sanitized[key] = sanitizeDiagnosticValue(item);
      }
      continue;
    }
    sanitized[key] = sanitizeDiagnosticValue(item);
  }
  return sanitized;
}

function safeDiagnosticObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(sanitizeDiagnosticValue(value)));
  } catch (_err) {
    return null;
  }
}

function tianxiErrorDiagnostics(data) {
  const diagnostics = {};
  for (const key of [
    'credential_state',
    'registry_credential_state',
    'log_credential_state',
    'refresh_state',
    'qoder_runtime_state',
  ]) {
    const value = safeDiagnosticObject(data[key]);
    if (value) diagnostics[key] = value;
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : null;
}

function tianxiErrorFromFrame(frame, status) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  const param = tianxiErrorDiagnostics(data);
  return {
    code: compactText(data.error_code || status.toLowerCase()),
    message: normalizeTianxiErrorMessage(
      data.error_detail || data.message || data.error || status,
      data
    ),
    ...(param ? { param } : {}),
  };
}

function createTianxiResponsesState(requestBody = {}, model, deps = {}) {
  const seed = { model: requestBody.model || model, input: requestBody.input };
  const fallbackId =
    typeof deps.fallbackId === 'function'
      ? deps.fallbackId
      : (prefix) => prefix + '_tianxi_' + Date.now();
  const stableCreated =
    typeof deps.stableCreated === 'function'
      ? deps.stableCreated
      : () => Math.floor(Date.now() / 1000);
  return {
    id: deps.responseId || fallbackId('resp', seed),
    object: 'response',
    created_at: deps.createdAt || stableCreated(seed),
    model: requestBody.model || model || 'tianxi-super',
    status: 'in_progress',
    output: [],
    text: '',
    reasoning: '',
    pendingText: '',
    nativeToolCounts: new Map(),
    error: null,
    incomplete_details: null,
    terminalCompleted: false,
    pendingToolCalls: new Set(),
    internalToolCalls: new Map(),
    nativeToolSeenIds: new Set(),
    lastStatusProgress: '',
  };
}

function addMessageOutput(state) {
  let item = state.output.find((candidate) => candidate.type === 'message');
  if (!item) {
    item = {
      id: 'msg_' + state.id,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }],
    };
    state.output.push(item);
  }
  return item;
}

function applyTianxiFrameToResponsesState(state, frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'task_output') {
    const reasoning = extractTianxiReasoning(frame);
    appendReasoningSummary(state, reasoning);
    const progress = extractTianxiProgress(frame);
    appendReasoningSummary(state, progress);
    const text = extractTianxiText(frame);
    if (text) {
      if (isAmbiguousTianxiText(frame)) state.pendingText += text;
      else {
        flushPendingTianxiText(state, false);
        state.text += text;
        addMessageOutput(state).content[0].text = state.text;
      }
    }
    return;
  }
  if (frame.type === 'act_exec') {
    flushPendingTianxiText(state, true);
    const action = tianxiActionFromFrame(frame);
    const internalTool = isInternalTianxiToolFrame(frame);
    if (internalTool) {
      appendReasoningSummary(state, startNativeToolProgress(state, frame));
      return;
    }
    state.pendingToolCalls.add(action.id);
    state.output.push(tianxiToolCallItem(action.id, action.name, action.arguments));
    return;
  }
  if (frame.type === 'act_resp') {
    const progress = finishNativeToolProgress(state, frame);
    if (progress) {
      flushPendingTianxiText(state, true);
      appendReasoningSummary(state, progress);
      return;
    }
    const output = tianxiToolOutputFromFrame(frame);
    if (!state.pendingToolCalls.has(output.call_id)) return;
    state.pendingToolCalls.delete(output.call_id);
    const call = state.output.find(
      (item) =>
        (item.type === 'function_call' || item.type === 'custom_tool_call') &&
        item.call_id === output.call_id
    );
    if (call) call.status = 'completed';
    state.output.push(tianxiToolOutputItem(output));
    return;
  }
  if (frame.type === 'risk_exec') {
    flushPendingTianxiText(state, true);
    const name = 'tianxi_permission_request';
    appendReasoningSummary(state, nativeToolProgressText(state, name, 'awaiting permission'));
    return;
  }
  if (frame.type === 'task_status') {
    const status = statusFromFrame(frame);
    if (status === 'COMPLETED') flushPendingTianxiText(state, false);
    appendDedupedStatusProgress(state, tianxiStatusProgressText(frame));
    if (status === 'COMPLETED' && state.status !== 'failed') {
      state.status = 'completed';
      state.terminalCompleted = true;
    }
    if (TERMINAL_FAILED.has(status)) {
      state.status = 'failed';
      state.error = tianxiErrorFromFrame(frame, status);
    }
  }
}

function buildTianxiResponsesResponse(
  requestBody,
  frames,
  model,
  deps,
  { interrupted = false } = {}
) {
  const state = createTianxiResponsesState(requestBody, model, deps);
  for (const frame of Array.isArray(frames) ? frames : []) {
    applyTianxiFrameToResponsesState(state, frame);
  }
  flushPendingTianxiText(state, false);
  if (state.status === 'failed') {
    state.incomplete_details = null;
  } else if (interrupted) {
    state.status = 'incomplete';
    state.incomplete_details = { reason: 'tianxi_native_stream_interrupted' };
    for (const item of state.output) {
      if (item.type === 'message') item.status = 'incomplete';
    }
  } else if (state.pendingToolCalls.size > 0) {
    state.status = 'incomplete';
    state.incomplete_details = {
      reason: 'tianxi_tool_calls_pending',
    };
  } else if (state.status === 'in_progress') {
    state.status = 'incomplete';
    state.incomplete_details = { reason: 'tianxi_terminal_status_missing' };
  } else if (state.status === 'completed' && state.output.length === 0) {
    state.status = 'incomplete';
    state.incomplete_details = { reason: 'tianxi_empty_completion' };
  }
  for (const item of state.output) {
    if (item.type === 'message' && state.status !== 'completed') item.status = 'incomplete';
    if (item.type === 'reasoning') {
      item.status = state.status === 'completed' ? 'completed' : 'incomplete';
    }
  }
  return {
    id: state.id,
    object: 'response',
    created_at: state.created_at,
    model: state.model,
    status: state.status,
    output: state.output,
    ...(state.text ? { output_text: state.text } : {}),
    incomplete_details: state.incomplete_details,
    error: state.error,
    usage: null,
  };
}

function writeTianxiResponsesFrame(clientRes, state, frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'task_output') {
    const reasoning = extractTianxiReasoning(frame);
    if (reasoning) writeTianxiReasoningDelta(clientRes, state, reasoning);
    const progress = extractTianxiProgress(frame);
    if (progress) writeTianxiReasoningDelta(clientRes, state, progress);
    const text = extractTianxiText(frame);
    if (text) {
      if (isAmbiguousTianxiText(frame)) {
        state.pendingText += text;
        return;
      }
      writePendingTianxiText(clientRes, state, false);
      writeTianxiTextDelta(clientRes, state, text);
    }
    return;
  }
  if (frame.type === 'act_exec' || frame.type === 'risk_exec') {
    writePendingTianxiText(clientRes, state, true);
    const action = tianxiActionFromFrame(frame);
    const internalTool = isProviderNativeTianxiToolFrame(frame);
    if (internalTool) {
      const progressName = frame.type === 'risk_exec' ? 'tianxi_permission_request' : action.name;
      const progress =
        frame.type === 'act_exec'
          ? startNativeToolProgress(state, frame)
          : nativeToolProgressText(state, progressName, 'awaiting permission');
      if (progress) writeTianxiReasoningDelta(clientRes, state, progress);
    }
    if (internalTool) return;
    const callId = frame.type === 'risk_exec' ? 'permission_' + action.id : action.id;
    const name = frame.type === 'risk_exec' ? 'tianxi_permission_request' : action.name;
    const args = action.arguments;
    const item = tianxiToolCallItem(callId, name, '');
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item,
    });
    state.pendingToolCalls.add(callId);
    if (args) {
      writeResponsesSseEvent(clientRes, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        response_id: state.id,
        item_id: item.id,
        output_index: state.outputIndex,
        delta: args,
      });
    }
    writeResponsesSseEvent(clientRes, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      response_id: state.id,
      item_id: item.id,
      output_index: state.outputIndex,
      arguments: args,
    });
    state.toolItems.set(callId, {
      index: state.outputIndex,
      item: tianxiToolCallItem(callId, name, args),
    });
    state.outputIndex += 1;
    return;
  }
  if (frame.type === 'act_resp') {
    const progress = finishNativeToolProgress(state, frame);
    if (progress) {
      writePendingTianxiText(clientRes, state, true);
      writeTianxiReasoningDelta(clientRes, state, progress);
      return;
    }
    const output = tianxiToolOutputFromFrame(frame);
    if (!state.pendingToolCalls.has(output.call_id)) return;
    state.pendingToolCalls.delete(output.call_id);
    const call = state.toolItems.get(output.call_id);
    if (call) {
      call.item.status = 'completed';
      writeResponsesSseEvent(clientRes, 'response.output_item.done', {
        type: 'response.output_item.done',
        response_id: state.id,
        output_index: call.index,
        item: call.item,
      });
    }
    const item = tianxiToolOutputItem(output);
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item,
    });
    writeResponsesSseEvent(clientRes, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: state.id,
      output_index: state.outputIndex,
      item,
    });
    state.outputIndex += 1;
    return;
  }
  if (frame.type === 'task_status') {
    const status = statusFromFrame(frame);
    if (status === 'COMPLETED') {
      state.terminalCompleted = true;
      writePendingTianxiText(clientRes, state, false);
    }
    writeDedupedStatusProgress(clientRes, state, tianxiStatusProgressText(frame));
  }
}

function writePendingTianxiText(clientRes, state, asReasoning) {
  const text = state.pendingText || '';
  state.pendingText = '';
  if (!text) return;
  if (asReasoning) writeTianxiReasoningDelta(clientRes, state, text);
  else writeTianxiTextDelta(clientRes, state, text);
}

function writeTianxiTextDelta(clientRes, state, text) {
  if (!state.messageStarted) {
    state.messageStarted = true;
    state.messageId = 'msg_' + state.id;
    state.messageIndex = state.outputIndex;
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex++,
      item: {
        id: state.messageId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    writeResponsesSseEvent(clientRes, 'response.content_part.added', {
      type: 'response.content_part.added',
      response_id: state.id,
      item_id: state.messageId,
      output_index: state.messageIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    });
  }
  state.text += text;
  writeResponsesSseEvent(clientRes, 'response.output_text.delta', {
    type: 'response.output_text.delta',
    response_id: state.id,
    item_id: state.messageId,
    output_index: state.messageIndex,
    content_index: 0,
    delta: text,
    logprobs: [],
  });
}

function writeTianxiReasoningDelta(clientRes, state, reasoning) {
  if (!state.reasoningStarted) {
    state.reasoningStarted = true;
    state.reasoningId = 'rsn_' + state.id;
    state.reasoningIndex = state.outputIndex;
    state.reasoningSummaryStarted = true;
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex++,
      item: { id: state.reasoningId, type: 'reasoning', status: 'in_progress', summary: [] },
    });
    writeResponsesSseEvent(clientRes, 'response.reasoning_summary_part.added', {
      type: 'response.reasoning_summary_part.added',
      response_id: state.id,
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
  }
  state.reasoning += reasoning;
  writeResponsesSseEvent(clientRes, 'response.reasoning_summary_text.delta', {
    type: 'response.reasoning_summary_text.delta',
    response_id: state.id,
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    delta: reasoning,
  });
}

function createTianxiResponsesStream(clientRes, requestBody, model, deps) {
  const frames = [];
  const summary = {
    frameCount: 0,
    taskOutputFrames: 0,
    toolCallFrames: 0,
    toolResponseFrames: 0,
    reasoningChars: 0,
    textChars: 0,
    outputMarkers: {},
    outputFields: {},
    terminalFrameCount: 0,
    terminalStatus: '',
    pendingToolCalls: 0,
    responseStatus: '',
    incompleteReason: '',
    byteCount: 0,
  };
  const state = {
    ...createTianxiResponsesState(requestBody, model, deps),
    outputIndex: 0,
    messageStarted: false,
    reasoningStarted: false,
    reasoningSummaryStarted: false,
    text: '',
    reasoning: '',
    pendingToolCalls: new Set(),
    internalToolCalls: new Map(),
    toolItems: new Map(),
  };
  if (!clientRes.headersSent) {
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
  }
  writeResponsesSseEvent(clientRes, 'response.created', {
    type: 'response.created',
    response: {
      id: state.id,
      object: 'response',
      created_at: state.created_at,
      model: state.model,
      status: 'in_progress',
      output: [],
      error: null,
      incomplete_details: null,
      usage: null,
    },
  });
  writeResponsesSseEvent(clientRes, 'response.in_progress', {
    type: 'response.in_progress',
    response: {
      id: state.id,
      object: 'response',
      created_at: state.created_at,
      model: state.model,
      status: 'in_progress',
      output: [],
      error: null,
      incomplete_details: null,
      usage: null,
    },
  });
  let finished = false;
  const isWritable = () => !clientRes.destroyed && !clientRes.writableEnded;
  const writeFrame = (frame) => {
    if (finished || !isWritable() || !frame || typeof frame !== 'object') return;
    frames.push(frame);
    summary.frameCount += 1;
    summary.byteCount += safeJsonByteLength(frame);
    if (frame.type === 'task_output') {
      summary.taskOutputFrames += 1;
      const shape = tianxiOutputShape(frame);
      summary.outputMarkers[shape.markerKind] = (summary.outputMarkers[shape.markerKind] || 0) + 1;
      for (const field of shape.fields) {
        summary.outputFields[field] = (summary.outputFields[field] || 0) + 1;
      }
    }
    if (frame.type === 'task_status') {
      summary.terminalFrameCount += 1;
      summary.terminalStatus = statusFromFrame(frame) || summary.terminalStatus;
    }
    if (frame.type === 'act_exec' || frame.type === 'risk_exec') summary.toolCallFrames += 1;
    if (frame.type === 'act_resp') summary.toolResponseFrames += 1;
    const reasoningBefore = state.reasoning.length;
    const textBefore = state.text.length;
    writeTianxiResponsesFrame(clientRes, state, frame);
    summary.reasoningChars += state.reasoning.length - reasoningBefore;
    summary.textChars += state.text.length - textBefore;
  };
  const finish = (fallbackFrames = [], termination = {}) => {
    if (finished) return null;
    if (!isWritable()) {
      finished = true;
      return null;
    }
    const liveFrameCounts = new Map();
    for (const frame of frames) {
      const key = JSON.stringify(frame);
      liveFrameCounts.set(key, (liveFrameCounts.get(key) || 0) + 1);
    }
    for (const frame of Array.isArray(fallbackFrames) ? fallbackFrames : []) {
      const key = JSON.stringify(frame);
      const count = liveFrameCounts.get(key) || 0;
      if (count > 0) liveFrameCounts.set(key, count - 1);
      else writeFrame(frame);
    }
    const reasoningBefore = state.reasoning.length;
    const textBefore = state.text.length;
    writePendingTianxiText(clientRes, state, false);
    summary.reasoningChars += state.reasoning.length - reasoningBefore;
    summary.textChars += state.text.length - textBefore;
    finished = true;
    const response = buildTianxiResponsesResponse(
      requestBody,
      frames,
      model,
      { ...deps, responseId: state.id, createdAt: state.created_at },
      termination
    );
    if (state.reasoningStarted) {
      const part = { type: 'summary_text', text: state.reasoning };
      const item = {
        id: state.reasoningId,
        type: 'reasoning',
        status: response.status === 'completed' ? 'completed' : 'incomplete',
        summary: [part],
      };
      if (state.reasoningSummaryStarted) {
        writeResponsesSseEvent(clientRes, 'response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done',
          response_id: state.id,
          item_id: state.reasoningId,
          output_index: state.reasoningIndex,
          summary_index: 0,
          text: state.reasoning,
        });
        writeResponsesSseEvent(clientRes, 'response.reasoning_summary_part.done', {
          type: 'response.reasoning_summary_part.done',
          response_id: state.id,
          item_id: state.reasoningId,
          output_index: state.reasoningIndex,
          summary_index: 0,
          part,
          ...(response.status !== 'completed' ? { status: 'incomplete' } : {}),
        });
      }
      writeResponsesSseEvent(clientRes, 'response.output_item.done', {
        type: 'response.output_item.done',
        response_id: state.id,
        output_index: state.reasoningIndex,
        item,
      });
    }
    if (state.messageStarted) {
      const part = { type: 'output_text', text: state.text, annotations: [], logprobs: [] };
      const item = {
        id: state.messageId,
        type: 'message',
        status: response.status === 'completed' ? 'completed' : 'incomplete',
        role: 'assistant',
        content: [part],
      };
      writeResponsesSseEvent(clientRes, 'response.output_text.done', {
        type: 'response.output_text.done',
        response_id: state.id,
        item_id: state.messageId,
        output_index: state.messageIndex,
        content_index: 0,
        text: state.text,
        logprobs: [],
      });
      writeResponsesSseEvent(clientRes, 'response.content_part.done', {
        type: 'response.content_part.done',
        response_id: state.id,
        item_id: state.messageId,
        output_index: state.messageIndex,
        content_index: 0,
        part,
      });
      writeResponsesSseEvent(clientRes, 'response.output_item.done', {
        type: 'response.output_item.done',
        response_id: state.id,
        output_index: state.messageIndex,
        item,
      });
    }
    summary.pendingToolCalls = state.pendingToolCalls.size;
    summary.responseStatus = response.status;
    summary.incompleteReason = response.incomplete_details?.reason || '';
    if (response.status === 'failed') {
      writeResponsesSseEvent(clientRes, 'response.failed', {
        type: 'response.failed',
        response,
      });
    } else if (response.status === 'incomplete') {
      writeResponsesSseEvent(clientRes, 'response.incomplete', {
        type: 'response.incomplete',
        response,
      });
    } else {
      writeResponsesSseEvent(clientRes, 'response.completed', {
        type: 'response.completed',
        response,
      });
    }
    clientRes.write('data: [DONE]\n\n');
    clientRes.end();
    return response;
  };
  return {
    finish,
    getSummary() {
      return { ...summary };
    },
    state,
    writeFrame,
    get frameCount() {
      return frames.length;
    },
  };
}

function writeTianxiResponsesStream(clientRes, requestBody, frames, model, deps) {
  const stream = createTianxiResponsesStream(clientRes, requestBody, model, deps);
  for (const frame of Array.isArray(frames) ? frames : []) stream.writeFrame(frame);
  stream.finish();
  return stream;
}

function parseTianxiBridgeFramesPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.frames)) return payload.frames;
  if (Array.isArray(payload.events)) return payload.events;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.type) return [payload];
  return [];
}

module.exports = {
  applyTianxiFrameToResponsesState,
  buildTianxiResponsesResponse,
  createTianxiResponsesStream,
  parseTianxiBridgeFramesPayload,
  writeResponsesSseEvent,
  writeTianxiResponsesFrame,
  writeTianxiResponsesStream,
};
