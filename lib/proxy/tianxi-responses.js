'use strict';

const TERMINAL_FAILED = new Set(['FAILED', 'CANCELED']);

function writeResponsesSseEvent(clientRes, event, payload) {
  clientRes.write('event: ' + event + '\n');
  clientRes.write('data: ' + JSON.stringify(payload) + '\n\n');
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

function firstOwnValue(sources, fields, fallback) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of fields) {
      if (Object.hasOwn(source, field)) return source[field];
    }
  }
  return fallback;
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

function extractTianxiText(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  if (isTianxiReasoningMarker(data)) return '';
  if (data.content_type && data.content_type !== 'text') return '';
  return compactText(firstOwnValue([data], ['content', 'delta'], ''));
}

function extractTianxiReasoning(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  const explicit = firstOwnValue(
    [data],
    [
      'reasoning_content',
      'reasoning',
      'thought_content',
      'thinking_content',
      'thought',
      'thinking',
    ],
    undefined
  );
  if (explicit !== undefined) return compactText(explicit);
  if (!isTianxiReasoningMarker(data)) return '';
  return compactText(firstOwnValue([data], ['content', 'delta', 'text'], ''));
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

function safeTianxiPermissionArgs(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  const action = Array.isArray(data.actions) ? data.actions[0] || {} : data.action || data;
  const args =
    action.parameters ||
    action.args ||
    action.arguments ||
    data.parameters ||
    data.args ||
    data.tool_input ||
    data.toolInput ||
    {};
  const payload = {
    action_id: String(action.id || data.action_id || data.actionId || data.id || frame.id || ''),
    tool_name: String(
      action.name || data.action_name || data.tool_name || data.name || data.type || ''
    ),
    title: String(data.title || data.display_name || data.displayName || action.title || ''),
    tool_input: safeJsonParse(args),
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === '' || payload[key] == null) delete payload[key];
  }
  return normalizeToolArgs(payload);
}

function tianxiActionFromFrame(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  const action = Array.isArray(data.actions) ? data.actions[0] || {} : data.action || data;
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
    name:
      String(
        action.name || data.action_name || data.tool_name || data.name || data.type || ''
      ).trim() || 'tianxi_tool',
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
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : 'tool';
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

function statusFromFrame(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  return String(data.status || frame.status || '').toUpperCase();
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
    model: model || requestBody.model || 'tianxi-super',
    status: 'in_progress',
    output: [],
    text: '',
    reasoning: '',
    error: null,
    incomplete_details: null,
    terminalCompleted: false,
    pendingToolCalls: new Set(),
    internalToolCalls: new Map(),
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
      content: [{ type: 'output_text', text: '' }],
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
    const text = extractTianxiText(frame);
    if (text) {
      state.text += text;
      const item = addMessageOutput(state);
      item.content[0].text = state.text;
    }
    return;
  }
  if (frame.type === 'act_exec') {
    const action = tianxiActionFromFrame(frame);
    if (frame.data?.exec_mode !== 'local') {
      const toolName = safeTianxiToolName(action.name);
      state.internalToolCalls.set(action.id, toolName);
      appendReasoningSummary(state, `Using ${toolName}.\n`);
      return;
    }
    state.pendingToolCalls.add(action.id);
    state.output.push({
      id: 'fc_' + action.id,
      type: 'function_call',
      call_id: action.id,
      name: action.name,
      arguments: action.arguments,
      status: 'in_progress',
    });
    return;
  }
  if (frame.type === 'act_resp') {
    const output = tianxiToolOutputFromFrame(frame);
    if (state.internalToolCalls.has(output.call_id)) {
      const toolName = state.internalToolCalls.get(output.call_id);
      state.internalToolCalls.delete(output.call_id);
      appendReasoningSummary(state, `${toolName} completed.\n`);
      return;
    }
    if (!state.pendingToolCalls.has(output.call_id)) return;
    state.pendingToolCalls.delete(output.call_id);
    const call = state.output.find(
      (item) => item.type === 'function_call' && item.call_id === output.call_id
    );
    if (call) call.status = 'completed';
    state.output.push({
      id: 'fco_' + output.call_id,
      type: 'function_call_output',
      call_id: output.call_id,
      output: output.output,
      status: 'completed',
    });
    return;
  }
  if (frame.type === 'risk_exec') {
    const action = tianxiActionFromFrame(frame);
    const callId = 'permission_' + action.id;
    state.pendingToolCalls.add(callId);
    state.output.push({
      id: 'fc_permission_' + action.id,
      type: 'function_call',
      call_id: callId,
      name: 'tianxi_permission_request',
      arguments: safeTianxiPermissionArgs(frame),
      status: 'in_progress',
    });
    return;
  }
  if (frame.type === 'task_status') {
    const status = statusFromFrame(frame);
    if (status === 'COMPLETED') {
      state.status = 'completed';
      state.terminalCompleted = true;
    }
    if (TERMINAL_FAILED.has(status)) {
      state.status = 'failed';
      state.error = tianxiErrorFromFrame(frame, status);
    }
  }
}

