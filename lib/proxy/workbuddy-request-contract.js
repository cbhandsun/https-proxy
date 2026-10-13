'use strict';

const { convertedOutputFormat } = require('./converted-output-format');
const { normalizeClaudeModernOptions } = require('./claude-modern-options');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalidRequest() {
  const error = new TypeError(
    'Requested output format or tool choice cannot be preserved by this WorkBuddy model'
  );
  error.code = 'invalid_request_error';
  throw error;
}

function isWorkBuddyTarget(prepared) {
  return Boolean(
    prepared &&
    (prepared.authProvider === 'workbuddy' || prepared.profile?.protocol === 'workbuddy')
  );
}

function coveredModel(model) {
  // Live controls certify this model only. Do not infer limitations for every
  // model in WorkBuddy's catalog from one account/model's capability results.
  return (
    typeof model === 'string' &&
    model.replace(/^(?:workbuddy|codebuddy)\//i, '').toLowerCase() === 'deepseek-v4-flash'
  );
}

function validateWorkBuddyRequest(body, shape, model) {
  if (!coveredModel(model)) return;
  if (!record(body) || !['chat', 'responses', 'claude'].includes(shape)) invalidRequest();
  try {
    if (shape === 'claude') {
      const normalized = normalizeClaudeModernOptions(body, 'Chat');
      if (convertedOutputFormat(normalized, 'chat', 'Chat', model)) invalidRequest();
    } else if (convertedOutputFormat(body, shape, 'Chat', model)) invalidRequest();
  } catch (error) {
    if (error.code !== 'invalid_request_error') throw error;
    invalidRequest();
  }
  const choice = body.tool_choice;
  if (choice == null) return;
  if (shape === 'claude') {
    if (
      !record(choice) ||
      !['auto', 'none'].includes(choice.type) ||
      Object.keys(choice).some((key) => !['type', 'disable_parallel_tool_use'].includes(key)) ||
      (choice.disable_parallel_tool_use != null &&
        typeof choice.disable_parallel_tool_use !== 'boolean')
    )
      invalidRequest();
  } else if (choice !== 'auto' && choice !== 'none') invalidRequest();
}

function preflightWorkBuddyRequest(prepared, { requestPath, requestEncoding } = {}) {
  if (!isWorkBuddyTarget(prepared)) return;
  const pathname = typeof requestPath === 'string' ? requestPath.split('?')[0] : '';
  const shape = /\/chat\/completions\/?$/.test(pathname)
    ? 'chat'
    : /\/responses\/?$/.test(pathname)
      ? 'responses'
      : /\/messages\/?$/.test(pathname)
        ? 'claude'
        : null;
  if (!shape) return;
  const model =
    typeof prepared.rewriteTo === 'string' && prepared.rewriteTo && prepared.rewriteTo !== '-'
      ? prepared.rewriteTo
      : prepared.model;
  if (!coveredModel(model)) return;
  if (requestEncoding && requestEncoding !== 'identity') invalidRequest();
  if (!Buffer.isBuffer(prepared.buffer)) invalidRequest();
  let body;
  try {
    body = JSON.parse(prepared.buffer.toString('utf8'));
  } catch (_) {
    invalidRequest();
  }
  validateWorkBuddyRequest(body, shape, model);
}

module.exports = { isWorkBuddyTarget, validateWorkBuddyRequest, preflightWorkBuddyRequest };
