'use strict';

const { convertedOutputFormat } = require('./converted-output-format');
const { normalizeClaudeModernOptions } = require('./claude-modern-options');
const { shouldConvertResponsesToOpenAIChat } = require('./responses-routing-policy');
const { normalizeDeepSeekSearchHistory } = require('./deepseek-search-history');
const {
  parseDeepSeekClaudeReasoning,
  applyDeepSeekClaudeReasoning,
} = require('./deepseek-claude-reasoning');
const {
  validateDeepSeekNativeResponses,
  validateDeepSeekNativeResponsesControls,
} = require('./deepseek-responses-contract');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const models = new Set(['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-pro']);

function invalidRequest() {
  const error = new TypeError(
    'Requested output format is invalid or unsupported by this DeepSeek endpoint'
  );
  error.code = 'invalid_request_error';
  error.provider = 'deepseek';
  throw error;
}
function isDeepSeekOfficialTarget(prepared) {
  const profile = prepared?.profile;
  if (
    !profile ||
    !['openai', 'openai-chat', 'claude', 'openai-responses'].includes(profile.protocol)
  )
    return false;
  try {
    const url = new URL(profile.targetUrl);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.deepseek.com' &&
      (!url.port || url.port === '443')
    );
  } catch {
    return false;
  }
}
function coveredModel(model) {
  return typeof model === 'string' && models.has(model.replace(/^deepseek\//i, '').toLowerCase());
}
function coveredResponsesTarget(prepared) {
  if (!isDeepSeekOfficialTarget(prepared)) return false;
  const model =
    prepared?.rewriteTo && prepared.rewriteTo !== '-' ? prepared.rewriteTo : prepared?.model;
  return coveredModel(model);
}
function preflightDeepSeekResponsesBody(prepared, body) {
  if (!coveredResponsesTarget(prepared)) return body;
  validateDeepSeekNativeResponses(body);
  return normalizeDeepSeekSearchHistory(body);
}
function preflightDeepSeekResponsesControls(prepared, body) {
  if (coveredResponsesTarget(prepared)) validateDeepSeekNativeResponsesControls(body);
}
function prepareDeepSeekClaudeReasoning(prepared, body) {
  return coveredResponsesTarget(prepared) && prepared.profile.protocol === 'claude'
    ? parseDeepSeekClaudeReasoning(body)
    : null;
}
function validateDeepSeekOutputFormat(body, shape, model, targetProtocol) {
  if (!coveredModel(model)) return;
  if (!record(body) || !['chat', 'responses', 'claude'].includes(shape)) invalidRequest();
  try {
    const formatBody =
      shape === 'claude' && targetProtocol === 'claude'
        ? parseDeepSeekClaudeReasoning(body).source
        : body;
    const normalized = shape === 'claude' ? normalizeClaudeModernOptions(formatBody, 'Chat') : body;
    const format = convertedOutputFormat(
      normalized,
      shape === 'claude' ? 'chat' : shape,
      'Chat',
      model
    );
    // Official Chat documents text/json_object only. Live controls also show
    // ignored schemas through native Claude and native Responses endpoints.
    // A schema-shaped reply is not proof of schema enforcement.
    if (format?.type === 'json_schema' || (format && targetProtocol === 'claude')) invalidRequest();
  } catch (error) {
    if (error?.code !== 'invalid_request_error') throw error;
    invalidRequest();
  }
}
function preflightDeepSeekRequest(prepared, { requestPath, requestEncoding } = {}) {
  if (!isDeepSeekOfficialTarget(prepared)) return;
  const model =
    typeof prepared.rewriteTo === 'string' && prepared.rewriteTo && prepared.rewriteTo !== '-'
      ? prepared.rewriteTo
      : prepared.model;
  if (!coveredModel(model)) return;
  const path = typeof requestPath === 'string' ? requestPath.split('?')[0] : '';
  const shape = /\/chat\/completions\/?$/.test(path)
    ? 'chat'
    : /\/responses\/?$/.test(path)
      ? 'responses'
      : /\/messages\/?$/.test(path)
        ? 'claude'
        : null;
  if (!shape) return;
  if ((requestEncoding && requestEncoding !== 'identity') || !Buffer.isBuffer(prepared.buffer))
    invalidRequest();
  let body;
  try {
    body = JSON.parse(prepared.buffer.toString('utf8'));
  } catch {
    invalidRequest();
  }
  const reasoningPlan = prepareDeepSeekClaudeReasoning(prepared, body);
  validateDeepSeekOutputFormat(body, shape, model, prepared.profile.protocol);
  if (
    shape === 'responses' &&
    prepared.profile.protocol !== 'claude' &&
    !shouldConvertResponsesToOpenAIChat(prepared.profile)
  ) {
    const normalized = preflightDeepSeekResponsesBody(prepared, body);
    if (normalized !== body) {
      prepared.buffer = Buffer.from(JSON.stringify(normalized));
      prepared.bodyChanged = true;
    }
  }
  if (shape === 'claude' && reasoningPlan?.effort != null) {
    prepared.buffer = Buffer.from(
      JSON.stringify(applyDeepSeekClaudeReasoning(reasoningPlan.source, reasoningPlan))
    );
    prepared.bodyChanged = true;
  }
}
module.exports = {
  isDeepSeekOfficialTarget,
  validateDeepSeekOutputFormat,
  preflightDeepSeekRequest,
  preflightDeepSeekResponsesBody,
  preflightDeepSeekResponsesControls,
  prepareDeepSeekClaudeReasoning,
};
