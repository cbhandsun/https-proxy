'use strict';
const { applyConvertedParallelTools } = require('./converted-parallel-tools');
const {
  validateConvertedRequestScalars,
  resolveConvertedOutputTokenLimit,
} = require('./converted-request-scalars');
const { applyConvertedOutputFormat } = require('./converted-output-format');
const { applyConvertedServiceTier } = require('./converted-service-tier');
const { applyResponsesHistoryPolicy } = require('./responses-history-policy');
const {
  validateResponsesEndpointOptions,
  applyResponsesEndpointOptions,
} = require('./responses-endpoint-options');
const { classifyResponsesWebSearchTools } = require('./openai-web-search-tools');
const {
  functionToolContract,
  validateConvertedFunctionTools,
} = require('./function-tool-contract');
const {
  extractCanonicalReasoning,
  applyReasoningToClaude,
  parseOpenAIReasoningEffort,
} = require('./reasoning-adapter');
const { applyNativeGeminiReasoning } = require('./native-reasoning-controls');
const { invalidHistory } = require('./responses-semantic-history');
function responsesTargetOptions(source, model, target) {
  validateResponsesEndpointOptions(source, target, model);
  validateConvertedRequestScalars(source, target);
  if (!source || typeof source !== 'object' || Array.isArray(source)) invalidHistory();
  if (source.tools != null && !Array.isArray(source.tools)) invalidHistory();
  const config = {
    model,
    max_tokens: resolveConvertedOutputTokenLimit(source) ?? 4096,
  };
  applyConvertedOutputFormat(config, source, 'responses', target, model);
  applyResponsesHistoryPolicy(config, source);
  applyConvertedServiceTier(config, source, 'openai', target);
  if (source.stream === true) config.stream = true;
  for (const key of ['temperature', 'top_p']) if (source[key] != null) config[key] = source[key];
  if (target === 'Gemini') applyNativeGeminiReasoning(config, source, model);
  else
    applyReasoningToClaude(config, extractCanonicalReasoning(source), {
      explicitOutputLimit: resolveConvertedOutputTokenLimit(source) !== undefined,
      model,
      relativeEffort: Boolean(parseOpenAIReasoningEffort(source).effort),
    });
  applyResponsesEndpointOptions(config, source, target, model);
  config.reasoning_effort = source.reasoning?.effort ?? source.reasoning_effort;
  const allTools = source.tools == null ? [] : [...source.tools];
  for (const item of Array.isArray(source.input) ? source.input : [])
    if (item?.type === 'additional_tools') {
      if (!Array.isArray(item.tools)) invalidHistory();
      allTools.push(...item.tools);
    }
  // Validate before the shared classifier recursively flattens namespaces.
  let toolCount = 0;
  function validateTools(entries, depth = 0) {
    if (depth > 64 || !Array.isArray(entries)) invalidHistory();
    for (const entry of entries) {
      if (++toolCount > 4096 || !entry || typeof entry !== 'object' || Array.isArray(entry))
        invalidHistory();
      if (entry.type === 'namespace') validateTools(entry.tools ?? entry.functions, depth + 1);
    }
  }
  validateTools(allTools);
  const classified = classifyResponsesWebSearchTools(
    allTools,
    source.__disableManagedWebSearchPromotion === true,
    source
  );
  if (classified.useNativeSearch) config.__nativeWebSearch = 'gemini-google-search';
  if (classified.managedFallback) config.__managedWebSearchFallback = classified.managedFallback;
  if (
    classified.managedFallback ||
    classified.functionTools.some(
      (tool) => (tool.name || tool.function?.name)?.toLowerCase() === 'web_search'
    )
  )
    config.__managedWebSearchHistoryAsText = true;
  const names = new Set();
  const tools = [];
  for (const tool of classified.functionTools) {
    const fn = tool.function || tool;
    const name = fn.name;
    const normalized = {
      type: 'function',
      name,
      description: fn.description || '',
      parameters: fn.parameters ?? fn.input_schema,
      ...(fn.strict != null ? { strict: fn.strict } : {}),
    };
    validateConvertedFunctionTools([normalized], 'responses', target);
    if (names.has(name)) continue;
    names.add(name);
    const contract = functionToolContract(normalized, 'parameters', 'input_schema');
    tools.push({ name, description: normalized.description, ...contract });
  }
  if (tools.length) config.tools = tools;
  const choice = source.tool_choice;
  if (choice === 'none' || choice?.type === 'none') config.tool_choice = { type: 'none' };
  else if (choice === 'required' || choice?.type === 'required')
    config.tool_choice = { type: 'any' };
  else if (choice?.type === 'function') {
    const name = choice.name || choice.function?.name;
    if (typeof name !== 'string' || !names.has(name)) invalidHistory();
    config.tool_choice = { type: 'tool', name };
  } else if (choice != null && choice !== 'auto' && choice?.type !== 'auto') invalidHistory();
  applyConvertedParallelTools(config, source, target);
  return config;
}
module.exports = { responsesTargetOptions };
