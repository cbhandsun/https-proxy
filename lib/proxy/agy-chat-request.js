'use strict';

const MODELS = Object.freeze(['agy/gemini-3.7-flash-high']);
const MAX_BODY_BYTES = 128 * 1024;

class AgyError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid() {
  throw new AgyError('agy_unsupported_request', 400);
}

function textContent(value) {
  let text;
  if (typeof value === 'string') text = value;
  else if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    value.every(
      (part) =>
        record(part) &&
        part.type === 'text' &&
        typeof part.text === 'string' &&
        Object.keys(part).every((k) => ['type', 'text'].includes(k))
    )
  )
    text = value.map((part) => part.text).join('\n');
  else invalid();
  if (!text.trim() || text.length > 32768 || text.includes('\u0000')) invalid();
  return text;
}

function parseChatRequest(value) {
  if (!record(value)) invalid();
  const allowed = ['model', 'messages', 'stream', 'stream_options'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
  if (!MODELS.includes(value.model)) throw new AgyError('agy_model_not_supported', 400);
  if (value.stream !== undefined && typeof value.stream !== 'boolean') invalid();
  if (
    value.stream_options !== undefined &&
    (value.stream !== true ||
      !record(value.stream_options) ||
      Object.keys(value.stream_options).some((key) => key !== 'include_usage') ||
      typeof value.stream_options.include_usage !== 'boolean')
  )
    invalid();
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 64)
    invalid();
  const messages = value.messages.map((message, index) => {
    if (!record(message) || Object.keys(message).some((key) => !['role', 'content'].includes(key)))
      invalid();
    if (!['system', 'user', 'assistant'].includes(message.role)) invalid();
    if (message.role === 'system' && index !== 0) invalid();
    return { role: message.role, content: textContent(message.content) };
  });
  if (messages.at(-1).role !== 'user') invalid();
  // CLI stdin has user turns, not OpenAI role envelopes. Preserve history explicitly;
  // do not reuse a shared CLI conversation across unrelated HTTP requests.
  const prompt =
    'You are a text-only chat assistant. Answer the final user message in the following JSON conversation. ' +
    'Use earlier messages as conversation context. Do not use tools, access files, execute commands, or expand skills.\n' +
    JSON.stringify({ messages });
  if (Buffer.byteLength(prompt) > MAX_BODY_BYTES) throw new AgyError('agy_request_too_large', 413);
  return {
    model: value.model,
    cliModel: value.model.slice(4),
    prompt,
    stream: value.stream === true,
    includeUsage: value.stream_options?.include_usage === true,
  };
}

module.exports = { AgyError, MAX_BODY_BYTES, MODELS, parseChatRequest, record };
