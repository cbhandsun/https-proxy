'use strict';

function chatIncompleteReason(reason) {
  if (reason === 'length') return 'max_output_tokens';
  if (reason === 'content_filter') return 'content_filter';
  return null;
}

function responsesFinishReason(response, hasToolCalls, terminalType) {
  const incomplete = terminalType === 'response.incomplete' || response?.status === 'incomplete';
  if (incomplete) {
    return response?.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length';
  }
  return hasToolCalls ? 'tool_calls' : 'stop';
}

module.exports = { chatIncompleteReason, responsesFinishReason };
