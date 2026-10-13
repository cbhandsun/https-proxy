'use strict';

const {
  parseOpenAIReasoningEffort,
  supportsGeminiThinkingLevel,
  geminiThinkingConfigFromOpenAI,
} = require('./reasoning-adapter');
const {
  convertedServiceTier,
  geminiServiceTier,
  validateGeminiServiceTier,
} = require('./converted-service-tier');
const { validateSchemaKeywords } = require('./output-schema-contract');
const { supportsGeminiThinkingBudget } = require('./gemini-thinking-contract');
// These capabilities belong to validated in-process requests, never JSON input.
const geminiOutputSchema = Symbol('validatedGeminiOutputSchema');
const responsesThinkingSummary = Symbol('validatedResponsesThinkingSummary');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalidOptions() {
  const error = new TypeError(
    'Claude modern request options cannot be preserved by this conversion target'
  );
  error.code = 'invalid_request_error';
  throw error;
}
function validateOutputSchema(schema) {
  if (!record(schema)) invalidOptions();
  const ancestors = new Set();
  let nodes = 0;
  function visit(value, depth) {
    if (++nodes > 10000 || depth > 64) invalidOptions();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || ancestors.has(value)) invalidOptions();
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      invalidOptions();
    ancestors.add(value);
    for (const child of Object.values(value)) visit(child, depth + 1);
    ancestors.delete(value);
  }
  visit(schema, 0);
  return validateSchemaKeywords(schema, invalidOptions);
}
function validateGeminiOutputSchema(schema) {
  validateOutputSchema(schema);
  // Gemini accepts only a JSON Schema subset. In particular oneOf behaves as
  // anyOf, so forwarding it would weaken exclusive-union semantics.
  const keys = new Set([
    '$id',
    '$anchor',
    'type',
    'format',
    'title',
    'description',
    'enum',
    'items',
    'prefixItems',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
    'anyOf',
    'properties',
    'additionalProperties',
    'required',
    'propertyOrdering',
  ]);
  function check(node) {
    if (!record(node) || Object.keys(node).some((key) => !keys.has(key))) invalidOptions();
    if (
      node.enum != null &&
      (!Array.isArray(node.enum) ||
        node.enum.some((value) => !['string', 'number'].includes(typeof value)))
    )
      invalidOptions();
    for (const key of ['items', 'additionalProperties']) if (record(node[key])) check(node[key]);
    if (node.items != null && !record(node.items)) invalidOptions();
    if (
      node.additionalProperties != null &&
      typeof node.additionalProperties !== 'boolean' &&
      !record(node.additionalProperties)
    )
      invalidOptions();
    for (const key of ['prefixItems', 'anyOf'])
      if (node[key] != null) {
        if (!Array.isArray(node[key])) invalidOptions();
        node[key].forEach(check);
      }
    if (node.properties != null) {
      if (!record(node.properties)) invalidOptions();
      Object.values(node.properties).forEach(check);
    }
  }
  check(schema);
  return schema;
}
function normalizeClaudeModernOptions(body, target, options = {}) {
  if (!record(body)) invalidOptions();
  if (
    target === 'Gemini' &&
    options.codeAssist === true &&
    (body[geminiOutputSchema] || body.output_config?.format != null)
  )
    invalidOptions();
  convertedServiceTier(body.service_tier, 'claude', target, options);
  if (target === 'Gemini') validateGeminiServiceTier(body[geminiServiceTier], options);
  const config = body.output_config;
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== 'boolean')
    invalidOptions();
  const thinking = body.thinking;
  if (
    thinking != null &&
    (!record(thinking) || !['enabled', 'disabled', 'adaptive'].includes(thinking.type))
  )
    invalidOptions();
  if (
    config != null &&
    (!record(config) || Object.keys(config).some((key) => !['effort', 'format'].includes(key)))
  )
    invalidOptions();
  const adaptive = thinking?.type === 'adaptive';
  const parallel = body.tool_choice?.disable_parallel_tool_use;
  if (parallel != null && typeof parallel !== 'boolean') invalidOptions();
  if (!adaptive && config == null && thinking?.display == null && parallel == null) return body;
  const result = { ...body };
  if (parallel != null) {
    if (body.parallel_tool_calls != null && body.parallel_tool_calls !== !parallel)
      invalidOptions();
    result.parallel_tool_calls = !parallel;
    if (target === 'Gemini' && parallel && body.tools?.length && body.tool_choice?.type !== 'none')
      invalidOptions();
  }
  if (thinking?.display != null) {
    if (!['enabled', 'adaptive'].includes(thinking.type)) invalidOptions();
    if (thinking.display !== 'summarized' || target !== 'Responses') invalidOptions();
    result[responsesThinkingSummary] = true;
  }
  if (adaptive && Object.keys(thinking).some((key) => !['type', 'display'].includes(key)))
    invalidOptions();
  const effort = config?.effort ?? (adaptive ? 'high' : null);
  if (effort != null) {
    if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) invalidOptions();
    if (thinking?.type === 'disabled') invalidOptions();
    if (
      target === 'Gemini' &&
      !supportsGeminiThinkingLevel(options.model) &&
      !supportsGeminiThinkingBudget(options.model)
    )
      invalidOptions();
    const prior = parseOpenAIReasoningEffort(body);
    if (!prior.valid || (prior.effort && prior.effort !== effort)) invalidOptions();
    result.reasoning_effort = effort;
  }
  if (adaptive) {
    delete result.thinking;
    if (target === 'Responses') result[responsesThinkingSummary] = true;
  }
  if (config?.format != null) {
    const format = config.format;
    if (
      !record(format) ||
      format.type !== 'json_schema' ||
      Object.keys(format).some((key) => !['type', 'schema'].includes(key))
    )
      invalidOptions();
    const schema = validateOutputSchema(format.schema);
    if (target === 'Gemini' && /[- ]image(?:[- ]|$)/i.test(options.model || '')) invalidOptions();
    const mapped = {
      type: 'json_schema',
      json_schema: { name: 'claude_output', schema, strict: true },
    };
    if (body.response_format != null) validateOutputSchema(body.response_format);
    if (
      body.response_format != null &&
      JSON.stringify(body.response_format) !== JSON.stringify(mapped)
    )
      invalidOptions();
    result.response_format = mapped;
    if (target === 'Gemini') result[geminiOutputSchema] = validateGeminiOutputSchema(schema);
  }
  delete result.output_config;
  return result;
}
function rejectClaudeModernOptions(clientRes, body, target, sendJsonError, options) {
  try {
    const normalized = normalizeClaudeModernOptions(body, target, options);
    if (target === 'Gemini' && options?.model)
      geminiThinkingConfigFromOpenAI(normalized, options.model);
    return false;
  } catch (error) {
    if (error.code !== 'invalid_request_error') throw error;
    sendJsonError(clientRes, 400, {
      error: { type: 'invalid_request_error', message: error.message },
    });
    return true;
  }
}
module.exports = {
  geminiOutputSchema,
  responsesThinkingSummary,
  normalizeClaudeModernOptions,
  rejectClaudeModernOptions,
  validateOutputSchema,
  validateGeminiOutputSchema,
};
