'use strict';

const UNSUPPORTED_INPUT_TYPES =
  /^(input_image|input_audio|input_video|input_file|image|audio|video|file)$/;

function hasUnsupportedInputPart(value) {
  if (Array.isArray(value)) return value.some(hasUnsupportedInputPart);
  if (!value || typeof value !== 'object') return false;
  if (typeof value.type === 'string' && UNSUPPORTED_INPUT_TYPES.test(value.type)) return true;
  return hasUnsupportedInputPart(value.content);
}

const TOOL_HISTORY_INPUT_TYPES = new Set([
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'tool_call',
  'tool_call_output',
  'call',
]);

function hasToolHistoryInput(value) {
  if (Array.isArray(value)) return value.some(hasToolHistoryInput);
  if (!value || typeof value !== 'object') return false;
  if (TOOL_HISTORY_INPUT_TYPES.has(value.type)) return true;
  return hasToolHistoryInput(value.content);
}

function unsupportedTianxiResponsesFeature(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (hasUnsupportedInputPart(body.input)) return 'input';
  if (
    Object.hasOwn(body, 'tools') &&
    (!Array.isArray(body.tools) ||
      (body.tools.length > 0 &&
        (options.nativeReadTools !== true ||
          body.tools.length > 128 ||
          body.tools.some((tool) => !tool || typeof tool !== 'object' || Array.isArray(tool)))))
  ) {
    return 'tools';
  }
  if (body.tool_choice != null && !['auto', 'none'].includes(body.tool_choice)) {
    return 'tool_choice';
  }
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== 'boolean') {
    return 'parallel_tool_calls';
  }
  if (body.previous_response_id != null && options.responseHistory !== true) {
    return 'previous_response_id';
  }
  if (hasToolHistoryInput(body.input) && options.toolHistory !== true) return 'tool_history';
  return null;
}

module.exports = { unsupportedTianxiResponsesFeature };
