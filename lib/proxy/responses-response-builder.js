'use strict';

const {
  appendChatToolCallsAsResponses,
  collectCustomToolNames,
} = require('./responses-custom-tools');
const { claudeUsageToResponsesUsage } = require('./protocol-usage-details');
const {
  createConversionStreamBudget,
  conversionFailureCode,
} = require('./conversion-stream-budget');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function createResponsesResponseBuilder({
  fallbackId,
  stableCreated,
  cleanToolArgs,
  inferToolNameFromArguments,
  functionCallItemId,
  functionCallCallId,
  protocolOptions,
}) {
  return function build({
    parts,
    id,
    model,
    stopReason,
    usage,
    options = {},
    textForPart,
    isThinking,
    failureCode,
  }) {
    if (
      !Array.isArray(parts) ||
      typeof id !== 'string' ||
      !id ||
      parts.some(
        (part) =>
          !record(part) ||
          ['text', 'thinking', 'signature'].some(
            (key) => part[key] != null && typeof part[key] !== 'string'
          ) ||
          (part.id != null && (typeof part.id !== 'string' || !part.id))
      )
    )
      throw new TypeError('Invalid upstream response content');
    const budget = createConversionStreamBudget(protocolOptions);
    const budgetState = {};
    const output = [];
    const reasoning = parts
      .filter(isThinking)
      .map((part) => part.thinking || part.signature || '')
      .join('');
    const text = parts
      .filter((part) => part.type !== 'tool_use' && !isThinking(part))
      .map(textForPart)
      .join('');
    if (reasoning)
      output.push({
        id: fallbackId('rsn', { model, text: reasoning }),
        type: 'reasoning',
        status: 'completed',
        summary: reasoning,
      });
    if (text)
      output.push({
        id: fallbackId('msg', { model, text }),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    let reason;
    if (['max_tokens', 'model_context_window_exceeded'].includes(stopReason))
      reason = 'max_output_tokens';
    else if (stopReason === 'refusal') reason = 'content_filter';
    else if (!['end_turn', 'stop_sequence', 'tool_use', 'pause_turn'].includes(stopReason))
      failureCode ||= 'upstream_stream_incomplete';
    const calls = [];
    try {
      budget.consume(budgetState, reasoning);
      budget.consume(budgetState, text);
      if (!reason && !failureCode && stopReason !== 'pause_turn') {
        for (const [index, part] of parts.filter((part) => part.type === 'tool_use').entries()) {
          if (!record(part.input) || typeof part.name !== 'string' || !part.name.trim()) {
            failureCode = 'upstream_stream_invalid_tool_arguments';
            break;
          }
          budget.appendArguments({}, JSON.stringify(part.input));
          const input = cleanToolArgs(part.name, part.input);
          if (!record(input)) {
            failureCode = 'upstream_stream_invalid_tool_arguments';
            break;
          }
          const args = JSON.stringify(input);
          budget.addTool(budgetState);
          budget.appendArguments({}, args);
          budget.consume(budgetState, args);
          calls.push({
            id: part.id || fallbackId('call', { index, name: part.name, input }),
            type: 'function',
            function: { name: part.name, arguments: args },
          });
        }
      }
    } catch (error) {
      failureCode = conversionFailureCode(error);
      if (failureCode === 'upstream_stream_conversion_limit') output.length = 0;
    }
    if (!failureCode)
      appendChatToolCallsAsResponses({
        output,
        toolCalls: calls,
        customToolNames: collectCustomToolNames(options),
        fallbackId,
        inferToolNameFromArguments,
        functionCallItemId,
        functionCallCallId,
      });
    const normalizedUsage = claudeUsageToResponsesUsage(usage) || {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
    if (!normalizedUsage.cached_input_tokens) delete normalizedUsage.cached_input_tokens;
    return {
      id: id.replace(/^chatcmpl/, 'resp'),
      object: 'response',
      created_at: stableCreated(id),
      status: failureCode ? 'failed' : reason ? 'incomplete' : 'completed',
      ...(failureCode
        ? {
            error: {
              code: failureCode,
              message: 'Upstream response could not be completed safely',
            },
          }
        : {}),
      ...(reason ? { incomplete_details: { reason } } : {}),
      model,
      output,
      usage: normalizedUsage,
    };
  };
}

module.exports = { createResponsesResponseBuilder };
