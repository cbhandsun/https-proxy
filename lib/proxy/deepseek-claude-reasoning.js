'use strict';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const efforts = {
  none: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
};
function invalid() {
  const error = new TypeError('DeepSeek Anthropic reasoning controls cannot preserve this request');
  error.code = 'invalid_request_error';
  error.provider = 'deepseek';
  throw error;
}
function parseDeepSeekClaudeReasoning(body) {
  if (!record(body)) invalid();
  let effort;
  function select(value) {
    if (value == null) return;
    if (typeof value !== 'string' || !Object.hasOwn(efforts, value)) invalid();
    const selected = efforts[value];
    if (effort != null && effort !== selected) invalid();
    effort = selected;
  }
  select(body.reasoning_effort);
  if (body.reasoning != null) {
    if (!record(body.reasoning) || Object.keys(body.reasoning).some((key) => key !== 'effort'))
      invalid();
    select(body.reasoning.effort);
  }
  if (body.output_config != null) {
    if (
      !record(body.output_config) ||
      Object.keys(body.output_config).some((key) => !['effort', 'format'].includes(key))
    )
      invalid();
    select(body.output_config.effort);
  }
  if (body.thinking != null) {
    if (
      !record(body.thinking) ||
      !['enabled', 'disabled', 'adaptive'].includes(body.thinking.type) ||
      Object.keys(body.thinking).some((key) => key !== 'type')
    )
      invalid();
    // The upstream ignores numeric budgets; accepting them would promise a cap it cannot enforce.
    if (body.thinking.type === 'disabled') select('none');
    else if (effort === 'none') invalid();
    else if (effort == null) effort = 'high';
  }
  const source = { ...body };
  delete source.reasoning;
  delete source.reasoning_effort;
  delete source.thinking;
  if (body.output_config != null) {
    source.output_config = { ...body.output_config };
    delete source.output_config.effort;
    if (Object.keys(source.output_config).length === 0) delete source.output_config;
  }
  return { source, effort };
}
function applyDeepSeekClaudeReasoning(result, plan) {
  if (!plan || plan.effort == null) return result;
  result.thinking = { type: plan.effort === 'none' ? 'disabled' : 'enabled' };
  if (plan.effort !== 'none')
    result.output_config = { ...result.output_config, effort: plan.effort };
  return result;
}
module.exports = { parseDeepSeekClaudeReasoning, applyDeepSeekClaudeReasoning };
