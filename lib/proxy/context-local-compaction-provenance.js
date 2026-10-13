'use strict';

// This capability is created only after authenticated envelope replay, never by
// recognizing a client-visible marker. Exact clones retain it across planners.
const restored = new WeakMap();
function contentData(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const role = Object.getOwnPropertyDescriptor(message, 'role');
  const content = Object.getOwnPropertyDescriptor(message, 'content');
  if (
    role?.value !== 'assistant' ||
    !content ||
    !Object.hasOwn(content, 'value') ||
    typeof content.value !== 'string'
  )
    return null;
  return content.value;
}
function bindLocalCompactionMessages(messages, authenticatedTexts) {
  if (!Array.isArray(messages) || !Array.isArray(authenticatedTexts)) return;
  for (const message of messages) {
    const content = contentData(message);
    if (
      content !== null &&
      authenticatedTexts.some(
        (text) => typeof text === 'string' && text.length > 0 && content.includes(text)
      )
    )
      restored.set(message, content);
  }
}
function isLocalCompactionMessage(message) {
  return restored.has(message) && contentData(message) === restored.get(message);
}
function carryLocalCompactionMessage(target, source) {
  if (isLocalCompactionMessage(source) && contentData(target) === contentData(source))
    restored.set(target, contentData(source));
  return target;
}
module.exports = {
  bindLocalCompactionMessages,
  isLocalCompactionMessage,
  carryLocalCompactionMessage,
};
