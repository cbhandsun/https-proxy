'use strict';

function invalidScalar() {
  const error = new TypeError('Converted request scalar options have invalid types or ranges');
  error.code = 'invalid_request_error';
  throw error;
}
function validateConvertedRequestScalars(source, target) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) invalidScalar();
  if (source.stream != null && typeof source.stream !== 'boolean') invalidScalar();
  resolveConvertedOutputTokenLimit(source);
  for (const key of ['temperature', 'top_p']) {
    const value = source[key];
    const maximum = key === 'temperature' && target !== 'Claude' ? 2 : 1;
    if (
      value != null &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum)
    )
      invalidScalar();
  }
}
function resolveConvertedOutputTokenLimit(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) invalidScalar();
  let limit;
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    const value = source[key];
    if (value == null) continue;
    if (!Number.isSafeInteger(value) || value <= 0) invalidScalar();
    if (limit !== undefined && value !== limit) invalidScalar();
    limit = value;
  }
  return limit;
}
module.exports = { validateConvertedRequestScalars, resolveConvertedOutputTokenLimit };
