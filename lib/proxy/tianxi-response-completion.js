'use strict';

// Native execution progress is not a substitute for the model's final answer.
// Client-owned calls may complete a Responses turn for tool-result continuation.
function tianxiCompletionDetails(state, interrupted) {
  if (state.status === 'failed') return { status: 'failed', incomplete_details: null };
  let reason = null;
  if (interrupted) reason = 'tianxi_native_stream_interrupted';
  else if (state.pendingToolCalls.size > 0) reason = 'tianxi_tool_calls_pending';
  else if (state.pendingNativePermissions.size > 0) reason = 'tianxi_native_permission_required';
  else if (!state.terminalCompleted) reason = 'tianxi_terminal_status_missing';
  else if (state.internalToolCalls.size > 0) reason = 'tianxi_native_tools_pending';
  else {
    const hasAnswer = state.text.trim().length > 0;
    const hasClientOutput = state.output.some((item) =>
      [
        'function_call',
        'function_call_output',
        'custom_tool_call',
        'custom_tool_call_output',
      ].includes(item.type)
    );
    if (!hasAnswer && !hasClientOutput) reason = 'tianxi_empty_completion';
  }
  return reason
    ? { status: 'incomplete', incomplete_details: { reason } }
    : { status: 'completed', incomplete_details: null };
}

module.exports = { tianxiCompletionDetails };
