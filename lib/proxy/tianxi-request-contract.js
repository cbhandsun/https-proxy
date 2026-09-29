'use strict';

const UNSUPPORTED_INPUT_TYPES =
  /^(input_image|input_audio|input_video|input_file|image|audio|video|file)$/;

function hasUnsupportedInputPart(value) {
  if (Array.isArray(value)) return value.some(hasUnsupportedInputPart);
  if (!value || typeof value !== 'object') return false;
  if (typeof value.type === 'string' && UNSUPPORTED_INPUT_TYPES.test(value.type)) return true;
  return hasUnsupportedInputPart(value.content);
}

function hasFunctionCallOutputInput(value) {
  if (Array.isArray(value)) return value.some(hasFunctionCallOutputInput);
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'function_call_output') return true;
  return hasFunctionCallOutputInput(value.content);
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
  if (body.previous_response_id != null && options.responseHistory !== true) {
    return 'previous_response_id';
  }
  if (hasFunctionCallOutputInput(body.input)) return 'function_call_output';
  return null;
}

module.exports = { unsupportedTianxiResponsesFeature };
