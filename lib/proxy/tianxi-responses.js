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

function extractTianxiText(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  if (data.content_stage === 'summary' || data.content_schema === 'summary') return '';
  if (data.content_type && data.content_type !== 'text') return '';
  return compactText(data.content || data.delta || '');
}

function extractTianxiReasoning(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  return compactText(data.reasoning_content || data.reasoning || '');
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
  const raw =
    data.result ||
    data.output ||
    data.response ||
    action.result ||
    action.output ||
    action.response ||
    data;
  return {
    call_id:
      String(action.id || data.action_id || data.actionId || data.id || frame.id || '').trim() ||
      'tianxi_action',
    output: compactText(raw),
  };
}

function statusFromFrame(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  return String(data.status || frame.status || '').toUpperCase();
}

function normalizeTianxiErrorMessage(value, details = {}) {
  const message = compactText(value);
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
    id: fallbackId('resp', seed),
    object: 'response',
    created_at: stableCreated(seed),
    model: model || requestBody.model || 'tianxi-super',
    status: 'in_progress',
    output: [],
    text: '',
    reasoning: '',
    error: null,
    incomplete_details: null,
    terminalCompleted: false,
    pendingToolCalls: new Set(),
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
    if (reasoning) {
      state.reasoning += reasoning;
      let item = state.output.find((candidate) => candidate.type === 'reasoning');
      if (!item) {
        item = { id: 'rsn_' + state.id, type: 'reasoning', summary: '' };
        state.output.push(item);
      }
      item.summary = state.reasoning;
    }
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
  if (state.status === 'in_progress' && state.pendingToolCalls && state.pendingToolCalls.size > 0) {
    state.status = 'incomplete';
    state.incomplete_details = { reason: 'tianxi_tool_calls_pending' };
  }
  if (state.status === 'in_progress') state.status = 'completed';
  return {
    id: state.id,
    object: 'response',
    created_at: state.created_at,
    model: state.model,
    status: state.status,
    output: state.output,
    ...(state.incomplete_details ? { incomplete_details: state.incomplete_details } : {}),
    error: state.error,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function writeTianxiResponsesFrame(clientRes, state, frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'task_output') {
    const reasoning = extractTianxiReasoning(frame);
    if (reasoning) {
      if (!state.reasoningStarted) {
        state.reasoningStarted = true;
        state.reasoningId = 'rsn_' + state.id;
        writeResponsesSseEvent(clientRes, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: state.outputIndex++,
          item: { id: state.reasoningId, type: 'reasoning', summary: '' },
        });
      }
      state.reasoning += reasoning;
      writeResponsesSseEvent(clientRes, 'response.reasoning.delta', {
        type: 'response.reasoning.delta',
        item_id: state.reasoningId,
        output_index: 0,
        delta: reasoning,
      });
    }
    const text = extractTianxiText(frame);
    if (text) {
      if (!state.messageStarted) {
        state.messageStarted = true;
        state.messageId = 'msg_' + state.id;
        writeResponsesSseEvent(clientRes, 'response.output_item.added', {
          type: 'response.output_item.added',
          output_index: state.outputIndex++,
          item: {
            id: state.messageId,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        });
      }
      state.text += text;
      writeResponsesSseEvent(clientRes, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: state.messageId,
        output_index: Math.max(0, state.outputIndex - 1),
        content_index: 0,
        delta: text,
      });
    }
    return;
  }
  if (frame.type === 'act_exec' || frame.type === 'risk_exec') {
    const action = tianxiActionFromFrame(frame);
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
    };
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: state.outputIndex,
      item,
    });
    if (args) {
      writeResponsesSseEvent(clientRes, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: item.id,
        output_index: state.outputIndex,
        delta: args,
      });
    }
    writeResponsesSseEvent(clientRes, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: item.id,
      output_index: state.outputIndex,
      arguments: args,
    });
    state.outputIndex += 1;
    return;
  }
  if (frame.type === 'act_resp') {
    const output = tianxiToolOutputFromFrame(frame);
    state.pendingToolCalls.delete(output.call_id);
    writeResponsesSseEvent(clientRes, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: state.outputIndex++,
      item: {
        id: 'fco_' + output.call_id,
        type: 'function_call_output',
        call_id: output.call_id,
        output: output.output,
      },
    });
    return;
  }
  if (frame.type === 'task_status') {
    const status = statusFromFrame(frame);
    if (status === 'COMPLETED') state.terminalCompleted = true;
    if (TERMINAL_FAILED.has(status)) {
      state.failed = tianxiErrorFromFrame(frame, status);
    }
  }
}

function writeTianxiResponsesStream(clientRes, requestBody, frames, model, deps) {
  const state = {
    ...createTianxiResponsesState(requestBody, model, deps),
    outputIndex: 0,
    messageStarted: false,
    reasoningStarted: false,
    text: '',
    reasoning: '',
    terminalCompleted: false,
    pendingToolCalls: new Set(),
  };
  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
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
  for (const frame of Array.isArray(frames) ? frames : []) {
    writeTianxiResponsesFrame(clientRes, state, frame);
  }
  if (state.reasoningStarted) {
    writeResponsesSseEvent(clientRes, 'response.reasoning.done', {
      type: 'response.reasoning.done',
      item_id: state.reasoningId,
      output_index: 0,
      text: state.reasoning,
    });
  }
  if (state.messageStarted) {
    writeResponsesSseEvent(clientRes, 'response.output_text.done', {
      type: 'response.output_text.done',
      item_id: state.messageId,
      output_index: Math.max(0, state.outputIndex - 1),
      content_index: 0,
      text: state.text,
    });
  }
  if (state.failed) {
    writeResponsesSseEvent(clientRes, 'response.failed', {
      type: 'response.failed',
      response: {
        id: state.id,
        object: 'response',
        status: 'failed',
        error: state.failed,
      },
    });
  } else if (!state.terminalCompleted && state.pendingToolCalls.size > 0) {
    writeResponsesSseEvent(clientRes, 'response.incomplete', {
      type: 'response.incomplete',
      response: {
        id: state.id,
        object: 'response',
        created_at: state.created_at,
        model: state.model,
        status: 'incomplete',
        incomplete_details: { reason: 'tianxi_tool_calls_pending' },
        output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
  } else {
    writeResponsesSseEvent(clientRes, 'response.completed', {
      type: 'response.completed',
      response: {
        id: state.id,
        object: 'response',
        created_at: state.created_at,
        model: state.model,
        status: 'completed',
        output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
  }
  clientRes.end();
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
  parseTianxiBridgeFramesPayload,
  writeResponsesSseEvent,
  writeTianxiResponsesFrame,
  writeTianxiResponsesStream,
};
