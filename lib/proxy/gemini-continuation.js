'use strict';

const GEMINI_CONTINUATION_TEXT =
  'Continue from the preceding assistant response without repeating content already provided.';

// Responses retries can end with a partial assistant turn. Gemini requires a
// user turn to generate again; preserve the partial output as history instead
// of dropping it or inventing tool results. Run before context budgeting.
function normalizeGeminiContinuationHistory(messages, convertMessage) {
  const history = [];
  let lastContent = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const content = convertMessage(message);
    if (
      !content ||
      !['user', 'model'].includes(content.role) ||
      !Array.isArray(content.parts) ||
      !content.parts.some(
        (part) =>
          part &&
          typeof part === 'object' &&
          ((typeof part.text === 'string' && part.text.trim()) ||
            part.functionCall ||
            part.functionResponse ||
            part.inlineData ||
            part.fileData)
      )
    )
      continue;
    history.push(message);
    lastContent = content;
  }
  const appended = lastContent?.role === 'model';
  if (appended) history.push({ role: 'user', content: GEMINI_CONTINUATION_TEXT });
  return { messages: history, appended };
}

module.exports = { GEMINI_CONTINUATION_TEXT, normalizeGeminiContinuationHistory };
