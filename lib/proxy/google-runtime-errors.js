'use strict';

const CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR',
  'ERR_INVALID_URL',
  'ERR_RESPONSE_TOO_LARGE',
  'ERR_RESPONSE_ABORTED',
  'OAUTH_INVALID_GRANT',
  'OAUTH_INVALID_CLIENT',
  'OAUTH_TEMPORARILY_UNAVAILABLE',
  'OAUTH_REFRESH_REJECTED',
  'OAUTH_INVALID_RESPONSE',
]);
const STAGES = new Set([
  'credential_read',
  'oauth_refresh',
  'credential_refresh',
  'code_assist_probe',
]);

function googleRuntimeErrorSummary(error, fallbackStage = 'credential_refresh') {
  const value = error && typeof error === 'object' ? error : {};
  const code = CODES.has(value.code)
    ? value.code
    : /^Connection timeout \(\d+s\)$/.test(String(value.message || ''))
      ? 'ETIMEDOUT'
      : 'GOOGLE_RUNTIME_ERROR';
  return {
    errorType: code,
    stage: STAGES.has(value.stage)
      ? value.stage
      : STAGES.has(fallbackStage)
        ? fallbackStage
        : 'credential_refresh',
  };
}

async function withGoogleRuntimeStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    const summary = googleRuntimeErrorSummary(error, stage);
    const failure = new Error('Google runtime operation failed');
    failure.code = summary.errorType;
    failure.stage = summary.stage;
    throw failure;
  }
}

module.exports = { googleRuntimeErrorSummary, withGoogleRuntimeStage };
