'use strict';
const { createLazyHandlerGroup } = require('./lazy-handler-group');

// Explicit exports keep object spreading and destructuring lazy at composition.
const PROTOCOL_HANDLERS = Object.freeze({
  openai: Object.freeze([
    'buildResponsesResponse',
    'responsesHistoryToClaude',
    'claudeResponseToResponses',
    'createResponsesStreamEmitter',
    'createChatClaudeStream',
    'createResponsesClaudeStream',
    'createClaudeResponsesStream',
    'openAIContentToClaudeContent',
    'openAIToolCallToClaudeBlock',
    'openAIToolResultContentToClaude',
    'openAIChatToClaudeMessages',
    'claudeContentBlockToOpenAIMessage',
    'claudeToolUseToOpenAIToolCall',
    'claudeResponseToOpenAIChat',
    'openAIChunkFinishReason',
    'writeOpenAIChatSseChunk',
    'processClaudeEventToOpenAI',
    'processClaudeSseEventToOpenAI',
    'processClaudeSseChunkToOpenAI',
    'flushClaudeSseToOpenAI',
    'claudeContentToOpenAIContent',
    'claudeToolUseToOpenAIToolMessage',
    'claudeToolToOpenAITool',
    'claudeToolChoiceToOpenAI',
    'claudeMessagesToOpenAIChat',
    'claudeMessagesToResponsesRequest',
    'openAIMessageToClaudeContent',
    'openAIResponseToClaudeMessage',
    'responsesResponseToClaude',
    'hasResponsesNativeWebSearchTool',
    'openAIResponsesToChat',
    'mergeAdjacentAssistantMessages',
    'openAIChatToResponses',
    'processOpenAIChatChunkToResponses',
    'processOpenAIChatSseChunkToResponses',
    'flushOpenAIChatSseToResponses',
    'openAIChatToResponsesRequest',
    'openAIResponsesToChatResponse',
    'processOpenAIResponsesSseChunkToChat',
    'flushOpenAIResponsesSseToChat',
  ]),
  gemini: Object.freeze([
    'geminiRoleFromClaude',
    'geminiMimeType',
    'geminiClaudeToolId',
    'rememberGeminiToolCall',
    'geminiToolResponseText',
    'claudeBlockToGeminiPart',
    'claudeContentToGeminiParts',
    'normalizeClaudeSystem',
    'geminiSchemaType',
    'sanitizeGeminiSchema',
    'claudeToolToGeminiDeclaration',
    'geminiToolsFromClaude',
    'geminiNativeSearchToolsFromClaude',
    'geminiToolConfigFromClaude',
    'hasGeminiIncompatibleToolHistory',
    'claudeToolHistoryBlockToGeminiPart',
    'claudeMessageToGeminiContent',
    'claudeMessagesToGemini',
    'tryOpenAIChatToGemini',
    'responsesHistoryToGemini',
    'isGeminiImageGenerationModel',
    'geminiInlineImageToClaudeBlock',
    'geminiPartToClaudeBlock',
    'claudeStopReasonFromGemini',
    'geminiUsageToClaude',
    'geminiResponseToClaude',
    'geminiResponseToResponses',
    'geminiResponseToChat',
    'geminiGeneratePath',
  ]),
  claude: Object.freeze([
    'createGeminiClaudeStream',
    'createGeminiResponsesStream',
    'createGeminiChatStream',
    'mergeGeminiToolArgs',
    'makeSafeClaudeToolUseContentBlock',
    'writeClaudeSseEvent',
    'writeClaudeToolUseBlock',
    'writeOpenAIToolUseBlock',
    'processOpenAISanitizedSseEvent',
    'rewriteClaudeToolEvent',
    'processClaudeSseEvent',
    'writeClaudeTextBlock',
    'writeClaudeReplacementTextBlock',
    'flushPendingGeminiToolCall',
    'geminiClaudeStopReason',
    'streamGeminiChunkToClaude',
    'processGeminiSseEvent',
    'processClaudeSseChunk',
    'flushClaudeSseFilter',
    'writeClaudeFromOpenAIStreamChunk',
    'flushOpenAIStreamToolCallsToClaude',
    'processOpenAISseEventToClaude',
    'processOpenAISseChunkToClaude',
    'flushOpenAISseToClaude',
  ]),
});
function group(
  names,
  modulePath,
  factoryName,
  dependencies,
  { loadModule = () => require(modulePath) } = {}
) {
  if (typeof loadModule !== 'function') throw new TypeError('Invalid protocol module loader');
  let initializing = false;
  return createLazyHandlerGroup(names, () => {
    if (initializing) throw new Error('Protocol initialization is recursive');
    initializing = true;
    try {
      const loaded = loadModule();
      if (!loaded || typeof loaded[factoryName] !== 'function')
        throw new TypeError('Protocol module is missing its factory');
      const handlers = loaded[factoryName](dependencies);
      if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers))
        throw new TypeError('Protocol factory must return handlers');
      return handlers;
    } finally {
      initializing = false;
    }
  });
}
function createOpenAIProtocol(dependencies, options) {
  return group(
    PROTOCOL_HANDLERS.openai,
    './protocol-openai',
    'createOpenAIProtocol',
    dependencies,
    options
  );
}
function createGeminiProtocol(dependencies, options) {
  return group(
    PROTOCOL_HANDLERS.gemini,
    './protocol-gemini',
    'createGeminiProtocol',
    dependencies,
    options
  );
}
function createClaudeStream(dependencies, options) {
  const names = dependencies?.createResponsesStreamEmitter
    ? PROTOCOL_HANDLERS.claude
    : PROTOCOL_HANDLERS.claude.filter((name) => name !== 'createGeminiResponsesStream');
  return group(names, './stream-claude', 'createClaudeStream', dependencies, options);
}
module.exports = {
  createOpenAIProtocol,
  createGeminiProtocol,
  createClaudeStream,
  PROTOCOL_HANDLERS,
};
