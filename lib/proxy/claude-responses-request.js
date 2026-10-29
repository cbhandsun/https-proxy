'use strict';
const {
  normalizeClaudeModernOptions,
  responsesThinkingSummary,
} = require('./claude-modern-options');

const { functionToolContract } = require('./function-tool-contract');
const {
  applyResponsesRequestOptions,
  chatContentPartToResponses,
} = require('./responses-request-options');
const { applyConvertedServiceTier } = require('./converted-service-tier');
const { extractCanonicalReasoning } = require('./reasoning-adapter');
const { applyContextBudgetToMessages } = require('./context-budget-manager');
const { applyProviderCacheHintsToRequest } = require('./context-cache-hints');
const { estimateTokensForValue } = require('./inline-media');

function invalidRequest() {
  const error = new TypeError(
    'Claude request contains content or options unsupported by Responses conversion'
  );
  error.code = 'invalid_request_error';
  throw error;
}
function object(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value) {
  return (
    typeof value === 'string' &&
    value.trim() &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32)
  );
}
function textBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) invalidRequest();
  return content;
}
function toolResultText(content) {
  return textBlocks(content)
    .map((block) => {
      if (!object(block) || block.type !== 'text' || typeof block.text !== 'string')
        invalidRequest();
      return block.text;
    })
    .join('\n');
}
function contentPart(block, role) {
  if (block.type === 'text') {
    if (typeof block.text !== 'string') invalidRequest();
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text };
  }
  if (block.type !== 'image' || role !== 'user' || !object(block.source)) invalidRequest();
  const source = block.source;
  let url;
  if (source.type === 'base64') {
    if (
      !/^image\/(?:png|jpeg|gif|webp)$/.test(source.media_type) ||
      typeof source.data !== 'string' ||
      !source.data ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data)
    )
      invalidRequest();
    url = 'data:' + source.media_type + ';base64,' + source.data;
  } else if (source.type === 'url') {
    url = source.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) invalidRequest();
  } else invalidRequest();
  return chatContentPartToResponses({ type: 'image_url', image_url: { url } }, role);
}

