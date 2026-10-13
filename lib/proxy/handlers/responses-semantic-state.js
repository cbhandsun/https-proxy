'use strict';
const {
  applyResponsesHistoryPolicy,
  shouldStoreResponsesHistory,
  preservesResponsesHistory,
} = require('../responses-history-policy');

const {
  parseResponsesHistory,
  chatHistoryToSemantic,
  validateSemanticHistory,
  isSemanticEntry,
} = require('../responses-semantic-history');
const { mergeProviderContextOutputItems } = require('../provider-context-history');
const { summaryToChatMessages } = require('../context-summary');

function createResponsesSemanticState({
  responsesHistory,
  responsesSummaries,
  rememberResponsesHistory,
  fallbackId,
  sendJsonError,
}) {
  function resolveResponsesHistory(clientRes, parsed, targetModel) {
    const history = parseResponsesHistory(parsed.input, { fallbackId }, parsed.instructions);
    const context = applyResponsesHistoryPolicy({ model: targetModel, history }, parsed);
    if (!parsed.previous_response_id) return context;
    const previous = responsesHistory.get(parsed.previous_response_id);
    let background;
    if (isSemanticEntry(previous)) background = validateSemanticHistory(previous.history);
    else if (Array.isArray(previous)) background = chatHistoryToSemantic(previous, { fallbackId });
    else {
      const summary = responsesSummaries.get(parsed.previous_response_id);
      const summaryMessages = summaryToChatMessages(summary);
      if (summaryMessages.length > 0 && !preservesResponsesHistory(context))
        background = chatHistoryToSemantic(summaryMessages, { fallbackId });
      else {
        sendJsonError(clientRes, 400, {
          error: {
            type: 'invalid_request_error',
            message:
              'previous_response_id is not available in this proxy process. Send full input history or retry without previous_response_id.',
          },
        });
        return null;
      }
    }
    return { ...context, history: [...background, ...history] };
  }
  function rememberSemanticBridge(bridge, context) {
    const state = bridge?.responseState;
    if (!state || state.failed || !shouldStoreResponsesHistory(context)) return;
    const output = parseResponsesHistory(
      mergeProviderContextOutputItems(
        state.completedOutputItems || [],
        state.providerContextItems || []
      ),
      { fallbackId }
    );
    rememberResponsesHistory(state.id, { version: 2, history: [...context.history, ...output] });
  }
  return { resolveResponsesHistory, rememberSemanticBridge };
}

module.exports = { createResponsesSemanticState };
