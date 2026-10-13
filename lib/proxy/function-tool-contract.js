'use strict';

function contractError() {
  const error = new TypeError(
    'Function tool requires a valid name, object schema and boolean strict'
  );
  error.code = 'invalid_request_error';
  return error;
}

function functionToolContract(source, schemaKey = 'parameters', outputKey = schemaKey) {
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    typeof source.name !== 'string' ||
    !source.name.trim()
  )
    throw contractError();
  const schema = source[schemaKey];
  if (schema != null && (typeof schema !== 'object' || Array.isArray(schema)))
    throw contractError();
  if (source.strict != null && typeof source.strict !== 'boolean') throw contractError();
  return {
    [outputKey]: schema ?? { type: 'object', properties: {} },
    ...(source.strict != null ? { strict: source.strict } : {}),
  };
}

function validateConvertedFunctionTools(tools, shape, targetProtocol) {
  if (tools == null) return;
  if (!Array.isArray(tools)) throw contractError();
  for (const tool of tools) {
    if (shape === 'responses' && tool && tool.type !== 'function') continue;
    const source =
      shape === 'chat'
        ? tool?.function
        : shape === 'responses' && tool?.name == null && tool?.function
          ? tool.function
          : tool;
    functionToolContract(source, shape === 'claude' ? 'input_schema' : 'parameters');
    if (targetProtocol === 'Gemini' && source.strict === true) {
      const error = new TypeError(
        'Strict function tools cannot be enforced by this Gemini conversion route'
      );
      error.code = 'invalid_request_error';
      throw error;
    }
  }
}

function rejectFunctionToolContract(clientRes, parsed, shape, targetProtocol, sendJsonError) {
  try {
    validateConvertedFunctionTools(parsed?.tools, shape, targetProtocol);
    return false;
  } catch (error) {
    sendJsonError(clientRes, 400, {
      error: { type: 'invalid_request_error', message: error.message },
    });
    return true;
  }
}

module.exports = {
  functionToolContract,
  validateConvertedFunctionTools,
  rejectFunctionToolContract,
};
