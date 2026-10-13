'use strict';

function applyConvertedParallelTools(result, source, target) {
  const parallel = source.parallel_tool_calls;
  if (parallel == null) return;
  if (typeof parallel !== 'boolean') {
    const error = new TypeError('parallel_tool_calls must be a boolean');
    error.code = 'invalid_request_error';
    throw error;
  }
  if (result.tool_choice?.type === 'none' || result.tool_choice === 'none') return;
  if (target === 'Gemini') {
    if (!parallel && result.tools?.length) {
      const error = new TypeError(
        'This Gemini conversion route cannot enforce parallel_tool_calls=false'
      );
      error.code = 'invalid_request_error';
      throw error;
    }
    return;
  }
  result.tool_choice = {
    ...(result.tool_choice || { type: 'auto' }),
    disable_parallel_tool_use: !parallel,
  };
}
function rejectConvertedParallelTools(clientRes, source, target, sendJsonError) {
  try {
    applyConvertedParallelTools(
      { tools: source?.tools, tool_choice: source?.tool_choice },
      source || {},
      target
    );
    return false;
  } catch (error) {
    if (error.code !== 'invalid_request_error') throw error;
    sendJsonError(clientRes, 400, {
      error: { type: 'invalid_request_error', message: error.message },
    });
    return true;
  }
}
module.exports = { applyConvertedParallelTools, rejectConvertedParallelTools };
