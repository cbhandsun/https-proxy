'use strict';

const TYPES = new Set([
  'api_error',
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'rate_limit_error',
  'overloaded_error',
  'proxy_error',
  'google_official_auth_unavailable',
  'upstream_response_too_large',
  'conversion_failed',
]);
const CODES = new Set([
  'INTERNAL',
  'UNAVAILABLE',
  'RESOURCE_EXHAUSTED',
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'ANTIGRAVITY_TOKEN_REFRESH_FAILED',
  'upstream_stream_error',
  'upstream_stream_incomplete',
  'upstream_stream_invalid_event',
]);

function captureAuditErrorSummary(auditData, payload) {
  if (!auditData || !payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const error = payload.error || (payload.type === 'response.failed' && payload.response?.error);
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  auditData.errorType = TYPES.has(error.type) ? error.type : 'upstream_error';
  if (CODES.has(error.code)) auditData.errorCode = error.code;
  else if (Number.isInteger(error.code) && error.code >= 400 && error.code <= 599)
    auditData.errorCode = error.code;
  if (CODES.has(error.status)) auditData.upstreamErrorStatus = error.status;
  return true;
}

module.exports = { captureAuditErrorSummary };
