'use strict';

function chatResponseToolCalls(message, legacyId) {
  if (message?.function_call == null) return message?.tool_calls;
  const fn = message.function_call;
  if (
    (Array.isArray(message.tool_calls) && message.tool_calls.length) ||
    !fn ||
    typeof fn !== 'object' ||
    Array.isArray(fn) ||
    typeof fn.name !== 'string' ||
    !fn.name.trim() ||
    (fn.arguments != null &&
      typeof fn.arguments !== 'string' &&
      (typeof fn.arguments !== 'object' || Array.isArray(fn.arguments)))
  ) {
    const error = new TypeError('Upstream Chat tool call shape is invalid');
    error.code = 'upstream_stream_invalid_tool_arguments';
    throw error;
  }
  return [
    {
      ...(legacyId ? { id: legacyId } : {}),
      type: 'function',
      function: { name: fn.name, arguments: fn.arguments ?? '{}' },
    },
  ];
}

function toolArgumentsComplete(call, customToolNames) {
  const name = call?.function?.name || call?.name;
  if (customToolNames?.has(name)) return true;
  const args = call?.function?.arguments;
  if (args == null || args === '') return true;
  if (typeof args === 'object') return !Array.isArray(args);
  if (typeof args !== 'string') return false;
  try {
    const parsed = JSON.parse(args);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function writeIncompleteToolCall({
  clientRes,
  state,
  prepared,
  toolCall,
  itemId,
  callId,
  writeEvent,
}) {
  const custom = state.customToolNames?.has(prepared.name);
  const item = {
    id: itemId,
    type: custom ? 'custom_tool_call' : 'function_call',
    status: 'incomplete',
    call_id: callId,
    name: prepared.name,
    [custom ? 'input' : 'arguments']: prepared.args,
  };
  const base = { response_id: state.id, output_index: state.outputIndex };
  writeEvent(clientRes, 'response.output_item.added', {
    type: 'response.output_item.added',
    ...base,
    item: { ...item, status: 'in_progress' },
  });
  writeEvent(clientRes, 'response.output_item.done', {
    type: 'response.output_item.done',
    ...base,
    item,
  });
  if (!Array.isArray(state.completedOutputItems)) state.completedOutputItems = [];
  state.completedOutputItems.push(item);
  state.outputIndex += 1;
  toolCall.flushed = true;
}

module.exports = { chatResponseToolCalls, toolArgumentsComplete, writeIncompleteToolCall };
