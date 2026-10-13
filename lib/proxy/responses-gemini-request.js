'use strict';

const { responsesTargetOptions } = require('./responses-target-options');
const { validateSemanticHistory, invalidHistory } = require('./responses-semantic-history');
const { geminiResponsesConversionErrorDiagnostics } = require('./gemini-responses-compat');

function createResponsesGeminiRequestConverter({
  buildGeminiRequest,
  nativeToolHistory,
  mergeAdjacentGeminiTextParts,
}) {
  function ordinaryPart(part) {
    if (part.kind === 'text') return { text: part.text };
    if (part.kind === 'media') return { inlineData: { mimeType: part.mediaType, data: part.data } };
    if (part.kind === 'reasoning' && !part.encryptedContent)
      return { thought: true, text: part.text };
    invalidHistory();
  }
  function repairHistory(history, options) {
    const nativeOptions = { ...options, preserveIds: true };
    const messages = [];
    let precedingCalls = new Set();
    let previousRole;
    let repairedCount = 0;
    for (const message of history) {
      const parts = [];
      const calls = [];
      const results = [];
      if (message.role === 'assistant' && previousRole !== 'assistant') precedingCalls = new Set();
      // A genuine user turn ends the preceding tool exchange. Consecutive result
      // turns keep the call set so parallel results can arrive in either order.
      if (message.role === 'user' && !message.parts.some((part) => part.kind === 'result'))
        precedingCalls = new Set();
      for (const part of message.parts) {
        if (part.kind === 'call') {
          if (message.role !== 'assistant') invalidHistory();
          precedingCalls.add(part.id);
          calls.push({ id: part.id });
          parts.push(...nativeToolHistory.callParts(part, nativeOptions));
        } else if (part.kind === 'result') {
          if (message.role !== 'user') invalidHistory();
          const content = part.parts.map(ordinaryPart);
          const orphan = !precedingCalls.has(part.id);
          if (orphan) repairedCount++;
          else results.push(part.id);
          parts.push(
            ...nativeToolHistory.resultParts(
              {
                ...part,
                text: content
                  .filter((item) => !item.inlineData)
                  .map((item) => item.text)
                  .join('\n'),
                mediaParts: content.filter((item) => item.inlineData),
                orphan,
              },
              nativeOptions
            )
          );
        } else parts.push(ordinaryPart(part));
      }
      previousRole = message.role;
      const previous = messages.at(-1);
      if (previous?.role === message.role) {
        previous.content = mergeAdjacentGeminiTextParts([...previous.content, ...parts]);
        previous.tool_calls.push(...calls);
        previous.tool_result_ids.push(...results);
      } else
        messages.push({
          role: message.role,
          content: parts.length ? mergeAdjacentGeminiTextParts(parts) : [{ text: '' }],
          tool_calls: calls,
          tool_result_ids: results,
        });
    }
    return { messages, repairedCount };
  }
  return function responsesHistoryToGemini(
    source,
    context,
    model,
    outputOptions = {},
    options = {}
  ) {
    const history = validateSemanticHistory(context.history);
    const config = responsesTargetOptions(source, model, 'Gemini');
    const system = [];
    config.messages = [];
    config.__responsesToolPreamble = options.toolPreamble === true;
    for (const message of history) {
      if (['system', 'developer'].includes(message.role)) {
        if (message.parts.some((part) => part.kind !== 'text')) invalidHistory();
        system.push(...message.parts.map(ordinaryPart));
      } else {
        // Validate all parts before the builder budgets or mutates tool caches.
        for (const part of message.parts) {
          if (part.kind === 'result') part.parts.forEach(ordinaryPart);
          else if (part.kind !== 'call') ordinaryPart(part);
          if (
            (part.kind === 'call' && message.role !== 'assistant') ||
            (part.kind === 'result' && message.role !== 'user')
          )
            invalidHistory();
        }
        config.messages.push(message);
      }
    }
    const request = buildGeminiRequest(config, model, outputOptions, {
      systemInstruction: system.length ? { parts: system } : null,
      repairHistory,
      convertMessage: (message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: typeof message.content === 'string' ? [{ text: message.content }] : message.content,
      }),
    });
    return {
      request,
      tools: config.tools,
      __managedWebSearchHistoryAsText: config.__managedWebSearchHistoryAsText,
    };
  };
}

function resolveResponsesGeminiContext(ctx, clientRes, parsed, model) {
  try {
    const config = responsesTargetOptions(parsed, model, 'Gemini');
    const context = ctx.resolveResponsesHistory(clientRes, parsed, model);
    return context ? { ...config, ...context } : null;
  } catch (error) {
    if (error.code !== 'invalid_request_error') throw error;
    if (typeof ctx.logProxyEvent === 'function') {
      ctx.logProxyEvent(
        'gemini_responses_conversion_rejected',
        geminiResponsesConversionErrorDiagnostics(error, 'context')
      );
    }
    ctx.sendJsonError(clientRes, 400, {
      error: {
        type: 'invalid_request_error',
        message: 'Invalid Responses request for Gemini conversion',
      },
    });
    return null;
  }
}

module.exports = { createResponsesGeminiRequestConverter, resolveResponsesGeminiContext };