function createClaudeResponsesRequestConverter({
  cleanToolArgs,
  fallbackId,
  protocolOptions = {},
}) {
  function normalizeMessage(message, preparedParts) {
    if (!object(message) || !['user', 'assistant'].includes(message.role)) invalidRequest();
    const parts = [];
    const content = textBlocks(message.content)
      .map((block) => {
        if (!object(block)) invalidRequest();
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          if (
            message.role !== 'assistant' ||
            (block.thinking != null && typeof block.thinking !== 'string') ||
            (block.signature != null && typeof block.signature !== 'string') ||
            (block.data != null && typeof block.data !== 'string')
          )
            invalidRequest();
          // Claude signatures cannot be reused by another provider. Match the
          // existing request policy: do not replay private thinking as prompt text.
          return null;
        }
        if (block.type === 'tool_use') {
          if (
            message.role !== 'assistant' ||
            !identifier(block.name) ||
            (block.id != null && !identifier(block.id)) ||
            (block.input != null && !object(block.input))
          )
            invalidRequest();
          const input = cleanToolArgs(block.name, block.input || {});
          if (!object(input)) invalidRequest();
          return {
            type: 'tool_use',
            name: block.name,
            input,
            id: block.id || fallbackId('call', { name: block.name, input }),
          };
        }
        if (block.type === 'tool_result') {
          if (
            message.role !== 'user' ||
            !identifier(block.tool_use_id) ||
            (block.is_error != null && typeof block.is_error !== 'boolean')
          )
            invalidRequest();
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: toolResultText(block.content),
            ...(block.is_error === true ? { is_error: true } : {}),
          };
        }
        parts.push(contentPart(block, message.role));
        return block;
      })
      .filter(Boolean);
    const normalized = { role: message.role, content };
    preparedParts.set(normalized, parts);
    return normalized;
  }

  function emitMessage(message, preparedParts) {
    const input = [];
    const uses = message.content.filter((block) => block.type === 'tool_use');
    const results = message.content.filter((block) => block.type === 'tool_result');
    for (const block of results) {
      input.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: block.content,
        ...(block.is_error === true ? { status: 'error' } : {}),
      });
    }
    // Retain the compatibility route's text-before-calls and results-before-text ordering.
    // Reuse the strictly validated wire parts only for unchanged normalized
    // messages. Context folding creates new messages and must convert afresh.
    const parts =
      preparedParts.get(message) ||
      message.content
        .filter((block) => !['tool_use', 'tool_result'].includes(block.type))
        .map((block) => contentPart(block, message.role));
    if (parts.length === 1 && parts[0].text != null && !parts[0].text.trim()) parts.length = 0;
    if (parts.length || (message.role === 'user' ? results.length === 0 : uses.length === 0))
      input.push({ type: 'message', role: message.role, content: parts });
    for (const block of uses) {
      const argumentsText = JSON.stringify(block.input);
      const seed = { name: block.name, arguments: argumentsText };
      input.push({
        type: 'function_call',
        id: block.id.startsWith('fc_') ? block.id : fallbackId('fc', { source_id: block.id, seed }),
        call_id: block.id,
        name: block.name,
        arguments: argumentsText,
      });
    }
    return input;
  }

  function convert(body, model, options = {}) {
    body = normalizeClaudeModernOptions(body, 'Responses', options);
    if (
      !object(body) ||
      (body.messages != null && !Array.isArray(body.messages)) ||
      (body.tools != null && !Array.isArray(body.tools))
    )
      invalidRequest();
    if (body.stream != null && typeof body.stream !== 'boolean') invalidRequest();
    if (
      body.stop_sequences != null &&
      (!Array.isArray(body.stop_sequences) || body.stop_sequences.length)
    )
      invalidRequest();
    const system = toolResultText(body.system);
    const tools = body.tools?.map((tool) => {
      const contract = functionToolContract(tool, 'input_schema', 'parameters');
      if (
        !identifier(tool.name) ||
        (tool.description != null && typeof tool.description !== 'string') ||
        (tool.type != null && tool.type !== 'custom')
      )
        invalidRequest();
      return {
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        ...contract,
        ...(options.codex === false && tool.strict == null ? { strict: false } : {}),
      };
    });
    const preparedParts = new WeakMap();
    const messages = (body.messages || []).map((message) =>
      normalizeMessage(message, preparedParts)
    );
    const result = {
      model,
      store: false,
      instructions: body.system ? system : 'You are a helpful assistant.',
      stream: true,
    };
    if (tools) result.tools = tools;
    const choice = body.tool_choice;
    let parallel = body.parallel_tool_calls;
    if (choice != null) {
      if (
        !object(choice) ||
        !['auto', 'none', 'any', 'tool'].includes(choice.type) ||
        (choice.disable_parallel_tool_use != null &&
          typeof choice.disable_parallel_tool_use !== 'boolean')
      )
        invalidRequest();
      if (choice.disable_parallel_tool_use != null) {
        const requested = !choice.disable_parallel_tool_use;
        if (parallel != null && parallel !== requested) invalidRequest();
        parallel = requested;
      }
      if (choice.type === 'tool') {
        if (!identifier(choice.name) || !tools?.some((tool) => tool.name === choice.name))
          invalidRequest();
        result.tool_choice = { type: 'function', name: choice.name };
      } else if (choice.type !== 'auto')
        result.tool_choice = choice.type === 'any' ? 'required' : 'none';
    }
    applyResponsesRequestOptions(result, { ...body, parallel_tool_calls: parallel }, options);
    const canonical = extractCanonicalReasoning(body);
    if (!canonical.valid) invalidRequest();
    if (canonical.enabled) delete result.temperature;
    if (canonical.effort) result.reasoning = { effort: canonical.effort };
    if (body[responsesThinkingSummary]) result.reasoning = { ...result.reasoning, summary: 'auto' };
    applyConvertedServiceTier(result, body, 'claude', 'Responses');
    const fixed = { instructions: result.instructions, tools: result.tools || [] };
    const budget = applyContextBudgetToMessages(
      messages,
      { ...body, reasoning_effort: canonical.effort || undefined },
      model,
      options.nativeContextManagement === true
        ? { ...protocolOptions, contextWindowPolicy: 'disabled' }
        : protocolOptions,
      {
        fixedInputTokens: estimateTokensForValue(fixed),
        fixedInputValue: fixed,
      }
    );
    result.input = budget.messages.flatMap((message) => emitMessage(message, preparedParts));
    const diagnostics = { contextBudget: budget.diagnostics };
    applyProviderCacheHintsToRequest(result, 'openai', diagnostics, protocolOptions);
    Object.defineProperty(result, '__hpmDiagnostics', { value: diagnostics, configurable: true });
    return result;
  }
  return function claudeMessagesToResponsesRequest(body, model, options) {
    try {
      return convert(body, model, options);
    } catch (error) {
      if (error?.code === 'invalid_request_error') invalidRequest();
    }
    // Normalize dependency failures without retaining user input in an error cause.
    throw new TypeError('Claude request could not be converted safely');
  };
}

module.exports = { createClaudeResponsesRequestConverter };
