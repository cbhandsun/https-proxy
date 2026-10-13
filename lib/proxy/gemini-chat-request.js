'use strict';
const { applyConvertedParallelTools } = require('./converted-parallel-tools');
const { applyConvertedOutputFormat } = require('./converted-output-format');
const { applyConvertedServiceTier } = require('./converted-service-tier');
const { resolveConvertedOutputTokenLimit } = require('./converted-request-scalars');

const { validateChatMessages } = require('./responses-request-options');
const {
  functionToolContract,
  validateConvertedFunctionTools,
} = require('./function-tool-contract');
const { applyContextBudgetToMessages, resolveContextBudget } = require('./context-budget-manager');
const { estimatePayloadTokens } = require('./protocol-openai-message-normalization');
const { applyNativeGeminiReasoning } = require('./native-reasoning-controls');
const {
  chatPartToGemini,
  chatContentToGemini,
  validateGeminiChatHistory,
  createGeminiChatHistoryAdapter,
} = require('./gemini-chat-history');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function textContent(value) {
  return (
    value == null ||
    typeof value === 'string' ||
    (Array.isArray(value) &&
      value.every((part) => record(part) && part.type === 'text' && typeof part.text === 'string'))
  );
}
function textBlocks(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return Array.isArray(value) ? value.map((part) => ({ type: 'text', text: part.text })) : [];
}
function nativeText(message) {
  const blocks =
    typeof message.content === 'string' ? textBlocks(message.content) : message.content;
  let text = '';
  for (const part of blocks || [])
    text = text && part.text ? text + '\n' + part.text : text + part.text;
  return { role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
}

// Native histories retain their Chat roles and IDs through wire budgeting.
// Provider tools and media are emitted as parts without a Claude request envelope.
function createGeminiChatRequestAdapter({
  buildGeminiRequest,
  protocolOptions = {},
  ...historyDeps
}) {
  return function tryOpenAIChatToGemini(body, model, outputOptions = {}, options = {}) {
    if (!record(body)) {
      const error = new TypeError('Chat request must be an object');
      error.code = 'invalid_request_error';
      throw error;
    }
    validateChatMessages(body.messages, { validatePart: chatPartToGemini });
    const sourceMessages = body.messages || [];
    const argumentsCache = new WeakMap();
    validateGeminiChatHistory(sourceMessages, argumentsCache);
    const nativeHistory = sourceMessages.some(
      (message) =>
        message.role === 'tool' ||
        !textContent(message.content) ||
        message.reasoning_content != null ||
        message.tool_calls != null
    );
    validateConvertedFunctionTools(body.tools, 'chat', 'Gemini');
    if (body.messages == null && body.response_format == null) return null;
    const budgeted = resolveContextBudget(body, model, protocolOptions).enabled
      ? applyContextBudgetToMessages(sourceMessages, body, model, protocolOptions, {
          includeCacheDiagnostics: false,
          estimateMessageTokens: estimatePayloadTokens,
          fixedInputTokens: estimatePayloadTokens(body.tools || []),
          fixedInputValue: body.tools || [],
        })
      : { messages: sourceMessages };
    const systemParts = [];
    const messages = [];
    for (const message of budgeted.messages) {
      if (message.role === 'system' || message.role === 'developer') {
        systemParts.push(...chatContentToGemini(message.content));
        continue;
      }
      if (nativeHistory) {
        messages.push({ ...message });
        continue;
      }
      const blocks = textBlocks(message.content);
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const content =
        role === 'assistant'
          ? blocks.length
            ? blocks
            : ''
          : Array.isArray(message.content)
            ? blocks
            : message.content || '';
      const previous = messages[messages.length - 1];
      if (previous?.role === role)
        previous.content = [...textBlocks(previous.content), ...textBlocks(content)];
      else messages.push({ role, content });
    }
    const config = {
      max_tokens: resolveConvertedOutputTokenLimit(body) ?? 4096,
      messages,
      __nativeWebSearch: body.__nativeWebSearch,
      __managedWebSearchHistoryAsText: body.__managedWebSearchHistoryAsText,
      __responsesToolPreamble: options.toolPreamble === true,
    };
    applyConvertedOutputFormat(config, body, 'chat', 'Gemini', model);
    applyConvertedServiceTier(config, body, 'openai', 'Gemini');
    for (const key of ['temperature', 'top_p']) if (body[key] != null) config[key] = body[key];
    if (body.stop != null)
      config.stop_sequences = Array.isArray(body.stop) ? [...body.stop] : [body.stop];
    applyNativeGeminiReasoning(
      config,
      options.reasoningEffort == null
        ? body
        : { ...body, reasoning_effort: options.reasoningEffort },
      model
    );
    config.reasoning_effort = options.reasoningEffort ?? body.reasoning_effort;
    const names = new Set();
    const tools = [];
    for (const tool of body.tools || []) {
      const fn = tool.function;
      if (names.has(fn.name)) continue;
      names.add(fn.name);
      tools.push({
        name: fn.name,
        description: fn.description || '',
        ...functionToolContract(fn, 'parameters', 'input_schema'),
      });
    }
    if (tools.length) config.tools = tools;
    if (body.tool_choice === 'none') config.tool_choice = { type: 'none' };
    else if (body.tool_choice === 'required') config.tool_choice = { type: 'any' };
    else if (body.tool_choice?.type === 'function')
      config.tool_choice = { type: 'tool', name: body.tool_choice.function?.name };
    applyConvertedParallelTools(config, body, 'Gemini');
    const systemInstruction =
      systemParts.length && !(systemParts.length === 1 && !systemParts[0].text)
        ? { parts: systemParts }
        : null;
    const request = buildGeminiRequest(config, model, outputOptions, {
      systemInstruction,
      ...(nativeHistory
        ? createGeminiChatHistoryAdapter({ ...historyDeps, argumentsCache })
        : { convertMessage: nativeText }),
    });
    return {
      request,
      tools: config.tools,
      messages,
      __managedWebSearchHistoryAsText: config.__managedWebSearchHistoryAsText,
    };
  };
}
module.exports = { createGeminiChatRequestAdapter };
