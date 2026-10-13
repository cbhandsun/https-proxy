'use strict';

const { responsesTargetOptions } = require('./responses-target-options');
const {
  validateSemanticHistory,
  semanticMediaBlock,
  invalidHistory,
} = require('./responses-semantic-history');
const { applyContextBudgetToMessages } = require('./context-budget-manager');
const { applyProviderCacheHintsToRequest } = require('./context-cache-hints');
const { estimateTokensForValue } = require('./inline-media');

function createResponsesClaudeRequestConverter({
  cleanToolArgs,
  mergeAdjacentClaudeMessages,
  protocolOptions = {},
}) {
  function block(part) {
    if (part.kind === 'text') return { type: 'text', text: part.text };
    if (part.kind === 'reasoning') {
      // A Responses summary is plain context, not signed Anthropic thinking.
      if (part.encryptedContent) invalidHistory();
      return { type: 'text', text: part.text };
    }
    if (part.kind === 'provider_context') {
      if (part.provider !== 'anthropic') invalidHistory();
      return { ...part.data };
    }
    if (part.kind === 'media') {
      if (part.mediaKind !== 'image') invalidHistory();
      return semanticMediaBlock(part);
    }
    if (part.kind === 'call')
      return {
        type: 'tool_use',
        id: part.id,
        name: part.name,
        input: cleanToolArgs(part.name, part.args),
      };
    if (part.kind === 'result')
      return {
        type: 'tool_result',
        tool_use_id: part.id,
        content: part.parts.map(block),
        ...(part.error ? { is_error: true } : {}),
      };
    invalidHistory();
  }
  return function responsesHistoryToClaude(source, context, model, options = {}) {
    const history = validateSemanticHistory(context.history);
    const config = responsesTargetOptions(source, model, 'Claude');
    const system = [];
    const messages = [];
    for (const message of history) {
      if (['system', 'developer'].includes(message.role)) {
        if (message.parts.some((part) => part.kind !== 'text')) invalidHistory();
        system.push(...message.parts.map(block));
      } else {
        if (
          message.parts.some(
            (part) =>
              (part.kind === 'call' && message.role !== 'assistant') ||
              (part.kind === 'result' && message.role !== 'user') ||
              (part.kind === 'provider_context' && message.role !== 'assistant')
          )
        )
          invalidHistory();
        messages.push({ role: message.role, content: message.parts.map(block) });
      }
    }
    if (system.length === 1) config.system = system[0].text;
    else if (system.length) config.system = system;
    const fixed = { system: config.system, tools: config.tools };
    const contextProtocolOptions =
      options.nativeContextManagement === true
        ? { ...(protocolOptions || {}), contextWindowPolicy: 'disabled' }
        : protocolOptions;
    const budget = applyContextBudgetToMessages(
      mergeAdjacentClaudeMessages(messages),
      config,
      model,
      contextProtocolOptions,
      {
        estimateMessageTokens: estimateTokensForValue,
        fixedInputValue: fixed,
        fixedInputTokens: estimateTokensForValue(fixed),
      }
    );
    config.messages = budget.messages;
    // These flags belong to gateway routing and are not Anthropic wire fields.
    delete config.__managedWebSearchFallback;
    delete config.reasoning_effort;
    const summary = source.reasoning?.summary ?? source.reasoning?.generate_summary;
    const diagnostics = {
      contextBudget: budget.diagnostics,
      ...(['auto', 'concise', 'detailed'].includes(summary)
        ? {
            reasoningSummary: {
              requested: summary,
              effective: 'summarized',
              detailPreserved: summary === 'auto',
            },
          }
        : {}),
    };
    applyProviderCacheHintsToRequest(config, 'anthropic', diagnostics, protocolOptions);
    Object.defineProperty(config, '__hpmDiagnostics', {
      value: diagnostics,
      enumerable: false,
      configurable: true,
    });
    return config;
  };
}

function prepareResponsesClaudeRequest(ctx, clientRes, parsed, model, options = {}) {
  try {
    const context = ctx.resolveResponsesHistory(clientRes, parsed, model);
    return context
      ? { context, request: ctx.responsesHistoryToClaude(parsed, context, model, options) }
      : null;
  } catch (error) {
    if (error.code !== 'invalid_request_error') throw error;
    ctx.sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Invalid Responses request for Claude conversion',
      },
    });
    return null;
  }
}

module.exports = { createResponsesClaudeRequestConverter, prepareResponsesClaudeRequest };
