'use strict';
const { createGeminiPartialArguments } = require('./gemini-partial-arguments');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalidInput() {
  const error = new TypeError('Invalid upstream Gemini tool arguments');
  error.code = 'upstream_stream_invalid_tool_arguments';
  return error;
}

// The compatibility argument merger tolerates malformed JSON. Validate first so
// invalid native input cannot become an executable empty object.
function validateGeminiFunctionInput(call, { allowMissingName = false } = {}) {
  if (
    !record(call) ||
    (call.name != null && (typeof call.name !== 'string' || !call.name.trim())) ||
    (!allowMissingName && (typeof call.name !== 'string' || !call.name.trim())) ||
    (call.id != null && (typeof call.id !== 'string' || !call.id)) ||
    call.partialArgs != null ||
    (call.willContinue != null && call.willContinue !== false)
  )
    throw invalidInput();
  for (const key of ['args', 'arguments', 'parameters', 'input']) {
    if (call[key] === undefined) continue;
    let value = call[key];
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        throw invalidInput();
      }
    }
    if (!record(value)) throw invalidInput();
  }
}

function normalizeCompletedGeminiFunctionInput(call, protocolOptions) {
  if (record(call) && (call.partialArgs != null || call.willContinue === true)) {
    const partial = createGeminiPartialArguments(protocolOptions);
    partial.append(call);
    return partial.finish()[0];
  }
  validateGeminiFunctionInput(call);
  return call;
}
module.exports = { validateGeminiFunctionInput, normalizeCompletedGeminiFunctionInput };
