'use strict';
const {
  resolveConvertedOutputTokenLimit,
  validateConvertedRequestScalars,
} = require('./converted-request-scalars');
const { convertedOutputFormat } = require('./converted-output-format');
const { isCodexResponsesTarget } = require('./responses-target');

function requestError(message) {
  const error = new TypeError(message);
  error.code = 'invalid_request_error';
  throw error;
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32) return true;
  }
  return false;
}

function validateChatMessages(messages, { validatePart = chatContentPartToResponses } = {}) {
  if (messages == null) return;
  if (!Array.isArray(messages)) requestError('Chat messages must be an array');
  for (const message of messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
    ) {
      requestError('Chat message requires a supported role');
    }
    if (
      message.content != null &&
      typeof message.content !== 'string' &&
      !Array.isArray(message.content)
    )
      requestError('Chat message content must be text or an array');
    if (message.role !== 'tool' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part != null) validatePart(part, message.role === 'assistant' ? 'assistant' : 'user');
      }
    }
  }
}

function applyResponsesRequestOptions(result, source, options) {
  validateConvertedRequestScalars(source, 'Responses');
  if (source.parallel_tool_calls != null) {
    if (typeof source.parallel_tool_calls !== 'boolean')
      requestError('parallel_tool_calls must be a boolean');
    result.parallel_tool_calls = source.parallel_tool_calls;
  }
  const maxTokens = resolveConvertedOutputTokenLimit(source);
  if (maxTokens != null) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)
      requestError('Output token limit must be a positive safe integer');
    result.max_output_tokens = maxTokens;
  }
  for (const key of ['temperature', 'top_p']) {
    if (source[key] == null) continue;
    if (options.codex !== false)
      requestError('Sampling parameters are unsupported by this Codex Responses endpoint');
    const max = key === 'temperature' ? 2 : 1;
    if (
      typeof source[key] !== 'number' ||
      !Number.isFinite(source[key]) ||
      source[key] < 0 ||
      source[key] > max
    )
      requestError('Sampling parameter is outside its supported range');
    result[key] = source[key];
  }
  const format = source.response_format;
  if (format == null) return;
  convertedOutputFormat(source, 'chat', 'Chat');
  if (!format || typeof format !== 'object' || Array.isArray(format))
    requestError('response_format must be an object');
  if (format.type === 'text' || format.type === 'json_object') {
    result.text = { format: { type: format.type } };
    return;
  }
  const schema = format.json_schema;
  if (
    format.type !== 'json_schema' ||
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    typeof schema.name !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(schema.name) ||
    !schema.schema ||
    typeof schema.schema !== 'object' ||
    Array.isArray(schema.schema)
  )
    requestError('response_format requires a valid named JSON schema');
  if (schema.strict != null && typeof schema.strict !== 'boolean')
    requestError('JSON schema strict must be a boolean');
  result.text = {
    format: {
      type: 'json_schema',
      name: schema.name,
      ...(schema.description != null ? { description: schema.description } : {}),
      schema: schema.schema,
      ...(schema.strict != null ? { strict: schema.strict } : {}),
    },
  };
}

function chatContentPartToResponses(part, role) {
  if (typeof part === 'string')
    return { type: role === 'user' ? 'input_text' : 'output_text', text: part };
  if (!part || typeof part !== 'object' || Array.isArray(part))
    requestError('Chat content parts must be objects or strings');
  if (part.type === 'text') {
    if (typeof part.text !== 'string') requestError('Chat text must be a string');
    return { type: role === 'user' ? 'input_text' : 'output_text', text: part.text };
  }
  if (part.type === 'image_url') {
    const image = part.image_url;
    const url = typeof image === 'string' ? image : image?.url;
    if (
      typeof url !== 'string' ||
      !url ||
      !/^(?:https?:\/\/|data:image\/)/i.test(url) ||
      hasControlCharacters(url)
    )
      requestError('Chat image requires a supported image URL');
    const detail = typeof image === 'object' ? image?.detail : undefined;
    if (detail != null && !['auto', 'low', 'high'].includes(detail))
      requestError('Image detail must be auto, low, or high');
    return { type: 'input_image', image_url: url, ...(detail != null ? { detail } : {}) };
  }
  // Audio/video need an explicit upstream capability contract. Rejecting avoids
  // sending a request with silently missing user content.
  requestError('Chat content type is not supported by Responses conversion');
}

module.exports = {
  isCodexResponsesTarget,
  applyResponsesRequestOptions,
  chatContentPartToResponses,
  validateChatMessages,
};
