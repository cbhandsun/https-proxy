'use strict';
const { functionToolContract } = require('./function-tool-contract');
const { validateDeepSeekResponsesInput } = require('./deepseek-responses-input');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function unsupported(field) {
  const error = new TypeError(
    field === 'previous_response_id' || field === 'conversation'
      ? 'DeepSeek native Responses is stateless; send full input history for continuation'
      : 'Request contains options unsupported by DeepSeek native Responses'
  );
  error.code = 'invalid_request_error';
  error.provider = 'deepseek';
  error.param = field;
  throw error;
}
const emptyObject = (value) => record(value) && Object.keys(value).length === 0;
const emptyArray = (value) => Array.isArray(value) && value.length === 0;
// DeepSeek also accepts max, which is absent from the generic OpenAI contract.
const reasoningEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const neutral = {
  store: (value) => value === false,
  background: (value) => value === false,
  parallel_tool_calls: (value) => value === true,
  truncation: (value) => value === 'disabled',
  metadata: emptyObject,
  include: emptyArray,
  context_management: emptyArray,
  stream_options: emptyObject,
};
const unsupportedFields = [
  'previous_response_id',
  'conversation',
  'max_tool_calls',
  'prompt',
  'service_tier',
  'safety_identifier',
  'prompt_cache_key',
  'prompt_cache_retention',
];
function validateDeepSeekNativeResponsesControls(body) {
  if (!record(body)) unsupported('request');
  for (const field of unsupportedFields) if (body[field] != null) unsupported(field);
  for (const [field, accepts] of Object.entries(neutral))
    if (body[field] != null && !accepts(body[field])) unsupported(field);
  if (body.reasoning != null) {
    if (
      !record(body.reasoning) ||
      (body.reasoning.effort != null && !reasoningEfforts.has(body.reasoning.effort)) ||
      body.reasoning.summary != null ||
      Object.keys(body.reasoning).some((key) => !['effort', 'summary'].includes(key))
    )
      unsupported('reasoning');
  }
  if (body.text != null) {
    if (
      !record(body.text) ||
      body.text.verbosity != null ||
      Object.keys(body.text).some((key) => !['format', 'verbosity'].includes(key))
    )
      unsupported('text');
  }
}
function validateDeepSeekNativeResponses(body) {
  validateDeepSeekNativeResponsesControls(body);
  if (body.tools != null) {
    if (!Array.isArray(body.tools)) unsupported('tools');
    for (const tool of body.tools) {
      if (
        !record(tool) ||
        (tool.type !== 'function' && !(tool.type === 'custom' && tool.name === 'apply_patch'))
      )
        unsupported('tools');
      if (tool.type === 'function') {
        try {
          functionToolContract(tool);
        } catch (error) {
          if (error?.code === 'invalid_request_error') unsupported('tools');
          throw error;
        }
      }
    }
  }
  if (body.tool_choice != null) {
    const choice = body.tool_choice;
    if (typeof choice === 'string') {
      if (!['auto', 'none', 'required'].includes(choice)) unsupported('tool_choice');
    } else if (
      !record(choice) ||
      choice.type !== 'function' ||
      typeof choice.name !== 'string' ||
      !choice.name.trim()
    )
      unsupported('tool_choice');
  }
  validateDeepSeekResponsesInput(body.input, unsupported);
}
module.exports = { validateDeepSeekNativeResponses, validateDeepSeekNativeResponsesControls };
