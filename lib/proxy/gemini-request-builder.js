'use strict';
const { geminiReasoningSummary } = require('./responses-endpoint-options');
const { nativeGeminiThinking } = require('./native-reasoning-controls');
const { normalizeClaudeModernOptions, geminiOutputSchema } = require('./claude-modern-options');
const { geminiJsonMode } = require('./converted-output-format');
const {
  convertedServiceTier,
  geminiServiceTier,
  validateGeminiServiceTier,
} = require('./converted-service-tier');
const { applyConvertedParallelTools } = require('./converted-parallel-tools');
const { resolveGeminiOutputBudget } = require('./gemini-output-budget');
const { geminiThinkingConfigFromOpenAI } = require('./gemini-reasoning');
const { normalizeGeminiContinuationHistory } = require('./gemini-continuation');
const { applyContextBudgetToMessages } = require('./context-budget-manager');
const { applyProviderCacheHintsToRequest } = require('./context-cache-hints');
const { estimateTokensForValue } = require('./inline-media');
function createGeminiRequestBuilder(deps) {
  const {
    rejectsLegacySamplingParameters,
    isGeminiImageGenerationModel,
    geminiNativeSearchToolsFromClaude,
    geminiToolsFromClaude,
    geminiFunctionDeclarationNames,
    normalizeClaudeSystem,
    geminiToolsIncludeFunctionDeclarations,
    claudeMessageToGeminiContent,
    repairOrphanedClaudeToolResults,
    geminiToolConfigFromClaude,
    geminiToolsIncludeNativeAndFunction,
    RESPONSES_TOOL_PREAMBLE_INSTRUCTION,
  } = deps;
  function build(body, model, outputOptions = {}, adapter = {}) {
    body = normalizeClaudeModernOptions(body, 'Gemini', {
      model,
      codeAssist: outputOptions.codeAssist,
    });
    if (outputOptions.codeAssist === true && body[geminiJsonMode]) {
      const error = new TypeError('JSON output modes are unsupported by this Gemini transport');
      error.code = 'invalid_request_error';
      throw error;
    }
    applyConvertedParallelTools(
      { tools: body.tools, tool_choice: body.tool_choice },
      body,
      'Gemini'
    );
    const generationConfig = {};
    if (body[geminiJsonMode]) generationConfig.responseMimeType = 'application/json';
    if (body[geminiOutputSchema]) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseJsonSchema = body[geminiOutputSchema];
    }

    const outputBudget = resolveGeminiOutputBudget(body, model, outputOptions);
    const maxOutputTokens = outputBudget.effectiveTokens;
    if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
    if (!rejectsLegacySamplingParameters(model)) {
      if (body.temperature != null) generationConfig.temperature = body.temperature;
      if (body.top_p != null) generationConfig.topP = body.top_p;
      if (body.top_k != null) generationConfig.topK = body.top_k;
    }
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0)
      generationConfig.stopSequences = body.stop_sequences;
    let thinkingConfig = Object.hasOwn(body, nativeGeminiThinking)
      ? body[nativeGeminiThinking]
      : geminiThinkingConfigFromOpenAI(body, model);
    const summary = body[geminiReasoningSummary];
    if (summary === true || ['auto', 'concise', 'detailed'].includes(summary))
      thinkingConfig = { ...(thinkingConfig || {}), includeThoughts: true };
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
    if (thinkingConfig?.thinkingLevel) outputBudget.thinkingLevel = thinkingConfig.thinkingLevel;
    if (isGeminiImageGenerationModel(model)) {
      generationConfig.responseModalities = ['TEXT', 'IMAGE'];
    }

    const tools = geminiNativeSearchToolsFromClaude(body, geminiToolsFromClaude(body.tools));
    const toolHistoryOptions = {
      declaredFunctionNames: geminiFunctionDeclarationNames(tools),
      managedWebSearchHistoryAsText: body.__managedWebSearchHistoryAsText === true,
    };
    let systemInstruction = Object.hasOwn(adapter, 'systemInstruction')
      ? adapter.systemInstruction
      : normalizeClaudeSystem(body.system);
    const shouldAddResponsesToolPreamble =
      body.__responsesToolPreamble === true && geminiToolsIncludeFunctionDeclarations(tools);
    if (shouldAddResponsesToolPreamble) {
      systemInstruction = {
        ...(systemInstruction || {}),
        parts: [...(systemInstruction?.parts || []), { text: RESPONSES_TOOL_PREAMBLE_INSTRUCTION }],
      };
    }
    const converted = new Map();
    const convertMessage = (message) => {
      if (!message || typeof message !== 'object') return null;
      if (!converted.has(message)) {
        converted.set(
          message,
          (adapter.convertMessage || claudeMessageToGeminiContent)(message, toolHistoryOptions)
        );
      }
      return converted.get(message);
    };
    // Budget the wire representation, including instructions, declarations and signatures.
    // Do not truncate a second time after conversion: that splits tool exchanges.
    const repairedHistory = (adapter.repairHistory || repairOrphanedClaudeToolResults)(
      Array.isArray(body.messages) ? body.messages : [],
      toolHistoryOptions
    );
    const continuationHistory = normalizeGeminiContinuationHistory(
      repairedHistory.messages,
      convertMessage
    );
    const budgetedMessages = applyContextBudgetToMessages(
      continuationHistory.messages,
      maxOutputTokens === undefined ? body : { ...body, max_tokens: maxOutputTokens },
      model,
      deps.protocolOptions || {},
      {
        fixedInputTokens: estimateTokensForValue({ systemInstruction, tools }),
        fixedInputValue: { systemInstruction, tools },
        estimateMessageTokens: (message) => estimateTokensForValue(convertMessage(message)),
      }
    );
    const request = { contents: budgetedMessages.messages.map(convertMessage).filter(Boolean) };
    const tier =
      body[geminiServiceTier] ?? convertedServiceTier(body.service_tier, 'claude', 'Gemini');
    const effectiveTier = validateGeminiServiceTier(tier, outputOptions);
    if (effectiveTier != null) request.serviceTier = effectiveTier;
    const diagnostics = {
      ...(tier != null && outputOptions.codeAssist === true
        ? {
            serviceTier: {
              requested: tier,
              effective: 'provider-default',
              preserved: false,
              reason: 'code-assist-service-tier-unsupported',
            },
          }
        : {}),
      contextBudget: budgetedMessages.diagnostics,
      repairedOrphanToolResults: repairedHistory.repairedCount,
      appendedContinuationTurn: continuationHistory.appended,
      outputBudget,
      ...(typeof summary === 'string' && ['auto', 'concise', 'detailed'].includes(summary)
        ? {
            reasoningSummary: {
              requested: summary,
              effective: 'includeThoughts',
              detailPreserved: summary === 'auto',
            },
          }
        : {}),
    };
    applyProviderCacheHintsToRequest(request, 'gemini', diagnostics, deps.protocolOptions || {});
    if (
      budgetedMessages.diagnostics?.enabled ||
      outputBudget.source === 'code-assist-verified' ||
      diagnostics.reasoningSummary ||
      diagnostics.serviceTier
    ) {
      Object.defineProperty(request, '__hpmDiagnostics', {
        value: diagnostics,
        enumerable: false,
        configurable: true,
      });
    }
    if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
    if (systemInstruction) request.systemInstruction = systemInstruction;
    if (tools) request.tools = tools;
    const toolConfig = geminiToolConfigFromClaude(body.tool_choice);
    if (geminiToolsIncludeNativeAndFunction(tools)) {
      request.toolConfig = {
        ...(toolConfig || {}),
        includeServerSideToolInvocations: true,
        include_server_side_tool_invocations: true,
      };
      request.tool_config = request.toolConfig;
    } else if (toolConfig) {
      request.toolConfig = toolConfig;
      request.tool_config = toolConfig;
    }
    return request;
  }

  return build;
}
module.exports = { createGeminiRequestBuilder };