function buildTianxiResponsesResponse(requestBody, frames, model, deps) {
  const state = createTianxiResponsesState(requestBody, model, deps);
  for (const frame of Array.isArray(frames) ? frames : []) {
    applyTianxiFrameToResponsesState(state, frame);
  }
  if (state.status === 'failed') {
    state.incomplete_details = null;
  } else if (state.pendingToolCalls.size > 0) {
    state.status = 'incomplete';
    state.incomplete_details = {
      reason: 'tianxi_tool_calls_pending',
    };
  } else if (state.status === 'in_progress') {
    state.status = 'incomplete';
    state.incomplete_details = {
      reason: 'tianxi_terminal_status_missing',
    };
  } else if (state.status === 'completed' && state.output.length === 0) {
    state.status = 'incomplete';
    state.incomplete_details = { reason: 'tianxi_empty_completion' };
  }
  return {
    id: state.id,
    object: 'response',
    created_at: state.created_at,
    model: state.model,
    status: state.status,
    output: state.output,
    ...(state.incomplete_details ? { incomplete_details: state.incomplete_details } : {}),
    error: state.error,
    usage: null,
  };
}

function writeTianxiResponsesFrame(clientRes, state, frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'task_output') {
    const reasoning = extractTianxiReasoning(frame);
    if (reasoning) writeTianxiReasoningDelta(clientRes, state, reasoning);
    const text = extractTianxiText(frame);
    if (text) {
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
          part: { type: 'output_text', text: '', annotations: [] },
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
      });
    }
    return;
  }
  if (frame.type === 'act_exec' || frame.type === 'risk_exec') {
    const action = tianxiActionFromFrame(frame);
    if (frame.type === 'act_exec' && frame.data?.exec_mode !== 'local') {
      const toolName = safeTianxiToolName(action.name);
      state.internalToolCalls.set(action.id, toolName);
      writeTianxiReasoningDelta(clientRes, state, `Using ${toolName}.\n`);
      return;
    }
    const callId = frame.type === 'risk_exec' ? 'permission_' + action.id : action.id;
    const name = frame.type === 'risk_exec' ? 'tianxi_permission_request' : action.name;
    const args = frame.type === 'risk_exec' ? safeTianxiPermissionArgs(frame) : action.arguments;
    state.pendingToolCalls.add(callId);
    const item = {
      id: 'fc_' + callId,
      type: 'function_call',
      call_id: callId,
      name,
      arguments: '',
      status: 'in_progress',
    };
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item,
    });
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
    state.toolItems.set(callId, { index: state.outputIndex, item: { ...item, arguments: args } });
    state.outputIndex += 1;
    return;
  }
  if (frame.type === 'act_resp') {
    const output = tianxiToolOutputFromFrame(frame);
    if (state.internalToolCalls.has(output.call_id)) {
      const toolName = state.internalToolCalls.get(output.call_id);
      state.internalToolCalls.delete(output.call_id);
      writeTianxiReasoningDelta(clientRes, state, `${toolName} completed.\n`);
      return;
    }
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
    const item = {
      id: 'fco_' + output.call_id,
      type: 'function_call_output',
      call_id: output.call_id,
      output: output.output,
      status: 'completed',
    };
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
      item: { id: state.reasoningId, type: 'reasoning', status: 'in_progress', content: [] },
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
  writeResponsesSseEvent(clientRes, 'response.reasoning.delta', {
    type: 'response.reasoning.delta',
    response_id: state.id,
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    delta: reasoning,
  });
}

function createTianxiResponsesStream(clientRes, requestBody, model, deps) {
  const frames = [];
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
    },
  });
  let finished = false;
  const isWritable = () => !clientRes.destroyed && !clientRes.writableEnded;
  const writeFrame = (frame) => {
    if (finished || !isWritable() || !frame || typeof frame !== 'object') return;
    frames.push(frame);
    writeTianxiResponsesFrame(clientRes, state, frame);
  };
  const finish = (fallbackFrames = []) => {
    if (finished) return;
    if (!isWritable()) {
      finished = true;
      return;
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
    finished = true;
    if (state.reasoningStarted) {
      const part = { type: 'summary_text', text: state.reasoning };
      const item = {
        id: state.reasoningId,
        type: 'reasoning',
        status: 'completed',
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
        });
      }
      writeResponsesSseEvent(clientRes, 'response.reasoning.done', {
        type: 'response.reasoning.done',
        response_id: state.id,
        item_id: state.reasoningId,
        output_index: state.reasoningIndex,
        text: state.reasoning,
      });
      writeResponsesSseEvent(clientRes, 'response.output_item.done', {
        type: 'response.output_item.done',
        response_id: state.id,
        output_index: state.reasoningIndex,
        item,
      });
    }
    if (state.messageStarted) {
      const part = { type: 'output_text', text: state.text, annotations: [] };
      const item = {
        id: state.messageId,
        type: 'message',
        status: 'completed',
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
    const response = buildTianxiResponsesResponse(requestBody, frames, model, deps);
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
  };
  return {
    finish,
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
