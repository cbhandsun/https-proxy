'use strict';
const roles = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
function mergeResponsesChatHistory(previous, current) {
  for (const messages of [previous, current]) {
    if (
      !Array.isArray(messages) ||
      messages.some(
        (message) =>
          !message ||
          typeof message !== 'object' ||
          Array.isArray(message) ||
          !roles.has(message.role)
      )
    ) {
      const error = new TypeError('Invalid Responses Chat history');
      error.code = 'invalid_request_error';
      throw error;
    }
  }
  const leadingInstructions = (messages) => {
    let count = 0;
    while (count < messages.length && ['system', 'developer'].includes(messages[count].role))
      count++;
    return count;
  };
  const previousHeader = leadingInstructions(previous);
  const currentHeader = leadingInstructions(current);
  // Instructions are request context: keep them ahead of conversational turns
  // so a continued tool result immediately follows its stored assistant call.
  return [
    ...previous.slice(0, previousHeader),
    ...current.slice(0, currentHeader),
    ...previous.slice(previousHeader),
    ...current.slice(currentHeader),
  ];
}
module.exports = { mergeResponsesChatHistory };
