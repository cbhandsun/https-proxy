'use strict';
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');

const CODES = new Set([
  'server_error',
  'internal_error',
  'internal_server_error',
  'upstream_response_failed',
  'upstream_stream_error',
  'upstream_stream_incomplete',
  'upstream_stream_invalid_event',
  'invalid_prompt',
  'server_is_overloaded',
  'invalid_request_error',
  'rate_limit_exceeded',
  'usage_limit_reached',
  'insufficient_quota',
  'context_length_exceeded',
  'invalid_api_key',
  'invalid_token',
  'authentication_error',
  'permission_error',
  'model_not_found',
  'unsupported_parameter',
  'invalid_tool_arguments',
  'tool_execution_error',
  'overloaded_error',
]);
const TYPES = new Set([
  'api_error',
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'rate_limit_error',
  'overloaded_error',
  'proxy_error',
  'server_error',
  'service_unavailable_error',
  'upstream_response_error',
  'upstream_stream_error',
]);
const REASONS = {
  quota: /quota|usage limit|no balance|credits exhausted/i,
  rate_limit: /rate limit|requests.per.minute|tokens.per.minute/i,
  authentication: /authenticat|invalid.api.key|invalid.token|bearer/i,
  tool: /tool|function|code mode/i,
  invalid_request: /invalid|unsupported|unrecognized/i,
  policy: /policy|permission|refus/i,
  context: /context|too large|token limit/i,
  network: /connection|timeout|fetch failed|network|dns|socket/i,
  server: /server|internal|overload/i,
  compaction: /compact/i,
};

// Content-free classification only. Heuristics are hints, never a root-cause gate.
function summarizeNativeBenchmarkFailure(payload) {
  let value;
  try {
    value = normalizeCompactionData(payload, 256 * 1024);
  } catch {
    return { observationValid: false };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { observationValid: false };
  const error = value.error ?? value.response?.error ?? value;
  const message =
    typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  return {
    observationValid: true,
    code: CODES.has(error?.code) ? error.code : null,
    errorType: TYPES.has(error?.type) ? error.type : null,
    errorShape: error === null ? 'null' : Array.isArray(error) ? 'array' : typeof error,
    messagePresent: message.length > 0,
    hints: Object.keys(REASONS).filter((name) => REASONS[name].test(message.slice(0, 16384))),
  };
}

module.exports = { summarizeNativeBenchmarkFailure };
